/**
 * Saved searches for the list screens (FR-DM-017, saved half; UC-004 clause 5).
 *
 * A saved search is a name plus the canonical query string `buildTableQuery`
 * already builds (lib/table-state.ts). Every list round-trips its whole filter,
 * sort, search and page state through the URL, so a name and that one string
 * restore the screen exactly.
 *
 * Design constraints, all copied from lib/explore/history-store.ts:
 *  - A module store over `localStorage`, read through `useSyncExternalStore`.
 *    The server snapshot is the empty list, so the first client render matches
 *    the server markup and Next.js reports no hydration mismatch. The same
 *    pattern runs the sidebar collapse flag (components/shell/sidebar.tsx).
 *  - Every mutation is read-merge-write: re-read storage, apply, write back.
 *    Two tabs then interleave instead of clobbering each other.
 *  - One `localStorage` key per screen — `tm-saved-searches:runs`,
 *    `:files`, `:signals`, `:work-orders`. A runs filter can never reach the
 *    files screen.
 *  - A refused or full `localStorage` never throws. The store falls back to an
 *    in-memory copy, so the control keeps working for the rest of the tab, and
 *    `savedSearchesPersist` tells the UI to say so.
 *  - This is device-local state. Sharing a search with another person needs a
 *    route, a collection and an owner model, and it is a separate job.
 */

import { useSyncExternalStore } from "react";

export interface SavedSearch {
  id: string;
  /** The name a person typed. Trimmed, never empty. */
  name: string;
  /**
   * Why this search exists. Optional, so the key is absent when nobody wrote
   * one. Every row this store wrote before 24 Aug 2026 carries no key at all,
   * and it must still load.
   */
  description?: string;
  /** Canonical query string from `buildTableQuery`, e.g. `?status=complete`. */
  query: string;
  /** Epoch ms at save time. */
  at: number;
}

/** The screens that own a saved-search list. One storage key each. */
export type SavedSearchScope = "runs" | "files" | "signals" | "work-orders";

/**
 * One saved search plus the screen that owns it. A global list mixes the
 * scopes, and two scopes can hold one name, so the row must say which screen.
 */
export interface ScopedSavedSearch extends SavedSearch {
  readonly scope: SavedSearchScope;
}

/**
 * The keys force this map to grow with the union above: a fifth scope that
 * this object misses is a compile error, so no reader can silently skip it.
 */
const SCOPE_KEYS: Record<SavedSearchScope, null> = {
  runs: null,
  files: null,
  signals: null,
  "work-orders": null,
};

/** Every scope, so a reader of all of them never hard-codes the list. */
export const SAVED_SEARCH_SCOPES = Object.keys(SCOPE_KEYS) as readonly SavedSearchScope[];

export const SAVED_SEARCH_VERSION = 1;
/** A list you cannot scan is as useless as a list you cannot prune. */
export const MAX_SAVED_SEARCHES = 30;
/** Longer names truncate the row and tell a person nothing more. */
export const MAX_NAME_LENGTH = 60;
/**
 * A description needs more room than a name, because it is a sentence. The
 * server caps the field at the same number (`api/api/models/searches.py`), so
 * a description that saves here also saves there.
 */
export const MAX_DESCRIPTION_LENGTH = 200;

export function savedSearchStorageKey(scope: SavedSearchScope): string {
  return `tm-saved-searches:${scope}`;
}

const EMPTY: readonly SavedSearch[] = [];
const EMPTY_SCOPED: readonly ScopedSavedSearch[] = [];

/** Snapshot cache per scope — `useSyncExternalStore` needs stable references. */
const snapshots = new Map<SavedSearchScope, readonly SavedSearch[]>();
/** Snapshot cache for the merged read. A write to any scope drops it. */
let allSnapshot: readonly ScopedSavedSearch[] | undefined;
/** The copy that answers reads when `localStorage` refuses the write. */
const memory = new Map<SavedSearchScope, readonly SavedSearch[]>();
/** Scopes whose last write failed. Their reads come from `memory`. */
const volatileScopes = new Set<SavedSearchScope>();
const listeners = new Set<() => void>();

function isSavedSearch(value: unknown): value is SavedSearch {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    // The description is optional, so an older row that carries no key at all
    // is still a saved search. Only a wrong type fails the check.
    (entry.description === undefined || typeof entry.description === "string") &&
    typeof entry.query === "string" &&
    typeof entry.at === "number"
  );
}

function readEntries(scope: SavedSearchScope): readonly SavedSearch[] {
  if (typeof window === "undefined") return EMPTY;
  if (volatileScopes.has(scope)) return memory.get(scope) ?? EMPTY;
  try {
    const raw = window.localStorage.getItem(savedSearchStorageKey(scope));
    if (raw === null) return EMPTY;
    const stored = JSON.parse(raw) as { v: number; searches: unknown };
    if (stored.v !== SAVED_SEARCH_VERSION || !Array.isArray(stored.searches)) return EMPTY;
    return stored.searches.filter(isSavedSearch);
  } catch {
    // Corrupt JSON, an older version, or a blocked read. Fall back, never throw.
    return memory.get(scope) ?? EMPTY;
  }
}

