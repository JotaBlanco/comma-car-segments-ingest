/**
 * The Results tab keeps one row on one line, and a person can edit a result.
 *
 * Two clauses meet here.
 *
 * The first is the table. QuixLab publishes a node's whole SQL as the result's
 * `parameters`, and the raw cell used to widen the table until the page
 * scrolled sideways. The cell now clamps in JavaScript, so jsdom can prove it,
 * and the whole value stays in the cell `title`.
 *
 * The second is `PATCH /results/{result_id}`. The edit sends only the changed
 * field, it carries the Portal identity, and the result then shows an "Edited
 * by hand" mark. A provenance block records what a tool did. Once a person can
 * rewrite it, the block states what somebody says the tool did, so the mark
 * keeps the feature honest.
 *
 * Only `fetch` is a stub, so the request the browser sends is the thing under
 * test. Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { EditResultDialog } from "@/components/screens/run-detail/edit-result-dialog";
import { ResultsTab } from "@/components/screens/run-detail/results-tab";
import { formatArrival } from "@/lib/format";
import { setPortalApiBase } from "@/lib/portal/client";
import { setActivePortalToken } from "@/lib/portal/token-store";
import type { ProcessedResult } from "@/types";

// Each test drives a real dialog through user-event, so it takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const RUN_ID = "TAS-88214";
const FILE_ID = "f-11111111-2222-3333-4444-555555555555";
const PLAIN = "res-plain";
const EDITED = "res-edited";
const PORTAL_API = "https://portal-api.dev.quix.io";
/** The name the Portal profile resolves to. Every write must carry it. */
const PORTAL_NAME = "Erika Lindqvist";

/** One QuixLab node's whole SQL. It is what blows the table out. */
const LONG_SQL =
  "SELECT cycle_index, max(coolant_temp_c) AS peak_temp, avg(motor_rpm) AS mean_rpm, " +
  "count(*) AS samples FROM quixlake.bat_cyc_0814 WHERE valid = true AND cycle_index > 0 " +
  "GROUP BY cycle_index ORDER BY cycle_index";

const EDIT_MARK = { at: "2026-08-20T09:15:00Z", actor: PORTAL_NAME, fields: ["result.provenance.parameters", "result.name"] };

/** Every request the app sent, in order. */
let calls: Array<{ url: string; init: RequestInit }> = [];
/** The answer the PATCH route gives next. */
let patchAnswer: () => Response = () => json(result(PLAIN));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiError(status: number, code: string): Response {
  return json({ detail: `refused: ${code}`, code, errors: [] }, status);
}

function result(resultId: string, overrides: Partial<ProcessedResult> = {}): ProcessedResult {
  return {
    result_id: resultId,
    run_id: RUN_ID,
    name: `${resultId}.parquet`,
    result_key: resultId,
    version: 1,
    supersedes: null,
    description: "Cycle-level aggregates",
    storage_ref: "blob://ws/results/x.parquet",
    provenance: {
      tool: "quixlab",
      tool_version: "2.3.1",
      parameters: LONG_SQL,
      input_file_ids: [FILE_ID],
      produced_by: PORTAL_NAME,
      produced_at: "2026-08-14T12:02:00Z",
    },
    provenance_status: "verified",
    created_at: "2026-08-14T12:02:31Z",
    edited: null,
    ...overrides,
  };
}

const ROWS = [result(PLAIN), result(EDITED, { edited: EDIT_MARK })];

function emptyPage() {
  return { items: [], total: 0, page: 1, page_size: 50, total_pages: 0 };
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost");
      calls.push({ url: input, init });
      const method = (init.method ?? "GET").toUpperCase();
      if (url.pathname === "/profile") {
        return json({
          userId: "u-1",
          email: "e.lindqvist@volvo.com",
          firstName: "Erika",
          lastName: "Lindqvist",
        });
      }
      if (url.pathname === "/organisations/current") return new Response(null, { status: 204 });
      if (url.pathname === "/api/proxy/results") {
        return json({ items: ROWS, total: 2, page: 1, page_size: 20, total_pages: 1 });
      }
      if (url.pathname === `/api/proxy/test-runs/${RUN_ID}/files`) {
        return json({ items: [{ file_id: FILE_ID, filename: "bat_cyc_0814.mf4" }] });
      }
      for (const row of ROWS) {
        if (url.pathname === `/api/proxy/results/${row.result_id}`) {
          if (method === "PATCH") return patchAnswer();
          return json(row);
        }
        if (url.pathname === `/api/proxy/results/${row.result_id}/journal`) return json(emptyPage());
      }
      throw new TypeError(`no stub for ${method} ${input}`);
    }),
  );
}

/** The table row that prints a given result name. The row opens the result. */
function rowOf(name: string): HTMLElement {
  const row = screen
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByText(name) !== null);
  if (row === undefined) throw new Error(`no row prints ${name}`);
  return row;
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The one request the app sent to a write route, by method. */
function writeCall(method: string, fragment: string): { url: string; init: RequestInit } {
  const call = calls.find(
    (entry) => entry.url.includes(fragment) && (entry.init.method ?? "GET").toUpperCase() === method,
  );
  if (call === undefined) throw new Error(`the app sent no ${method} to ${fragment}`);
  return call;
}

