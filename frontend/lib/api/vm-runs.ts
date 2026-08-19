/**
 * API client for V-model test runs.
 *
 * Contract: dev-planning/v-shape-page/api.md §6, as implemented in
 * backend/api/routes/vm_runs.py. `apiGet`/`apiPost` already prefix `/api/v1`;
 * VMODEL_API_BASE supplies the `/vmodel` namespace. Paths are always relative -
 * the Next.js rewrite proxies them to the backend, so no host or port is ever
 * hardcoded here.
 *
 * @internal - Do not import directly. Use `useVmRunsApi()` from
 * `@/lib/hooks/use-api`.
 */

import { apiGet, apiPost } from "./client"
import { VMODEL_API_BASE } from "../vmodel/constants"
import type {
  RunCreate,
  RunDetailSummary,
  RunQuery,
  RunSummary,
  Trace,
  VModelRunStatus,
} from "@/types/vmodel"
import type { PaginatedResponse } from "@/types/pagination"

export const vmRunsApi = {
  /**
   * List runs, newest first. Seeded and created runs come back in one union, so a
   * run made in the Add Test Run dialog is the first row.
   */
  list: (
    query?: RunQuery,
    token?: string | null,
    refreshToken?: () => Promise<string | null>
  ) => {
    return apiGet<PaginatedResponse<RunSummary>>(
      `${VMODEL_API_BASE}/runs`,
      query,
      token,
      refreshToken
    )
  },

  /** Get one run: its pinned baseline, planned test cases, uploads and verdict counts. */
  get: (
    runId: string,
    token?: string | null,
    refreshToken?: () => Promise<string | null>
  ) => {
    return apiGet<RunSummary>(
      `${VMODEL_API_BASE}/runs/${encodeURIComponent(runId)}`,
      undefined,
      token,
      refreshToken
    )
  },

  /**
   * Traces attached to a run. An empty array is the normal state for a run created
   * from the dialog - decoding is a later pipeline stage. Only an unknown run id
   * is a 404.
   */
  traces: (
    runId: string,
    token?: string | null,
    refreshToken?: () => Promise<string | null>
  ) => {
    return apiGet<Trace[]>(
      `${VMODEL_API_BASE}/runs/${encodeURIComponent(runId)}/traces`,
      undefined,
      token,
      refreshToken
    )
  },

  /**
   * The per-run summary: every planned test case with its verdict, the requirement
   * coverage the run contributes and the success rate. Valid on a run with no
   * verdicts - every case comes back NOT_RUN.
   */
  summary: (
    runId: string,
    token?: string | null,
    refreshToken?: () => Promise<string | null>
  ) => {
    return apiGet<RunDetailSummary>(
      `${VMODEL_API_BASE}/runs/${encodeURIComponent(runId)}/summary`,
      undefined,
      token,
      refreshToken
    )
  },

  /**
   * Move a run through its execution states. `running` is what the Run action posts;
   * `completed` / `error` are posted by the execution step when it lands. An illegal
   * transition is a 409 with the allowed set in the message.
   */
  setStatus: (
    runId: string,
    status: VModelRunStatus,
    token?: string | null,
    refreshToken?: () => Promise<string | null>
  ) => {
    return apiPost<RunSummary>(
      `${VMODEL_API_BASE}/runs/${encodeURIComponent(runId)}/status`,
      { status },
      token,
      refreshToken
    )
  },

  /**
   * Create a run from the selected test cases. Returns the stored run, already
   * carrying its server-allocated `run_id` and its `planned` status.
   */
  create: (
    payload: RunCreate,
    token?: string | null,
    refreshToken?: () => Promise<string | null>
  ) => {
    return apiPost<RunSummary>(`${VMODEL_API_BASE}/runs`, payload, token, refreshToken)
  },
}
