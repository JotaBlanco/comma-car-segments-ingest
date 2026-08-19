/**
 * API client for the V-model requirements register.
 *
 * Contract: dev-planning/v-shape-page/api.md §2.
 * `apiGet` already prefixes `/api/v1`; VMODEL_API_BASE supplies the `/vmodel` namespace.
 * Paths are always relative - the Next.js rewrite proxies them to the backend.
 */

import { apiGet } from "./client"
import { VMODEL_API_BASE } from "../vmodel/constants"
import type {
  Requirement,
  RequirementDetail,
  RequirementQuery,
} from "@/types/vmodel"
import type { PaginatedResponse } from "@/types/pagination"

export const vmRequirementsApi = {
  /**
   * List requirements. Returns ALL versions by default - there is no server-side
   * fallback to "the last baseline" and no version selector in the UI.
   */
  list: (
    query?: RequirementQuery,
    token?: string | null,
    refreshToken?: () => Promise<string | null>
  ) => {
    return apiGet<PaginatedResponse<Requirement>>(
      `${VMODEL_API_BASE}/requirements`,
      query,
      token,
      refreshToken
    )
  },

  /**
   * Full detail for one requirement version.
   * @param key "{req_id}@{artifact_version}", e.g. "ACC-SYS-PRF-020@v0003"
   */
  get: (
    key: string,
    token?: string | null,
    refreshToken?: () => Promise<string | null>
  ) => {
    return apiGet<RequirementDetail>(
      `${VMODEL_API_BASE}/requirements/${encodeURIComponent(key)}`,
      undefined,
      token,
      refreshToken
    )
  },
}
