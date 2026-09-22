/**
 * The wire shape of a saved search the server stores (contract §D DS-9).
 *
 * `lib/saved-searches.ts` holds a **second** kind of saved search, the one
 * that lives in this browser alone. The two never share a store and neither
 * one replaces the other, so the names stay apart: `SavedSearch` is the device
 * row, `ServerSavedSearch` is the stored row.
 */

/** Who reads one stored search. The requirement row names these two states. */
export type SavedSearchVisibility = "personal" | "team";

export interface ServerSavedSearch {
  search_id: string;
  scope: "runs" | "files" | "signals";
  name: string;
  /**
   * Why this search exists. Optional, so it is null when nobody wrote one,
   * and an older API may omit the key.
   */
  description?: string | null;
  query: string;
  visibility: SavedSearchVisibility;
  /** The name the owner carried at save time. */
  owner: string;
  /**
   * The stable Portal user id of the owner. Null when the platform proved
   * nobody, which is the demo path. An older API may omit the key.
   */
  owner_id?: string | null;
  saved_at: string;
}
