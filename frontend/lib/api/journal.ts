import type {
  JournalEntityType,
  JournalEntry,
  JournalListFilters,
  Paginated,
} from "@/types";
import { api } from "./client";

/**
 * What a caller states when a person writes a note on any entity.
 *
 * The run keeps its own note route (`POST /test-runs/{run_id}/journal`), so
 * this shape serves the other five entity types: file, signal, work order,
 * result and test definition.
 */
export interface JournalNoteInput {
  entity_type: JournalEntityType;
  entity_id: string;
  note: string;
  actor: string;
}

/**
 * What a caller states when a person asks for access to one entity.
 *
 * `reason` is the only part a human reviewer can act on, so the route refuses
 * a blank one with 422.
 */
export interface AccessRequestInput {
  entity_type: JournalEntityType;
  entity_id: string;
  reason: string;
  actor: string;
}

export const journalApi = {
  /**
   * Read the journal across every entity — `GET /journal`.
   *
   * The six entity reads each answer one entity. This one answers the audit
   * question: who changed this field, and what did this person do last week.
   */
  list: (filters: JournalListFilters = {}) =>
    api.get<Paginated<JournalEntry>>("/journal", { ...filters }),

  /**
   * Add a person's note to any entity — `POST /journal`.
   *
   * The generic route takes events only: `JournalEventRequest` in
   * `api/api/models/journal.py` pins `kind` to `"event"` and requires `field`,
   * `source` and `at`. A note therefore rides as a `note` event with the
   * `manual` source — the timeline shows the note text either way, and the
   * journal names the signed-in person. The route checks the entity exists
   * and answers the entity's own 404 code for a stale id, because an entry
   * is append-only and the check is the one chance to refuse it.
   */
  addNote: ({ entity_type, entity_id, note, actor }: JournalNoteInput) =>
    api.post<JournalEntry>("/journal", {
      entity_type,
      entity_id,
      field: "note",
      kind: "event",
      source: "manual",
      actor,
      note,
      // The route keeps the caller's `at` and stamps its own `received_at`
      // beside it, so the browser clock here can never rewrite history.
      at: new Date().toISOString(),
    }),

  /**
   * Record a request for access to one entity — `POST /access-requests`.
   *
   * **The registry grants nothing.** It holds no scoped access at all: the
   * only check is workspace `Read` through the Quix Portal. The route writes
   * one journal event with the field `access.requested` and the stated reason
   * as the note, and a person acts on it outside this system. Contract
   * §D-Access.
   */
  requestAccess: ({ entity_type, entity_id, reason, actor }: AccessRequestInput) =>
    api.post<JournalEntry>("/access-requests", { entity_type, entity_id, reason, actor }),
};
