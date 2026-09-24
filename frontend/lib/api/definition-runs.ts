import type { VerdictOutcome } from "@/types";
import { api } from "./client";

/**
 * One test definition run on one test run as a QuixLab headless Job
 * (`api/api/routers/definition_runs.py`).
 *
 * Both calls run as the viewer: `client.ts` adds the `x-portal-token` header, and the
 * API answers 401 `quixlab_needs_login` without it.
 */

/** The Job the Portal accepted, or the one already going on this pair. */
export interface DefinitionRunJob {
  id: string;
  name: string;
  /** The Portal's own word, passed through. */
  status: string;
}

/** The verdict block of the stored `processed_results` document. */
export interface DefinitionVerdict {
  definition_id: string;
  outcome: VerdictOutcome;
  evidence: Record<string, unknown>;
  implementation_sha256: string;
}

/** Where a definition run stands. `state` follows the Job's exit code, never `status` alone. */
export interface DefinitionRunResult {
  /** The Job's deployment id; null once the Job was deleted after its verdict was stored. */
  id: string | null;
  name: string;
  state: "running" | "finished" | "failed";
  status: string;
  exit_code: number | null;
  quixlab_run_id: string | null;
  error: string | null;
  result_id: string | null;
  verdict: DefinitionVerdict | null;
}

function path(runId: string, tdId: string): string {
  return `/test-runs/${encodeURIComponent(runId)}/definitions/${encodeURIComponent(tdId)}/run`;
}

/** Start the definition's notebook on this run. A Job still going on the pair is answered as-is. */
export function startDefinitionRun(runId: string, tdId: string): Promise<DefinitionRunJob> {
  return api.post<DefinitionRunJob>(path(runId, tdId), {});
}

/** Where the pair's Job stands, or its stored verdict. 404 `run_job_not_found` when neither exists. */
export function getDefinitionRun(runId: string, tdId: string): Promise<DefinitionRunResult> {
  return api.get<DefinitionRunResult>(path(runId, tdId));
}
