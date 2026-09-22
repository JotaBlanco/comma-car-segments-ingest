import type { PageParams, Paginated, SortOrder, ViewCounts } from "./common";
import type { FieldSources, SourceTag } from "./source";
import type { RunStatus } from "./test-run";

/** Sortable column keys for `GET /signals` (see contract §2.3). */
export type SignalSortKey = "name" | "typical_rate_hz" | "run_count" | "last_seen";

/** The numbers one signal carries.
 *  The first four are always present. `rms`, `p50`, `p95` and `p99` are
 *  optional (FR-DM-014): a producer may measure none of them, and a percentile
 *  does not merge over two files, so a multi-file run serves all three as
 *  null. Null means "nobody measured this". A screen prints a dash, never a
 *  zero. */
export interface SignalStats {
  min: number;
  max: number;
  mean: number;
  std: number;
  rms?: number | null;
  p50?: number | null;
  p95?: number | null;
  p99?: number | null;
}

/** Per-file / per-run signal row (file detail `signals`, run signals tab). */
export interface FileSignal {
  name: string;
  unit: string | null;
  unit_source: SourceTag | null;
  rate_hz: number;
  dtype: string;
  stats: SignalStats | null;
}

/** Why a run-signals page carries blank numbers (contract #7).
 *  The route reads the registry alone, so a blank number means the ingestion
 *  pipeline measured nothing for that signal. `not_measured` means no signal
 *  of the run carries numbers; `partly_measured` means some do and some do
 *  not. Absent means every row carries numbers. */
export interface StatsUnavailable {
  reason: "not_measured" | "partly_measured";
  detail: string;
}

/** `GET /test-runs/{run_id}/signals` envelope. */
export interface RunSignalPage extends Paginated<FileSignal> {
  /** Optional, as the OpenAPI snapshot declares it: an older API and the
   *  built-in mock both answer a page without the key. Absent reads the same
   *  as null — every row of this page carries measured numbers. */
  stats_unavailable?: StatsUnavailable | null;
}

export interface SignalCatalogEntry {
  name: string;
  description: string | null;
  unit: string | null;
  unit_source: SourceTag | null;
  dtype: string;
  typical_rate_hz: number;
  run_count: number;
  first_seen: string;
  last_seen: string;
}

export interface SignalDetail extends SignalCatalogEntry {
  sensor_ref: string | null;
  catalogue_ref: string | null;
  rig_ids: string[];
  /** Every system that produced a file carrying this signal (FR-DM-111).
   *  Optional: a row written before the field existed carries none. */
  source_systems?: string[];
  field_sources: FieldSources;
}

export interface SignalRunStat {
  run_id: string;
  definition_id: string | null;
  rig_id: string;
  run_date: string;
  status: RunStatus;
  min: number;
  max: number;
  mean: number;
  std: number;
  /** Optional, as `SignalStats` explains. The lake computes all four, so a
   *  lake-served row carries them; a registry-served multi-file run does not. */
  rms?: number | null;
  p50?: number | null;
  p95?: number | null;
  p99?: number | null;
}

export interface SignalRunStatsResponse {
  name: string;
  unit: string | null;
  window: "run";
  items: SignalRunStat[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export type SignalListFilters = PageParams & {
  unit?: readonly string[];
  missing_unit?: boolean;
  rig?: readonly string[];
  rate?: readonly number[];
  /** Exact match on the stored data type — contract §14 (FR-DM-111). */
  dtype?: readonly string[];
  /** Matches the `source_systems` array of the catalog row (FR-DM-111). */
  source_system?: readonly string[];
  /** Provenance tag on the `field_sources` map of the row (TR-011). A row
   *  matches when at least one of its fields carries one of the named tags. */
  source?: readonly SourceTag[];
  q?: string;
  sort?: SignalSortKey;
  order?: SortOrder;
};

export interface SignalListResponse extends Paginated<SignalCatalogEntry> {
  /** Whole-table quick-view counts (optional, filter-independent). */
  view_counts?: ViewCounts & {
    all: number;
    missing_unit: number;
  };
}

/**
 * `GET /signals/facets` — the distinct filter values of the WHOLE catalog
 * (contract §14b). One page of `/signals` covers 8 per cent of 6,412 signals,
 * so a filter list built from a page misses most of the values.
 * Each list arrives sorted ascending.
 */
export interface SignalFacets {
  units: string[];
  rates: number[];
  rigs: string[];
  /** Added 24 Aug 2026 (FR-DM-111). Optional here, and always sent by the
   *  API: a test double written before this date states three lists. */
  dtypes?: string[];
  source_systems?: string[];
}

export type SignalStatsFilters = PageParams & {
  window?: "run";
  definition?: string;
  rig?: string;
  include_invalid?: boolean;
};

export interface SignalPatchBody {
  unit?: string;
  description?: string;
  sensor_ref?: string;
  actor: string;
  note?: string;
  context_run_id?: string;
}
