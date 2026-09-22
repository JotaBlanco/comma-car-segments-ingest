/**
 * FR-DM-043 — the server-side export on the three list screens.
 *
 * The browser export writes the file from the pages its own loop walked, and
 * it stops at 10,000 rows. The menu item under "From the server" asks the API
 * for the file instead, so the answer carries every matching row and a
 * program can fetch the same URL.
 *
 * The test drives the real path — the screen, the URL state, the filters
 * object, the export button and `fetch` — and reads the URL the button asked
 * for and the bytes it saved. Only `fetch`, the router, `sonner` and the
 * object URL are stubs.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { FileEntity, SignalCatalogEntry, TestRunListItem } from "@/types";
import { resetExportColumnsCache, setExportColumns } from "@/lib/export-columns";

const { nav, toastCalls } = vi.hoisted(() => ({
  nav: { search: "" },
  toastCalls: [] as Array<{ kind: string; message: string; description: string }>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// The screens mount no `<Toaster />`, so the toast never reaches the DOM.
// Record what the button said instead — the words are the promise it makes.
vi.mock("sonner", () => {
  const record =
    (kind: string) =>
    (message: string, opts?: { description?: string }) => {
      toastCalls.push({ kind, message, description: opts?.description ?? "" });
    };
  return {
    toast: {
      success: record("success"),
      warning: record("warning"),
      error: record("error"),
      info: record("info"),
    },
  };
});

import { FilesScreen } from "@/components/screens/files/files-screen";
import { RunsScreen } from "@/components/screens/runs/runs-screen";
import { SignalsScreen } from "@/components/screens/signals/signals-screen";

/** The label of the server item. The browser items read "CSV" and "Excel". */
const SERVER_ITEM = "CSV — every matching row";

/** Every blob the button handed to the browser, in order. */
let saved: Array<{ filename: string; blob: Blob }> = [];
let pending: Blob | null = null;
/** Every URL `fetch` was asked for, in order. */
let asked: string[] = [];
/** What the export route answers. A test replaces it to drive a refusal. */
let exportAnswer: () => Response;

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

/** What the API answers: a CSV body, named by Content-Disposition. */
function csv(body: string, filename: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "x-export-rows": "1",
      "x-journal-id": "j-export-1",
    },
  });
}

const RUN_CSV = "Run,Status\r\nTAS-88214,complete\r\n";

const RUN: TestRunListItem = {
  run_id: "TAS-88214",
  description: "HV soak",
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
  filename: "bat_cyc.mf4",
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
      asked.push(input);
      const url = new URL(input, "http://localhost:3000");
      switch (url.pathname) {
        case "/api/proxy/test-runs/export":
        case "/api/proxy/files/export":
        case "/api/proxy/signals/export":
          return exportAnswer();
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
  asked = [];
  pending = null;
  toastCalls.length = 0;
  exportAnswer = () => csv(RUN_CSV, "test-runs-2026-08-25.csv");
  window.localStorage.clear();
  resetExportColumnsCache();
  stubFetch();
  URL.createObjectURL = vi.fn((blob: Blob) => {
    pending = blob;
    return "blob:mock-url";
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
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
  window.localStorage.clear();
  resetExportColumnsCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Open the export menu of a screen and click the server item. */
async function serverExportFrom(trigger: RegExp): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: trigger }));
  await screen.findByRole("menu");
  await user.click(await screen.findByRole("menuitem", { name: SERVER_ITEM }));
}

/** The export URL the button asked for, parsed. */
function exportUrl(): URL {
  const hit = asked.find((url) => url.includes("/export"));
  expect(hit).toBeDefined();
  return new URL(hit as string, "http://localhost:3000");
}

