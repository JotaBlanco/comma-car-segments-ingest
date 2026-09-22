/**
 * FR-DM-075 — favourites: the store, the star on a detail header and the Home
 * panel.
 *
 * The store copies `lib/saved-searches.ts`, so the test copies that harness.
 * The list is device-local, exactly like the Explore star it copies, so no
 * route and no collection take part. Only `fetch` and the router are stubs.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { FileDetail, TestDefinitionDetail, WorkOrderDetail } from "@/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { FavouriteStar } from "@/components/shared/favourite-star";
import { FavouritesPanel } from "@/components/screens/home/favourites-panel";
import { FileDetailScreen } from "@/components/screens/files/file-detail-screen";
import { DefinitionDetailScreen } from "@/components/screens/definitions/definition-detail-screen";
import { WorkOrderDetailScreen } from "@/components/screens/work-orders/work-order-detail-screen";
import { setActivePortalToken } from "@/lib/portal/token-store";
import { setPortalApiBase } from "@/lib/portal/client";
import {
  FAVOURITES_KEY,
  FAVOURITES_VERSION,
  MAX_FAVOURITES,
  favouriteHref,
  favouritesPersist,
  removeFavourite,
  resetFavouritesCache,
  toggleFavourite,
  type Favourite,
} from "@/lib/favourites";

// Each test drives a real screen through user-event, so it takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const FILE_ID = "f-11111111-1111-4111-8111-111111111111";
const RUN_ID = "TAS-88214";
const FILENAME = "bat_cyc_20260814_0941.mf4";
const WO_ID = "WO-2026-0851";
const TD_ID = "TD-4471";
const PORTAL_API = "https://portal-api.dev.quix.io";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fileDetail(): FileDetail {
  return {
    file_id: FILE_ID,
    filename: FILENAME,
    run_id: RUN_ID,
    source_system: "TAS",
    format: "MF4",
    size_bytes: 4096,
    checksum_sha256: "a".repeat(64),
    checksum_state: "verified",
    status: "registered",
    quarantine_reason: null,
    lifecycle: "active",
    version: 1,
    sync_status: "success",
    upload_status: "success",
    conversion_status: "success",
    stage_error: null,
    signal_count: 2,
    time_start: "2026-08-14T09:00:00Z",
    time_end: "2026-08-14T11:00:00Z",
    registered_at: "2026-08-14T10:02:00Z",
    storage_ref: "tas-raw/2026/08/bat_cyc_20260814_0941.mf4",
    ingestion_job_id: "ing-8841",
    field_sources: {},
    ingestion_timeline: [],
    signals: [],
  };
}

function workOrderDetail(): WorkOrderDetail {
  return {
    wo_id: WO_ID,
    title: "Battery cycling campaign",
    project: "BEV-Gen3",
    status: "active",
    requestor: "e.lindqvist@volvo.com",
    department: "Propulsion",
    priority: "high",
    created_at_source: "2026-08-01T08:00:00Z",
    synced_at: "2026-08-14T10:00:00Z",
    definitions: [],
    runs: [],
  };
}

function definitionDetail(): TestDefinitionDetail {
  return {
    td_id: TD_ID,
    title: "Cold-start cycling",
    work_order_id: WO_ID,
    planned_runs: 4,
    actual_runs: 1,
    status: "on_plan",
    orphaned: false,
    synced_at: "2026-08-14T10:00:00Z",
    work_order: {
      wo_id: WO_ID,
      title: "Battery cycling campaign",
      project: "BEV-Gen3",
      status: "active",
    },
    runs: [],
    requirements_files: [],
    custom_properties: {},
  };
}

/** An empty page, the shape every journal route answers. */
function emptyPage(): unknown {
  return { items: [], total: 0, page: 1, page_size: 50, total_pages: 0 };
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/profile") {
        return json({
          userId: "u-1",
          email: "e.lindqvist@volvo.com",
          firstName: "Erika",
          lastName: "Lindqvist",
        });
      }
      if (url.pathname === "/organisations/current") return new Response(null, { status: 204 });
      if (url.pathname === `/api/proxy/files/${FILE_ID}/versions`) {
        return json({ items: [], total: 0 });
      }
      if (url.pathname === `/api/proxy/files/${FILE_ID}`) return json(fileDetail());
      if (url.pathname === "/api/proxy/test-runs") return json(emptyPage());
      if (url.pathname === `/api/proxy/work-orders/${WO_ID}`) return json(workOrderDetail());
      if (url.pathname === `/api/proxy/work-orders/${WO_ID}/journal`) return json(emptyPage());
      if (url.pathname === `/api/proxy/test-definitions/${TD_ID}`) return json(definitionDetail());
      if (url.pathname === `/api/proxy/test-definitions/${TD_ID}/journal`) {
        return json(emptyPage());
      }
      if (url.pathname === `/api/proxy/test-runs/${RUN_ID}`) {
        return json({ run_id: RUN_ID, work_order_id: "WO-2026-0851", definition_id: "TD-4471" });
      }
      throw new TypeError(`no stub for ${(init.method ?? "GET").toUpperCase()} ${input}`);
    }),
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The favourites `localStorage` holds right now. */
function stored(): Favourite[] {
  const raw = window.localStorage.getItem(FAVOURITES_KEY);
  if (raw === null) return [];
  return (JSON.parse(raw) as { favourites: Favourite[] }).favourites;
}

