import { ApiError } from "@/lib/api/client";
import {
  getDefinitionRun,
  startDefinitionRun,
  type DefinitionRunJob,
  type DefinitionRunResult,
  type DefinitionVerdict,
} from "@/lib/api/definition-runs";

/**
 * Running a test definition on a run as a QuixLab Job and waiting for its verdict.
 *
 * The API starts the Job and answers at once; this polls until the Job's exit code
 * decides the run. A poll that finds a verdict stores it, so the wait ends there.
 * A Job takes seconds to schedule and about ten to run, so the wait is capped.
 */

/** How often the run is asked whether it is done. */
export const RUN_POLL_MS = 3_000;

/** How long a run is waited for before the row says it is still going. */
export const RUN_GIVE_UP_MS = 5 * 60_000;

/** How many polls in a row may fail before the wait gives up. A 404 is final at once. */
export const RUN_POLL_RETRIES = 3;

/** How much of the evidence a row prints before it cuts the line short. */
const EVIDENCE_CHARS = 160;

/** What a row says when the API refused a run for want of the viewer's Portal token. */
export const NEEDS_LOGIN_MESSAGE =
  "Sign in to the Portal first: a definition run starts as you, and this browser holds no Portal token.";

export type RunOutcome =
  | { kind: "finished"; result: DefinitionRunResult }
  | { kind: "timeout"; status: string }
  | { kind: "abandoned" };

/** What one definition row shows about its run. */
export type RunView =
  | { kind: "idle" }
  | { kind: "pending"; text: string }
  | { kind: "verdict"; verdict: DefinitionVerdict }
  | { kind: "failed"; text: string };

export interface RunDeps {
  start(runId: string, tdId: string): Promise<DefinitionRunJob>;
  read(runId: string, tdId: string): Promise<DefinitionRunResult>;
  wait(ms: number): Promise<void>;
  now(): number;
}

const LIVE: RunDeps = {
  start: startDefinitionRun,
  read: getDefinitionRun,
  wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export interface RunWatch {
  /** Called with the Portal's status word on every poll that is still running. */
  onStatus(status: string): void;
  /** False once the row is gone; the poll stops there. */
  alive(): boolean;
}

/** Poll a Job already going until it finishes, the wait runs out, or the row goes. */
export async function pollDefinitionRun(
  runId: string,
  tdId: string,
  initialStatus: string,
  watch: RunWatch,
  deps: RunDeps = LIVE,
): Promise<RunOutcome> {
  const giveUpAt = deps.now() + RUN_GIVE_UP_MS;
  let status = initialStatus;
  let failures = 0;
  while (deps.now() < giveUpAt) {
    watch.onStatus(status);
    await deps.wait(RUN_POLL_MS);
    if (!watch.alive()) return { kind: "abandoned" };
    let result: DefinitionRunResult;
    try {
      result = await deps.read(runId, tdId);
    } catch (caught: unknown) {
      failures += 1;
      const gone = caught instanceof ApiError && caught.status === 404;
      if (gone || failures > RUN_POLL_RETRIES) throw caught;
      continue;
    }
    failures = 0;
    if (result.state !== "running") return { kind: "finished", result };
    status = result.status;
  }
  return { kind: "timeout", status };
}

/** Start the definition's Job on the run, then poll it until it decides. */
export async function runDefinition(
  runId: string,
  tdId: string,
  watch: RunWatch,
  deps: RunDeps = LIVE,
): Promise<RunOutcome> {
  const job = await deps.start(runId, tdId);
  return pollDefinitionRun(runId, tdId, job.status, watch, deps);
}

/** The row text while a Job runs. */
export function runningText(status: string): string {
  return `Running… (${status.trim() || "queued"})`;
}

function failedText(result: DefinitionRunResult): string {
  return `Run failed · exit ${result.exit_code ?? "?"} · ${result.error ?? "no reason given"}`;
}

/** What the row shows once the wait is over. */
export function viewOfOutcome(outcome: RunOutcome): RunView {
  if (outcome.kind === "abandoned") return { kind: "idle" };
  if (outcome.kind === "timeout") {
    return {
      kind: "failed",
      text: `Still ${outcome.status.trim().toLowerCase() || "running"} after ${
        RUN_GIVE_UP_MS / 60_000
      } minutes; check the Job in the Portal`,
    };
  }
  const { result } = outcome;
  if (result.state === "finished" && result.verdict !== null) {
    return { kind: "verdict", verdict: result.verdict };
  }
  return { kind: "failed", text: failedText(result) };
}

/** What the row shows for the answer it read on mount; null means no run yet. */
export function viewOfStored(result: DefinitionRunResult | null): RunView {
  if (result === null) return { kind: "idle" };
  if (result.state === "running") return { kind: "pending", text: runningText(result.status) };
  return viewOfOutcome({ kind: "finished", result });
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return JSON.stringify(value) ?? String(value);
}

/** The evidence on one line: `name value` pairs, cut short past a fixed length. */
export function summariseEvidence(evidence: Record<string, unknown>): string {
  const text = Object.entries(evidence)
    .map(([name, value]) => `${name} ${valueText(value)}`)
    .join(", ");
  if (text.length === 0) return "no evidence";
  return text.length > EVIDENCE_CHARS ? `${text.slice(0, EVIDENCE_CHARS)}…` : text;
}

/** The sentence a row shows for a refused start or poll. */
export function runErrorMessage(caught: unknown): string {
  if (caught instanceof ApiError) {
    return caught.code === "quixlab_needs_login" ? NEEDS_LOGIN_MESSAGE : caught.message;
  }
  return "The run could not be started";
}

/** What one row tells its panel, so the panel's Run all knows what it would start. */
export interface RowRunState {
  runnable: boolean;
  pending: boolean;
  /** True while the row still reads whether its definition has an implementation. */
  loading: boolean;
}

/** How many rows Run all would start, and why it cannot, if it cannot. */
export interface RunAllPlan {
  count: number;
  blocked: string | null;
}

/** The Run all plan over the panel's ids; an id with no report yet counts as loading. */
export function planRunAll(
  ids: readonly string[],
  rows: ReadonlyMap<string, RowRunState>,
): RunAllPlan {
  const states = ids.map((id) => rows.get(id));
  const count = states.filter((state) => state?.runnable && !state.pending).length;
  if (states.some((state) => state === undefined || state.loading)) {
    return { count, blocked: "Reading the definitions…" };
  }
  if (states.some((state) => state?.pending)) {
    return { count, blocked: "Wait for the runs already going to finish" };
  }
  if (count === 0) return { count, blocked: "No definition here has an implementation to run" };
  return { count, blocked: null };
}
