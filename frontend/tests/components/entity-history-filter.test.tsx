/**
 * The kind filter and the pager of the entity history panel (contract §8b).
 *
 * The panel used to hardcode `page_size=50` and print the total with no way
 * to reach page 2 or to read only the notes. The filter and the pager are
 * controlled: the harness holds the params in state, feeds them to the real
 * journal hook and hands the setter down — exactly what the five detail
 * screens do. The test drives the hook, the API client and `fetch`, so the
 * request the browser sends is the thing under test.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import {
  EntityHistoryPanel,
  type JournalPanelParams,
} from "@/components/shared/entity-history-panel";
import { useFileJournal } from "@/lib/hooks";
import type { JournalEntry, Paginated } from "@/types";

const FILE_ID = "f-9a41c2d0";

/** Every journal URL the app asked, in order. */
let calls: string[] = [];
/** The answer the journal route gives, per request. */
let answer: (url: URL) => Response = (url) => json(pageFor(url));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: "j-1",
    entity_type: "file",
    entity_id: FILE_ID,
    field: "file.downloaded",
    kind: "event",
    old: null,
    new: null,
    source: "manual",
    actor: "a.bergstrom",
    actor_id: null,
    note: "Downloaded bat_cyc.mf4 (2048 bytes)",
    at: "2026-08-14T11:32:04Z",
    ...overrides,
  };
}

/** A three-page journal: 120 entries, 50 a page, echoing the asked params. */
function pageFor(url: URL, items?: JournalEntry[]): Paginated<JournalEntry> {
  const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(url.searchParams.get("page_size") ?? "50", 10);
  return {
    items: items ?? [entry({ id: `j-p${page}` })],
    total: 120,
    page,
    page_size: pageSize,
    total_pages: Math.ceil(120 / pageSize),
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The controlled wiring every detail screen uses. */
function Harness() {
  const [params, setParams] = useState<JournalPanelParams>({ page_size: 50 });
  const query = useFileJournal(FILE_ID, params);
  return (
    <EntityHistoryPanel
      label="file"
      isPending={query.isPending}
      isError={query.isError}
      page={query.data}
      onRetry={() => void query.refetch()}
      params={params}
      onParamsChange={setParams}
    />
  );
}

/** The query params of the latest journal request. */
function lastAsked(): URLSearchParams {
  const last = calls.at(-1);
  if (last === undefined) throw new Error("the app asked the journal nothing");
  return new URL(last, "http://localhost").searchParams;
}

beforeEach(() => {
  calls = [];
  answer = (url) => json(pageFor(url));
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      calls.push(input);
      return Promise.resolve(answer(new URL(input, "http://localhost")));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the history panel kind filter", () => {
  it("offers the three kinds and All, and starts unfiltered", async () => {
    render(<Harness />, { wrapper: Wrapper });
    const group = await screen.findByRole("group", { name: "Filter the file history by kind" });
    expect(group).toBeInTheDocument();
    for (const label of ["All", "Changes", "Events", "Notes"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(calls.length).toBe(1));
    expect(lastAsked().get("kind")).toBeNull();
  });

  it("asks the route with ?kind= when a kind is picked, and page 1 again", async () => {
    const user = userEvent.setup();
    render(<Harness />, { wrapper: Wrapper });
    await screen.findByText("file.downloaded");

    // Walk to page 2 first, so the reset is observable.
    await user.click(screen.getByRole("button", { name: "Page 2" }));
    await waitFor(() => expect(lastAsked().get("page")).toBe("2"));

    await user.click(screen.getByRole("button", { name: "Notes" }));
    await waitFor(() => expect(lastAsked().get("kind")).toBe("note"));
    // A kind flip starts a fresh question, so it always reads page 1.
    expect(lastAsked().get("page")).toBe("1");
    expect(screen.getByRole("button", { name: "Notes" })).toHaveAttribute("aria-pressed", "true");
  });

  it("returns to the unfiltered read when All is picked again", async () => {
    const user = userEvent.setup();
    render(<Harness />, { wrapper: Wrapper });
    await screen.findByText("file.downloaded");

    await user.click(screen.getByRole("button", { name: "Events" }));
    await waitFor(() => expect(lastAsked().get("kind")).toBe("event"));
    await user.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(lastAsked().get("kind")).toBeNull());
  });

  it("says the filter came up empty without claiming an empty history", async () => {
    const user = userEvent.setup();
    render(<Harness />, { wrapper: Wrapper });
    await screen.findByText("file.downloaded");

    answer = (url) =>
      url.searchParams.get("kind") === "note"
        ? json({ items: [], total: 0, page: 1, page_size: 50, total_pages: 0 })
        : json(pageFor(url));
    await user.click(screen.getByRole("button", { name: "Notes" }));

    expect(
      await screen.findByText("No note entries in the history of this file."),
    ).toBeInTheDocument();
    // The plain "nothing happened yet" empty state would lie here.
    expect(screen.queryByText("No journal entries")).not.toBeInTheDocument();
  });
});

describe("the history panel pager", () => {
  it("shows the range and walks to page 2", async () => {
    const user = userEvent.setup();
    render(<Harness />, { wrapper: Wrapper });
    await screen.findByText("file.downloaded");

    expect(screen.getByText("1–50")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Page 2" }));
    await waitFor(() => expect(lastAsked().get("page")).toBe("2"));
    await screen.findByText("51–100");
  });

  it("asks page 1 again when the page size changes", async () => {
    const user = userEvent.setup();
    render(<Harness />, { wrapper: Wrapper });
    await screen.findByText("file.downloaded");

    await user.click(screen.getByRole("button", { name: "Page 2" }));
    await waitFor(() => expect(lastAsked().get("page")).toBe("2"));

    await user.selectOptions(screen.getByLabelText("Rows per page"), "100");
    await waitFor(() => expect(lastAsked().get("page_size")).toBe("100"));
    expect(lastAsked().get("page")).toBe("1");
  });
});
