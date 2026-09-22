/**
 * FR-DM-017 (saved half) and UC-004 clause 5 — saved searches on the three
 * list screens.
 *
 * A saved search is a name plus the canonical query string every list already
 * keeps in the URL, so applying one only sets the URL. The test drives the real
 * path: the control, the store, `localStorage` and the router. Only `fetch` and
 * the router are stubs.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type {
  FileEntity,
  PlanningSyncStatus,
  SignalCatalogEntry,
  TestRunListItem,
  WorkOrderListItem,
} from "@/types";

const { nav, push } = vi.hoisted(() => ({
  nav: { search: "" },
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { SavedSearchButton } from "@/components/shared/saved-search-button";
import { FilesScreen } from "@/components/screens/files/files-screen";
import { RunsScreen } from "@/components/screens/runs/runs-screen";
import { SignalsScreen } from "@/components/screens/signals/signals-screen";
import { WorkOrdersScreen } from "@/components/screens/work-orders/work-orders-screen";
import {
  SAVED_SEARCH_VERSION,
  resetSavedSearchCache,
  saveSearch,
  savedSearchStorageKey,
} from "@/lib/saved-searches";

const RUN: TestRunListItem = {
  run_id: "TAS-88214",
  description: "HV soak, cold",
  definition_id: "TD-4471",
  work_order_id: "WO-8821",
  project: "EX30",
  rig_id: "RIG-01",
  test_cell: "TC-2",
  file_count: 2,
  signal_count: 186,
  first_data_at: "2026-08-19T07:15:00Z",
  status: "complete",
  invalid: { flagged: false, reason: null, actor: null, at: null },
};

const FILE: FileEntity = {
  file_id: "f-1",
  filename: "bat_cyc_20260814_0941.mf4",
  run_id: "TAS-88214",
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
};

const SIGNAL: SignalCatalogEntry = {
  name: "batt_pack_temp_01",
  description: null,
  unit: "degC",
  unit_source: "manual",
  dtype: "float32",
  typical_rate_hz: 10,
  run_count: 12,
  first_seen: "2026-05-02T08:00:00Z",
  last_seen: "2026-08-19T09:00:00Z",
};

const WORK_ORDER: WorkOrderListItem = {
  wo_id: "WO-8821",
  title: "HV pack soak campaign",
  project: "EX30",
  status: "active",
  definition_count: 3,
  run_count: 12,
  synced_at: "2026-08-19T06:00:00Z",
};

const SYNC_STATUS: PlanningSyncStatus = {
  online: true,
  last_sync_at: "2026-08-19T06:00:00Z",
  last_sync_result: null,
  work_orders_mirrored: 1,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function page(items: unknown[], extra: Record<string, unknown> = {}): Response {
  return json({ items, total: items.length, page: 1, page_size: 20, total_pages: 1, ...extra });
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost:3000");
      switch (url.pathname) {
        case "/api/proxy/test-runs":
          return page([RUN], { view_counts: { all: 1, attention: 0, invalid: 0 } });
        case "/api/proxy/test-runs/facets":
          return json({ rigs: ["RIG-01"], projects: ["EX30"] });
        case "/api/proxy/files":
          return page([FILE], {
            view_counts: { all: 1, registered: 1, quarantined: 0, archived: 0, deleted: 0 },
          });
        case "/api/proxy/signals":
          return page([SIGNAL], { view_counts: { all: 1, missing_unit: 0, stale: 0 } });
        case "/api/proxy/signals/facets":
          return json({ units: ["degC"], rates: [10], rigs: ["RIG-01"] });
        case "/api/proxy/work-orders":
          return page([WORK_ORDER], { view_counts: { all: 1, active: 1, closed: 0 } });
        case "/api/proxy/work-orders/facets":
          return json({ projects: ["EX30"] });
        case "/api/proxy/planning-sync/status":
          return json(SYNC_STATUS);
        default:
          throw new TypeError(`no stub for ${input}`);
      }
    }),
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  nav.search = "";
  push.mockClear();
  localStorage.clear();
  resetSavedSearchCache();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Reveal the toolbar's Filters panel, where the saved-search control lives.
 *
 * A saved search IS a saved set of filters, so it sits with them rather than
 * loose in the always-on row. Idempotent: the button toggles.
 */
