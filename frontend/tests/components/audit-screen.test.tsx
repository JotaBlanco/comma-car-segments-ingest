/**
 * The Audit screen — the journal across every entity (FR-DM-055, NFR-DM-049).
 *
 * The six entity screens each show one history. This screen shows the whole
 * journal, and it filters by kind, by entity type, by entity id, by field, by
 * actor and by date. The test drives the real hook, the real API client and
 * `fetch`, so the request the browser sends is the thing under test.
 *
 * The filters live in the URL (`useTableState`), so the navigation mock below
 * is a real round trip: a push lands in a store, `useSearchParams` subscribes
 * to it, and the screen re-renders with the URL it just wrote — the same loop
 * the App Router runs in the browser.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { JournalEntry, Paginated } from "@/types";

const nav = vi.hoisted(() => ({
  search: { value: "" },
  listeners: new Set<() => void>(),
  navigate(url: string) {
    const cut = url.indexOf("?");
    nav.search.value = cut === -1 ? "" : url.slice(cut + 1);
    for (const listener of nav.listeners) listener();
  },
}));

vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const useSearchParams = () => {
    const value = useSyncExternalStore(
      (onChange: () => void) => {
        nav.listeners.add(onChange);
        return () => nav.listeners.delete(onChange);
      },
      () => nav.search.value,
    );
    return new URLSearchParams(value);
  };
  return {
    useRouter: () => ({ push: nav.navigate, replace: nav.navigate }),
    useSearchParams,
  };
});

import { AuditScreen } from "@/components/screens/audit/audit-screen";

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
    at: "2026-08-14T11:32:04Z",
    ...overrides,
  };
}

const ROWS: JournalEntry[] = [
  entry(),
  entry({
    id: "j-2",
    entity_type: "file",
    entity_id: "f-9a41c2d0",
    field: "file.downloaded",
    kind: "event",
    old: null,
    new: null,
    note: "Downloaded bat_cyc.mf4",
    actor: "b.lindqvist",
  }),
  entry({
    id: "j-3",
    entity_type: "result",
    entity_id: "res-4c1f",
    field: "result.written",
    kind: "event",
    old: null,
    new: null,
    note: null,
    actor: "quixlab",
  }),
];

const EMPTY_PAGE: Paginated<JournalEntry> = {
  items: [],
  total: 0,
  page: 1,
  page_size: 50,
  total_pages: 0,
};

/** A three-page journal: 120 entries, echoing the asked page and size. */
function pageFor(url: URL, items: JournalEntry[] = ROWS): Paginated<JournalEntry> {
  const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(url.searchParams.get("page_size") ?? "50", 10);
  return {
    items,
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

/** The query params of the latest journal request. */
function lastAsked(): URLSearchParams {
  const last = calls.at(-1);
  if (last === undefined) throw new Error("the app asked the journal nothing");
  return new URL(last, "http://localhost").searchParams;
}

beforeEach(() => {
  calls = [];
  answer = (url) => json(pageFor(url));
  nav.search.value = "";
  nav.listeners.clear();
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

/**
 * Open the audit Filters panel.
 *
 * The exact-match and date controls sit behind it, so a person opens the
 * panel before narrowing. With a clean URL the panel starts shut; a URL that
 * already carries a panel filter opens it on arrival — that case has its own
 * test below.
 */
async function openFilters(): Promise<void> {
  await userEvent.setup().click(screen.getByRole("button", { name: /^Filters/ }));
}

describe("the audit screen read", () => {
  it("asks the cross-entity route once, with no filter", async () => {
    render(<AuditScreen />, { wrapper: Wrapper });

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].startsWith("/api/proxy/journal?")).toBe(true);
    const asked = lastAsked();
    expect(asked.get("page")).toBe("1");
    expect(asked.get("page_size")).toBe("50");
    for (const name of [
      "kind",
      "entity_type",
      "entity_id",
      "field",
      "actor",
      "source",
      "since",
      "until",
    ]) {
      expect(asked.get(name)).toBeNull();
    }
  });

  it("names its loading state while the read runs", () => {
    render(<AuditScreen />, { wrapper: Wrapper });

    expect(screen.getByRole("status")).toHaveTextContent("Loading the audit journal");
  });

  it("prints one row per entry, with the id as a real link", async () => {
    render(<AuditScreen />, { wrapper: Wrapper });

    const runLink = await screen.findByRole("link", { name: "TAS-88214" });
    expect(runLink).toHaveAttribute("href", "/runs/TAS-88214");
    expect(screen.getByRole("link", { name: "f-9a41c2d0" })).toHaveAttribute(
      "href",
      "/files/f-9a41c2d0",
    );
    expect(screen.getByText("Test run")).toBeInTheDocument();
    expect(screen.getByText("a.bergstrom", { selector: "td" })).toBeInTheDocument();
  });

  it("states a result id as plain text, because a result owns no screen", async () => {
    render(<AuditScreen />, { wrapper: Wrapper });

    expect(await screen.findByText("res-4c1f")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "res-4c1f" })).not.toBeInTheDocument();
  });
});

