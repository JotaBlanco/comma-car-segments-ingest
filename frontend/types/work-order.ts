import type { PageParams, Paginated, ViewCounts } from "./common";
import type { SourceTag } from "./source";
import type { RunStatus } from "./test-run";

export type WorkOrderStatus = "active" | "closed";

export type DefinitionStatus = "on_plan" | "awaiting_data";

/**
 * What the runs decided about a test definition, beside `DefinitionStatus`,
 * which is plan adherence. `not_run` — no run carries it; `no_verdict` — a
 * run carries it and nothing judged it; the other three are the outcome of
 * its latest verdict. `error` is never a failure: the evaluator could not
 * decide.
 */
export type DefinitionVerdictState =
  | "not_run"
  | "no_verdict"
  | "passed"
  | "failed"
  | "error";

/** The verdict that decided `verdict_state`, and where it came from. */
export interface DefinitionVerdictRef {
  run_id: string;
  result_id: string;
  outcome: "pass" | "fail" | "error";
  produced_at: string | null;
}

export interface WorkOrderListItem {
  wo_id: string;
  title: string;
  project: string;
  status: WorkOrderStatus;
  definition_count: number;
  run_count: number;
  /**
   * Who wrote the row: `api:planning` for a mirrored campaign, `manual` for
   * one opened in the Test Manager. Absent on a row served before the field
   * existed, and those all came from planning.
   */
  origin?: SourceTag;
  /** Null on a work order a person opened here — it synced from nowhere. */
  synced_at: string | null;
}

export interface WorkOrderDefinition {
  td_id: string;
  title: string;
  planned_runs: number;
  actual_runs: number;
  status: DefinitionStatus;
}

export interface WorkOrderRunRollup {
  run_id: string;
  /** The FIRST of `definition_ids`. A run fulfils a set of definitions. */
  definition_id: string | null;
  /** Every definition this run fulfils, sorted ascending. Empty when none. */
  definition_ids?: string[];
  rig_id: string;
  test_cell: string | null;
  first_data_at: string;
  file_count: number;
  signal_count: number;
  status: RunStatus;
}

export interface WorkOrderDetail {
  wo_id: string;
  title: string;
  project: string;
  status: WorkOrderStatus;
  requestor: string | null;
  department: string | null;
  priority: string | null;
  created_at_source: string | null;
  /** See `WorkOrderListItem.origin`. */
  origin?: SourceTag;
  synced_at: string | null;
  definitions: WorkOrderDefinition[];
  runs: WorkOrderRunRollup[];
}

/**
 * Body of `POST /work-orders` — a campaign a person opens in the Test
 * Manager. The row is written at source `manual`; planning's own campaigns
 * arrive through `POST /planning/sync` and never here. `status` starts
 * `active` and the server decides it.
 */
export interface WorkOrderCreateBody {
  wo_id: string;
  title: string;
  project?: string;
  note?: string;
}

/**
 * Body of `PATCH /work-orders/{wo_id}`. The status is the one field a person
 * authors on a work order — planning owns the title, the project and the rest,
 * and the route answers 422 to any other key.
 */
export interface WorkOrderStatusBody {
  status: WorkOrderStatus;
}

/** What `DELETE /work-orders/{wo_id}` reports: the id, and the definitions that went with it. */
export interface WorkOrderDeletionReport {
  wo_id: string;
  definitions: number;
}

export type WorkOrderListFilters = PageParams & {
  status?: readonly WorkOrderStatus[];
  project?: readonly string[];
  q?: string;
};

/**
 * `GET /work-orders/facets` — the distinct project values of the WHOLE
 * mirror (contract §10b). The screen used to hard-code its project list, so
 * a newly mirrored project never reached the filter. The list arrives sorted
 * ascending, blanks dropped.
 */
export interface WorkOrderFacets {
  projects: string[];
}

export interface WorkOrderListResponse extends Paginated<WorkOrderListItem> {
  /** Whole-table quick-view counts (optional, filter-independent). */
  view_counts?: ViewCounts & {
    all: number;
    active: number;
    closed: number;
  };
}

/**
 * Row of GET /test-definitions. A definition is orphaned when it names no
 * work order, or when it names one that this registry does not mirror.
 */
export interface TestDefinitionListItem {
  td_id: string;
  title: string;
  work_order_id: string | null;
  planned_runs: number;
  actual_runs: number;
  /** Plan adherence: runs recorded against runs planned. Never an outcome. */
  status: DefinitionStatus;
  orphaned: boolean;
  synced_at: string;
  /** What the latest verdict decided, and the verdict that decided it.
      Derived by the API on every read, never stored. Optional: an API built
      before the verdict rollups shipped sends no field. */
  verdict_state?: DefinitionVerdictState;
  latest_verdict?: DefinitionVerdictRef | null;
  /** The requirements this definition verifies — authored, mirrored by
      planning (requirement-status-from-runs spec §5.2/§7.2). On both the
      list row and the detail, so the two never disagree. Optional: an API
      built before the requirement catalog lands sends no field. */
  covers_req_ids?: string[];
}

/**
 * The work order a definition belongs to. Null on an orphan — the registry
 * never creates a work order to repair a link.
 */
