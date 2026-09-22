import type { JournalEntry } from "@/types";

/** The list screen behind each linkable entity type. */
const ENTITY_PATH = {
  run: "/runs",
  file: "/files",
  signal: "/signals",
  work_order: "/work-orders",
  test_definition: "/definitions",
  requirement: "/requirements",
} as const;

/** An entity type that owns a detail screen. */
export type LinkableEntityType = keyof typeof ENTITY_PATH;

/**
 * The detail screen of one entity. The Audit table, the topbar notification
 * bell and the Home Needs-attention panel all link an id to its screen, so
 * all of them read this one map. A second copy would drift, and a drifted
 * copy sends a person to a dead route.
 */
export function entityHref(entityType: LinkableEntityType, entityId: string): string {
  return `${ENTITY_PATH[entityType]}/${encodeURIComponent(entityId)}`;
}

/**
 * The screen one journal entry opens, or null when it has none.
 *
 * A result owns no detail route — the Results tab of a run holds it — and the
 * journal entry names no run. A result entry therefore carries no link. An
 * export entry is the same case for a different reason: it names a list, not a
 * document, so there is nothing to open.
 */
export function journalEntityHref(entry: JournalEntry): string | null {
  // `result`, `export`, and any entity type this build does not know, all
  // fall outside the map. Never invent a route for them.
  if (!(entry.entity_type in ENTITY_PATH)) return null;
  return entityHref(entry.entity_type as LinkableEntityType, entry.entity_id);
}
