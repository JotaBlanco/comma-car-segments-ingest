/**
 * R-12 — a person uploads a processed result from the run detail screen.
 *
 * The test drives the real path: the tab, the dialog, the hook, the API client
 * and `fetch`. Only `fetch` is a stub, so the shape of the request the browser
 * sends is the thing under test. See the result-upload box (v1.2) in
 * `plans/API-CONTRACT.md` and `api/api/routers/results.py`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { ResultsTab } from "@/components/screens/run-detail/results-tab";
import { setActivePortalToken } from "@/lib/portal/token-store";
import { setPortalApiBase } from "@/lib/portal/client";

// Each test drives a real dialog through user-event, so it takes seconds, not
// milliseconds. The default 5 s limit fires when the whole suite runs together.
vi.setConfig({ testTimeout: 30_000 });

const RUN_ID = "TAS-88214";
const PORTAL_API = "https://portal-api.dev.quix.io";
const FILE_ID = "f-11111111-2222-3333-4444-555555555555";

const savedEnv = { ...process.env };

/** The rows `GET /results` answers. A 201 pushes the new row on to it. */
let resultRows: unknown[] = [];
/** The answer `POST /results/upload` gives next. */
let uploadAnswer: () => Response = () => json(storedResult(), 201);
/** Every request the app sent, in order. */
let calls: Array<{ url: string; init: RequestInit }> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiError(status: number, code: string): Response {
  return json({ detail: `refused: ${code}`, code, errors: [] }, status);
}

function storedResult(): Record<string, unknown> {
  return {
    result_id: "res-1",
    run_id: RUN_ID,
    name: "thermal_summary_v1.parquet",
    result_key: "thermal_summary",
    version: 1,
    supersedes: null,
    description: "Cycle-level aggregates",
    storage_ref: "blob://ws/test-manager/results/TAS-88214/u-thermal_summary_v1.parquet",
    provenance: {
      tool: "bat-post",
      tool_version: "2.3.1",
      parameters: "--cycles all --dt 0.1",
      input_file_ids: [FILE_ID],
      produced_by: "Erika Lindqvist",
      produced_at: "2026-08-14T12:02:00Z",
    },
    provenance_status: "verified",
    created_at: "2026-08-14T12:02:31Z",
  };
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost");
      calls.push({ url: input, init });
      if (url.pathname === "/profile") {
        return json({ userId: "u-1", email: "e.lindqvist@volvo.com", firstName: "Erika", lastName: "Lindqvist" });
      }
      if (url.pathname === "/organisations/current") return new Response(null, { status: 204 });
      if (url.pathname === "/api/proxy/results/upload") return uploadAnswer();
      if (url.pathname === "/api/proxy/results") {
        return json({ items: resultRows, total: resultRows.length, page: 1, page_size: 20, total_pages: 1 });
      }
      if (url.pathname === `/api/proxy/test-runs/${RUN_ID}/files`) {
        return json({ items: [{ file_id: FILE_ID, filename: "bat_cyc_0814.mf4" }] });
      }
      throw new TypeError(`no stub for ${input}`);
    }),
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderTab() {
  return render(<ResultsTab runId={RUN_ID} />, { wrapper: Wrapper });
}

/** Open the dialog and wait for the Portal identity the provenance needs. */
async function openTheDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: /upload result/i }));
  await screen.findByRole("dialog");
  // The maker comes from the Portal profile, so wait for it before typing.
  await screen.findByText("Erika Lindqvist");
}

/** A result file with its own modification time, the way a browser hands one over. */
function resultFile(filename: string, lastModified: number): File {
  return new File(["result bytes"], filename, {
    type: "application/octet-stream",
    lastModified,
  });
}

/** The value of one text box of the dialog. */
function fieldValue(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

/** Open the dialog and fill every field the API makes mandatory. */
async function fillTheForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await openTheDialog(user);

  const file = new File(["result bytes"], "thermal_summary_v1.parquet", {
    type: "application/octet-stream",
  });
  await user.upload(screen.getByLabelText("Result file"), file);
  await user.type(screen.getByLabelText("Tool"), "bat-post");
  await user.type(screen.getByLabelText("Tool version"), "2.3.1");
  await user.type(screen.getByLabelText("Parameters"), "--cycles all --dt 0.1");
  // The wrapping label names the box as well as its own aria-label, so the
  // accessible name repeats the filename. Match it, do not spell it twice.
  await user.click(screen.getByRole("checkbox", { name: /bat_cyc_0814\.mf4/ }));
}

async function submitTheForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = screen.getByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: /upload result/i }));
}

/** The one request the app sent to the upload route. */
function uploadCall(): { url: string; init: RequestInit } {
  const call = calls.find((entry) => entry.url.includes("/results/upload"));
  if (call === undefined) throw new Error("the app sent no upload request");
  return call;
}