beforeEach(() => {
  setPortalApiBase(PORTAL_API);
  window.localStorage.setItem("tm.portal.token", "portal-pat");
  setActivePortalToken(null);
  calls = [];
  patchAnswer = () => json(result(PLAIN));
  stubFetch();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }),
  );
});

afterEach(() => {
  setPortalApiBase(null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Results tab clamps a long cell and keeps the whole value", () => {
  it("never puts the whole SQL in the table cell, and keeps it in the title", async () => {
    render(<ResultsTab runId={RUN_ID} />, { wrapper: Wrapper });
    await screen.findByText(`${PLAIN}.parquet`);

    // Two rows carry the same SQL, so the query finds both cells.
    const cells = screen.getAllByTitle(LONG_SQL);
    expect(cells.length).toBe(2);
    const text = cells[0].textContent ?? "";

    // The clamp holds, and the whole value never reaches the cell text.
    expect(text).not.toBe(LONG_SQL);
    expect(text.length).toBeLessThan(LONG_SQL.length);
    expect(text.endsWith("…")).toBe(true);
    // The head stays long enough to tell two rows of one job apart.
    expect(text.startsWith(LONG_SQL.slice(0, 40))).toBe(true);
    // No element anywhere in the table prints the whole string.
    expect(screen.queryByText(LONG_SQL)).toBeNull();
  });
});

describe("the details dialog shows the whole result", () => {
  it("prints the parameters whole", async () => {
    const user = userEvent.setup();
    render(<ResultsTab runId={RUN_ID} />, { wrapper: Wrapper });
    await screen.findByText(`${PLAIN}.parquet`);

    await user.click(rowOf(`${PLAIN}.parquet`));

    const dialog = await screen.findByRole("dialog");
    // The block keeps every character, and it keeps the whitespace.
    expect(await within(dialog).findByText(LONG_SQL)).toBeInTheDocument();
    // The two time facts read under two different labels.
    expect(within(dialog).getByText("Produced at (the tool ran)")).toBeInTheDocument();
    expect(within(dialog).getByText("Created (the registry took it)")).toBeInTheDocument();
  });
});

describe("the mark says a person edited the provenance", () => {
  it("puts the mark on the row and names the fields and the time in the dialog", async () => {
    const user = userEvent.setup();
    render(<ResultsTab runId={RUN_ID} />, { wrapper: Wrapper });
    await screen.findByText(`${EDITED}.parquet`);

    // The row carries one mark, and it carries words as well as a colour.
    const marks = screen.getAllByText("Edited by hand");
    expect(marks.length).toBe(1);
    const rowMark = marks[0].parentElement;
    expect(rowMark?.getAttribute("title")).toContain("provenance.parameters");
    expect(rowMark?.getAttribute("title")).toContain(PORTAL_NAME);

    await user.click(rowOf(`${EDITED}.parquet`));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("provenance.parameters, name")).toBeInTheDocument();
    expect(
      within(dialog).getByText(new RegExp(formatArrival(EDIT_MARK.at)), { exact: false }),
    ).toBeInTheDocument();
  });

  it("shows no mark on a result nobody edited", async () => {
    render(<ResultsTab runId={RUN_ID} />, { wrapper: Wrapper });
    await screen.findByText(`${PLAIN}.parquet`);

    // Two rows, one mark. The unedited row carries none.
    expect(screen.getAllByText("Edited by hand").length).toBe(1);
  });
});

describe("the edit dialog reaches PATCH /results/{result_id}", () => {
  it("sends only the changed field, and it carries the Portal identity", async () => {
    const user = userEvent.setup();
    render(
      <EditResultDialog result={result(PLAIN)} open onOpenChange={() => {}} />,
      { wrapper: Wrapper },
    );
    // Wait until the Portal name resolves, so no write races it.
    await screen.findByText(PORTAL_NAME);

    const version = screen.getByLabelText("Tool version");
    await user.clear(version);
    await user.type(version, "2.4.0");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(writeCall("PATCH", `/results/${PLAIN}`)).toBeDefined());
    const body = JSON.parse(writeCall("PATCH", `/results/${PLAIN}`).init.body as string);
    expect(body).toEqual({
      provenance: { tool_version: "2.4.0" },
      actor: PORTAL_NAME,
    });
  });

  it("says what to do when the registry answers 422 provenance_required", async () => {
    patchAnswer = () => apiError(422, "provenance_required");
    const user = userEvent.setup();
    render(
      <EditResultDialog result={result(PLAIN)} open onOpenChange={() => {}} />,
      { wrapper: Wrapper },
    );
    await screen.findByText(PORTAL_NAME);

    const tool = screen.getByLabelText("Tool");
    await user.clear(tool);
    await user.type(tool, "quixlab-sql");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("blank");
    expect(alert.textContent).toContain("Put the value back, then save.");
  });
});
