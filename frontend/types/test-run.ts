import type { PageParams, Paginated, SortOrder, ViewCounts } from "./common";
import type { FieldSources, SourceTag } from "./source";

export type RunStatus = "complete" | "awaiting_work_order" | "invalid";

/** Sortable column keys for `GET /test-runs` (see contract §2.3). */
export type RunSortKey = "first_data_at";

export interface InvalidFlag {
  flagged: boolean;
  reason: string | null;
  actor: string | null;
  at: string | null;
}

export interface TestRunListItem {
  run_id: string;
  description: string | null;
  /** The FIRST of `definition_ids`. A run fulfils a set of definitions. */
  definition_id: string | null;
  /**
   * Every definition this run fulfils, sorted ascending. Optional here: the
   * API always sends it, and a mock row written before it existed still
   * compiles.
   */
  definition_ids?: string[];
  work_order_id: string | null;
  /** The work-order id the rig claimed at ingest, when the mirror could not
   *  honour it yet — what an awaiting_work_order run is actually waiting on. */
  claimed_work_order_id?: string | null;
  /** The definition id the rig claimed at ingest, unhonoured so far. */
  claimed_definition_id?: string | null;
  project: string | null;
  rig_id: string;
  test_cell: string | null;
  file_count: number;
  signal_count: number;
  first_data_at: string;
  status: RunStatus;
  invalid: InvalidFlag;
}

export interface TestRun extends TestRunListItem {
  operator: string | null;
  bench_sw: string | null;
  started_at: string | null;
  ended_at: string | null;
  result_count: number;
  journal_count: number;
  field_sources: FieldSources;
  created_at: string;
  updated_at: string;
  /** Free key and value pairs a person types. Empty when the run carries none. */
  custom_properties: Record<string, string>;
}

export type RunListFilters = PageParams & {
  status?: readonly RunStatus[];
  rig?: readonly string[];
  project?: readonly string[];
  /** The test cell the run ran in — contract §2 (FR-DM-108). */
  test_cell?: readonly string[];
  /** The source tag of at least one field of the run — contract §2 (TR-011).
   *  The Home "Metadata by source" card deep-links into this filter. */
  source?: readonly SourceTag[];
  definition?: string;
  work_order?: string;
  signal?: string;
  q?: string;
  sort?: RunSortKey;
  order?: SortOrder;
};

/**
 * `GET /test-runs/facets` — the distinct filter values of the WHOLE runs
 * table (contract §2b). The screen used to build its rig list from the
 * newest 200 runs, so an idle rig dropped out of the filter. Each list
 * arrives sorted ascending, nulls and blanks dropped.
 */
export interface RunFacets {
  rigs: string[];
  projects: string[];
  /**
   * Every custom property key any run carries (FR-DM-108). The Group-by
   * control lists them, so a person picks a criterion of their own instead of
   * typing one.
   */
  custom_property_keys: string[];
}

/**
 * The fixed fields `GET /test-runs/groups` can group by — contract §2c.
 *
 * The workbook (FR-DM-108) names five: project, test cell, vehicle, rig and
 * bench. No run document holds a `vehicle` or a `bench` field, so the API
 * offers the three that exist rather than two empty options.
 */
export type RunGroupByField = "project" | "test_cell" | "rig";

/** The prefix that names a custom property as the criterion — contract §2c. */
export const CUSTOM_GROUP_PREFIX = "custom:";

/**
 * Every value `group_by` takes: one of the three fixed fields, or
 * `custom:<property key>` naming a key from `RunFacets.custom_property_keys`.
 * That second half is how a person defines a criterion of their own.
 */
export type RunGroupBy = RunGroupByField | `custom:${string}`;

/** One group of runs. `value` is null for the runs that hold no value. */
export interface RunGroup {
  value: string | null;
  count: number;
}

/**
 * `GET /test-runs/groups` — contract §2c. It is a SECOND answer, never a
 * field on `RunListResponse`: the list shape stays the one the contract pins.
 * `total` counts the groups, because the page holds groups. Sum `count` over
 * every page and you get the `total` of the flat list for the same filters.
 */
export type RunGroupPage = Paginated<RunGroup>;

/** Every filter of the list, plus the required group field. */
export type RunGroupFilters = RunListFilters & { group_by: RunGroupBy };

export interface RunListResponse extends Paginated<TestRunListItem> {
  /** Whole-table quick-view counts (optional, filter-independent). */
  view_counts?: ViewCounts & {
    all: number;
    attention: number;
    invalid: number;
  };
}

/**
 * Body of `PATCH /test-runs/{run_id}` (contract §B #4).
 *
 * The two link fields joined the patchable set on 19 Aug 2026. A stated id must
 * name a mirrored row, so an unknown id answers 422 `unknown_work_order` or 422
 * `unknown_definition`. `project` stays out: it follows the work order, and the
 * route copies it from the mirror row. `test_cell` stays out too: it is
 * embedded identity and no route patches it.
 *
 * A field sent as `null` counts as absent, so this body cannot clear a value.
 */
export interface RunPatchBody {
  description?: string;
  operator?: string;
  bench_sw?: string;
  work_order_id?: string;
  definition_id?: string;
  /**
   * The WHOLE custom property map, never a merge. An absent field changes
   * nothing, and an empty object clears every property. So this one field
   * does not follow the "a null counts as absent" rule above — it has no
   * null, and `{}` is the clear.
   */
  custom_properties?: Record<string, string>;
  actor: string;
  note?: string;
}

export interface InvalidFlagBody {
  reason: string;
  actor: string;
}

export interface RunDeleteBody {
  actor: string;
}

/** What the lakehouse did with a deleted run's samples. */
export interface LakeDeletion {
  table: string;
  /** `deleted` — the folders went. `empty` — the lake held none. `skipped` —
      no lakehouse is configured, so the samples (if any) stay. */
  status: "deleted" | "empty" | "skipped";
  partitions: string[];
  partitions_deleted: number;
}

/** What one run delete removed. Every number is what the registry reported. */
export interface RunDeletionReport {
  run_id: string;
  files: number;
  signals: number;
  results: number;
  blobs_removed: number;
  /** Objects storage would not delete. The registry rows went anyway, so this
      is the one number a person must read: it names bytes left behind. */
  blobs_failed: number;
  lake: LakeDeletion;
}