beforeEach(() => {
  setPortalApiBase(PORTAL_API);
  window.localStorage.clear();
  window.localStorage.setItem("tm.portal.token", "portal-pat");
  setActivePortalToken(null);
  resetFavouritesCache();
  stubFetch();
});

afterEach(() => {
  setPortalApiBase(null);
  window.localStorage.clear();
  resetFavouritesCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the favourites store", () => {
  it("saves one entity and removes it on the second toggle", () => {
    expect(toggleFavourite("run", RUN_ID, RUN_ID)).toBe(true);
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ type: "run", id: RUN_ID, label: RUN_ID });
    expect(typeof stored()[0].at).toBe("number");

    expect(toggleFavourite("run", RUN_ID, RUN_ID)).toBe(false);
    expect(stored()).toHaveLength(0);
  });

  it("keys on the type and the id, so one id under two types is two rows", () => {
    toggleFavourite("run", "X-1", "X-1");
    toggleFavourite("file", "X-1", "X-1.mf4");
    expect(stored()).toHaveLength(2);

    removeFavourite("run", "X-1");
    expect(stored()).toEqual([expect.objectContaining({ type: "file", id: "X-1" })]);
  });

  it("caps the list and keeps the newest rows", () => {
    for (let index = 0; index < MAX_FAVOURITES + 5; index += 1) {
      toggleFavourite("run", `TAS-${index}`, `TAS-${index}`);
    }
    const rows = stored();
    expect(rows).toHaveLength(MAX_FAVOURITES);
    expect(rows[0].id).toBe(`TAS-${MAX_FAVOURITES + 4}`);
    expect(rows.some((row) => row.id === "TAS-0")).toBe(false);
  });

  it("reads an empty list from corrupt storage and never throws", () => {
    window.localStorage.setItem(FAVOURITES_KEY, "{ not json at all");
    resetFavouritesCache();

    render(<FavouritesPanel />);
    expect(screen.getByText("No favorites yet")).toBeInTheDocument();

    // A write still lands, and it replaces the broken payload.
    expect(toggleFavourite("run", RUN_ID, RUN_ID)).toBe(true);
    expect(stored()).toHaveLength(1);
  });

  it("drops a payload from another version and every row of the wrong shape", () => {
    window.localStorage.setItem(
      FAVOURITES_KEY,
      JSON.stringify({ v: FAVOURITES_VERSION + 1, favourites: [{ type: "run", id: "A" }] }),
    );
    resetFavouritesCache();
    render(<FavouritesPanel />);
    expect(screen.getByText("No favorites yet")).toBeInTheDocument();
  });

  it("keeps working in memory when the browser refuses storage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(toggleFavourite("run", RUN_ID, RUN_ID)).toBe(true);
    expect(favouritesPersist()).toBe(false);

    render(<FavouritesPanel />);
    expect(screen.getByText(RUN_ID)).toBeInTheDocument();
    expect(screen.getByText(/This browser refuses storage/)).toBeInTheDocument();
  });

  it("renders the empty list on the server, so the first client pass agrees", () => {
    toggleFavourite("run", RUN_ID, RUN_ID);
    resetFavouritesCache();

    const markup = renderToStaticMarkup(<FavouritesPanel />);

    expect(markup).toContain("No favorites yet");
    expect(markup).not.toContain(RUN_ID);
  });

  it("routes a work order and a test definition to their own detail screen", () => {
    expect(favouriteHref({ type: "work_order", id: WO_ID, label: WO_ID, at: 1 })).toBe(
      `/work-orders/${WO_ID}`,
    );
    expect(favouriteHref({ type: "test_definition", id: TD_ID, label: TD_ID, at: 1 })).toBe(
      `/definitions/${TD_ID}`,
    );
  });

  it("escapes an id that carries a slash, so the route still names one entity", () => {
    expect(favouriteHref({ type: "work_order", id: "WO/1", label: "WO/1", at: 1 })).toBe(
      "/work-orders/WO%2F1",
    );
  });
});