function commit(scope: SavedSearchScope, searches: readonly SavedSearch[]): void {
  memory.set(scope, searches);
  snapshots.set(scope, searches);
  allSnapshot = undefined;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        savedSearchStorageKey(scope),
        JSON.stringify({ v: SAVED_SEARCH_VERSION, searches }),
      );
      volatileScopes.delete(scope);
    } catch {
      // Quota or privacy mode. The list lives in memory for this tab only.
      volatileScopes.add(scope);
    }
  }
  for (const listener of listeners) listener();
}

function searchId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `s-${Math.random().toString(36).slice(2, 10)}`;
}

function cleanName(name: string): string {
  return name.trim().slice(0, MAX_NAME_LENGTH);
}

/** Trim and cap the description. A blank one is no description at all. */
function cleanDescription(description: string | undefined): string | undefined {
  const trimmed = (description ?? "").trim().slice(0, MAX_DESCRIPTION_LENGTH);
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Save the current query under a name. A second save with the same name
 * overwrites the first, because two rows with one name help nobody.
 * Returns `null` when the name is empty.
 *
 * The description is optional, so a caller that passes none saves exactly as
 * it did before the field existed. `JSON.stringify` drops an `undefined`
 * value, so a row with no description keeps the shape it always had.
 */
export function saveSearch(
  scope: SavedSearchScope,
  name: string,
  query: string,
  description?: string,
): SavedSearch | null {
  const trimmed = cleanName(name);
  if (trimmed.length === 0) return null;
  const searches = readEntries(scope);
  const previous = searches.find((entry) => entry.name.toLowerCase() === trimmed.toLowerCase());
  const saved: SavedSearch = {
    id: previous?.id ?? searchId(),
    name: trimmed,
    description: cleanDescription(description),
    query,
    at: Date.now(),
  };
  const rest = searches.filter((entry) => entry.id !== saved.id);
  commit(scope, [saved, ...rest].slice(0, MAX_SAVED_SEARCHES));
  return saved;
}

/** Rename one saved search. An empty name changes nothing. */
export function renameSavedSearch(scope: SavedSearchScope, id: string, name: string): void {
  const trimmed = cleanName(name);
  if (trimmed.length === 0) return;
  const searches = readEntries(scope);
  commit(
    scope,
    searches.map((entry) => (entry.id === id ? { ...entry, name: trimmed } : entry)),
  );
}

export function removeSavedSearch(scope: SavedSearchScope, id: string): void {
  const searches = readEntries(scope);
  commit(
    scope,
    searches.filter((entry) => entry.id !== id),
  );
}

/** False when the last write failed, so the UI can say the list is temporary. */
export function savedSearchesPersist(scope: SavedSearchScope): boolean {
  return !volatileScopes.has(scope);
}

/** The scope each storage key belongs to, so one event drops one cache. */
const SCOPE_BY_KEY = new Map<string, SavedSearchScope>(
  SAVED_SEARCH_SCOPES.map((scope) => [savedSearchStorageKey(scope), scope]),
);

/**
 * A second tab wrote one of the keys. Drop the caches before the listeners
 * run: React re-reads on the notification, and a cache that still holds the
 * old list answers with the same object, so React renders nothing new.
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
  allSnapshot = undefined;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  // One window listener serves every reader, so one event drops the caches one
  // time and every reader then reads the same new list.
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

function getSnapshot(scope: SavedSearchScope): readonly SavedSearch[] {
  const cached = snapshots.get(scope);
  if (cached !== undefined) return cached;
  const searches = readEntries(scope);
  snapshots.set(scope, searches);
  return searches;
}

/** The server holds no `localStorage`, so it renders an empty list. */
const serverSnapshot = (): readonly SavedSearch[] => EMPTY;

export function useSavedSearches(scope: SavedSearchScope): readonly SavedSearch[] {
  return useSyncExternalStore(subscribe, () => getSnapshot(scope), serverSnapshot);
}

/**
 * Every scope in one list, newest first.
 *
 * One `listeners` set already serves every scope, so one subscription sees
 * every write. That is why this is a single hook and not a loop over
 * `SAVED_SEARCH_SCOPES`: the Rules of Hooks forbid a hook call in a loop over
 * a runtime array, and a fifth scope must not change any caller's hook count.
 */
function getAllSnapshot(): readonly ScopedSavedSearch[] {
  if (allSnapshot !== undefined) return allSnapshot;
  const merged: ScopedSavedSearch[] = [];
  for (const scope of SAVED_SEARCH_SCOPES) {
    for (const entry of getSnapshot(scope)) merged.push({ ...entry, scope });
  }
  merged.sort((a, b) => b.at - a.at);
  allSnapshot = merged;
  return merged;
}

/** The server holds no `localStorage`, so it renders an empty list. */
const serverScopedSnapshot = (): readonly ScopedSavedSearch[] => EMPTY_SCOPED;

export function useAllSavedSearches(): readonly ScopedSavedSearch[] {
  return useSyncExternalStore(subscribe, getAllSnapshot, serverScopedSnapshot);
}

/** Test seam — drops the caches so a cleared `localStorage` is re-read. */
export function resetSavedSearchCache(): void {
  snapshots.clear();
  allSnapshot = undefined;
  memory.clear();
  volatileScopes.clear();
}
