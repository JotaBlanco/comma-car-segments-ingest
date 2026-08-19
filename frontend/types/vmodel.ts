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

/* ------------------------------------------------------------------ *
 * Test specifications - the second V-model stage.
 * Mirrors GET /api/v1/vmodel/test-specs (9 items, all at v0001 today).
 * ------------------------------------------------------------------ */

/** The machine-evaluable comparison a criterion applies to its reduced value. */
export interface CriterionRule {
  /** "le" | "ge" | "eq" | "within" | "equals_enum" - open set, rendered by name. */
  op: string
  value?: number | string | (number | string)[] | null
  /** Upper bound of a `within` rule. */
  value2?: number | null
  /** "all" | "any" when the rule is evaluated sample-wise. */
  quantifier?: string | null
  [key: string]: unknown
}

/** How the raw signal is reduced to the single value the rule compares. */
export interface CriterionReduce {
  /** "max" | "min" | "mean" | "abs_max" | "derivative" | "time_between_edges" | ... */
  op: string
  from?: Record<string, unknown> | null
  to?: Record<string, unknown> | null
  occurrence?: string | null
  [key: string]: unknown
}

/** The slice of the trace the criterion is evaluated over. */
export interface CriterionWindow {
  /** "full" | "state_mask" | "signal_threshold" | "time_range" | "all_of" */
  type: string
  [key: string]: unknown
}

export interface CriterionTolerance {
  abs?: number | null
  rel?: number | null
}

export interface PassCriterion {
  criterion_id: string
  description: string
  /** Bare requirement id - no "@version" suffix. See lib/vmodel/test-specs.ts. */
  requirement_ref: string
  signal: string
  channel_group: string
  unit?: string | null
  rule: CriterionRule
  reduce: CriterionReduce
  window: CriterionWindow
  tolerance: CriterionTolerance | null
  min_samples: number
  on_missing_signal: string
  resolved_signal?: unknown
  [key: string]: unknown
}

export interface TestSpecDataRequirements {
  min_traces: number
  required_channel_groups: string[]
  required_signals: string[]
  trace_required: boolean
}

export interface TestSpec {
  /** "{tc_id}@{artifact_version}", e.g. "ACC-SYS-TC-001@v0001" */
  key: string
  tc_id: string
  artifact_version: string
  mnemonic: string
  title: string
  objective: string
  /**
   * Bare requirement ids, WITHOUT the "@version" suffix that requirement keys
   * carry. Resolve with `requirementKeyFor()` before building a deep link.
   */
  covers_req_ids: string[]
  entry_criteria: string
  exit_criteria: string
  pass_criteria: PassCriterion[]
  /** "all" | "any" - how the criteria combine into the case verdict. */
  pass_criteria_logic: string
  data_requirements: TestSpecDataRequirements
  preconditions?: Record<string, unknown> | null
  steps?: Record<string, unknown>[] | null
  stimulus?: Record<string, unknown> | null
  technique: string
  priority: string
  status: string
  revision: string
  regression_flag: boolean
  verification_method: string
  test_environment: string
  impl_ref: string | null
  notes: string
  last_change: string | null
  schema_version: string
  canonical_sha256: string
  /**
   * Derived client-side from `covers_req_ids[0]` - the register carries no
   * chapter on a test case. Added by `withDerivedChapter()`, which also makes it
   * an ordinary filter attribute.
   */
  chapter?: string
  /** Anything the backend adds later shows up in the filter automatically. */
  [key: string]: unknown
}

export type TestSpecQuery = {
  tc_id?: string
  status?: string
  artifact_version?: string
  q?: string
  page?: number
  page_size?: number
}