async function revealControl(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  // Absent when the test mounts `SavedSearchButton` on its own, with no
  // toolbar around it. Then there is nothing to reveal.
  const toggle = screen.queryByRole("button", { name: /^Filters/ });
  if (toggle === null || toggle.getAttribute("aria-expanded") === "true") return;
  await user.click(toggle);
}

/** Open the saved-search popover of the rendered screen. */
async function openPanel(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await revealControl(user);
  await user.click(await screen.findByRole("button", { name: /^Saved searches —/ }));
  return screen.getByRole("dialog", { name: "Saved searches" });
}

describe("the control mounts on the list screens", () => {
  it.each([
    ["runs", RunsScreen],
    ["files", FilesScreen],
    ["signals", SignalsScreen],
    ["work orders", WorkOrdersScreen],
  ] as const)("shows a saved-search button on the %s screen", async (_name, Screen) => {
    render(<Screen />, { wrapper: Wrapper });
    await revealControl(userEvent.setup());
    expect(await screen.findByRole("button", { name: /^Saved searches —/ })).toBeInTheDocument();
  });

  it("saves the filters on screen and never mixes two screens", async () => {
    const user = userEvent.setup();
    nav.search = "rig=RIG-01";
    const runs = render(<RunsScreen />, { wrapper: Wrapper });

    await openPanel(user);
    await user.type(screen.getByLabelText("Name this search"), "Cold soak on rig 1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByRole("button", {
        name: "Apply the saved search Cold soak on rig 1, saved on this device — the filters on screen now",
      }),
    ).toBeInTheDocument();
    // One key per screen — a runs row can never reach the files list.
    expect(localStorage.getItem(savedSearchStorageKey("runs"))).toContain("Cold soak on rig 1");
    expect(localStorage.getItem(savedSearchStorageKey("files"))).toBeNull();

    runs.unmount();
    nav.search = "";
    render(<FilesScreen />, { wrapper: Wrapper });

    await openPanel(user);
    expect(screen.getByText(/No saved search yet/)).toBeInTheDocument();
    expect(screen.queryByText("Cold soak on rig 1")).not.toBeInTheDocument();
  });

  it("saves the filters on screen from the work orders screen", async () => {
    const user = userEvent.setup();
    nav.search = "status=active&project=EX30";
    render(<WorkOrdersScreen />, { wrapper: Wrapper });

    await openPanel(user);
    await user.type(screen.getByLabelText("Name this search"), "Active EX30{Enter}");

    const stored = JSON.parse(localStorage.getItem(savedSearchStorageKey("work-orders")) as string);
    expect(stored.searches[0]).toMatchObject({
      name: "Active EX30",
      query: "?status=active&project=EX30",
    });
  });

  it("restores the work orders filters by setting the URL", async () => {
    const user = userEvent.setup();
    saveSearch("work-orders", "Closed work", "?status=closed");
    render(<WorkOrdersScreen />, { wrapper: Wrapper });

    await openPanel(user);
    await user.click(
      screen.getByRole("button", {
        name: "Apply the saved search Closed work, saved on this device",
      }),
    );

    expect(push).toHaveBeenCalledWith("/work-orders?status=closed", { scroll: false });
  });
});

