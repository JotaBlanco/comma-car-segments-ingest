/**
 * The Run control on each definition row of the run detail screen.
 *
 * Each test drives the real path: the panel, the hooks, the API client and `fetch`.
 * Only `fetch` is a stub, so the request the browser sends is the thing under test.
 * The route is `api/api/routers/definition_runs.py`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { DefinitionsPanel } from "@/components/screens/run-detail/definitions-panel";
import { NEEDS_LOGIN_MESSAGE, RUN_POLL_MS } from "@/lib/definition-run";
import { keys } from "@/lib/hooks/keys";
import { PORTAL_TOKEN_HEADER, setActivePortalToken } from "@/lib/portal/token-store";
import type { TestRun } from "@/types";

const RUN_ID = "TAS-88214";
const WO_ID = "WO-2026-0851";
const RUNNABLE = "TD-4471";
const BARE = "TD-4472";
const RUN_PATH = `/api/proxy/test-runs/${RUN_ID}/definitions/${RUNNABLE}/run`;

const VERDICT = {
  definition_id: RUNNABLE,
  outcome: "fail",
  evidence: { peak_kw: 212.5, limit_kw: 200 },
  implementation_sha256: "abc",
};

type Answer = () => Response;

/** Every request the app sent, in order. */
let calls: Array<{ url: string; method: string; headers: Headers }> = [];
let getAnswers: Answer[] = [];
let postAnswer: Answer = () => json({ id: "dep-run", name: "tm-run-x", status: "Queued" }, 202);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiError(status: number, code: string, detail = `refused: ${code}`): Response {
  return json({ detail, code, errors: [] }, status);
}

function runResult(over: Record<string, unknown>): Response {
  return json({
    id: "dep-run",
    name: "tm-run-x",
    state: "running",
    status: "Running",
    exit_code: null,
    quixlab_run_id: null,
    error: null,
    result_id: null,
    verdict: null,
    ...over,
  });
}

function definition(tdId: string, implementation: boolean): Response {
  return json({
    td_id: tdId,
    title: `Definition ${tdId}`,
    implementation: implementation ? { blob_path: `impl/${tdId}.py` } : null,
  });
}

const RUN = {
  run_id: RUN_ID,
  work_order_id: WO_ID,
  definition_ids: [RUNNABLE, BARE],
} as TestRun;

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost");
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({ url: url.pathname, method, headers: new Headers(init.headers) });
      if (url.pathname === `/api/proxy/work-orders/${WO_ID}`) {
        return json({
          wo_id: WO_ID,
          definitions: [RUNNABLE, BARE].map((td_id) => ({
            td_id,
            title: `Definition ${td_id}`,
            planned_runs: 1,
            actual_runs: 1,
            status: "on_plan",
          })),
          runs: [],
        });
      }
      if (url.pathname === `/api/proxy/test-definitions/${RUNNABLE}`) return definition(RUNNABLE, true);
      if (url.pathname === `/api/proxy/test-definitions/${BARE}`) return definition(BARE, false);
      if (url.pathname === RUN_PATH && method === "POST") return postAnswer();
      if (url.pathname === RUN_PATH && method === "GET") {
        return (getAnswers.shift() ?? (() => runResult({})))();
      }
      throw new TypeError(`no stub for ${method} ${input}`);
    }),
  );
}

let client: QueryClient;

function withClient(node: ReactElement): ReactElement {
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function sent(method: string): typeof calls {
  return calls.filter((call) => call.url === RUN_PATH && call.method === method);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  calls = [];
  getAnswers = [() => apiError(404, "run_job_not_found")];
  postAnswer = () => json({ id: "dep-run", name: "tm-run-x", status: "Queued" }, 202);
  setActivePortalToken("token-one");
  stubFetch();
});

afterEach(() => {
  setActivePortalToken(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function runButton(tdId: string): Promise<HTMLElement> {
  const button = await screen.findByRole("button", { name: `Run ${tdId} on this run` });
  return button;
}

describe("the Run control on a definition row", () => {
  it("shows the stored verdict on mount and starts nothing", async () => {
    getAnswers = [
      () => runResult({ id: null, state: "finished", status: "", result_id: "res-1", verdict: VERDICT }),
    ];

    render(withClient(<DefinitionsPanel run={RUN} />));

    expect(await screen.findByText("FAIL")).toBeTruthy();
    expect(screen.getByText("peak_kw 212.5, limit_kw 200")).toBeTruthy();
    expect(sent("POST")).toHaveLength(0);
  });

  it("disables Run for a definition with no implementation and asks nothing about it", async () => {
    render(withClient(<DefinitionsPanel run={RUN} />));

    await waitFor(async () => expect(await runButton(RUNNABLE)).toBeEnabled());
    expect(await runButton(BARE)).toBeDisabled();
    expect(calls.some((call) => call.url.includes(`/definitions/${BARE}/run`))).toBe(false);
  });

  it("runs the definition as the viewer, polls, then shows the verdict and refreshes", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(withClient(<DefinitionsPanel run={RUN} />));
    await waitFor(async () => expect(await runButton(RUNNABLE)).toBeEnabled());
    await waitFor(() => expect(sent("GET")).toHaveLength(1));
    getAnswers = [
      () => runResult({ status: "Running" }),
      () => runResult({ state: "finished", status: "Completed", exit_code: 0, verdict: VERDICT }),
    ];

    await user.click(await runButton(RUNNABLE));

    expect(await screen.findByText("Running… (Queued)")).toBeTruthy();
    expect(await runButton(RUNNABLE)).toBeDisabled();
    expect(sent("POST")[0].headers.get(PORTAL_TOKEN_HEADER)).toBe("token-one");
    await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
    expect(await screen.findByText("Running… (Running)")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
    expect(await screen.findByText("FAIL")).toBeTruthy();
    expect(await runButton(RUNNABLE)).toBeEnabled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.results.all });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.requirements.all });
  });

  it("names the error of a run that failed", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(withClient(<DefinitionsPanel run={RUN} />));
    await waitFor(async () => expect(await runButton(RUNNABLE)).toBeEnabled());
    await waitFor(() => expect(sent("GET")).toHaveLength(1));
    getAnswers = [() => runResult({ state: "failed", exit_code: 1, error: "evaluate() raised" })];

    await user.click(await runButton(RUNNABLE));
    await vi.advanceTimersByTimeAsync(RUN_POLL_MS);

    expect(await screen.findByText("Run failed · exit 1 · evaluate() raised")).toBeTruthy();
  });

  it("asks for a Portal login when the API has no token for the viewer", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    postAnswer = () => apiError(401, "quixlab_needs_login");
    render(withClient(<DefinitionsPanel run={RUN} />));
    await waitFor(async () => expect(await runButton(RUNNABLE)).toBeEnabled());

    await user.click(await runButton(RUNNABLE));

    expect(await screen.findByText(NEEDS_LOGIN_MESSAGE)).toBeTruthy();
    expect((await runButton(RUNNABLE)).textContent).toBe("Run");
  });

  it("shows why a run could not start", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    postAnswer = () => apiError(409, "quixlab_no_template", "no QuixLab template in this workspace");
    render(withClient(<DefinitionsPanel run={RUN} />));
    await waitFor(async () => expect(await runButton(RUNNABLE)).toBeEnabled());

    await user.click(await runButton(RUNNABLE));

    expect(await screen.findByText("no QuixLab template in this workspace")).toBeTruthy();
  });
});