export interface TestDefinitionWorkOrder {
  wo_id: string;
  title: string;
  project: string;
  status: WorkOrderStatus;
}

/**
 * One requirements document on a test definition.
 *
 * The name is unique inside one definition, and it addresses the document on
 * the delete route and on the download route. Planning owns a `planning`
 * document, so nobody removes one here; a person owns a `manual` document, and
 * `updated_by` names that person.
 *
 * **A document holds text or bytes, never both.**
 *
 * - A TEXT document carries `content` (UTF-8, markdown or plain) and
 *   `render_markdown`. `storage_ref` is null.
 * - A BINARY document carries `storage_ref`, `content_type` and `size_bytes`.
 *   `content` is the empty string and `render_markdown` is null: bytes carry
 *   no markdown, so the screen shows no switch for one. The bytes come back
 *   from `GET .../requirements-files/{name}/download`.
 *
 * The four fields below are optional here on purpose. The API always sends
 * them, and a test factory or a mock row written before they existed still
 * compiles. The screen falls back to the same rule the API applies.
 */
export interface RequirementsFile {
  name: string;
  content: string;
  source: "planning" | "manual";
  updated_at: string;
  updated_by: string | null;
  /** True renders markdown, false renders plain text, null means bytes. */
  render_markdown?: boolean | null;
  /** The blob the bytes live in, or null on a text document. */
  storage_ref?: string | null;
  /** The type the browser stated at upload. A DISPLAY LABEL only. */
  content_type?: string | null;
  size_bytes?: number | null;
}

/** The body of POST /test-definitions/{td_id}/requirements-files. */
export interface RequirementsFileCreate {
  name: string;
  content: string;
  /** Absent takes the default off the name: `.md` is markdown, else plain. */
  render_markdown?: boolean;
}

/**
 * The body of PATCH /test-definitions/{td_id}/requirements-files/{name}.
 *
 * It carries **no name**: the path names the document, and the route never
 * renames one. An absent `render_markdown` keeps the stored flag.
 */
export interface RequirementsFileEdit {
  content: string;
  render_markdown?: boolean;
}

/**
 * The executable test implementation of one definition — one `.py` in blob.
 *
 * It is named by path AND by the sha256 of its bytes, so a verdict can state
 * the exact code that produced it. `entrypoint` is the module-level function a
 * runner calls: `evaluate(run_id, table) -> {verdict, evidence}`.
 *
 * The bytes come back from
 * `GET /test-definitions/{td_id}/implementation/download`.
 */
export interface DefinitionImplementation {
  blob_path: string;
  filename: string;
  sha256: string;
  size_bytes: number;
  language: string;
  entrypoint: string;
  uploaded_at: string;
  uploaded_by: string | null;
}

/**
 * GET /test-definitions/{td_id}. The list row, plus the work order and the
 * runs that carry the definition. The detail extends the row, so no field
 * reads one way on the list and another way here.
 */
export interface TestDefinitionDetail extends TestDefinitionListItem {
  work_order: TestDefinitionWorkOrder | null;
  runs: WorkOrderRunRollup[];
  /** The API sorts the list: manual first, then by name. Empty by default. */
  requirements_files: RequirementsFile[];
  /** Null until a `.py` has been uploaded for this definition. */
  implementation?: DefinitionImplementation | null;
  /**
   * Free name and value pairs a person types. They always carry the source
   * `manual`: they live in their own store beside the mirror, so a planning
   * sync pass never writes and never erases one.
   */
  custom_properties: Record<string, string>;
}

/** The body of PATCH /test-definitions/{td_id}/custom-properties. */
export interface DefinitionCustomPropertiesBody {
  /** The whole map, never a merge. An empty object clears every property. */
  custom_properties: Record<string, string>;
  note?: string;
}

/** What that route answers. */
export interface DefinitionCustomProperties {
  custom_properties: Record<string, string>;
}

/**
 * `GET /test-definitions/facets` — the distinct filter values of the WHOLE
 * definition mirror, sorted ascending. The three dropdowns of the Test
 * definitions page read this one answer, so each offers every value the
 * mirror holds rather than the values of the page on screen.
 *
 * `statuses` is `string[]` and not `DefinitionStatus[]`: the API derives it
 * from planned versus actual runs and reports the states the mirror really
 * holds, which is a subset of the two the union allows.
 */
export interface TestDefinitionFacets {
  work_orders: string[];
  statuses: string[];
  requirements: string[];
}

/**
 * `GET /test-definitions` query. `work_order`, `status` and `requirement` are
 * repeated params (OR inside one key, AND across keys), `q` is a
 * case-insensitive substring over `td_id` and `title`, and `orphaned` is the
 * tri-state the Home panel deep-links. The route whitelists no sort key: it
 * always orders by the id ascending.
 */
export type TestDefinitionListFilters = PageParams & {
  q?: string;
  work_order?: readonly string[];
  status?: readonly DefinitionStatus[];
  requirement?: readonly string[];
  orphaned?: boolean;
};

export type TestDefinitionListResponse = Paginated<TestDefinitionListItem>;
