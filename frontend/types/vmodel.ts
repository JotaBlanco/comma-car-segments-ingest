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

/** One numbered step of a test procedure: what to do, and what to observe. */
export interface TestSpecStep {
  step_no?: number
  action?: string
  expected?: string
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
  steps?: TestSpecStep[] | null
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

/* ------------------------------------------------------------------ *
 * Test runs, traces and results - the right-hand side of the V.
 * Mirrors backend/api/models_vmodel_chain.py (RunSummary, RunCreate, Trace,
 * TestResult) and backend/api/models.py (TcUpload). Verified against the live
 * responses of GET /api/v1/vmodel/runs, /runs/{id}/traces and /results.
 * ------------------------------------------------------------------ */

/** Verdict of one check against one trace. Exactly the backend enum. */
export type VerdictStatus = "PASS" | "FAIL" | "INCONCLUSIVE" | "NOT_RUN"

/** Verdict order used for count summaries and for column order in tables. */
export const VERDICT_ORDER: VerdictStatus[] = ["PASS", "FAIL", "INCONCLUSIVE", "NOT_RUN"]

/**
 * Where a run came from. `seeded` runs are derived from the run/trace join written
 * by the fixture ingest; `planned` runs are stored `tests` documents created by the
 * Add Test Run dialog. A planned run legitimately has no traces and no verdicts.
 */
export type RunOrigin = "seeded" | "planned"

/**
 * One measurement file attached to one planned test case.
 *
 * `upload_id` is the handle the MF4 upload service returns from
 * `POST /upload/direct`; the other fields are echoed back by the backend and are
 * `null` when the client did not send them.
 */
export interface TcUpload {
  tc_id: string
  /** Null when the run is planned from test cases alone and the MF4 is attached later. */
  upload_id: string | null
  filename?: string | null
  blob_path?: string | null
  size_bytes?: number | null
  sha256?: string | null
  attached_utc?: string | null
}

export interface RunSummary {
  run_id: string
  baseline_id: string | null
  label: string | null
  scenario: string | null
  origin: RunOrigin
  trace_keys: string[]
  planned_tc_ids: string[]
  tc_uploads: TcUpload[]
  created_utc: string | null
  evaluated_utc: string | null
  /** Verdict counts, absent keys meaning zero. Empty `{}` on an un-evaluated run. */
  counts: Partial<Record<VerdictStatus, number>>
}

/**
 * The whole Add Test Run payload. `planned_tc_ids` is derived server-side from
 * `tc_uploads`, and nothing about campaigns, devices, environments, operators,
 * dates or sensors is sent - the dialog does not collect any of it.
 */
export interface RunCreate {
  tc_uploads: Array<Pick<TcUpload, "tc_id" | "upload_id"> & Partial<TcUpload>>
  label?: string
  baseline_id?: string
}

/** An MF4 measurement file as catalogued by the backend. Not parsed in this phase. */
export interface Trace {
  trace_key: string
  scenario: string | null
  source_path: string | null
  blob_path: string | null
  content_sha256: string
  size_bytes: number
  uploaded_utc: string | null
  device_id: string | null
  sw_version: string | null
  hw_version: string | null
  mdf_version: string | null
  ingest_status: string
}

/** Per-criterion breakdown of a verdict, when the check reports one. */
export interface ResultCriterion {
  criterion_id: string
  actual: number | null
  bound: number | null
  unit: string | null
  tolerance: number | null
  verdict: string | null
}

/** One verdict for one (run, test case, trace). */
export interface TestResult {
  result_id: string
  run_id: string
  tc_id: string
  impl_id: string | null
  trace_key: string | null
  req_ids: string[]
  verification_tag: string
  title: string
  status: VerdictStatus
  measured: number | null
  bound: number | null
  comparison: string | null
  margin: number | null
  tolerance: number
  unit: string
  window: string
  scope: string
  samples_in_scope: number
  signals: string[]
  /** Populated even on PASS - render it in full, never truncate to a glyph. */
  reason: string
  notes: string[]
  criteria: ResultCriterion[]
  baseline_id: string | null
  evaluated_utc: string | null
}

export type RunQuery = {
  page?: number
  page_size?: number
}

export type ResultQuery = {
  run_id?: string
  tc_id?: string
  req_id?: string
  status?: VerdictStatus
  trace_key?: string
  baseline?: string
  page?: number
  page_size?: number
}
