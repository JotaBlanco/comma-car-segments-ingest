/**
 * TypeScript types for the V-model artifact chain.
 * Mirrors backend/api/models_vmodel.py and dev-planning/v-shape-page/data-model.md.
 */

export type RequirementStatus =
  | "Draft"
  | "Reviewed"
  | "Approved"
  | "Rejected"
  | "Obsolete"

/** Statuses that mean the requirement is retired but must stay visible and findable. */
export const RETIRED_REQUIREMENT_STATUSES: RequirementStatus[] = ["Rejected", "Obsolete"]

export interface Measurand {
  name: string
  unit: string
}

export interface Requirement {
  /** "{req_id}@{artifact_version}", e.g. "ACC-SYS-PRF-020@v0003" */
  key: string
  req_id: string
  artifact_version: string
  chapter: string
  title: string
  text: string
  ears_pattern: string
  system_states: string[]
  rationale: string
  source: string[]
  verification_tag: string
  verification_method: string
  measurand: Measurand[]
  status: RequirementStatus
  revision: string
  figure_refs: string[]
  related_reqs: string[]
  /** Empty in the source data until the test phase. Not the coverage source. */
  verified_by: string[]
  last_change: string | null
  schema_version: string
  canonical_sha256: string
  /** Anything the backend adds later shows up in the filter automatically. */
  [key: string]: unknown
}

export interface FigureReference {
  figure_id: string
  title: string
  url: string
}

export interface RequirementDetail extends Requirement {
  figures: FigureReference[]
  available_versions: string[]
  baseline_ids: string[]
  covering_tc_ids: string[]
}

export type RequirementQuery = {
  req_id?: string
  chapter?: string
  status?: RequirementStatus
  artifact_version?: string
  q?: string
  page?: number
  page_size?: number
}
