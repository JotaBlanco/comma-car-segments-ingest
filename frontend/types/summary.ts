import type { SourceTag } from "./source";
import type { RunStatus } from "./test-run";

export interface HomeCounts {
  test_runs: number;
  files: number;
  signals: number;
  work_orders: number;
  /** The whole definition mirror. Optional: an API built before this count
      omits the field, and a missing count must read as zero — never as NaN
      in the sidebar. Same rule as `orphaned_definitions` below. */
  test_definitions?: number;
  /** The whole requirements mirror. Optional: an API built before the
      requirement catalog lands sends no field, and a missing count must
      read as zero — never as NaN in the sidebar. */
  requirements?: number;
  runs_today: number;
  files_today: number;
  rig_count: number;
}

export interface NeedsAttention {
  awaiting_work_order: number;
  quarantined_files: number;
  invalid_runs: number;
  /** Definitions that no mirrored work order names (TR-001). Optional: an API
      built before TR-001 omits the field, and a missing count must read as
      zero — never as NaN in the panel's total. */
  orphaned_definitions?: number;
}

/** One run the Needs-attention panel names. `reason` is the engineer's text
    on an invalid-flagged run; an awaiting run carries none. */
export interface AttentionRunRow {
  run_id: string;
  rig_id: string | null;
  reason: string | null;
}

/** One quarantined file the panel names. `quarantine_reason` says why. */
export interface AttentionFileRow {
  file_id: string;
  filename: string | null;
  quarantine_reason: string | null;
}

/** One orphaned test definition the panel names. */
export interface AttentionDefinitionRow {
  td_id: string;
  title: string | null;
}

/**
 * The first rows behind each `NeedsAttention` count. The API caps each list
 * at three rows and reads the same clause as the count, in the same response
 * — so the rows and the count can never drift apart. The count stays the
 * true total, and the panel says how many rows the cap holds back.
 */
export interface AttentionRows {
  awaiting_work_order: AttentionRunRow[];
  quarantined_files: AttentionFileRow[];
  invalid_runs: AttentionRunRow[];
  orphaned_definitions: AttentionDefinitionRow[];
}

export interface RecentRun {
  run_id: string;
  description: string | null;
  definition_id: string | null;
  work_order_id: string | null;
  rig_id: string;
  first_data_at: string;
  status: RunStatus;
}

/** How many tagged metadata fields one source wrote — TR-011.
 *  One field of one document counts once, over the runs, files, signals and
 *  work orders. Every source appears, even at zero, so the card never
 *  reflows between two loads. */
export interface SourceCount {
  source: SourceTag;
  field_count: number;
}

export interface HomeSummary {
  counts: HomeCounts;
  needs_attention: NeedsAttention;
  /** Optional: an API older than 26 Aug 2026 sends counts only. The panel
      then shows the counts and no rows, as it always did. */
  attention_rows?: AttentionRows;
  planning_sync: {
    online: boolean;
    last_sync_at: string | null;
  };
  recent_runs: RecentRun[];
  /** Optional: an API older than 24 Aug 2026 sends no breakdown. */
  source_breakdown?: SourceCount[];
}

export interface SyncResult {
  work_orders: number;
  definitions: number;
  runs_backfilled: number;
}

export interface PlanningSyncStatus {
  online: boolean;
  last_sync_at: string | null;
  last_sync_result: SyncResult | null;
  work_orders_mirrored: number;
}

/** The toggle answers the same body as the status route. */
export type PlanningSyncToggleResponse = PlanningSyncStatus;

/** What planning's push half of one triggered pass reported (24 Aug 2026).
 *  Absent from an API older than that day; null when the push made no
 *  report. `adopted` names the orphan claimed pairs this pass turned into
 *  real work orders and definitions. */
export interface PlanningPushOutcome {
  pushed: boolean;
  runs?: number;
  links?: number;
  adopted?: string[];
  reason?: string;
  counts?: Record<string, number>;
  at?: string;
}

/** The trigger answers the status body plus the push outcome. */
export type PlanningSyncTriggerResult = PlanningSyncStatus & {
  push?: PlanningPushOutcome | null;
};
