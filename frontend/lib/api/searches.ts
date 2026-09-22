import type { Paginated, SavedSearchVisibility, ServerSavedSearch } from "@/types";
import { api } from "./client";

/** The list screens that own a saved-search list. Contract §D DS-9. */
export type SavedSearchApiScope = "runs" | "files" | "signals" | "work-orders";

export interface SavedSearchCreateBody {
  scope: SavedSearchApiScope;
  name: string;
  /** Optional. Omit it, or send null, when nobody wrote one. */
  description?: string | null;
  query: string;
  visibility: SavedSearchVisibility;
  actor: string;
}

/**
 * The saved-search routes (contract §D DS-9).
 *
 * Every call names the actor. The routes read it to decide who owns a row,
 * and the delete route refuses a caller who owns nothing.
 */
export const savedSearchesApi = {
  list: (scope: SavedSearchApiScope, actor: string) =>
    api.get<Paginated<ServerSavedSearch>>("/saved-searches", { scope, actor, page_size: 50 }),
  create: (body: SavedSearchCreateBody) => api.post<ServerSavedSearch>("/saved-searches", body),
  /* 204, no body. See `api.deleteVoid`. */
  remove: (searchId: string, actor: string) =>
    api.deleteVoid(`/saved-searches/${encodeURIComponent(searchId)}`, { actor }),
};
