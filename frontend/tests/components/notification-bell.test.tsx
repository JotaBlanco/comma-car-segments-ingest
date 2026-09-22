/**
 * The topbar notification bell (FR-DM-085).
 *
 * The bell reads `GET /journal` page by page, counts the entries that
 * arrived after the viewer last opened it, and links each one to its entity.
 * The test drives the real component, the real API client and `fetch`, so the
 * request the browser sends is the thing under test.
 *
 * The cases the control has to hold on every screen of the demo:
 *  1. The badge counts only the entries after the last-seen time.
 *  2. Opening the panel clears the count - and removes no entry. The list
 *     never hides anything; the watermark drives the badge alone.
 *  3. A failed journal call shows no badge and no error.
 *  4. Escape shuts the panel and returns focus to the bell.
 *  5. The watermark persists: a remount reads it back from `localStorage`.
 *  6. Entries newer than the last look carry a "New" mark; older ones do not.
 *  7. More pages load on request, and the end of the journal says so.
 *  8. The badge falling to zero is spoken through the app's live region.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { IsRestoringProvider, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JournalEntry } from "@/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import {
  NOTIFICATIONS_SEEN_KEY,
  NOTIFICATIONS_SEEN_VERSION,
  NotificationBell,
  resetNotificationsSeenCache,
} from "@/components/shell/notification-bell";
import { AnnouncerProvider } from "@/lib/hooks/use-announce";

/** Every URL the app asked, in order. */
let calls: string[] = [];
/** The answer the journal route gives, by URL - the paging case reads it. */
let answer: (url: string) => Response = () => json(page(ROWS));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function page(items: JournalEntry[], overrides: Record<string, unknown> = {}): unknown {
  return { items, total: items.length, page: 1, page_size: 100, total_pages: 1, ...overrides };
}

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: "j-1",
    entity_type: "run",
    entity_id: "TAS-88214",
    field: "run.operator",
    kind: "change",
    old: "(empty)",
    new: "a.bergstrom",
    source: "manual",
    actor: "a.bergstrom",
    actor_id: null,
    note: null,
    at: "2026-08-24T11:32:04Z",
    ...overrides,
  };
}

/**
 * Two entries after the mark below, one before it.
 *
 * `j-2` is the shape `POST /files` really writes for a quarantined file:
 * entity type `file`, kind `event`, field `file.registered` and the reason in
 * the note. `api/tests/test_files_quarantine_alert.py` holds the API to it, so
 * a change on either side breaks one of the two. That entry is the in-app half
 * of "an alert is raised" (FR-DM-004, UC-001 step 7).
 */
const ROWS: JournalEntry[] = [
  entry({ id: "j-3", at: "2026-08-24T12:00:00Z", entity_id: "TAS-90001" }),
  entry({
    id: "j-2",
    at: "2026-08-24T11:00:00Z",
    entity_type: "file",
    entity_id: "f-9a41c2d0",
    kind: "event",
    field: "file.registered",
    source: "embedded",
    actor: "ingestion",
    note: "Quarantined: checksum mismatch.",
  }),
  entry({ id: "j-1", at: "2026-08-20T09:00:00Z", entity_id: "TAS-11111" }),
];

/** The moment the viewer last looked: after `j-1`, before `j-2` and `j-3`. */
const LAST_SEEN = Date.parse("2026-08-24T10:00:00Z");

function seedLastSeen(at: number): void {
  window.localStorage.setItem(
    NOTIFICATIONS_SEEN_KEY,
    JSON.stringify({ v: NOTIFICATIONS_SEEN_VERSION, at }),
  );
  resetNotificationsSeenCache();
}

function Wrap({ children, restoring = false }: { children: ReactNode; restoring?: boolean }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return (
    <QueryClientProvider client={client}>
      <IsRestoringProvider value={restoring}>{children}</IsRestoringProvider>
    </QueryClientProvider>
  );
}

/** The bell button, whatever its count says. */
function bell(): HTMLElement {
  return screen.getByRole("button", { name: /^Notifications/ });
}

beforeEach(() => {
  calls = [];
  answer = () => json(page(ROWS));
  window.localStorage.clear();
  resetNotificationsSeenCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      return answer(String(url));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetNotificationsSeenCache();
});

