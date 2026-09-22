/**
 * The Home saved-searches panel (FR-DM-017).
 *
 * The panel prints one list from two stores: the device store the list-screen
 * toolbar writes, and the saved-search routes a signed-in Quix person owns.
 * `useMergedSavedSearches` merges them, and the topbar menu reads the same
 * hook, so this file guards the panel's own shell and its own gate.
 *
 * The cases the demo has to hold:
 *  1. The panel renders with its heading and its column headers.
 *  2. A device row links to its list screen plus its query, and names the
 *     screen, because two screens can hold one name.
 *  3. A signed-in person reads the server rows here too.
 *  4. A signed-out person still reads the device rows, and sends no request.
 *  5. A failed server read keeps the device rows and says the shared list did
 *     not load.
 *  6. The empty state tells a person how to make a saved search.
 *  7. Long lists cap, and the panel says how many rows it holds back.
 *
 * The harness copies `tests/components/favourites-menu.test.tsx` whole.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSavedSearch } from "@/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { SavedSearchesPanel } from "@/components/screens/home/saved-searches-panel";
import {
  SAVED_SEARCH_VERSION,
  resetSavedSearchCache,
  savedSearchStorageKey,
  type SavedSearch,
  type SavedSearchScope,
} from "@/lib/saved-searches";
import { setPortalApiBase } from "@/lib/portal/client";
import { PORTAL_TOKEN_STORAGE_KEY, setActivePortalToken } from "@/lib/portal/token-store";

const PORTAL_API = "https://portal-api.dev.quix.io";
/** The signed-in person. The Portal profile names her and gives her id. */
const ME = { userId: "u-1", displayName: "Erika Lindqvist" };

let client: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** How many times the app read the Portal profile. The identity waits on it. */
let profileCalls = 0;
/** Every `GET /saved-searches` the panel sent, by the scope it asked for. */
let listedScopes: string[] = [];
/** The rows the routes serve, per scope. A test seeds them. */
let stored: Partial<Record<SavedSearchScope, ServerSavedSearch[]>> = {};
/** When true, `GET /saved-searches` answers 500. */
let listFails = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function serverRow(over: Partial<ServerSavedSearch> = {}): ServerSavedSearch {
  return {
    search_id: "ss-1",
    scope: "runs",
    name: "Team cold soak",
    description: null,
    query: "?rig=RIG-01",
    visibility: "team",
    owner: ME.displayName,
    owner_id: ME.userId,
    saved_at: "2026-08-24T09:41:00Z",
    ...over,
  };
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost:3000");
      const method = (init.method ?? "GET").toUpperCase();

      if (url.pathname === "/profile") {
        profileCalls += 1;
        return json({
          userId: ME.userId,
          email: "e.lindqvist@volvo.com",
          firstName: "Erika",
          lastName: "Lindqvist",
        });
      }
      if (url.pathname === "/organisations/current") return new Response(null, { status: 204 });

      if (url.pathname === "/api/proxy/saved-searches" && method === "GET") {
        const scope = url.searchParams.get("scope") ?? "";
        listedScopes.push(scope);
        if (listFails) {
          return json({ detail: "the registry is down", code: "server_error" }, 500);
        }
        const items = stored[scope as SavedSearchScope] ?? [];
        return json({ items, total: items.length, page: 1, page_size: 50, total_pages: 1 });
      }
      throw new TypeError(`no stub for ${method} ${input}`);
    }),
  );
}

/** Give this browser a Portal token, so the identity resolves to `ME`. */
function signIn(): void {
  window.localStorage.setItem(PORTAL_TOKEN_STORAGE_KEY, "portal-pat");
}

function writeSearches(scope: SavedSearchScope, searches: SavedSearch[]): void {
  window.localStorage.setItem(
    savedSearchStorageKey(scope),
    JSON.stringify({ v: SAVED_SEARCH_VERSION, searches }),
  );
}

function search(overrides: Partial<SavedSearch> = {}): SavedSearch {
  return {
    id: "s-1",
    name: "Complete this week",
    query: "?status=complete",
    at: 1_760_000_000_000,
    ...overrides,
  };
}

