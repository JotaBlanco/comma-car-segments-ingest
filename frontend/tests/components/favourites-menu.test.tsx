/**
 * The topbar favorites and saved-searches menu.
 *
 * The favorites list is device-local. The saved searches come from two stores:
 * the device store, and the saved-search routes a signed-in Quix person owns.
 * The test writes `localStorage` the way the two device stores write it, stubs
 * `fetch` for the routes, then drives the real component through `user-event`.
 *
 * The cases the menu has to hold on every screen of the demo:
 *  1. The button opens the menu, and both sections carry a heading.
 *  2. A favorite row links to its detail screen and prints its type.
 *  3. A saved-search row links to its list screen plus its query, and prints
 *     which screen, because two screens can hold one name.
 *  4. Each section states its own empty case.
 *  5. Long lists cap, and the menu says how many rows it hides.
 *  6. Escape shuts the menu and returns focus to the button, and the button
 *     carries `aria-expanded`.
 *  7. A signed-in person reads the server rows here, not on the list screen
 *     alone. A signed-out person still reads the device rows, and a failed
 *     read still shows them.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSavedSearch } from "@/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { FavouritesMenu } from "@/components/shell/favourites-menu";
import {
  FAVOURITES_KEY,
  FAVOURITES_VERSION,
  resetFavouritesCache,
  type Favourite,
} from "@/lib/favourites";
import {
  SAVED_SEARCH_SCOPES,
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

/** The menu holds a query per scope, so the test owns one client per case. */
let client: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** How many times the app read the Portal profile. The identity waits on it. */
let profileCalls = 0;
/** Every `GET /saved-searches` the menu sent, by the scope it asked for. */
let listedScopes: string[] = [];
/** The rows the routes serve, per scope. A test seeds them. */
let stored: Partial<Record<SavedSearchScope, ServerSavedSearch[]>> = {};
/** When true, `GET /saved-searches` answers 500. */
let listFails = false;

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The Portal profile and the saved-search routes.
 *
 * The list route answers per scope, because the menu asks once per scope and
 * a stub that ignored the scope would print one row four times.
 */
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

function writeFavourites(favourites: Favourite[]): void {
  window.localStorage.setItem(
    FAVOURITES_KEY,
    JSON.stringify({ v: FAVOURITES_VERSION, favourites }),
  );
}

function writeSearches(scope: SavedSearchScope, searches: SavedSearch[]): void {
  window.localStorage.setItem(
    savedSearchStorageKey(scope),
    JSON.stringify({ v: SAVED_SEARCH_VERSION, searches }),
  );
}

function favourite(overrides: Partial<Favourite> = {}): Favourite {
  return { type: "run", id: "TAS-88214", label: "TAS-88214", at: 1_760_000_000_000, ...overrides };
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

/** The topbar button, found by its accessible name alone. */
function trigger(): HTMLElement {
  return screen.getByRole("button", { name: /Favorites and saved searches/ });
}

async function openMenu(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<FavouritesMenu />, { wrapper: Wrapper });
  await user.click(trigger());
  await screen.findByText("Saved searches");
  return user;
}

/**
 * A second tab writes the same key.
 *
 * The browser fires `storage` in every other document of the origin, never in
 * the document that wrote. jsdom fires none at all, so the test writes the key
 * and then fires the event a browser fires.
 */
function otherTabWrites(key: string, value: unknown): void {
  window.localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(new StorageEvent("storage", { key }));
}

