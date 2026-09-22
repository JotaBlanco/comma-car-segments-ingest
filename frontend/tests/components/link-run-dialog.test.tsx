/**
 * The quarantine repair (TR-003): the Link-to-run dialog on the file detail.
 *
 * Each test drives the real path: the dialog, the hook, the API client and
 * `fetch`. Only `fetch` is a stub, so the request the browser sends is the
 * thing under test. The route is `PATCH /files/{file_id}`
 * (`api/api/routers/files.py`), and the run picker reads `GET /test-runs?q=`.
 *
 * The in-app mock BFF has no PATCH route for files yet, so these tests stub
 * at the fetch level on purpose and never touch the mock.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));

// Capture every toast the dialog fires. `sonner` renders nothing here.
vi.mock("sonner", () => {
  const record = (message: unknown): string => {
    toasts.push(typeof message === "string" ? message : String(message));
    return "toast-id";
  };
  const toast = Object.assign(record, {
    success: record,
    error: record,
    info: record,
    warning: record,
    message: record,
    loading: record,
    custom: record,
    dismiss: vi.fn(),
    promise: vi.fn(),
  });
  return { toast, Toaster: () => null };
});

import { LinkRunDialog } from "@/components/screens/files/link-run-dialog";
import { setActivePortalToken } from "@/lib/portal/token-store";
import { setPortalApiBase } from "@/lib/portal/client";
import type { FileDetail, TestRunListItem } from "@/types";

// Each test drives a real dialog through user-event, so it takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const FILE_ID = "f-9a41c2d0";
const FILENAME = "bat_cyc_orphan.mf4";
const PORTAL_API = "https://portal-api.dev.quix.io";
/** The name the Portal profile resolves to. Every write must carry it. */
const PORTAL_NAME = "Erika Lindqvist";

/** Every request the app sent, in order. */
let calls: Array<{ url: string; init: RequestInit }> = [];
/** The answer the PATCH route gives next. */
let patchAnswer: () => Response = () => json(fileDetail());

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiError(status: number, code: string): Response {
  return json({ detail: `refused: ${code}`, code, errors: [] }, status);
}

function fileDetail(overrides: Partial<FileDetail> = {}): FileDetail {
  return {
    file_id: FILE_ID,
    filename: FILENAME,
    run_id: "TAS-88214",
    source_system: "TAS",
    format: "MF4",
    size_bytes: 2048,
    checksum_sha256: "ab".repeat(32),
    checksum_state: "verified",
    status: "registered",
    quarantine_reason: null,
    signal_count: 0,
    time_start: null,
    time_end: null,
    registered_at: "2026-08-14T10:02:00Z",
    storage_ref: null,
    ingestion_job_id: null,
    field_sources: {},
    ingestion_timeline: [],
    signals: [],
    ...overrides,
  };
}

/** The registered runs the picker offers. */
const RUNS: Array<Partial<TestRunListItem> & { run_id: string }> = [
  {
    run_id: "TAS-88214",
    description: "E-machine efficiency map",
    rig_id: "RIG-04",
    status: "complete",
  },
  {
    run_id: "TAS-88215",
    description: "Inverter derating sweep",
    rig_id: "RIG-07",
    status: "complete",
  },
];

function runRow(row: Partial<TestRunListItem> & { run_id: string }): TestRunListItem {
  return {
    description: null,
    definition_id: null,
    work_order_id: null,
    project: null,
    rig_id: "RIG-04",
    test_cell: null,
    file_count: 0,
    signal_count: 0,
    first_data_at: "2026-08-14T10:02:00Z",
    status: "complete",
    invalid: { flagged: false, reason: null, actor: null, at: null },
    ...row,
  };
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost");
      calls.push({ url: input, init });
      if (url.pathname === "/profile") {
        return json({
          userId: "u-1",
          email: "e.lindqvist@volvo.com",
          firstName: "Erika",
          lastName: "Lindqvist",
        });
      }
      if (url.pathname === "/organisations/current") return new Response(null, { status: 204 });
      const method = (init.method ?? "GET").toUpperCase();
      if (url.pathname === `/api/proxy/files/${FILE_ID}` && method === "PATCH") {
        return patchAnswer();
      }
      if (url.pathname === "/api/proxy/test-runs") {
        const q = url.searchParams.get("q")?.toLowerCase() ?? "";
        const items = RUNS.map(runRow).filter(
          (run) =>
            q.length === 0 ||
            run.run_id.toLowerCase().includes(q) ||
            (run.description ?? "").toLowerCase().includes(q),
        );
        return json({ items, total: items.length, page: 1, page_size: 200, total_pages: 1 });
      }
      throw new TypeError(`no stub for ${method} ${input}`);
    }),
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The one request the app sent to the PATCH route. */
function patchCall(): { url: string; init: RequestInit } {
  const call = calls.find(
    (entry) => (entry.init.method ?? "GET").toUpperCase() === "PATCH",
  );
  if (call === undefined) throw new Error("the app sent no PATCH");
  return call;
}

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

/** Wait until the dialog shows the resolved Portal name, so no write races it. */
async function awaitIdentity(): Promise<void> {
  await screen.findByText(PORTAL_NAME);
}