describe("the Home saved-searches panel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSavedSearchCache();
    setActivePortalToken(null);
    setPortalApiBase(PORTAL_API);
    profileCalls = 0;
    listedScopes = [];
    stored = {};
    listFails = false;
    // No retry: a 500 must reach the screen inside one test, not after three.
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch();
  });

  afterEach(() => {
    window.localStorage.clear();
    resetSavedSearchCache();
    setActivePortalToken(null);
    vi.unstubAllGlobals();
  });

  it("renders with its heading and its columns", () => {
    render(<SavedSearchesPanel />, { wrapper: Wrapper });

    expect(screen.getByRole("heading", { name: "Saved searches" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Saved searches" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Table" })).toBeInTheDocument();
  });

  it("links a device row to its own screen plus its query, and names the screen", () => {
    // One name, two screens. Only the screen tells the two rows apart.
    writeSearches("runs", [search()]);
    writeSearches("files", [search({ id: "s-2", query: "?format=MF4", at: 1_759_000_000_000 })]);
    render(<SavedSearchesPanel />, { wrapper: Wrapper });

    const rows = screen.getAllByRole("link", { name: /Complete this week/ });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("href", "/runs?status=complete");
    expect(rows[0]).toHaveAccessibleName("Complete this week on Test runs");
    expect(rows[1]).toHaveAttribute("href", "/files?format=MF4");
    expect(rows[1]).toHaveAccessibleName("Complete this week on Files");
    // The screen also reads off the row itself, in its own column.
    expect(screen.getAllByRole("cell", { name: "Test runs" })).toHaveLength(1);
    expect(screen.getAllByRole("cell", { name: "Files" })).toHaveLength(1);
  });

  it("shows a server row for a signed-in person, above the device rows", async () => {
    // The merge rule: server first, device after, and no row drops out.
    signIn();
    stored = { runs: [serverRow()] };
    writeSearches("runs", [search()]);
    render(<SavedSearchesPanel />, { wrapper: Wrapper });

    await waitFor(() => expect(profileCalls).toBeGreaterThan(0));

    let rows: HTMLElement[] = [];
    await waitFor(() => {
      rows = screen.getAllByRole("link", { name: /on Test runs/ });
      expect(rows).toHaveLength(2);
    });
    expect(rows[0]).toHaveAccessibleName("Team cold soak on Test runs");
    expect(rows[0]).toHaveAttribute("href", "/runs?rig=RIG-01");
    expect(rows[1]).toHaveAccessibleName("Complete this week on Test runs");
  });

  it("sends a server row to the screen it read it from, never to the scope on the row", async () => {
    // The row's own `scope` field still misses `work-orders`, so a panel that
    // trusted it would send a work-order search to the runs screen.
    signIn();
    stored = {
      "work-orders": [serverRow({ search_id: "ss-wo", name: "Open orders", query: "?state=open" })],
    };
    render(<SavedSearchesPanel />, { wrapper: Wrapper });

    const row = await screen.findByRole("link", { name: /Open orders/ });
    expect(row).toHaveAttribute("href", "/work-orders?state=open");
    expect(row).toHaveAccessibleName("Open orders on Work orders");
  });

  it("shows the device rows and no failure while nobody is signed in", async () => {
    writeSearches("runs", [search()]);
    render(<SavedSearchesPanel />, { wrapper: Wrapper });

    expect(screen.getByRole("link", { name: /Complete this week/ })).toHaveAttribute(
      "href",
      "/runs?status=complete",
    );
    // No Quix identity, so the panel asks no route and can print no failure.
    await waitFor(() => expect(listedScopes).toEqual([]));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the device rows when the server read fails, and says so", async () => {
    signIn();
    listFails = true;
    writeSearches("runs", [search()]);
    render(<SavedSearchesPanel />, { wrapper: Wrapper });

    expect(
      await screen.findByText(
        "The shared list did not load. The searches on this device are still here.",
      ),
    ).toBeInTheDocument();
    // The failure adds a line. It never empties the list.
    expect(screen.getByRole("link", { name: /Complete this week/ })).toHaveAttribute(
      "href",
      "/runs?status=complete",
    );
    expect(screen.queryByText(/No saved search yet/)).not.toBeInTheDocument();
  });

  it("tells a person how to make one when the list is empty", () => {
    render(<SavedSearchesPanel />, { wrapper: Wrapper });

    expect(screen.getByText("No saved search yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Set the filters you want on a list screen, then name them with the Saved searches button there.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Device and team")).toBeInTheDocument();
  });

  it("caps the rows and says how many it holds back", () => {
    writeSearches(
      "runs",
      Array.from({ length: 9 }, (_, index) =>
        search({ id: `s-${index}`, name: `Search ${index}`, at: 1_000 - index }),
      ),
    );
    render(<SavedSearchesPanel />, { wrapper: Wrapper });

    expect(screen.getAllByRole("link", { name: /^Search \d/ })).toHaveLength(6);
    expect(
      screen.getByText("3 more saved searches. Each list screen holds its own."),
    ).toBeInTheDocument();
    expect(screen.getByText("6 of 9")).toBeInTheDocument();
  });
});