describe("the topbar favorites and saved-searches menu", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetFavouritesCache();
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
    resetFavouritesCache();
    resetSavedSearchCache();
    setActivePortalToken(null);
    vi.unstubAllGlobals();
  });

  it("opens on a click and shows both sections", async () => {
    render(<FavouritesMenu />, { wrapper: Wrapper });
    const user = userEvent.setup();

    expect(screen.queryByText("Saved searches")).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger());

    expect(await screen.findByText("Favorites")).toBeInTheDocument();
    expect(screen.getByText("Saved searches")).toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
  });

  it("links a favorite to its detail screen and names its type", async () => {
    writeFavourites([
      favourite(),
      favourite({ type: "work_order", id: "WO-2026-0851", label: "WO-2026-0851" }),
    ]);
    await openMenu();

    const run = screen.getByRole("link", { name: /TAS-88214/ });
    expect(run).toHaveAttribute("href", "/runs/TAS-88214");
    expect(within(run).getByText("Test run")).toBeInTheDocument();

    const workOrder = screen.getByRole("link", { name: /WO-2026-0851/ });
    expect(workOrder).toHaveAttribute("href", "/work-orders/WO-2026-0851");
    expect(within(workOrder).getByText("Work order")).toBeInTheDocument();
  });

  it("links a saved search to its own screen plus its query", async () => {
    // One name, two screens. Only the screen tells the two rows apart.
    writeSearches("runs", [search()]);
    writeSearches("files", [search({ id: "s-2", query: "?format=MF4", at: 1_759_000_000_000 })]);
    await openMenu();

    const rows = screen.getAllByRole("link", { name: /Apply the saved search Complete this week/ });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("href", "/runs?status=complete");
    expect(rows[0]).toHaveAccessibleName(
      "Apply the saved search Complete this week on Test runs",
    );
    expect(rows[1]).toHaveAttribute("href", "/files?format=MF4");
    expect(rows[1]).toHaveAccessibleName("Apply the saved search Complete this week on Files");
  });

  it("reads every scope the store declares", async () => {
    // The menu must not hard-code the scope list. Every scope gets one row.
    SAVED_SEARCH_SCOPES.forEach((scope, index) => {
      writeSearches(scope, [search({ id: `s-${scope}`, name: `Search ${scope}`, at: index })]);
    });
    await openMenu();

    for (const scope of SAVED_SEARCH_SCOPES) {
      expect(
        screen.getByRole("link", { name: new RegExp(`Apply the saved search Search ${scope}`) }),
      ).toBeInTheDocument();
    }
  });

  it("states each empty case on its own", async () => {
    await openMenu();

    expect(screen.getByText(/No favorites yet\./)).toHaveTextContent(
      "Star a run, a file, a signal, a work order or a test definition on its detail screen.",
    );
    expect(screen.getByText(/No saved search yet\./)).toHaveTextContent(
      "Set the filters you want on a list screen",
    );
  });

  it("caps each section and says how many rows it hides", async () => {
    writeFavourites(
      Array.from({ length: 12 }, (_, index) =>
        favourite({ id: `TAS-${index}`, label: `TAS-${index}` }),
      ),
    );
    writeSearches(
      "runs",
      Array.from({ length: 11 }, (_, index) =>
        search({ id: `s-${index}`, name: `Search ${index}`, at: 1_000 - index }),
      ),
    );
    await openMenu();

    expect(screen.getAllByRole("link", { name: /^TAS-/ })).toHaveLength(8);
    expect(screen.getByText("4 more favorites. Home lists them all.")).toBeInTheDocument();

    expect(screen.getAllByRole("link", { name: /Apply the saved search/ })).toHaveLength(8);
    expect(
      screen.getByText("3 more saved searches. Each list screen holds its own."),
    ).toBeInTheDocument();
    expect(screen.getByText("8 of 12")).toBeInTheDocument();
    expect(screen.getByText("8 of 11")).toBeInTheDocument();
  });

  it("shuts on Escape and gives the focus back to the button", async () => {
    const user = await openMenu();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText("Saved searches")).not.toBeInTheDocument());
    expect(trigger()).toHaveFocus();
  });

  describe("a second tab changes a list", () => {
    it("shows the favorite the other tab starred, and counts it", async () => {
      writeFavourites([favourite()]);
      await openMenu();
      expect(screen.getByRole("link", { name: /TAS-88214/ })).toBeInTheDocument();

      await act(async () => {
        otherTabWrites(FAVOURITES_KEY, {
          v: FAVOURITES_VERSION,
          favourites: [favourite({ id: "TAS-90001", label: "TAS-90001" }), favourite()],
        });
      });

      expect(screen.getByRole("link", { name: /TAS-90001/ })).toHaveAttribute(
        "href",
        "/runs/TAS-90001",
      );
      // The badge and the rows read one list, so they can never disagree.
      expect(screen.getByText("2")).toBeInTheDocument();
      expect(trigger()).toHaveAccessibleName(/2 favorites/);
    });

    it("drops the favorite the other tab unstarred", async () => {
      writeFavourites([favourite()]);
      await openMenu();
      expect(screen.getByRole("link", { name: /TAS-88214/ })).toBeInTheDocument();

      await act(async () => {
        otherTabWrites(FAVOURITES_KEY, { v: FAVOURITES_VERSION, favourites: [] });
      });

      expect(screen.queryByRole("link", { name: /TAS-88214/ })).not.toBeInTheDocument();
      expect(screen.getByText(/No favorites yet\./)).toBeInTheDocument();
    });

    it("shows the saved search the other tab saved", async () => {
      await openMenu();

      await act(async () => {
        otherTabWrites(savedSearchStorageKey("runs"), {
          v: SAVED_SEARCH_VERSION,
          searches: [search()],
        });
      });

      expect(
        screen.getByRole("link", { name: /Apply the saved search Complete this week/ }),
      ).toHaveAttribute("href", "/runs?status=complete");
    });
  });

  describe("the searches a Quix account owns", () => {
    /** Wait until the identity settles, so `enabled` has its final answer. */
    async function mountAndSettle(): Promise<ReturnType<typeof userEvent.setup>> {
      const user = userEvent.setup();
      render(<FavouritesMenu />, { wrapper: Wrapper });
      await waitFor(() => expect(profileCalls).toBeGreaterThan(0));
      return user;
    }

    it("lists a server row above the device rows, and counts both", async () => {
      // The merge rule of `saved-search-button.tsx:147`: server first, device
      // after, and no row drops out.
      signIn();
      stored = { runs: [serverRow()] };
      writeSearches("runs", [search()]);
      const user = await mountAndSettle();

      await user.click(trigger());

      const rows = await screen.findAllByRole("link", { name: /Apply the saved search/ });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveAccessibleName("Apply the saved search Team cold soak on Test runs");
      expect(rows[0]).toHaveAttribute("href", "/runs?rig=RIG-01");
      expect(rows[1]).toHaveAccessibleName(
        "Apply the saved search Complete this week on Test runs",
      );
      await waitFor(() => expect(trigger()).toHaveAccessibleName(/2 saved searches/));
    });

    it("sends a row to the screen it read it from, never to the scope on the row", async () => {
      // The row's own `scope` field still misses `work-orders`, so a menu that
      // trusted it would send a work-order search to the runs screen.
      signIn();
      stored = {
        "work-orders": [
          serverRow({ search_id: "ss-wo", name: "Open orders", query: "?state=open" }),
        ],
      };
      const user = await mountAndSettle();

      await user.click(trigger());

      const row = await screen.findByRole("link", { name: /Apply the saved search Open orders/ });
      expect(row).toHaveAttribute("href", "/work-orders?state=open");
      expect(row).toHaveAccessibleName("Apply the saved search Open orders on Work orders");
    });

    it("asks no route before a person opens the menu, then asks every scope once", async () => {
      signIn();
      stored = { runs: [serverRow()] };
      const user = await mountAndSettle();

      // The page load costs nothing. The menu sits on every screen.
      expect(listedScopes).toEqual([]);

      await user.click(trigger());

      await waitFor(() =>
        expect([...listedScopes].sort()).toEqual([...SAVED_SEARCH_SCOPES].sort()),
      );
    });

    it("shows the device rows and no failure while nobody is signed in", async () => {
      writeSearches("runs", [search()]);
      await openMenu();

      expect(
        screen.getByRole("link", { name: /Apply the saved search Complete this week/ }),
      ).toHaveAttribute("href", "/runs?status=complete");
      expect(listedScopes).toEqual([]);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("keeps the device rows when the server read fails, and says so", async () => {
      signIn();
      listFails = true;
      writeSearches("runs", [search()]);
      const user = await mountAndSettle();

      await user.click(trigger());

      expect(
        await screen.findByText(
          "The shared list did not load. The searches on this device are still here.",
        ),
      ).toBeInTheDocument();
      // The failure adds a line. It never empties the list.
      expect(
        screen.getByRole("link", { name: /Apply the saved search Complete this week/ }),
      ).toHaveAttribute("href", "/runs?status=complete");
      expect(screen.queryByText(/No saved search yet\./)).not.toBeInTheDocument();
    });
  });
});
