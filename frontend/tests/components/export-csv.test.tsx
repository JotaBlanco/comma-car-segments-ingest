/**
 * FR-DM-018 — Export CSV on the three list screens.
 *
 * The export walks the whole filtered list page by page, then writes one
 * document in the browser. The test drives the real path — the screen, the
 * URL state, the hook, the API client and `fetch` — and reads the saved
 * bytes, so the file a person gets is the thing under test. Only `fetch`,
 * the router, `sonner` and the object URL are stubs.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { FileEntity, SignalCatalogEntry, TestRunListItem } from "@/types";

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
  return json({
    items,
    total: items.length,
    page: 1,
    page_size: 20,
    total_pages: 1,
    ...extra,
  });
}

const RUN: TestRunListItem = {
  run_id: "TAS-88214",
  description: 'HV soak, "phase 2", cold',
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
  toastCalls.length = 0;
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
});

/**
 * Click the export button of a screen and read the saved document.
 *
 * The button fetches before it writes, so the helper waits for the blob.
 */
async function exportFrom(
  trigger: RegExp,
  format: "CSV" | "Excel" = "CSV",
): Promise<{ filename: string; text: string }> {
  const user = userEvent.setup();
  // Clicking the trigger of an OPEN menu shuts it again, so only open when shut.
  if (screen.queryByRole("menu") === null) {
    await user.click(await screen.findByRole("button", { name: trigger }));
    await screen.findByRole("menu");
  }
  await user.click(await screen.findByRole("menuitem", { name: format }));
  await waitFor(() => expect(saved).toHaveLength(1));
  return { filename: saved[0].filename, text: await saved[0].blob.text() };
}

describe("the three list screens export the whole filtered list", () => {
  it("exports every test run the filters hold", async () => {
    render(<RunsScreen />, { wrapper: Wrapper });

    const { filename, text } = await exportFrom(/^Export all 1 test runs$/);

    expect(filename).toMatch(/^test-runs-\d{4}-\d{2}-\d{2}\.csv$/);
    const [header, first] = text.split("\r\n");
    expect(header).toBe(
      "Run,Description,Definition,Work order,Project,Rig,Test cell,Files,Signals,Arrived,Status,Invalid,Invalid reason",
    );
    // A comma and a quote inside a field must not break the row.
    expect(first).toContain('"HV soak, ""phase 2"", cold"');
    expect(first).toContain("TAS-88214");
    // The raw timestamp travels, never the short date the screen prints.
    expect(first).toContain("2026-08-19T07:15:00Z");
  });

  it("exports the files with the whole checksum and the raw size", async () => {
    render(<FilesScreen />, { wrapper: Wrapper });

    const { filename, text } = await exportFrom(/^Export all 1 files$/);

    expect(filename).toMatch(/^files-\d{4}-\d{2}-\d{2}\.csv$/);
    const [header, first] = text.split("\r\n");
    expect(header).toContain("Checksum SHA-256");
    expect(first).toContain("a".repeat(64));
    expect(first).toContain("4096");
    // The screen prints a shortened digest and a rounded size. Neither travels.
    expect(first).not.toContain("kB");
    expect(first).not.toContain("…");
  });

  it("exports every signal the filters hold", async () => {
    render(<SignalsScreen />, { wrapper: Wrapper });

    const { filename, text } = await exportFrom(/^Export all 1 signals$/);

    expect(filename).toMatch(/^signals-\d{4}-\d{2}-\d{2}\.csv$/);
    const [header, first] = text.split("\r\n");
    expect(header).toBe(
      "Signal,Description,Unit,Unit source,Data type,Typical rate Hz,Runs,First seen,Last seen",
    );
    expect(first).toBe(
      "batt_pack_temp_01,,degC,manual,float32,10,12,2026-05-02T08:00:00Z,2026-08-19T09:00:00Z",
    );
  });

  it("carries the filter a person set into every page it asks for", async () => {
    nav.search = "q=batt";
    render(<SignalsScreen />, { wrapper: Wrapper });

    const { text } = await exportFrom(/^Export all 1 signals$/);

    // The screen asked the API with the search, so the export holds the
    // answer to that search and nothing else.
    const asked = vi.mocked(fetch).mock.calls.map((call) => String(call[0]));
    expect(asked.some((url) => url.includes("/signals?") && url.includes("q=batt"))).toBe(true);
    expect(text.split("\r\n").filter((line) => line.length > 0)).toHaveLength(2);
  });
});

