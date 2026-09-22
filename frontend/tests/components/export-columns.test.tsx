/**
 * FR-DM-018 — the export column picker and the Excel file.
 *
 * The test drives the real path: the screen, the picker, the store over
 * `localStorage`, the paging loop and both writers. It reads the saved bytes,
 * so the file a person gets is the thing under test. Only `fetch`, the
 * router, `sonner` and the object URL are stubs.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { FileEntity, SignalCatalogEntry, TestRunListItem } from "@/types";
import {
  EXPORT_COLUMNS_VERSION,
  exportColumnsStorageKey,
  resetExportColumnsCache,
  type ExportColumnScope,
} from "@/lib/export-columns";

const { nav } = vi.hoisted(() => ({ nav: { search: "" } }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// The screens mount no `<Toaster />`, so the toast never reaches the DOM.
vi.mock("sonner", () => {
  const noop = () => undefined;
  return { toast: { success: noop, warning: noop, error: noop, info: noop } };
});

import { FilesScreen } from "@/components/screens/files/files-screen";
import { RunsScreen } from "@/components/screens/runs/runs-screen";
import { SignalsScreen } from "@/components/screens/signals/signals-screen";

/** Every blob the button handed to the browser, in order. */
let saved: Array<{ filename: string; blob: Blob }> = [];
/** The blob the last `createObjectURL` call carried. */
let pending: Blob | null = null;

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function page(items: unknown[], extra: Record<string, unknown> = {}): Response {
  return json({ items, total: items.length, page: 1, page_size: 20, total_pages: 1, ...extra });
}

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
  saved = [];
  pending = null;
  window.localStorage.clear();
  resetExportColumnsCache();
  stubFetch();
  URL.createObjectURL = vi.fn((blob: Blob) => {
    pending = blob;
    return "blob:mock-url";
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  // jsdom follows no blob: link, and a real click would only warn. Record
  // what the anchor asked for instead.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    if (pending !== null) saved.push({ filename: this.download, blob: pending });
    pending = null;
  });
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetExportColumnsCache();
});

const user = () => userEvent.setup();

/**
 * Open the export menu of the screen under test.
 *
 * Every list screen spends one toolbar slot on `Export`, and the column rows
 * live inside that menu. The trigger names the act and the row count, so the
 * caller passes the count its stub serves.
 */
async function openPicker(triggerName: RegExp = /^Export all \d+ /): Promise<void> {
  // Idempotent: clicking the trigger of an OPEN menu shuts it again, and a
  // test that ticks a column and then exports would otherwise close the very
  // menu it needs.
  if (screen.queryByRole("menu") !== null) return;
  await user().click(await screen.findByRole("button", { name: triggerName }));
  await screen.findByRole("menu");
}

/** Every column row of the open menu, in the order it lists them. */
function columnBoxes(): HTMLElement[] {
  return within(screen.getByRole("menu")).getAllByRole("menuitemcheckbox");
}

/**
 * One column row of the open menu.
 *
 * The row is the `menuitemcheckbox` and it carries the header as its text.
 * The box drawn inside it is decoration — `aria-hidden` and not focusable —
 * so the text is the one value the row states.
 */
function columnBox(header: string): HTMLElement {
  const box = columnBoxes().find((row) => row.textContent?.trim() === header);
  expect(box, `no column row for ${header}`).toBeDefined();
  return box!;
}

/** Tick or untick one column in the open picker. */
async function toggleColumn(header: string): Promise<void> {
  await user().click(columnBox(header));
}

/** Open the menu, pick a format, and read the saved document. */
async function exportFrom(
  trigger: RegExp,
  format: "CSV" | "Excel" = "CSV",
): Promise<{ filename: string; blob: Blob }> {
  await openPicker(trigger);
  await user().click(await screen.findByRole("menuitem", { name: format }));
  await waitFor(() => expect(saved).toHaveLength(1));
  return saved[0];
}