describe("SavedSearchButton", () => {
  const mount = () =>
    render(<SavedSearchButton scope="runs" pathname="/runs" query="?status=complete" />, {
      wrapper: Wrapper,
    });

  it("says the list is empty and holds no row before a person saves one", async () => {
    const user = userEvent.setup();
    mount();
    const panel = await openPanel(user);
    expect(within(panel).getByText(/No saved search yet/)).toBeInTheDocument();
    expect(within(panel).queryByRole("list")).not.toBeInTheDocument();
  });

  it("refuses a blank name — the Save button stays disabled", async () => {
    const user = userEvent.setup();
    mount();
    await openPanel(user);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(screen.getByLabelText("Name this search"), "   ");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("saves the current query and counts the list on the trigger", async () => {
    const user = userEvent.setup();
    mount();
    await openPanel(user);
    await user.type(screen.getByLabelText("Name this search"), "Complete runs{Enter}");

    const stored = JSON.parse(localStorage.getItem(savedSearchStorageKey("runs")) as string);
    expect(stored.searches[0]).toMatchObject({ name: "Complete runs", query: "?status=complete" });
    expect(screen.getByRole("button", { name: "Saved searches — 1 saved" })).toBeInTheDocument();
  });

  it("restores the filters by setting the URL", async () => {
    const user = userEvent.setup();
    saveSearch("runs", "Rig 1 only", "?rig=RIG-01&sort=first_data_at");
    mount();

    await openPanel(user);
    await user.click(
      screen.getByRole("button", { name: "Apply the saved search Rig 1 only, saved on this device" }),
    );

    expect(push).toHaveBeenCalledWith("/runs?rig=RIG-01&sort=first_data_at", { scroll: false });
    // Applying closes the panel, so the screen is visible again.
    expect(screen.queryByRole("dialog", { name: "Saved searches" })).not.toBeInTheDocument();
  });

  it("marks the row that matches the filters on screen", async () => {
    const user = userEvent.setup();
    saveSearch("runs", "On screen", "?status=complete");
    saveSearch("runs", "Somewhere else", "?rig=RIG-09");
    mount();

    await openPanel(user);
    expect(
      screen.getByRole("button", {
        name: "Apply the saved search On screen, saved on this device — the filters on screen now",
      }),
    ).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("button", {
        name: "Apply the saved search Somewhere else, saved on this device",
      }),
    ).not.toHaveAttribute("aria-current");
  });

  it("renames a row and keeps its query", async () => {
    const user = userEvent.setup();
    saveSearch("runs", "Old name", "?rig=RIG-01");
    mount();

    await openPanel(user);
    await user.click(screen.getByRole("button", { name: "Rename the saved search Old name" }));
    const field = screen.getByLabelText("Rename the saved search Old name");
    await user.clear(field);
    await user.type(field, "New name{Enter}");

    expect(
      await screen.findByRole("button", { name: "Apply the saved search New name, saved on this device" }),
    ).toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem(savedSearchStorageKey("runs")) as string);
    expect(stored.searches[0]).toMatchObject({ name: "New name", query: "?rig=RIG-01" });
  });

  it("keeps the old name when a rename is cancelled", async () => {
    const user = userEvent.setup();
    saveSearch("runs", "Old name", "?rig=RIG-01");
    mount();

    await openPanel(user);
    await user.click(screen.getByRole("button", { name: "Rename the saved search Old name" }));
    await user.click(screen.getByRole("button", { name: "Keep the name Old name" }));

    expect(
      screen.getByRole("button", { name: "Apply the saved search Old name, saved on this device" }),
    ).toBeInTheDocument();
  });

  it("names what a delete removes before it removes it", async () => {
    const user = userEvent.setup();
    saveSearch("runs", "Keep me", "?q=1");
    saveSearch("runs", "Drop me", "?q=2");
    mount();

    await openPanel(user);
    await user.click(
      screen.getByRole("button", { name: "Delete the saved search Drop me from this device" }),
    );

    // The confirmation states the name and the cost.
    expect(screen.getByText(/Delete “Drop me”\?/)).toBeInTheDocument();
    expect(screen.getByText(/The rows on screen do not change/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete the saved search Drop me" }));

    expect(
      screen.queryByRole("button", { name: "Apply the saved search Drop me, saved on this device" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Apply the saved search Keep me, saved on this device" }),
    ).toBeInTheDocument();
  });

  it("keeps the row when the delete is cancelled", async () => {
    const user = userEvent.setup();
    saveSearch("runs", "Drop me", "?q=2");
    mount();

    await openPanel(user);
    await user.click(
      screen.getByRole("button", { name: "Delete the saved search Drop me from this device" }),
    );
    await user.click(screen.getByRole("button", { name: "Keep the saved search Drop me" }));

    expect(
      screen.getByRole("button", { name: "Apply the saved search Drop me, saved on this device" }),
    ).toBeInTheDocument();
  });

  it("says on the screen that a saved search stays on this device", async () => {
    const user = userEvent.setup();
    mount();
    const panel = await openPanel(user);
    expect(within(panel).getByText(/stays on this device/)).toBeInTheDocument();
  });
});

describe("hydration safety", () => {
  it("renders the empty list on the server even when storage holds rows", () => {
    saveSearch("runs", "Cold soak", "?rig=RIG-01");
    resetSavedSearchCache();

    /* `useSyncExternalStore` takes the server snapshot on the server AND on the
       first client pass, so the two agree and Next.js reports no mismatch. The
       same guard runs the sidebar collapse flag. */
    const markup = renderToStaticMarkup(
      <Wrapper>
        <SavedSearchButton scope="runs" pathname="/runs" query="" />
      </Wrapper>,
    );

    expect(markup).toContain("none saved yet");
    expect(markup).not.toContain("Cold soak");
  });

  it("shows the stored rows once the client takes over", async () => {
    const user = userEvent.setup();
    saveSearch("runs", "Cold soak", "?rig=RIG-01");
    resetSavedSearchCache();

    render(<SavedSearchButton scope="runs" pathname="/runs" query="" />, { wrapper: Wrapper });

    await openPanel(user);
    expect(
      screen.getByRole("button", { name: "Apply the saved search Cold soak, saved on this device" }),
    ).toBeInTheDocument();
  });
});

describe("a browser that refuses localStorage", () => {
  it("keeps the control working and says the list ends with the tab", async () => {
    const user = userEvent.setup();
    /* jsdom's `localStorage` is a proxy: an own-property assignment becomes a
       stored KEY, not a method override. Patch the prototype instead. */
    const proto = Object.getPrototypeOf(window.localStorage) as Storage;
    const setItem = proto.setItem;
    proto.setItem = () => {
      throw new DOMException("QuotaExceededError");
    };

    try {
      render(<SavedSearchButton scope="runs" pathname="/runs" query="?q=a" />, {
        wrapper: Wrapper,
      });
      await openPanel(user);
      await user.type(screen.getByLabelText("Name this search"), "Still works{Enter}");

      // The row is there, the screen did not break, and the panel says why.
      expect(await screen.findByRole("button", { name: /Apply the saved search Still works/ })).toBeInTheDocument();
      expect(screen.getByText(/This browser blocks storage/)).toBeInTheDocument();
      expect(localStorage.getItem(savedSearchStorageKey("runs"))).toBeNull();
    } finally {
      proto.setItem = setItem;
    }
  });
});

describe("a second tab saves a search", () => {
  it("lists the row the other tab wrote", async () => {
    const user = userEvent.setup();
    render(<SavedSearchButton scope="runs" pathname="/runs" query="?status=complete" />, {
      wrapper: Wrapper,
    });
    const panel = await openPanel(user);
    expect(within(panel).getByText(/No saved search yet/)).toBeInTheDocument();

    // The browser fires `storage` in every other document of the origin,
    // never in the document that wrote. jsdom fires none, so the test does.
    await act(async () => {
      const key = savedSearchStorageKey("runs");
      localStorage.setItem(
        key,
        JSON.stringify({
          v: SAVED_SEARCH_VERSION,
          searches: [{ id: "s-1", name: "From the other tab", query: "?rig=RIG-01", at: 1 }],
        }),
      );
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });

    expect(screen.getByText("From the other tab")).toBeInTheDocument();
  });
});