describe("the audit screen filters", () => {
  it("sends the field a person types, once Enter applies it", async () => {
    const user = userEvent.setup();
    render(<AuditScreen />, { wrapper: Wrapper });
    await screen.findByRole("link", { name: "TAS-88214" });

    await openFilters();
    await user.type(screen.getByLabelText("Field"), "run.operator");
    // The match is exact, so a half-typed value must send nothing.
    expect(lastAsked().get("field")).toBeNull();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(lastAsked().get("field")).toBe("run.operator"));
    expect(lastAsked().get("actor")).toBeNull();
  });

  it("sends the actor a person types, once Enter applies it", async () => {
    const user = userEvent.setup();
    render(<AuditScreen />, { wrapper: Wrapper });
    await screen.findByRole("link", { name: "TAS-88214" });

    await openFilters();
    await user.type(screen.getByLabelText("Actor"), "b.lindqvist{Enter}");

    await waitFor(() => expect(lastAsked().get("actor")).toBe("b.lindqvist"));
  });

  it("sends the id a person pastes into Entity id", async () => {
    const user = userEvent.setup();
    render(<AuditScreen />, { wrapper: Wrapper });
    await screen.findByRole("link", { name: "TAS-88214" });

    await openFilters();
    await user.type(screen.getByLabelText("Entity id"), "TAS-88214{Enter}");

    await waitFor(() => expect(lastAsked().get("entity_id")).toBe("TAS-88214"));
  });

  it("sends the entity type a person picks, and the pill names it", async () => {
    const user = userEvent.setup();
    render(<AuditScreen />, { wrapper: Wrapper });
    await screen.findByRole("link", { name: "TAS-88214" });

    await user.click(screen.getByLabelText("Type"));
    await user.click(await screen.findByRole("option", { name: "File" }));

    await waitFor(() => expect(lastAsked().get("entity_type")).toBe("file"));
    expect(
      screen.getByRole("button", { name: "Remove filter: Type File" }),
    ).toBeInTheDocument();
  });

  it("clears the entity type through Any type", async () => {
    const user = userEvent.setup();
    nav.search.value = "entity_type=file";
    render(<AuditScreen />, { wrapper: Wrapper });
    await waitFor(() => expect(lastAsked().get("entity_type")).toBe("file"));

    await user.click(screen.getByLabelText("Type"));
    await user.click(await screen.findByRole("option", { name: "Any type" }));

    await waitFor(() => expect(lastAsked().get("entity_type")).toBeNull());
  });

  it("sends the source a person picks, and the pill names it", async () => {
    // The data steward's question: show me every manual override.
    const user = userEvent.setup();
    render(<AuditScreen />, { wrapper: Wrapper });
    await screen.findByRole("link", { name: "TAS-88214" });

    await openFilters();
    await user.click(screen.getByLabelText("Source"));
    await user.click(await screen.findByRole("option", { name: "manual" }));

    await waitFor(() => expect(lastAsked().get("source")).toBe("manual"));
    expect(
      screen.getByRole("button", { name: "Remove filter: Source manual" }),
    ).toBeInTheDocument();
  });

  it("turns the two picked days into an inclusive window", async () => {
    render(<AuditScreen />, { wrapper: Wrapper });
    await screen.findByRole("link", { name: "TAS-88214" });

    await openFilters();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-08-12" } });
    await waitFor(() => expect(lastAsked().get("since")).toBe("2026-08-12T00:00:00Z"));

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-08-14" } });
    // The last moment of the day, so a person who picks one day reads it whole.
    await waitFor(() => expect(lastAsked().get("until")).toBe("2026-08-14T23:59:59Z"));
    expect(lastAsked().get("since")).toBe("2026-08-12T00:00:00Z");
  });

  it("sends the kind of Chris's segmented filter", async () => {
    const user = userEvent.setup();
    render(<AuditScreen />, { wrapper: Wrapper });
    await screen.findByRole("link", { name: "TAS-88214" });

    await user.click(screen.getByRole("button", { name: "Notes" }));

    await waitFor(() => expect(lastAsked().get("kind")).toBe("note"));
  });

  it("reads page 1 again after a filter changes", async () => {
    const user = userEvent.setup();
    render(<AuditScreen />, { wrapper: Wrapper });
    await screen.findByRole("link", { name: "TAS-88214" });

    await user.click(screen.getByRole("button", { name: "Page 2" }));
    await waitFor(() => expect(lastAsked().get("page")).toBe("2"));

    await user.click(screen.getByRole("button", { name: "Events" }));
    await waitFor(() => expect(lastAsked().get("kind")).toBe("event"));
    expect(lastAsked().get("page")).toBe("1");
  });

  it("keeps each panel group named, and states the exact rule once", async () => {
    render(<AuditScreen />, { wrapper: Wrapper });
    await screen.findByRole("link", { name: "TAS-88214" });

    await openFilters();

    // Each group block owns its caption AND its controls, so a caption can
    // never wrap away from its fields. The name is on the group role.
    const exact = screen.getByRole("group", { name: "Exact match" });
    expect(within(exact).getByLabelText("Field")).toBeInTheDocument();
    expect(within(exact).getByLabelText("Actor")).toBeInTheDocument();
    expect(within(exact).getByLabelText("Entity id")).toBeInTheDocument();
    // The rule reads once, on the group — not as a tag on every input.
    expect(within(exact).getAllByText(/never finds/)).toHaveLength(1);

    const period = screen.getByRole("group", { name: "Period" });
    expect(within(period).getByLabelText("From")).toBeInTheDocument();
    expect(within(period).getByLabelText("To")).toBeInTheDocument();
  });

  it("says nothing matches when the filters come up empty", async () => {
    const user = userEvent.setup();
    render(<AuditScreen />, { wrapper: Wrapper });
    await screen.findByRole("link", { name: "TAS-88214" });

    answer = (url) =>
      url.searchParams.get("kind") === "note" ? json(EMPTY_PAGE) : json(pageFor(url));
    await user.click(screen.getByRole("button", { name: "Notes" }));

    expect(await screen.findByText(/Nothing matches the current filters/)).toBeInTheDocument();
  });

  it("explains the exact match when a typed filter finds nothing", async () => {
    const user = userEvent.setup();
    render(<AuditScreen />, { wrapper: Wrapper });
    await screen.findByRole("link", { name: "TAS-88214" });

    answer = (url) =>
      url.searchParams.get("actor") === "a.berg" ? json(EMPTY_PAGE) : json(pageFor(url));
    await openFilters();
    await user.type(screen.getByLabelText("Actor"), "a.berg{Enter}");

    // The trap this screen must not spring: a partial value, zero rows, and a
    // message that reads as "the journal is empty". The state names the rule.
    expect(
      await screen.findByText(/match the stored value exactly/),
    ).toBeInTheDocument();
  });
});