describe("the list screens offer the server-side export", () => {
  it("asks the runs export route and saves the file the server named", async () => {
    render(<RunsScreen />, { wrapper: Wrapper });

    await serverExportFrom(/^Export all 1 test runs$/);
    await waitFor(() => expect(saved).toHaveLength(1));

    expect(exportUrl().pathname).toBe("/api/proxy/test-runs/export");
    // The server names the file, so the browser never invents a second name.
    expect(saved[0].filename).toBe("test-runs-2026-08-25.csv");
    expect(await saved[0].blob.text()).toBe(RUN_CSV);
    expect(toastCalls[0].kind).toBe("success");
    expect(toastCalls[0].description).toContain("written by the server");
  });

  it("sends the screen's filters and never a page", async () => {
    // The state the URL carries is the state the export must carry.
    nav.search = "status=complete&rig=RIG-01&q=soak";
    render(<RunsScreen />, { wrapper: Wrapper });

    await serverExportFrom(/^Export all 1 test runs$/);
    await waitFor(() => expect(saved).toHaveLength(1));

    const params = exportUrl().searchParams;
    expect(params.getAll("status")).toEqual(["complete"]);
    expect(params.getAll("rig")).toEqual(["RIG-01"]);
    expect(params.get("q")).toBe("soak");
    // The export carries the whole set, so a page would only narrow it.
    expect(params.has("page")).toBe(false);
    expect(params.has("page_size")).toBe(false);
  });

  it("sends the chosen columns, and nothing when the person chose none", async () => {
    setExportColumns("runs", ["Run", "Status"]);
    render(<RunsScreen />, { wrapper: Wrapper });

    await serverExportFrom(/^Export all 1 test runs$/);
    await waitFor(() => expect(saved).toHaveLength(1));

    expect(exportUrl().searchParams.getAll("columns")).toEqual(["Run", "Status"]);
  });

  it("asks for no column when the person chose none", async () => {
    render(<RunsScreen />, { wrapper: Wrapper });

    await serverExportFrom(/^Export all 1 test runs$/);
    await waitFor(() => expect(saved).toHaveLength(1));

    // No `columns` at all. The route reads that as every column.
    expect(exportUrl().searchParams.has("columns")).toBe(false);
  });

  it("states the server's own reason when the route refuses", async () => {
    exportAnswer = () =>
      new Response(
        JSON.stringify({
          detail: "The export matches 60000 rows and the cap is 50000. Narrow the filters and export again.",
          code: "export_too_large",
          errors: [],
        }),
        { status: 413, headers: { "content-type": "application/json" } },
      );
    render(<RunsScreen />, { wrapper: Wrapper });

    await serverExportFrom(/^Export all 1 test runs$/);
    await waitFor(() => expect(toastCalls).toHaveLength(1));

    expect(saved).toHaveLength(0);
    expect(toastCalls[0].kind).toBe("error");
    // The cap is the whole point of the message. A generic sentence hides it.
    expect(toastCalls[0].description).toContain("the cap is 50000");
  });

  it("keeps the browser export working beside it", async () => {
    render(<RunsScreen />, { wrapper: Wrapper });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /^Export all 1 test runs$/ }));
    await user.click(await screen.findByRole("menuitem", { name: "CSV" }));
    await waitFor(() => expect(saved).toHaveLength(1));

    // The browser wrote it, so no export route was called.
    expect(asked.some((url) => url.includes("/export"))).toBe(false);
    expect(await saved[0].blob.text()).toContain("TAS-88214");
  });

  it("asks the files export route", async () => {
    exportAnswer = () => csv("File id\r\nf-1\r\n", "files-2026-08-25.csv");
    render(<FilesScreen />, { wrapper: Wrapper });

    await serverExportFrom(/^Export all 1 files$/);
    await waitFor(() => expect(saved).toHaveLength(1));

    expect(exportUrl().pathname).toBe("/api/proxy/files/export");
    expect(saved[0].filename).toBe("files-2026-08-25.csv");
  });

  it("asks the signals export route", async () => {
    exportAnswer = () => csv("Signal\r\nbatt_pack_temp_01\r\n", "signals-2026-08-25.csv");
    render(<SignalsScreen />, { wrapper: Wrapper });

    await serverExportFrom(/^Export all 1 signals$/);
    await waitFor(() => expect(saved).toHaveLength(1));

    expect(exportUrl().pathname).toBe("/api/proxy/signals/export");
    expect(saved[0].filename).toBe("signals-2026-08-25.csv");
  });
});
