import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import type { DefinitionRunResult } from "@/lib/api/definition-runs";
import {
  NEEDS_LOGIN_MESSAGE,
  pollDefinitionRun,
  RUN_GIVE_UP_MS,
  RUN_POLL_MS,
  RUN_POLL_RETRIES,
  runDefinition,
  runErrorMessage,
  summariseEvidence,
  viewOfOutcome,
  viewOfStored,
  type RunDeps,
} from "@/lib/definition-run";

/**
 * Running a test definition on a run as a QuixLab Job: poll until the exit code decides,
 * never forever, and never past the row that asked.
 */

const VERDICT = {
  definition_id: "TD-1",
  outcome: "pass" as const,
  evidence: { peak_kw: 212.5, cycles: 14 },
  implementation_sha256: "abc",
};

function result(over: Partial<DefinitionRunResult>): DefinitionRunResult {
  return {
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
  };
}

function deps(
  answers: (DefinitionRunResult | Error)[],
  clock = { at: 0 },
): RunDeps & { reads: number; starts: number } {
  const queue = [...answers];
  const out = {
    reads: 0,
    starts: 0,
    start: () => {
      out.starts += 1;
      return Promise.resolve({ id: "dep-run", name: "tm-run-x", status: "Queued" });
    },
    read: () => {
      out.reads += 1;
      const next = queue.shift() ?? result({});
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    wait: (ms: number) => {
      clock.at += ms;
      return Promise.resolve();
    },
    now: () => clock.at,
  };
  return out;
}

const watch = (statuses: string[] = [], alive = () => true) => ({
  onStatus: (status: string) => statuses.push(status),
  alive,
});

describe("runDefinition", () => {
  it("starts the Job, then polls until it finishes and answers its result", async () => {
    const done = result({ state: "finished", status: "Completed", exit_code: 0, verdict: VERDICT });
    const statuses: string[] = [];
    const d = deps([result({}), done]);

    const outcome = await runDefinition("r1", "TD-1", watch(statuses), d);

    expect(outcome).toEqual({ kind: "finished", result: done });
    expect(d.starts).toBe(1);
    expect(d.reads).toBe(2);
    expect(statuses).toEqual(["Queued", "Running"]);
  });

  it("gives up after the cap rather than polling forever", async () => {
    const d = deps([]);

    const outcome = await runDefinition("r1", "TD-1", watch(), d);

    expect(outcome).toEqual({ kind: "timeout", status: "Running" });
    expect(d.reads).toBe(RUN_GIVE_UP_MS / RUN_POLL_MS);
  });

  it("rides out a few transient poll failures in a row", async () => {
    const outage = new ApiError(503, "the Quix platform did not answer", "quixlab_unreachable");
    const done = result({ state: "finished", exit_code: 0, verdict: VERDICT });
    const d = deps([...Array<Error>(RUN_POLL_RETRIES).fill(outage), done]);

    const outcome = await runDefinition("r1", "TD-1", watch(), d);

    expect(outcome).toEqual({ kind: "finished", result: done });
  });

  it("gives up once the failures in a row pass the retries", async () => {
    const outage = new ApiError(503, "the Quix platform did not answer", "quixlab_unreachable");
    const d = deps(Array<Error>(RUN_POLL_RETRIES + 1).fill(outage));

    await expect(runDefinition("r1", "TD-1", watch(), d)).rejects.toBe(outage);
    expect(d.reads).toBe(RUN_POLL_RETRIES + 1);
  });

  it("treats a 404 as final at once", async () => {
    const gone = new ApiError(404, "no run of TD-1 on r1", "run_job_not_found");
    const d = deps([gone]);

    await expect(runDefinition("r1", "TD-1", watch(), d)).rejects.toBe(gone);
    expect(d.reads).toBe(1);
  });

  it("stops polling once the row is gone", async () => {
    const d = deps([]);

    const outcome = await runDefinition("r1", "TD-1", watch([], () => false), d);

    expect(outcome).toEqual({ kind: "abandoned" });
    expect(d.reads).toBe(0);
  });
});

describe("pollDefinitionRun", () => {
  it("follows a Job already going without starting another", async () => {
    const done = result({ state: "failed", exit_code: 1, error: "boom" });
    const statuses: string[] = [];
    const d = deps([done]);

    const outcome = await pollDefinitionRun("r1", "TD-1", "Running", watch(statuses), d);

    expect(outcome).toEqual({ kind: "finished", result: done });
    expect(d.starts).toBe(0);
    expect(statuses).toEqual(["Running"]);
  });
});

describe("the row view", () => {
  it("shows the verdict of a finished run", () => {
    const view = viewOfOutcome({
      kind: "finished",
      result: result({ state: "finished", exit_code: 0, verdict: VERDICT }),
    });

    expect(view).toEqual({ kind: "verdict", verdict: VERDICT });
  });

  it("names the exit code and the error of a failed run", () => {
    const view = viewOfOutcome({
      kind: "finished",
      result: result({ state: "failed", exit_code: 137, error: "the run process died" }),
    });

    expect(view).toEqual({ kind: "failed", text: "Run failed · exit 137 · the run process died" });
  });

  it("reads a finished run with no verdict as a failure", () => {
    const view = viewOfOutcome({
      kind: "finished",
      result: result({ state: "finished", exit_code: 0, error: "no verdict" }),
    });

    expect(view).toEqual({ kind: "failed", text: "Run failed · exit 0 · no verdict" });
  });

  it("says a run is still going after the cap", () => {
    expect(viewOfOutcome({ kind: "timeout", status: "Running" })).toEqual({
      kind: "failed",
      text: "Still running after 5 minutes; check the Job in the Portal",
    });
  });

  it("reads no stored run as nothing to show, and a running one as pending", () => {
    expect(viewOfStored(null)).toEqual({ kind: "idle" });
    expect(viewOfStored(result({ status: "Queued" }))).toEqual({
      kind: "pending",
      text: "Running… (Queued)",
    });
  });
});

describe("summariseEvidence", () => {
  it("prints the evidence as name and value pairs", () => {
    expect(summariseEvidence({ peak_kw: 212.5, ok: true, note: "fine", bins: [1, 2] })).toBe(
      "peak_kw 212.5, ok true, note fine, bins [1,2]",
    );
  });

  it("cuts a long line short and names empty evidence", () => {
    const text = summariseEvidence({ blob: "x".repeat(400) });
    expect(text.length).toBe(161);
    expect(text.endsWith("…")).toBe(true);
    expect(summariseEvidence({})).toBe("no evidence");
  });
});

describe("runErrorMessage", () => {
  it("asks for a Portal login on quixlab_needs_login and passes other refusals through", () => {
    expect(runErrorMessage(new ApiError(401, "no portal token", "quixlab_needs_login"))).toBe(
      NEEDS_LOGIN_MESSAGE,
    );
    expect(runErrorMessage(new ApiError(409, "no template", "quixlab_no_template"))).toBe(
      "no template",
    );
    expect(runErrorMessage(new Error("network"))).toBe("The run could not be started");
  });
});