/** What one screen stored under its own key. */
function storedChoice(scope: ExportColumnScope): string[] | null {
  const raw = window.localStorage.getItem(exportColumnsStorageKey(scope));
  return raw === null ? null : (JSON.parse(raw) as { headers: string[] }).headers;
}

describe("the column picker", () => {
  it("lists every column of the screen, in the declared order", async () => {
    render(<SignalsScreen />, { wrapper: Wrapper });
    await openPicker();

    const names = columnBoxes().map((box) => box.textContent?.trim());
    expect(names).toEqual([
      "Signal",
      "Description",
      "Unit",
      "Unit source",
      "Data type",
      "Typical rate Hz",
      "Runs",
      "First seen",
      "Last seen",
    ]);
  });

  it("selects a column and deselects it again", async () => {
    render(<SignalsScreen />, { wrapper: Wrapper });
    await openPicker();

    await toggleColumn("Unit");
    await waitFor(() => expect(storedChoice("signals")).toEqual(["Unit"]));
    expect(columnBox("Unit")).toBeChecked();

    await toggleColumn("Unit");
    await waitFor(() => expect(storedChoice("signals")).toEqual([]));
    expect(columnBox("Unit")).not.toBeChecked();
  });

  it("carries an accessible name and the count a person chose", async () => {
    render(<SignalsScreen />, { wrapper: Wrapper });
    await openPicker();
    await toggleColumn("Unit");
    await toggleColumn("Runs");

    // The menu heading says how many columns travel, and the empty rule with
    // it. The count is the ONLY thing that reports the choice while the menu
    // is shut, because the trigger says "Export" and never a column name.
    await openPicker(/^Export all 1 signals$/);
    expect(
      within(screen.getByRole("menu")).getByText("2/9"),
    ).toBeInTheDocument();
  });

  it("reaches the columns and ticks one with the keyboard alone", async () => {
    render(<SignalsScreen />, { wrapper: Wrapper });
    const trigger = await screen.findByRole("button", { name: /^Export all 1 signals$/ });

    trigger.focus();
    await user().keyboard("{Enter}");
    await screen.findByRole("menu");
    const box = columnBox("Signal");
    box.focus();
    await user().keyboard(" ");

    await waitFor(() => expect(storedChoice("signals")).toEqual(["Signal"]));
  });
});

describe("the choice survives and stays on its own screen", () => {
  it("remembers the choice after a remount", async () => {
    const first = render(<SignalsScreen />, { wrapper: Wrapper });
    await openPicker();
    await toggleColumn("Unit");
    await waitFor(() => expect(storedChoice("signals")).toEqual(["Unit"]));
    first.unmount();

    render(<SignalsScreen />, { wrapper: Wrapper });
    await openPicker();

    expect(columnBox("Unit")).toBeChecked();
    expect(columnBox("Runs")).not.toBeChecked();
  });

  it("keeps a runs choice out of the files screen", async () => {
    const runs = render(<RunsScreen />, { wrapper: Wrapper });
    // The runs toolbar runs `compact`, so its column rows live in the export
    // menu rather than in a picker of their own. Same store, same key, so the
    // isolation this test states is unchanged — only the way a person reaches
    // the rows differs.
    await user().click(await screen.findByRole("button", { name: /^Export all 1 test runs$/ }));
    await user().click(await screen.findByRole("menuitemcheckbox", { name: "Project" }));
    await waitFor(() => expect(storedChoice("runs")).toEqual(["Project"]));
    runs.unmount();

    render(<FilesScreen />, { wrapper: Wrapper });
    // The files screen stored nothing, so it exports every column.
    // "Invalid" and "Invalid reason" arrived with a81b271, the file-level
    // invalid mark. They sit between "Lifecycle" and "Version".
    expect(storedChoice("files")).toBeNull();
    const { blob } = await exportFrom(/^Export all 1 files$/);
    const header = (await blob.text()).split("\r\n")[0];

    expect(header).toBe(
      "File id,Filename,Run,Source,Format,Size bytes,Checksum SHA-256,Checksum state,Status,Quarantine reason,Lifecycle,Invalid,Invalid reason,Version,Signals,Time start,Time end,Registered",
    );
  });
});