describe("the audit screen URL state", () => {
  it("reads the filters a pasted URL carries, and opens the panel", async () => {
    nav.search.value = "entity_type=file&actor=b.lindqvist";
    render(<AuditScreen />, { wrapper: Wrapper });

    await waitFor(() => expect(calls.length).toBe(1));
    const asked = lastAsked();
    expect(asked.get("entity_type")).toBe("file");
    expect(asked.get("actor")).toBe("b.lindqvist");
    // The URL carries a panel filter, so the panel opens on arrival.
    expect(screen.getByLabelText("Actor")).toHaveValue("b.lindqvist");
  });

  it("writes each applied filter into the URL", async () => {
    const user = userEvent.setup();
    render(<AuditScreen />, { wrapper: Wrapper });
    await screen.findByRole("link", { name: "TAS-88214" });

    await openFilters();
    await user.type(screen.getByLabelText("Field"), "run.operator{Enter}");

    await waitFor(() => expect(nav.search.value).toContain("field=run.operator"));
  });

  it("drops a filter when its pill is removed", async () => {
    const user = userEvent.setup();
    nav.search.value = "field=run.operator";
    render(<AuditScreen />, { wrapper: Wrapper });
    await waitFor(() => expect(lastAsked().get("field")).toBe("run.operator"));

    await user.click(
      screen.getByRole("button", { name: "Remove filter: Field run.operator" }),
    );

    await waitFor(() => expect(lastAsked().get("field")).toBeNull());
    // The box follows the URL, so the cleared filter empties it too.
    expect(screen.getByLabelText("Field")).toHaveValue("");
  });

  it("ignores an entity type the route does not take", async () => {
    // The URL is caller input. A mistyped deep link filters nothing — it must
    // never become a 422 the screen cannot recover from.
    nav.search.value = "entity_type=rig";
    render(<AuditScreen />, { wrapper: Wrapper });

    await waitFor(() => expect(calls.length).toBe(1));
    expect(lastAsked().get("entity_type")).toBeNull();
  });
});

describe("the audit screen pager", () => {
  it("shows the range and walks to page 2", async () => {
    const user = userEvent.setup();
    render(<AuditScreen />, { wrapper: Wrapper });
    await screen.findByRole("link", { name: "TAS-88214" });

    expect(screen.getByText("1–50")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Page 2" }));
    await waitFor(() => expect(lastAsked().get("page")).toBe("2"));
    await screen.findByText("51–100");
  });

  it("asks page 1 again when the page size changes", async () => {
    const user = userEvent.setup();
    render(<AuditScreen />, { wrapper: Wrapper });
    await screen.findByRole("link", { name: "TAS-88214" });

    await user.click(screen.getByRole("button", { name: "Page 2" }));
    await waitFor(() => expect(lastAsked().get("page")).toBe("2"));

    await user.selectOptions(screen.getByLabelText("Rows per page"), "100");
    await waitFor(() => expect(lastAsked().get("page_size")).toBe("100"));
    expect(lastAsked().get("page")).toBe("1");
  });
});