/**
 * The export walks the list route. These cases replace the shared stub with
 * one that answers per page, so the loop itself is under test.
 *
 * The screen's own list call asks for `page_size=20`; the export asks for
 * `page_size=500`. The stub tells them apart on that value.
 */
function stubPagedSignals(totalPages: number, perPage: number, total: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost:3000");
      if (url.pathname === "/api/proxy/signals/facets") {
        return json({ units: ["degC"], rates: [10], rigs: ["RIG-01"] });
      }
      if (url.pathname !== "/api/proxy/signals") throw new TypeError(`no stub for ${input}`);

      const pageSize = Number(url.searchParams.get("page_size"));
      const asked = Number(url.searchParams.get("page") ?? "1");
      if (pageSize !== 500) {
        // The screen's own page. It only feeds the table and the total.
        return json({
          items: [SIGNAL],
          total,
          page: 1,
          page_size: 20,
          total_pages: 1,
          view_counts: { all: total, missing_unit: 0, stale: 0 },
        });
      }
      const items = Array.from({ length: perPage }, (_, index) => ({
        ...SIGNAL,
        name: `sig_p${asked}_r${index + 1}`,
      }));
      return json({ items, total, page: asked, page_size: 500, total_pages: totalPages });
    }),
  );
}

/** Every page the export asked the list route for, in order. */
function exportPagesAsked(): number[] {
  return vi
    .mocked(fetch)
    .mock.calls.map((call) => new URL(String(call[0]), "http://localhost:3000"))
    .filter(
      (url) =>
        url.pathname === "/api/proxy/signals" && url.searchParams.get("page_size") === "500",
    )
    .map((url) => Number(url.searchParams.get("page") ?? "1"));
}

describe("the export walks every page of the filtered list", () => {
  it("joins three pages into one document", async () => {
    stubPagedSignals(3, 2, 6);
    render(<SignalsScreen />, { wrapper: Wrapper });

    const { text } = await exportFrom(/^Export all 6 signals$/);

    expect(exportPagesAsked()).toEqual([1, 2, 3]);
    const lines = text.split("\r\n").filter((line) => line.length > 0);
    // One header and the six rows of the three pages.
    expect(lines).toHaveLength(7);
    expect(lines[1]).toContain("sig_p1_r1");
    expect(lines[6]).toContain("sig_p3_r2");
    expect(toastCalls).toEqual([
      expect.objectContaining({ kind: "success", message: "Exported 6 signals" }),
    ]);
  });

  it("carries the filter a person set into every page", async () => {
    nav.search = "q=batt";
    stubPagedSignals(2, 1, 2);
    render(<SignalsScreen />, { wrapper: Wrapper });

    await exportFrom(/^Export all 2 signals$/);

    const asked = vi
      .mocked(fetch)
      .mock.calls.map((call) => new URL(String(call[0]), "http://localhost:3000"))
      .filter((url) => url.searchParams.get("page_size") === "500");
    expect(asked).toHaveLength(2);
    for (const url of asked) expect(url.searchParams.get("q")).toBe("batt");
  });

  it("stops at the cap and warns that the file is not complete", async () => {
    // 999 pages is far past the 20-page cap the button holds.
    stubPagedSignals(999, 1, 100_000);
    render(<SignalsScreen />, { wrapper: Wrapper });

    const { text } = await exportFrom(/^Export all 100000 signals$/);

    // The loop stops at 20 pages, so it never walks the 999.
    expect(exportPagesAsked()).toHaveLength(20);
    expect(text.split("\r\n").filter((line) => line.length > 0)).toHaveLength(21);
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].kind).toBe("warning");
    expect(toastCalls[0].message).toBe("Exported the first 20 of 100000 signals");
    expect(toastCalls[0].description).toContain("not complete");
  });
});