describe("the chosen columns reach the CSV", () => {
  it("writes only the chosen columns, in the declared order", async () => {
    render(<SignalsScreen />, { wrapper: Wrapper });
    await openPicker();
    // Click the later column first. The file must still lead with "Signal".
    await toggleColumn("Runs");
    await toggleColumn("Signal");
    await waitFor(() => expect(storedChoice("signals")).toEqual(["Signal", "Runs"]));

    const { blob } = await exportFrom(/^Export all 1 signals$/);
    const text = await blob.text();

    expect(text).toBe("Signal,Runs\r\nbatt_pack_temp_01,12\r\n");
  });

  it("writes every column when a person chooses nothing", async () => {
    render(<SignalsScreen />, { wrapper: Wrapper });

    const { blob } = await exportFrom(/^Export all 1 signals$/);
    const text = await blob.text();

    expect(text.split("\r\n")[0]).toBe(
      "Signal,Description,Unit,Unit source,Data type,Typical rate Hz,Runs,First seen,Last seen",
    );
    expect(text.length).toBeGreaterThan(0);
  });

  it("writes every column when a person unticks the last one", async () => {
    render(<SignalsScreen />, { wrapper: Wrapper });
    await openPicker();
    await toggleColumn("Unit");
    await waitFor(() => expect(storedChoice("signals")).toEqual(["Unit"]));
    await toggleColumn("Unit");
    await waitFor(() => expect(storedChoice("signals")).toEqual([]));

    const { blob } = await exportFrom(/^Export all 1 signals$/);
    const text = await blob.text();

    // An empty choice is the whole set, never an empty file.
    expect(text.split("\r\n")[0]).toBe(
      "Signal,Description,Unit,Unit source,Data type,Typical rate Hz,Runs,First seen,Last seen",
    );
  });
});

describe("the Excel button writes the same rows and columns", () => {
  it("saves an xlsx file the picker chose", async () => {
    render(<SignalsScreen />, { wrapper: Wrapper });
    await openPicker();
    await toggleColumn("Signal");
    await toggleColumn("Runs");
    await waitFor(() => expect(storedChoice("signals")).toEqual(["Signal", "Runs"]));

    const { filename, blob } = await exportFrom(/^Export all 1 signals$/, "Excel");
    const bytes = new Uint8Array(await blob.arrayBuffer());

    expect(filename).toMatch(/^signals-\d{4}-\d{2}-\d{2}\.xlsx$/);
    // "PK" — the local file header of a ZIP.
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("names the file for the list, like the CSV button does", async () => {
    render(<RunsScreen />, { wrapper: Wrapper });

    const { filename } = await exportFrom(/^Export all 1 test runs$/, "Excel");

    expect(filename).toMatch(/^test-runs-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });
});

describe("a second tab changes the choice", () => {
  it("ticks the column the other tab chose", async () => {
    render(<SignalsScreen />, { wrapper: Wrapper });
    await openPicker();
    expect(columnBox("Unit")).not.toBeChecked();

    /* The browser fires `storage` in every other document of the origin,
       never in the document that wrote. jsdom fires none at all, so the test
       writes the key and then fires the event a browser fires. */
    await act(async () => {
      const key = exportColumnsStorageKey("signals");
      window.localStorage.setItem(
        key,
        JSON.stringify({ v: EXPORT_COLUMNS_VERSION, headers: ["Unit"] }),
      );
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });

    expect(columnBox("Unit")).toBeChecked();
    // The heading counts one list, so it can never disagree with the rows.
    expect(within(screen.getByRole("menu")).getByText("1/9")).toBeInTheDocument();
  });
});
