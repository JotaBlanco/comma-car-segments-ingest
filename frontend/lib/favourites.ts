/**
 * Favourites for the three detail screens and the Home dashboard (FR-DM-075).
 *
 * A favourite is an entity type, an id, a label and the epoch ms at save time.
 * One list holds every type, so Home reads one store and shows one panel.
 *
 * Design constraints, all copied from lib/saved-searches.ts, which copied them
 * from lib/explore/history-store.ts:
 *  - A module store over `localStorage`, read through `useSyncExternalStore`.
 *    The server snapshot is the empty list, so the first client render matches
 *    the server markup and Next.js reports no hydration mismatch. The sidebar
 *    collapse flag runs the same pattern (components/shell/sidebar.tsx).
 *  - Every mutation is read-merge-write: re-read storage, apply, write back.
 *    Two tabs then interleave instead of clobbering each other.
 *  - A refused or full `localStorage` never throws. The store falls back to an
 *    in-memory copy, and `favouritesPersist` tells the UI to say so.
 *  - This is device-local state, exactly like the Explore star it copies.
 *    Sharing a favourite with another person needs a route, a collection and
 *    an owner model, and the row asks for no such thing.
 */

import { useSyncExternalStore } from "react";

/**
 * The entity types a person can star. Each one owns a detail screen.
 *
 * The names copy `JournalEntityType` (types/journal.ts), so one entity reads
 * the same word everywhere.
 */
export type FavouriteType = "run" | "file" | "signal" | "work_order" | "test_definition";

/**
 * What each entity type is called on screen. It sits beside the type, so the
 * Home panel and the topbar menu print one word for one type.
 */
export const FAVOURITE_TYPE_LABEL: Record<FavouriteType, string> = {
  run: "Test run",
  file: "File",
  signal: "Signal",
  work_order: "Work order",
  test_definition: "Test definition",
};

export interface Favourite {
  /** The entity type. It pairs with `id` to name one entity. */
  type: FavouriteType;
  /** The run id, the file id, the signal name, the wo id or the td id. */
  id: string;
  /** What the row prints. The star passes the heading a person saw. */
  label: string;
  /** Epoch ms at save time. */
  at: number;
}

export const FAVOURITES_KEY = "tm-favourites";
export const FAVOURITES_VERSION = 1;
/** A list you cannot scan is as useless as a list you cannot prune. */
export const MAX_FAVOURITES = 50;
/** Longer labels truncate the row and tell a person nothing more. */
export const MAX_LABEL_LENGTH = 120;

const EMPTY: readonly Favourite[] = [];
const TYPES: readonly FavouriteType[] = [
  "run",
  "file",
  "signal",
  "work_order",
  "test_definition",
];

/** Snapshot cache — `useSyncExternalStore` needs a stable reference. */
let snapshot: readonly Favourite[] | undefined;
/** The copy that answers reads when `localStorage` refuses the write. */
let memory: readonly Favourite[] = EMPTY;
/** True when the last write failed. Reads then come from `memory`. */
let volatileStore = false;
const listeners = new Set<() => void>();

function isFavouriteEntry(value: unknown): value is Favourite {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.type === "string" &&
    TYPES.includes(entry.type as FavouriteType) &&
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    typeof entry.label === "string" &&
    typeof entry.at === "number"
  );
}

function readEntries(): readonly Favourite[] {
  if (typeof window === "undefined") return EMPTY;
  if (volatileStore) return memory;
  try {
    const raw = window.localStorage.getItem(FAVOURITES_KEY);
    if (raw === null) return EMPTY;
    const stored = JSON.parse(raw) as { v: number; favourites: unknown };
    if (stored.v !== FAVOURITES_VERSION || !Array.isArray(stored.favourites)) return EMPTY;
    return stored.favourites.filter(isFavouriteEntry);
  } catch {
    // Corrupt JSON, an older version, or a blocked read. Fall back, never throw.
    return memory;
  }
}

function commit(favourites: readonly Favourite[]): void {
  memory = favourites;
  snapshot = favourites;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        FAVOURITES_KEY,
        JSON.stringify({ v: FAVOURITES_VERSION, favourites }),
      );
      volatileStore = false;
    } catch {
      // Quota or privacy mode. The list lives in memory for this tab only.
      volatileStore = true;
    }
  }
  for (const listener of listeners) listener();
}

function same(entry: Favourite, type: FavouriteType, id: string): boolean {
  return entry.type === type && entry.id === id;
}

function cleanLabel(label: string, id: string): string {
  const trimmed = label.trim().slice(0, MAX_LABEL_LENGTH);
  return trimmed.length > 0 ? trimmed : id;
}

/**
 * Star one entity. A second call on the same entity removes it.
 * Returns the state after the call: true when the entity is a favourite now.
 */
export function toggleFavourite(type: FavouriteType, id: string, label: string): boolean {
  if (id.length === 0) return false;
  const favourites = readEntries();
  if (favourites.some((entry) => same(entry, type, id))) {
    commit(favourites.filter((entry) => !same(entry, type, id)));
    return false;
  }
  const saved: Favourite = { type, id, label: cleanLabel(label, id), at: Date.now() };
  commit([saved, ...favourites].slice(0, MAX_FAVOURITES));
  return true;
}

/** Drop one favourite. An entity that is not starred stays unchanged. */
export function removeFavourite(type: FavouriteType, id: string): void {
  const favourites = readEntries();
  commit(favourites.filter((entry) => !same(entry, type, id)));
}

/** False when the last write failed, so the UI can say the list is temporary. */
export function favouritesPersist(): boolean {
  return !volatileStore;
}

/**
 * A second tab wrote the same key. Drop the cache before the listeners run:
 * React re-reads on the notification, and a cache that still holds the old
 * list answers with the same object, so React renders nothing new.
 */
function onStorage(event: StorageEvent): void {
  // `key` is null when a tab cleared the whole store.
  if (event.key !== null && event.key !== FAVOURITES_KEY) return;
  snapshot = undefined;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  // One window listener serves every reader, so one event drops the cache one
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

function getSnapshot(): readonly Favourite[] {
  if (snapshot !== undefined) return snapshot;
  snapshot = readEntries();
  return snapshot;
}

/** The server holds no `localStorage`, so it renders an empty list. */
const serverSnapshot = (): readonly Favourite[] => EMPTY;

export function useFavourites(): readonly Favourite[] {
  return useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
}

/** True when this one entity is starred right now. */
export function useIsFavourite(type: FavouriteType, id: string): boolean {
  return useFavourites().some((entry) => same(entry, type, id));
}

/** The detail screen one favourite links to. */
export function favouriteHref(favourite: Favourite): string {
  const id = encodeURIComponent(favourite.id);
  if (favourite.type === "run") return `/runs/${id}`;
  if (favourite.type === "file") return `/files/${id}`;
  if (favourite.type === "work_order") return `/work-orders/${id}`;
  if (favourite.type === "test_definition") return `/definitions/${id}`;
  return `/signals/${id}`;
}

/** Test seam — drops the caches so a cleared `localStorage` is re-read. */
export function resetFavouritesCache(): void {
  snapshot = undefined;
  memory = EMPTY;
  volatileStore = false;
}
