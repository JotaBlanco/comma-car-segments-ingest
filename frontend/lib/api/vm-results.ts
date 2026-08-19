/**
 * API client for V-model verdicts.
 *
 * Contract: dev-planning/v-shape-page/api.md §7, as implemented in
 * backend/api/routes/vm_results.py. One document per (run, test case, trace).
 *
 * @internal - Do not import directly. Use `useVmResultsApi()` from
 * `@/lib/hooks/use-api`.
 */

import { apiGet } from "./client"
import { VMODEL_API_BASE } from "../vmodel/constants"
import type { ResultQuery, TestResult } from "@/types/vmodel"
import type { PaginatedResponse } from "@/types/pagination"

export const vmResultsApi = {
  /**
   * List verdicts. The result view always narrows by `run_id`; the unfiltered list
   * is 333 documents and is never loaded whole.
   */
  list: (
    query?: ResultQuery,
    token?: string | null,
    refreshToken?: () => Promise<string | null>
  ) => {
    return apiGet<PaginatedResponse<TestResult>>(
      `${VMODEL_API_BASE}/results`,
      query,
      token,
      refreshToken
    )
  },
}
