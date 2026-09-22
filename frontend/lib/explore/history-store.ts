/**
 * Per-run Explore query history (plan §4 follow-on) — module store over
 * localStorage, exposed to React through useSyncExternalStore.
 *
 * Design constraints:
 *  - Only explicit SQL-editor runs record. Viz zoom/pan requeries and AI tool
 *    runs never touch history — the panel is a log of user intent, not
 *    traffic. Recording therefore lives in the SQL pane's run handler, not
 *    inside useExploreQuery.
 *  - Every mutation is read-merge-write: re-read storage, apply, write back.
 *    Two browser tabs on the same run then interleave instead of clobbering
 *    each other's entries with stale in-memory copies.
 *  - A consecutive re-run of the same SQL REPLACES the previous entry —
 *    timestamp bumps, status/row counts/timings update (a run that now fails
 *    must not hide behind a stale green dot) — and a star + label carry over,
 *    so saving a query survives re-running it.
 *  - Cap of 50 unsaved entries, evicted oldest-first. Saved entries are never
 *    evicted.
 *  - Explore is read-only and journal-free by decision D-E5; this history is
 *    device-local convenience state, never registry data.
 */

import { useSyncExternalStore } from "react";

export interface ExploreHistoryEntry {
  id: string;
  sql: string;
  /** Epoch ms at record time. */
  at: number;
  /**
   * "ok" or "error" — nothing else. The old third value ("rejected", from the
   * deleted backend guard's 400 sql_rejected) is gone; a stored entry that
   * still carries it is silently dropped by the read filter, which is fine
   * for device-local convenience state.
   */
  status: "ok" | "error";
  rowCount?: number;
  truncated?: boolean;
  /** Lake round-trip reported by the API (elapsed_ms). */
  lakeMs?: number;
  /** Client-measured wall clock around the request. */
  totalMs?: number;
  /** Error detail, safe to render. */
  detail?: string;
  saved: boolean;
  label?: string;
}

export const HISTORY_VERSION = 1;
export const MAX_UNSAVED_ENTRIES = 50;

export function historyStorageKey(runId: string): string {
  return `tm-explore-history:${runId}`;
}

const EMPTY: ExploreHistoryEntry[] = [];

/** Snapshot cache keyed by run — useSyncExternalStore needs stable references. */
const snapshots = new Map<string, ExploreHistoryEntry[]>();
const listeners = new Set<() => void>();

function isEntry(value: unknown): value is ExploreHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.sql === "string" &&
    typeof entry.at === "number" &&
    (entry.status === "ok" || entry.status === "error") &&
    typeof entry.saved === "boolean"
  );
}

function readEntries(runId: string): ExploreHistoryEntry[] {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(historyStorageKey(runId));
    if (raw === null) return EMPTY;
    const stored = JSON.parse(raw) as { v: number; entries: unknown };
    if (stored.v !== HISTORY_VERSION || !Array.isArray(stored.entries)) return EMPTY;
    return stored.entries.filter(isEntry);
  } catch {
    return EMPTY;
  }
}

function writeEntries(runId: string, entries: ExploreHistoryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      historyStorageKey(runId),
      JSON.stringify({ v: HISTORY_VERSION, entries }),
    );
  } catch {
    // Quota or privacy mode — history is a convenience, never a failure.
  }
}

function commit(runId: string, entries: ExploreHistoryEntry[]): void {
  writeEntries(runId, entries);
  snapshots.set(runId, entries);
  for (const listener of listeners) listener();
}

/** Oldest unsaved entries fall off past the cap; saved entries always stay. */
function evict(entries: ExploreHistoryEntry[]): ExploreHistoryEntry[] {
  let unsaved = entries.filter((entry) => !entry.saved).length;
  if (unsaved <= MAX_UNSAVED_ENTRIES) return entries;
  const kept: ExploreHistoryEntry[] = [];
  // Entries are newest-first; walk from the end (oldest) dropping unsaved.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry.saved && unsaved > MAX_UNSAVED_ENTRIES) {
      unsaved -= 1;
      continue;
    }
    kept.unshift(entry);
  }
  return kept;
}

function entryId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `h-${Math.random().toString(36).slice(2, 10)}`;
}

export function recordExploreHistory(
  runId: string,
  entry: Omit<ExploreHistoryEntry, "id" | "saved">,
): void {
  const entries = readEntries(runId);
  const previous = entries[0];
  if (previous !== undefined && previous.sql === entry.sql) {
    // Consecutive re-run: replace in place, preserving identity + star.
    const replaced: ExploreHistoryEntry = {
      ...entry,
      id: previous.id,
      saved: previous.saved,
      label: previous.label,
    };
    commit(runId, [replaced, ...entries.slice(1)]);
    return;
  }
  commit(runId, evict([{ ...entry, id: entryId(), saved: false }, ...entries]));
}

export function toggleSaved(runId: string, id: string, label?: string): void {
  const entries = readEntries(runId);
  const next = entries.map((entry) =>
    entry.id === id
      ? { ...entry, saved: !entry.saved, label: label ?? entry.label }
      : entry,
  );
  commit(runId, next);
}

export function removeHistoryEntry(runId: string, id: string): void {
  const entries = readEntries(runId);
  commit(runId, entries.filter((entry) => entry.id !== id));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(runId: string): ExploreHistoryEntry[] {
  const cached = snapshots.get(runId);
  if (cached !== undefined) return cached;
  const entries = readEntries(runId);
  snapshots.set(runId, entries);
  return entries;
}

export function useExploreHistory(runId: string): ExploreHistoryEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshot(runId),
    () => EMPTY,
  );
}

/** Test seam — drops the snapshot cache so a cleared localStorage is re-read. */
export function resetHistoryCache(): void {
  snapshots.clear();
}
