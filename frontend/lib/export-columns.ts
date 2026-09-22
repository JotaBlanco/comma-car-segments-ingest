/**
 * The export column choice of the list screens (FR-DM-018, picker half).
 *
 * A person picks the columns before the export runs. The choice is a list of
 * column headers. An empty list means every column, so a person who picks
 * nothing still gets the whole file.
 *
 * Design constraints, all copied from lib/saved-searches.ts:
 *  - A module store over `localStorage`, read through `useSyncExternalStore`.
 *    The server snapshot is the empty list, so the first client render matches
 *    the server markup and Next.js reports no hydration mismatch.
 *  - Every mutation is read-merge-write: re-read storage, apply, write back.
 *    Two tabs then interleave instead of clobbering each other.
 *  - One `localStorage` key per screen — `tm-export-columns:runs`, `:files`,
 *    `:signals`, `:requirements`. A runs choice can never reach the files
 *    screen.
 *  - A refused or full `localStorage` never throws. The store falls back to an
 *    in-memory copy, so the picker keeps working for the rest of the tab, and
 *    `exportColumnsPersist` tells the UI to say so.
 *  - This is device-local state. Sharing a column set with another person
 *    needs a route, a collection and an owner model, and it is a separate job.
 */

import { useSyncExternalStore } from "react";

/** The screens that own an export column choice. One storage key each. */
export type ExportColumnScope = "runs" | "files" | "signals" | "requirements";

export const EXPORT_COLUMNS_VERSION = 1;

export function exportColumnsStorageKey(scope: ExportColumnScope): string {
  return `tm-export-columns:${scope}`;
}

const EMPTY: readonly string[] = [];

/** Snapshot cache per scope — `useSyncExternalStore` needs stable references. */
const snapshots = new Map<ExportColumnScope, readonly string[]>();
/** The copy that answers reads when `localStorage` refuses the write. */
const memory = new Map<ExportColumnScope, readonly string[]>();
/** Scopes whose last write failed. Their reads come from `memory`. */
const volatileScopes = new Set<ExportColumnScope>();
const listeners = new Set<() => void>();

function readEntries(scope: ExportColumnScope): readonly string[] {
  if (typeof window === "undefined") return EMPTY;
  if (volatileScopes.has(scope)) return memory.get(scope) ?? EMPTY;
  try {
    const raw = window.localStorage.getItem(exportColumnsStorageKey(scope));
    if (raw === null) return EMPTY;
    const stored = JSON.parse(raw) as { v: number; headers: unknown };
    if (stored.v !== EXPORT_COLUMNS_VERSION || !Array.isArray(stored.headers)) return EMPTY;
    return stored.headers.filter((header): header is string => typeof header === "string");
  } catch {
    // Corrupt JSON, an older version, or a blocked read. Fall back, never throw.
    return memory.get(scope) ?? EMPTY;
  }
}

function commit(scope: ExportColumnScope, headers: readonly string[]): void {
  memory.set(scope, headers);
  snapshots.set(scope, headers);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        exportColumnsStorageKey(scope),
        JSON.stringify({ v: EXPORT_COLUMNS_VERSION, headers }),
      );
      volatileScopes.delete(scope);
    } catch {
      // Quota or privacy mode. The choice lives in memory for this tab only.
      volatileScopes.add(scope);
    }
  }
  for (const listener of listeners) listener();
}

/**
 * Store the chosen headers of one screen.
 *
 * The caller passes the headers in the declared order of the screen, so the
 * stored list, the picker and the file all read the same way.
 */
export function setExportColumns(scope: ExportColumnScope, headers: readonly string[]): void {
  // Read-merge-write. The re-read drops a value a second tab already removed.
  readEntries(scope);
  commit(scope, [...headers]);
}

/** Drop the choice of one screen. The export then writes every column. */
export function clearExportColumns(scope: ExportColumnScope): void {
  commit(scope, EMPTY);
}

/** False when the last write failed, so the UI can say the choice is temporary. */
export function exportColumnsPersist(scope: ExportColumnScope): boolean {
  return !volatileScopes.has(scope);
}

/** The scope each storage key belongs to, so one event drops one cache. */
const SCOPE_BY_KEY = new Map<string, ExportColumnScope>(
  (["runs", "files", "signals", "requirements"] as const).map((scope) => [
    exportColumnsStorageKey(scope),
    scope,
  ]),
);

/**
 * A second tab wrote one of the keys. Drop the cache before the listeners
 * run: React re-reads on the notification, and a cache that still holds the
 * old choice answers with the same object, so React renders nothing new.
 */
function onStorage(event: StorageEvent): void {
  // `key` is null when a tab cleared the whole store.
  if (event.key === null) {
    snapshots.clear();
  } else {
    const scope = SCOPE_BY_KEY.get(event.key);
    if (scope === undefined) return;
    snapshots.delete(scope);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  // One window listener serves every reader, so one event drops the cache one
  // time and every reader then reads the same new choice.
  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function getSnapshot(scope: ExportColumnScope): readonly string[] {
  const cached = snapshots.get(scope);
  if (cached !== undefined) return cached;
  const headers = readEntries(scope);
  snapshots.set(scope, headers);
  return headers;
}

/** The server holds no `localStorage`, so it renders the empty choice. */
const serverSnapshot = (): readonly string[] => EMPTY;

export function useExportColumns(scope: ExportColumnScope): readonly string[] {
  return useSyncExternalStore(subscribe, () => getSnapshot(scope), serverSnapshot);
}

/** Test seam — drops the caches so a cleared `localStorage` is re-read. */
export function resetExportColumnsCache(): void {
  snapshots.clear();
  memory.clear();
  volatileScopes.clear();
}
