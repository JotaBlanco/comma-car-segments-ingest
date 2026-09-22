import type { PageParams } from "./common";
import type { SourceTag } from "./source";

export type JournalEntityType =
  | "run"
  | "file"
  | "signal"
  | "work_order"
  | "result"
  | "test_definition"
  /* A whole-list CSV export (`api/api/services/exports.py`). It names no
     stored document: the entity id is the list a person exported, so an
     export row carries no detail link. */
  | "export";

export type JournalKind = "change" | "event" | "note";

/**
 * Body of `POST /test-runs/{run_id}/journal`.
 *
 * The route accepts these two keys and refuses every other one, because
 * `RequestModel` sets `extra="forbid"` (`api/api/models/journal.py`).
 */
export interface NoteCreateBody {
  note: string;
  actor: string;
}

export interface JournalEntry {
  id: string;
  entity_type: JournalEntityType;
  entity_id: string;
  field: string | null;
  kind: JournalKind;
  old: string | null;
  new: string | null;
  source: SourceTag;
  actor: string;
  /**
   * Portal user id when the Quix platform verified the actor.
   * Null when the actor is a caller claim or a service name.
   */
  actor_id: string | null;
  note: string | null;
  at: string;
}

/**
 * The query of `GET /journal`, the cross-entity audit read (FR-DM-055).
 *
 * Every key is optional, and the keys combine with AND. `entity_type`,
 * `entity_id`, `field`, `actor`, `source` and `kind` match the stored value
 * exactly. `since` and `until` bound `at`, and both bounds are inclusive.
 * Both carry an ISO-8601 date-time.
 */
export type JournalListFilters = PageParams & {
  entity_type?: JournalEntityType;
  entity_id?: string;
  field?: string;
  actor?: string;
  /** One `Source` enum tag. The data steward's cut: every manual override. */
  source?: SourceTag;
  kind?: JournalKind;
  since?: string;
  until?: string;
};