beforeEach(() => {
  setPortalApiBase(PORTAL_API);
  window.localStorage.setItem("tm.portal.token", "portal-pat");
  setActivePortalToken(null);
  resultRows = [];
  calls = [];
  uploadAnswer = () => json(storedResult(), 201);
  stubFetch();
});

afterEach(() => {
  setPortalApiBase(null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
});

describe("the upload control posts the contract's multipart request", () => {
  it("sends both parts: the file bytes and the metadata JSON", async () => {
    const user = userEvent.setup();
    renderTab();
    await fillTheForm(user);
    await submitTheForm(user);

    await waitFor(() => expect(uploadCall()).toBeDefined());
    const body = uploadCall().init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const sent = body.get("file") as File;
    expect(sent.name).toBe("thermal_summary_v1.parquet");

    const metadata = JSON.parse(body.get("metadata") as string);
    expect(metadata.run_id).toBe(RUN_ID);
    expect(metadata.name).toBe("thermal_summary_v1.parquet");
    // The file name minus its extension suggests the key. A person may edit it.
    expect(metadata.result_key).toBe("thermal_summary_v1");
    expect(metadata.provenance.tool).toBe("bat-post");
    expect(metadata.provenance.tool_version).toBe("2.3.1");
    expect(metadata.provenance.parameters).toBe("--cycles all --dt 0.1");
    expect(metadata.provenance.input_file_ids).toEqual([FILE_ID]);
  });

  it("names the signed-in Portal identity as the maker, and never a typed default", async () => {
    const user = userEvent.setup();
    renderTab();
    await fillTheForm(user);
    await submitTheForm(user);

    await waitFor(() => expect(uploadCall()).toBeDefined());
    const metadata = JSON.parse((uploadCall().init.body as FormData).get("metadata") as string);
    expect(metadata.provenance.produced_by).toBe("Erika Lindqvist");
    expect(metadata.provenance.produced_by).not.toBe("e.lindqvist");
    expect(metadata.provenance.produced_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("sends no storage_ref, because the server mints it", async () => {
    const user = userEvent.setup();
    renderTab();
    await fillTheForm(user);
    await submitTheForm(user);

    await waitFor(() => expect(uploadCall()).toBeDefined());
    const raw = (uploadCall().init.body as FormData).get("metadata") as string;
    expect(raw).not.toContain("storage_ref");
    expect(Object.keys(JSON.parse(raw))).not.toContain("storage_ref");
  });

  it("sets no Content-Type header, so the browser writes the multipart boundary", async () => {
    const user = userEvent.setup();
    renderTab();
    await fillTheForm(user);
    await submitTheForm(user);

    await waitFor(() => expect(uploadCall()).toBeDefined());
    const headers = (uploadCall().init.headers ?? {}) as Record<string, string>;
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    expect(names).not.toContain("content-type");
  });

  it("refuses to upload while no Portal identity signs the provenance", async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole("button", { name: /upload result/i }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByRole("alert").textContent).toMatch(/needs a signed-in Quix identity/);
    expect(within(dialog).getByRole("button", { name: /upload result/i })).toBeDisabled();
  });
});

describe("the tab shows the new row after a 201", () => {
  it("lists the stored result once the upload succeeds", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("No processed results");

    uploadAnswer = () => {
      resultRows = [storedResult()];
      return json(storedResult(), 201);
    };
    await fillTheForm(user);
    await submitTheForm(user);

    expect(await screen.findByText("thermal_summary_v1.parquet")).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });
});

describe("each refusal states a sentence a person can act on", () => {
  const cases: Array<[number, string, RegExp]> = [
    [413, "file_too_large", /100 MiB cap/],
    [503, "storage_unreachable", /store did not answer/],
    [503, "not_ready", /audit journal refused the entry/],
    [422, "provenance_required", /provenance is incomplete/],
    [409, "version_conflict", /holds this result version/],
  ];

  for (const [status, code, message] of cases) {
    it(`states its own message for ${status} ${code}`, async () => {
      uploadAnswer = () => apiError(status, code);
      const user = userEvent.setup();
      renderTab();
      await fillTheForm(user);
      await submitTheForm(user);

      const dialog = screen.getByRole("dialog");
      await waitFor(() => {
        const alerts = within(dialog).getAllByRole("alert");
        expect(alerts.some((alert) => message.test(alert.textContent ?? ""))).toBe(true);
      });
      // The dialog stays open, so the person reads the reason and retries.
      expect(within(dialog).getByRole("button", { name: /upload result/i })).toBeEnabled();
    });
  }
});

describe("a file pick fills only what the application already knows", () => {
  // 14 Aug 2026, 12:02 UTC. The stamp holds no second and no millisecond, so a
  // datetime-local box, which stops at the minute, gives it back unchanged.
  const STAMP = Date.UTC(2026, 7, 14, 12, 2, 0);

  it("fills the name, the result key and the file's own produced-at time", async () => {
    const user = userEvent.setup();
    renderTab();
    await openTheDialog(user);

    const box = screen.getByLabelText("Result file");
    await user.upload(box, resultFile("thermal_summary_v1.parquet", STAMP));

    expect(fieldValue("Name")).toBe("thermal_summary_v1.parquet");
    expect(fieldValue("Result key")).toBe("thermal_summary_v1");
    // The box holds local time, so read it back through Date to compare.
    expect(new Date(fieldValue("Produced at")).getTime()).toBe(STAMP);
  });

  it("leaves the tool, the version, the parameters and the description empty", async () => {
    const user = userEvent.setup();
    renderTab();
    await openTheDialog(user);

    await user.upload(screen.getByLabelText("Result file"), resultFile("brake.csv", STAMP));

    expect(fieldValue("Tool")).toBe("");
    expect(fieldValue("Tool version")).toBe("");
    expect(fieldValue("Parameters")).toBe("");
    expect(fieldValue("Description (optional)")).toBe("");
  });

  it("ticks no input file, because lineage is a person's statement", async () => {
    const user = userEvent.setup();
    renderTab();
    await openTheDialog(user);
    await screen.findByRole("checkbox", { name: /bat_cyc_0814\.mf4/ });

    await user.upload(screen.getByLabelText("Result file"), resultFile("brake.csv", STAMP));

    expect(screen.getByRole("checkbox", { name: /bat_cyc_0814\.mf4/ })).not.toBeChecked();
  });

  it("falls back to the clock when the file carries no usable time", async () => {
    const user = userEvent.setup();
    renderTab();
    await openTheDialog(user);
    const before = Date.now();

    await user.upload(screen.getByLabelText("Result file"), resultFile("brake.csv", 0));

    const shown = new Date(fieldValue("Produced at")).getTime();
    // The box drops the seconds, so allow one minute below the start.
    expect(shown).toBeGreaterThanOrEqual(before - 60_000);
    expect(shown).toBeLessThanOrEqual(Date.now());
  });
});

describe("a second file pick never overwrites what a person typed", () => {
  const FIRST = Date.UTC(2026, 7, 14, 12, 2, 0);
  const SECOND = Date.UTC(2026, 7, 15, 9, 30, 0);

  it("keeps an edited name and refreshes the fields nobody touched", async () => {
    const user = userEvent.setup();
    renderTab();
    await openTheDialog(user);

    const box = screen.getByLabelText("Result file");
    await user.upload(box, resultFile("thermal_summary_v1.parquet", FIRST));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Cycle aggregates");

    await user.upload(box, resultFile("brake_summary_v2.csv", SECOND));

    expect(fieldValue("Name")).toBe("Cycle aggregates");
    expect(fieldValue("Result key")).toBe("brake_summary_v2");
    expect(new Date(fieldValue("Produced at")).getTime()).toBe(SECOND);
  });

  it("keeps an edited result key and an edited produced-at time", async () => {
    const user = userEvent.setup();
    renderTab();
    await openTheDialog(user);

    const box = screen.getByLabelText("Result file");
    await user.upload(box, resultFile("thermal_summary_v1.parquet", FIRST));
    await user.clear(screen.getByLabelText("Result key"));
    await user.type(screen.getByLabelText("Result key"), "thermal_summary");
    await user.clear(screen.getByLabelText("Produced at"));
    await user.type(screen.getByLabelText("Produced at"), "2026-08-01T08:15");

    await user.upload(box, resultFile("brake_summary_v2.csv", SECOND));

    expect(fieldValue("Result key")).toBe("thermal_summary");
    expect(fieldValue("Produced at")).toBe("2026-08-01T08:15");
    expect(fieldValue("Name")).toBe("brake_summary_v2.csv");
  });

  it("sends the edited name and the file's time to the upload route", async () => {
    const user = userEvent.setup();
    renderTab();
    await openTheDialog(user);

    await user.upload(
      screen.getByLabelText("Result file"),
      resultFile("thermal_summary_v1.parquet", FIRST),
    );
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Cycle aggregates");
    await user.type(screen.getByLabelText("Tool"), "bat-post");
    await user.type(screen.getByLabelText("Tool version"), "2.3.1");
    await user.type(screen.getByLabelText("Parameters"), "--cycles all --dt 0.1");
    await submitTheForm(user);

    await waitFor(() => expect(uploadCall()).toBeDefined());
    const metadata = JSON.parse((uploadCall().init.body as FormData).get("metadata") as string);
    expect(metadata.name).toBe("Cycle aggregates");
    expect(metadata.result_key).toBe("thermal_summary_v1");
    expect(new Date(metadata.provenance.produced_at).getTime()).toBe(FIRST);
    // Nobody ticked an input file, so the request claims no lineage link.
    expect(metadata.provenance.input_file_ids).toEqual([]);
  });
});