describe("the star control", () => {
  it("carries an accessible name and aria-pressed, and toggles both", async () => {
    const user = userEvent.setup();
    render(<FavouriteStar type="signal" id="batt_pack_temp_01" label="batt_pack_temp_01" />);

    const star = screen.getByRole("button", { name: "Add batt_pack_temp_01 to favorites" });
    expect(star).toHaveAttribute("aria-pressed", "false");

    await user.click(star);

    const pressed = await screen.findByRole("button", {
      name: "Remove batt_pack_temp_01 from favorites",
    });
    expect(pressed).toHaveAttribute("aria-pressed", "true");
    expect(stored()).toEqual([
      expect.objectContaining({ type: "signal", id: "batt_pack_temp_01" }),
    ]);
  });

  it("stars the file from the file detail header", async () => {
    const user = userEvent.setup();
    render(<FileDetailScreen fileId={FILE_ID} />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: `Add ${FILENAME} to favorites` }));

    expect(
      await screen.findByRole("button", { name: `Remove ${FILENAME} from favorites` }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(stored()).toEqual([
      expect.objectContaining({ type: "file", id: FILE_ID, label: FILENAME }),
    ]);
  });

  it("stars the work order from the work order detail header, and unstars it", async () => {
    const user = userEvent.setup();
    render(<WorkOrderDetailScreen woId={WO_ID} />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: `Add ${WO_ID} to favorites` }));

    const pressed = await screen.findByRole("button", { name: `Remove ${WO_ID} from favorites` });
    expect(pressed).toHaveAttribute("aria-pressed", "true");
    expect(stored()).toEqual([
      expect.objectContaining({ type: "work_order", id: WO_ID, label: WO_ID }),
    ]);

    await user.click(pressed);

    expect(await screen.findByRole("button", { name: `Add ${WO_ID} to favorites` })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(stored()).toHaveLength(0);
  });

  it("stars the test definition from the definition detail header, and unstars it", async () => {
    const user = userEvent.setup();
    render(<DefinitionDetailScreen tdId={TD_ID} />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: `Add ${TD_ID} to favorites` }));

    const pressed = await screen.findByRole("button", { name: `Remove ${TD_ID} from favorites` });
    expect(pressed).toHaveAttribute("aria-pressed", "true");
    expect(stored()).toEqual([
      expect.objectContaining({ type: "test_definition", id: TD_ID, label: TD_ID }),
    ]);

    await user.click(pressed);

    expect(await screen.findByRole("button", { name: `Add ${TD_ID} to favorites` })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(stored()).toHaveLength(0);
  });
});

describe("the Home favourites panel", () => {
  it("says the list is empty and holds no row before a person stars one", () => {
    render(<FavouritesPanel />);
    expect(screen.getByText("No favorites yet")).toBeInTheDocument();
    expect(screen.getByText(/stays on this device/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("links every starred row to its own detail screen", () => {
    toggleFavourite("run", RUN_ID, RUN_ID);
    toggleFavourite("file", FILE_ID, FILENAME);
    toggleFavourite("signal", "batt_pack_temp_01", "batt_pack_temp_01");

    render(<FavouritesPanel />);

    expect(screen.getByRole("link", { name: RUN_ID })).toHaveAttribute("href", `/runs/${RUN_ID}`);
    expect(screen.getByRole("link", { name: FILENAME })).toHaveAttribute(
      "href",
      `/files/${FILE_ID}`,
    );
    expect(screen.getByRole("link", { name: "batt_pack_temp_01" })).toHaveAttribute(
      "href",
      "/signals/batt_pack_temp_01",
    );
    expect(screen.getByText("3 starred")).toBeInTheDocument();
  });

  it("removes one row and keeps the rest", async () => {
    const user = userEvent.setup();
    toggleFavourite("run", RUN_ID, RUN_ID);
    toggleFavourite("file", FILE_ID, FILENAME);

    render(<FavouritesPanel />);
    const table = screen.getByRole("table", { name: "Favorites" });
    await user.click(
      within(table).getByRole("button", { name: `Remove ${FILENAME} from favorites` }),
    );

    expect(screen.queryByText(FILENAME)).not.toBeInTheDocument();
    expect(screen.getByText(RUN_ID)).toBeInTheDocument();
    expect(stored()).toEqual([expect.objectContaining({ type: "run", id: RUN_ID })]);
  });
});

describe("a second tab changes the favourites", () => {
  /**
   * The browser fires `storage` in every other document of the origin, never
   * in the document that wrote. jsdom fires none, so the test fires it.
   */
  function otherTabWrites(favourites: Favourite[]): void {
    window.localStorage.setItem(
      FAVOURITES_KEY,
      JSON.stringify({ v: FAVOURITES_VERSION, favourites }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: FAVOURITES_KEY }));
  }

  it("presses the star and adds the Home row", async () => {
    // The panel row carries the same remove name as the star, so the header
    // landmark tells the two controls apart.
    render(
      <>
        <header>
          <FavouriteStar type="run" id={RUN_ID} label={RUN_ID} />
        </header>
        <FavouritesPanel />
      </>,
    );
    const star = () => within(screen.getByRole("banner")).getByRole("button");
    expect(star()).toHaveAccessibleName(`Add ${RUN_ID} to favorites`);
    expect(star()).toHaveAttribute("aria-pressed", "false");

    await act(async () => {
      otherTabWrites([{ type: "run", id: RUN_ID, label: RUN_ID, at: 1_760_000_000_000 }]);
    });

    expect(star()).toHaveAccessibleName(`Remove ${RUN_ID} from favorites`);
    expect(star()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("link", { name: RUN_ID })).toHaveAttribute("href", `/runs/${RUN_ID}`);
    expect(screen.getByText("1 starred")).toBeInTheDocument();
  });
});
