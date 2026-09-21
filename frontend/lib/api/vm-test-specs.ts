/**
 * API client for the V-model test specification register.
 *
 * Contract: dev-planning/v-shape-page/api.md §3.
 * `apiGet` already prefixes `/api/v1`; VMODEL_API_BASE supplies the `/vmodel`
 * namespace. Paths are always relative - the Next.js rewrite proxies them to the
 * backend, so no host or port is ever hardcoded in frontend code.
 *
 * @internal - Do not import directly. Use `useVmTestSpecsApi()` from
 * `@/lib/hooks/use-api`.
 */

import { apiGet } from "./client"
import { VMODEL_API_BASE } from "../vmodel/constants"
import type { TestSpec, TestSpecQuery } from "@/types/vmodel"
import type { PaginatedResponse } from "@/types/pagination"

export const vmTestSpecsApi = {
  /**
   * List test specifications. Returns every version by default - there is no
   * version selector and no baseline narrowing in the UI.
   *
   * The list row is already the complete document (`GET /test-specs/{key}`
   * returns the same fields), so the explorer needs no per-selection detail call.
   */
  list: (
    query?: TestSpecQuery,
    token?: string | null,
    refreshToken?: () => Promise<string | null>
  ) => {
    return apiGet<PaginatedResponse<TestSpec>>(
      `${VMODEL_API_BASE}/test-specs`,
      query,
      token,
      refreshToken
    )
  },
}