describe("the notification bell", () => {
  it("counts only the entries after the last-seen time", async () => {
    seedLastSeen(LAST_SEEN);
    render(
      <Wrap>
        <NotificationBell />
      </Wrap>,
    );

    // Two of the three entries are newer than the mark.
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications - 2 new entries"));
    // 100 per page since 26 Aug 2026: the owner asked for a real number up
    // to 99, and a 20-entry page could only prove "20+".
    expect(calls[0]).toBe("/api/proxy/journal?page=1&page_size=100");
  });

  it("counts every entry when the viewer never looked", async () => {
    render(
      <Wrap>
        <NotificationBell />
      </Wrap>,
    );

    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications - 3 new entries"));
  });

  it("shows the real number up to 99", async () => {
    // 42 unread out of 42 loaded, journal end reached: the badge states the
    // exact number. Under the old 20-entry page this could only say "20+".
    const many = Array.from({ length: 42 }, (_, i) =>
      entry({ id: `j-m${i}`, at: "2026-08-24T12:00:00Z", entity_id: `TAS-${i}` }),
    );
    answer = () => json(page(many));
    render(
      <Wrap>
        <NotificationBell />
      </Wrap>,
    );

    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications - 42 new entries"));
  });

  it("caps the badge at 99+ and says the same to a screen reader", async () => {
    // 100 unread on the loaded page and 250 in the journal. The badge and
    // the accessible name both say "99+": the loaded slice proves more than
    // 99, and an exact number past that is one the bell cannot know.
    const many = Array.from({ length: 100 }, (_, i) =>
      entry({ id: `j-m${i}`, at: "2026-08-24T12:00:00Z", entity_id: `TAS-${i}` }),
    );
    answer = () => json(page(many, { total: 250, total_pages: 3 }));
    render(
      <Wrap>
        <NotificationBell />
      </Wrap>,
    );

    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications - 99+ new entries"));
    expect(screen.getByText("99+")).toBeInTheDocument();
  });

  it("shows no badge when nothing arrived after the last-seen time", async () => {
    seedLastSeen(Date.parse("2026-08-25T00:00:00Z"));
    render(
      <Wrap>
        <NotificationBell />
      </Wrap>,
    );

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(bell()).toHaveAccessibleName("Notifications - nothing new");
  });

  it("clears the count when the viewer opens the panel", async () => {
    const user = userEvent.setup();
    seedLastSeen(LAST_SEEN);
    render(
      <Wrap>
        <NotificationBell />
      </Wrap>,
    );
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications - 2 new entries"));

    await user.click(bell());

    // The panel lists the entries, each row one link to its entity. The row
    // is the link now, so its name starts with the id and carries the rest.
    const link = await screen.findByRole("link", { name: /^TAS-90001/ });
    expect(link).toHaveAttribute("href", "/runs/TAS-90001");
    expect(screen.getByRole("link", { name: /^f-9a41c2d0/ })).toHaveAttribute(
      "href",
      "/files/f-9a41c2d0",
    );

    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications - nothing new"));
    // The mark survives a reload: it lives in `localStorage`, not in state.
    const stored = JSON.parse(window.localStorage.getItem(NOTIFICATIONS_SEEN_KEY) ?? "{}") as {
      at: number;
    };
    expect(stored.at).toBeGreaterThan(LAST_SEEN);
  });

  it("tells the viewer a file was quarantined, and why", async () => {
    // FR-DM-004 and UC-001 step 7 ask that "an alert is raised". This is the
    // in-app half: the ingestion journals the quarantine, the bell counts it,
    // and the row names the file and the reason with no new route and no
    // filter of ours. The API half is the pytest file named above.
    const user = userEvent.setup();
    seedLastSeen(LAST_SEEN);
    render(
      <Wrap>
        <NotificationBell />
      </Wrap>,
    );
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications - 2 new entries"));

    await user.click(bell());

    // Which file: the row links to the quarantined file's own screen. The
    // whole row is the link, so its name starts with the id and then carries
    // the moment, the "New" mark and the note. Match the id at the front, the
    // way the case above does.
    const link = await screen.findByRole("link", { name: /^f-9a41c2d0/ });
    expect(link).toHaveAttribute("href", "/files/f-9a41c2d0");
    // Why: the note is the one summary line the panel prints.
    expect(screen.getByText("Quarantined: checksum mismatch.")).toBeInTheDocument();
  });

  it("shows no badge and no error when the journal call fails", async () => {
    answer = () => json({ detail: "boom", code: "server_error", errors: [] }, 500);
    render(
      <Wrap>
        <NotificationBell />
      </Wrap>,
    );

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(bell()).toHaveAccessibleName("Notifications - nothing new");
    expect(screen.queryByText(/could not/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows no badge and no error when the answer has an unknown shape", async () => {
    answer = () => json({ nonsense: true });
    render(
      <Wrap>
        <NotificationBell />
      </Wrap>,
    );

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(bell()).toHaveAccessibleName("Notifications - nothing new");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shuts the panel on Escape and gives the focus back to the bell", async () => {
    const user = userEvent.setup();
    render(
      <Wrap>
        <NotificationBell />
      </Wrap>,
    );
    await waitFor(() => expect(calls).toHaveLength(1));

    await user.click(bell());
    expect(await screen.findByText("Recent activity")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText("Recent activity")).not.toBeInTheDocument());
    expect(bell()).toHaveFocus();
  });

  it("sends no request while the query gate holds", async () => {
    render(
      <Wrap restoring>
        <NotificationBell />
      </Wrap>,
    );

    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(0);
    expect(bell()).toHaveAccessibleName("Notifications - nothing new");
  });

  it("never throws when `localStorage` refuses to answer", async () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", { value: blocked, configurable: true });
    resetNotificationsSeenCache();
    try {
      const user = userEvent.setup();
      render(
        <Wrap>
          <NotificationBell />
        </Wrap>,
      );
      // A blocked read falls back to the in-memory copy, which is "never
      // looked", so every entry counts.
      await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications - 3 new entries"));

      // A blocked write must not break the click either. The mark then lives
      // in memory for this tab only, and the count still clears.
      await user.click(bell());
      await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications - nothing new"));
    } finally {
      if (original !== undefined) Object.defineProperty(window, "localStorage", original);
      resetNotificationsSeenCache();
    }
  });

  it("removes no entry when the viewer opens the panel", async () => {
    const user = userEvent.setup();
    seedLastSeen(LAST_SEEN);
    render(
      <Wrap>
        <NotificationBell />
      </Wrap>,
    );
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications - 2 new entries"));

    await user.click(bell());

    // The badge resets, but the list is a window on the journal: every entry
    // stays on screen, the already-seen ones included.
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications - nothing new"));
    expect(screen.getByRole("link", { name: /^TAS-90001/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^f-9a41c2d0/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^TAS-11111/ })).toBeInTheDocument();
  });

  it("marks only the entries since the last look as new", async () => {
    const user = userEvent.setup();
    seedLastSeen(LAST_SEEN);
    render(
      <Wrap>
        <NotificationBell />
      </Wrap>,
    );
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications - 2 new entries"));

    await user.click(bell());

    const fresh = await screen.findByRole("link", { name: /^TAS-90001/ });
    const stale = screen.getByRole("link", { name: /^TAS-11111/ });
    // The mark is a word as well as a dot, so it is never colour alone.
    expect(within(fresh).getByText("New")).toBeInTheDocument();
    expect(within(stale).queryByText("New")).not.toBeInTheDocument();
  });

  it("keeps the watermark across a remount", async () => {
    const user = userEvent.setup();
    const first = render(
      <Wrap>
        <NotificationBell />
      </Wrap>,
    );
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications - 3 new entries"));
    await user.click(bell());
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications - nothing new"));

    first.unmount();
    // Drop the module caches, so the next read must come from `localStorage`.
    resetNotificationsSeenCache();
    render(
      <Wrap>
        <NotificationBell />
      </Wrap>,
    );

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    expect(bell()).toHaveAccessibleName("Notifications - nothing new");
  });

  it("loads older pages on request and names the end of the journal", async () => {
    const user = userEvent.setup();
    const older = entry({ id: "j-0", at: "2026-08-19T08:00:00Z", entity_id: "TAS-00001" });
    answer = (url) =>
      url.includes("page=2")
        ? json(page([older], { page: 2, total: 4, total_pages: 2 }))
        : json(page(ROWS, { total: 4, total_pages: 2 }));
    render(
      <Wrap>
        <NotificationBell />
      </Wrap>,
    );
    await waitFor(() => expect(calls).toHaveLength(1));

    await user.click(bell());

    // Page one is on screen, and the journal says there is more.
    await screen.findByRole("link", { name: /^TAS-90001/ });
    expect(screen.queryByRole("link", { name: /^TAS-00001/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show older activity" }));

    // The next page arrives, appends below, and the list now ends honestly.
    await screen.findByRole("link", { name: /^TAS-00001/ });
    expect(calls).toContain("/api/proxy/journal?page=2&page_size=100");
    await screen.findByText("End of the journal.");
    expect(screen.queryByRole("button", { name: /older activity/i })).not.toBeInTheDocument();
  });

  it("speaks the badge reset through the app's live region", async () => {
    const user = userEvent.setup();
    seedLastSeen(LAST_SEEN);
    render(
      <Wrap>
        <AnnouncerProvider>
          <NotificationBell />
        </AnnouncerProvider>
      </Wrap>,
    );
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications - 2 new entries"));

    await user.click(bell());

    // The announcer debounces, so the sentence lands a beat later.
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("2 new entries marked as seen."),
    );
  });
});

describe("a second tab moves the seen mark", () => {
  it("drops the badge to zero when the other tab looked", async () => {
    seedLastSeen(LAST_SEEN);
    render(
      <Wrap>
        <NotificationBell />
      </Wrap>,
    );
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notifications - 2 new entries"));

    /* The browser fires `storage` in every other document of the origin,
       never in the document that wrote. jsdom fires none at all, so the test
       writes the key and then fires the event a browser fires. */
    await act(async () => {
      window.localStorage.setItem(
        NOTIFICATIONS_SEEN_KEY,
        JSON.stringify({
          v: NOTIFICATIONS_SEEN_VERSION,
          at: Date.parse("2026-08-25T00:00:00Z"),
        }),
      );
      window.dispatchEvent(new StorageEvent("storage", { key: NOTIFICATIONS_SEEN_KEY }));
    });

    expect(bell()).toHaveAccessibleName("Notifications - nothing new");
  });
});