beforeEach(() => {
  setPortalApiBase(PORTAL_API);
  window.localStorage.setItem("tm.portal.token", "portal-pat");
  setActivePortalToken(null);
  calls = [];
  toasts.length = 0;
  patchAnswer = () => json(fileDetail());
  stubFetch();
});

afterEach(() => {
  setPortalApiBase(null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderDialog() {
  return render(
    <LinkRunDialog fileId={FILE_ID} filename={FILENAME} open onOpenChange={() => {}} />,
    { wrapper: Wrapper },
  );
}

describe("the Link-to-run dialog (TR-003)", () => {
  it("offers a labeled combobox over the registered runs, never selection-free text", async () => {
    const user = userEvent.setup();
    renderDialog();
    await awaitIdentity();

    const picker = await screen.findByLabelText("Run");
    expect(picker).toHaveRole("combobox");
    await user.click(picker);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "TAS-88214 · E-machine efficiency map",
      "TAS-88215 · Inverter derating sweep",
    ]);
  });

  it("sends the typed text as a debounced ?q= to /test-runs, so no run is out of reach", async () => {
    const user = userEvent.setup();
    renderDialog();
    await awaitIdentity();

    await user.type(await screen.findByLabelText("Run"), "derating");

    await waitFor(() => {
      const searched = calls.find(
        (entry) => entry.url.includes("/api/proxy/test-runs") && entry.url.includes("q=derating"),
      );
      expect(searched, "the picker never sent ?q=derating to /test-runs").toBeDefined();
    });
  });

  it("sends PATCH /files/{id} with the run_id and the Portal identity", async () => {
    const user = userEvent.setup();
    renderDialog();
    await awaitIdentity();

    await user.click(await screen.findByLabelText("Run"));
    await user.click(await screen.findByRole("option", { name: /TAS-88215/ }));
    await user.click(screen.getByRole("button", { name: "Link to run" }));

    await waitFor(() => expect(patchCall()).toBeDefined());
    expect(patchCall().url).toBe(`/api/proxy/files/${FILE_ID}`);
    expect(bodyOf(patchCall())).toEqual({
      run_id: "TAS-88215",
      actor: PORTAL_NAME,
    });
  });

  it("carries the optional note into the journal entry", async () => {
    const user = userEvent.setup();
    renderDialog();
    await awaitIdentity();

    await user.click(await screen.findByLabelText("Run"));
    await user.click(await screen.findByRole("option", { name: /TAS-88214/ }));
    await user.type(screen.getByLabelText(/^Note/), "Run key confirmed against the rig log");
    await user.click(screen.getByRole("button", { name: "Link to run" }));

    await waitFor(() => expect(patchCall()).toBeDefined());
    expect(bodyOf(patchCall())).toEqual({
      run_id: "TAS-88214",
      note: "Run key confirmed against the rig log",
      actor: PORTAL_NAME,
    });
  });

  it("refuses to submit without a picked run, and sends no request", async () => {
    const user = userEvent.setup();
    renderDialog();
    await awaitIdentity();

    await user.click(screen.getByRole("button", { name: "Link to run" }));

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((alert) => /Pick a run first/.test(alert.textContent ?? ""))).toBe(true);
    expect(calls.some((entry) => (entry.init.method ?? "GET").toUpperCase() === "PATCH")).toBe(
      false,
    );
  });

  it("maps 422 unknown_run to a sentence a person can act on", async () => {
    patchAnswer = () => apiError(422, "unknown_run");
    const user = userEvent.setup();
    renderDialog();
    await awaitIdentity();

    await user.click(await screen.findByLabelText("Run"));
    await user.click(await screen.findByRole("option", { name: /TAS-88214/ }));
    await user.click(screen.getByRole("button", { name: "Link to run" }));

    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(
        alerts.some((alert) => /holds no run under that id/.test(alert.textContent ?? "")),
      ).toBe(true);
    });
    // The dialog stays open, so the person reads the reason and retries.
    expect(screen.getByRole("button", { name: "Link to run" })).toBeEnabled();
  });

  it("maps the 409 lifecycle refusals to the restore-first sentence", async () => {
    patchAnswer = () => apiError(409, "file_archived");
    const user = userEvent.setup();
    renderDialog();
    await awaitIdentity();

    await user.click(await screen.findByLabelText("Run"));
    await user.click(await screen.findByRole("option", { name: /TAS-88214/ }));
    await user.click(screen.getByRole("button", { name: "Link to run" }));

    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(
        alerts.some((alert) =>
          /archived\. Restore it first, then link it\./.test(alert.textContent ?? ""),
        ),
      ).toBe(true);
    });
  });

  it("states the standing quarantine in the toast when the link did not end it", async () => {
    patchAnswer = () =>
      json(
        fileDetail({
          run_id: "TAS-88214",
          status: "quarantined",
          quarantine_reason: "checksum mismatch",
        }),
      );
    const user = userEvent.setup();
    renderDialog();
    await awaitIdentity();

    await user.click(await screen.findByLabelText("Run"));
    await user.click(await screen.findByRole("option", { name: /TAS-88214/ }));
    await user.click(screen.getByRole("button", { name: "Link to run" }));

    await waitFor(() => expect(patchCall()).toBeDefined());
    // The toast never claims a promotion the registry refused.
    await waitFor(() => {
      expect(toasts.some((message) => /stays quarantined: checksum mismatch/.test(message))).toBe(
        true,
      );
    });
  });
});
