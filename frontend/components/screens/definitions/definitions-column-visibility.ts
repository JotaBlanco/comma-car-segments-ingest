import { useSyncExternalStore } from "react";

/**
 * Which test definition columns this browser hides.
 *
 * Device-local view state, so it lives in `localStorage` and nowhere else —
 * a pasted link carries the filters a colleague applied, not the columns they
 * happen to hide.
 *
 * Read through `useSyncExternalStore` with an empty server snapshot, so the
 * first client render matches the server markup and Next.js reports no
 * hydration mismatch.
 *
 * The version travels in the stored value. A value written by an older
 * version is dropped, which is also what happens to a value this browser
 * refuses to hand over.
 */

export const COLUMN_VISIBILITY_KEY = "tm-columns:definitions";
const COLUMN_VISIBILITY_VERSION = 1;

const EMPTY: readonly string[] = [];

/** `useSyncExternalStore` compares by reference, so the snapshot is cached. */
let snapshot: readonly string[] | null = null;
/** What reads answer with while `localStorage` refuses the write. */
let memory: readonly string[] = EMPTY;
const listeners = new Set<() => void>();

function read(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(COLUMN_VISIBILITY_KEY);
    if (raw === null) return EMPTY;
    const stored = JSON.parse(raw) as { version: number; hidden: readonly string[] };
    return stored.version === COLUMN_VISIBILITY_VERSION ? stored.hidden : EMPTY;
  } catch {
    return memory;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): readonly string[] {
  snapshot ??= read();
  return snapshot;
}

const getServerSnapshot = (): readonly string[] => EMPTY;

/** The hidden column ids, in the order they were hidden. */
export function useHiddenColumns(): readonly string[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function setHiddenColumns(hidden: readonly string[]): void {
  snapshot = hidden;
  memory = hidden;
  try {
    window.localStorage.setItem(
      COLUMN_VISIBILITY_KEY,
      JSON.stringify({ version: COLUMN_VISIBILITY_VERSION, hidden }),
    );
  } catch {
    // Refused or full storage. The choice holds for this tab only.
  }
  for (const listener of listeners) listener();
}

/** Test seam — drops the cache so a cleared `localStorage` is re-read. */
export function resetHiddenColumnsCache(): void {
  snapshot = null;
  memory = EMPTY;
}
