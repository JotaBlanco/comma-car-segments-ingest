"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { savedSearchesApi, type SavedSearchApiScope } from "@/lib/api/searches";
import { usePortalAuth, usePortalUser } from "@/lib/portal/use-portal-auth";
import {
  SAVED_SEARCH_SCOPES,
  useAllSavedSearches,
  type SavedSearchScope,
} from "@/lib/saved-searches";
import type { SavedSearchVisibility, ServerSavedSearch } from "@/types";
import { keys } from "./keys";
import { isPlaceholderName } from "./use-actor";

/**
 * The signed-in caller, as the saved-search routes read one.
 *
 * `useActor` returns the name alone, and the name is not enough here. The
 * routes key an owner on the stable Portal user id when the platform proved
 * one, so the screen needs both values to decide who owns a row.
 */
export interface SearchIdentity {
  /** The name every write body carries. Null when nobody signs in. */
  actor: string | null;
  /** The stable Portal user id. Null when no profile resolves. */
  userId: string | null;
}

/** Nobody is signed in, so no route call may go out. */
export const NO_SEARCH_IDENTITY: SearchIdentity = { actor: null, userId: null };

/**
 * Read the signed-in Quix Portal identity.
 *
 * A placeholder display name names nobody. `api/api/provenance.py` refuses it
 * with 422, so the screen treats it as "not signed in" and never sends it.
 * `useActor` states the same rule and this hook reuses its check.
 */
export function useSearchIdentity(): SearchIdentity {
  const { token } = usePortalAuth();
  const portalUser = usePortalUser(token);
  const displayName = portalUser.data?.displayName.trim() ?? "";
  if (displayName.length === 0 || isPlaceholderName(displayName)) return NO_SEARCH_IDENTITY;
  return { actor: displayName, userId: portalUser.data?.userId ?? null };
}

/**
 * Report whether this caller owns one stored search.
 *
 * The delete route compares `owner_key`, and it builds that key as
 * `actor_id(owner) or owner` (`api/api/routers/searches.py:95`). So a row the
 * platform proved keys on the Portal user id, and a row from the demo path
 * keys on the name. The screen builds the same two keys, and it shows a delete
 * control only where the route will answer 204.
 */
export function ownsSavedSearch(entry: ServerSavedSearch, identity: SearchIdentity): boolean {
  const ownerId = entry.owner_id ?? null;
  if (ownerId !== null) return identity.userId !== null && ownerId === identity.userId;
  return identity.actor !== null && entry.owner === identity.actor;
}

/**
 * Read the stored searches of one screen.
 *
 * The query stays off while nobody is signed in. A read that names nobody
 * serves the team searches alone (contract §D DS-9), and a person who cannot
 * save and cannot delete gains nothing from that list. The control then serves
 * the device-local searches, which is the whole list it served before.
 *
 * `active` is the caller's own extra gate, and it never widens the identity
 * rule above. The topbar menu holds four of these queries on every screen, so
 * it keeps them off until a person opens the panel. React Query keeps the
 * answer in its cache when the gate shuts again, so a second open re-reads the
 * cache and the row count stays right while the panel is closed.
 */
export function useServerSavedSearches(
  scope: SavedSearchApiScope,
  identity: SearchIdentity,
  active = true,
) {
  return useQuery({
    queryKey: keys.savedSearches.list(scope, identity.actor),
    queryFn: () => savedSearchesApi.list(scope, identity.actor as string),
    enabled: active && identity.actor !== null,
  });
}

export interface SaveServerSearchInput {
  name: string;
  /** Optional. Null when nobody wrote one. */
  description: string | null;
  query: string;
  visibility: SavedSearchVisibility;
}

/** Refuse a write that names nobody. The route answers 422 for the same case. */
function requireSearchActor(actor: string | null): string {
  if (actor === null) {
    throw new Error("A saved search needs a signed-in Quix identity, because it names its owner.");
  }
  return actor;
}

/** Store one search on the server, personal or shared with the team. */
export function useSaveServerSearch(scope: SavedSearchApiScope, identity: SearchIdentity) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveServerSearchInput) =>
      savedSearchesApi.create({ scope, ...input, actor: requireSearchActor(identity.actor) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.savedSearches.all });
    },
  });
}

/** Delete one stored search. The owner alone may call it. */
export function useDeleteServerSearch(identity: SearchIdentity) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (searchId: string) =>
      savedSearchesApi.remove(searchId, requireSearchActor(identity.actor)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.savedSearches.all });
    },
  });
}

/**
 * What each list screen is called, and where a saved search returns to.
 *
 * A global list mixes the scopes, and two scopes can hold one name, so every
 * row that leaves its own screen has to print the screen it belongs to.
 */
export const SAVED_SEARCH_SCOPE: Record<
  SavedSearchScope,
  { readonly label: string; readonly pathname: string }
> = {
  runs: { label: "Test runs", pathname: "/runs" },
  files: { label: "Files", pathname: "/files" },
  signals: { label: "Signals", pathname: "/signals" },
  "work-orders": { label: "Work orders", pathname: "/work-orders" },
  requirements: { label: "Requirements", pathname: "/requirements" },
};

/** One saved search from either store, ready to link. */
export interface MergedSavedSearch {
  /** Unique across both stores, because the two id spaces never meet. */
  readonly key: string;
  readonly name: string;
  readonly scope: SavedSearchScope;
  readonly query: string;
}

export interface MergedSavedSearches {
  /** The server rows first, the device rows after. No row drops out. */
  readonly rows: readonly MergedSavedSearch[];
  /** True when at least one scope read failed. The rows still stand. */
  readonly serverFailed: boolean;
}

/**
 * Every saved search a person owns, from both stores, in one list.
 *
 * The topbar menu and the Home panel both print this list, so the merge rule
 * lives here one time. It is the rule `components/shared/saved-search-button.tsx`
 * states on its own toolbar: the server rows lead, the device rows follow, and
 * nothing dedupes. The two stores never merge, so a name in both places is two
 * rows in both places.
 *
 * The server half needs one query per scope, and a hook may never run inside a
 * loop over a runtime array. So each scope gets its own named call, and the
 * `Record<SavedSearchScope, …>` type below makes a fifth scope a compile error
 * here, the way `SCOPE_KEYS` already does in `lib/saved-searches.ts`. The hook
 * count is then fixed, and no scope can go missing in silence.
 *
 * `active` is the caller's own extra gate. The menu holds it shut until a
 * person opens the panel; a panel that is already on screen passes `true`.
 * A signed-out person runs no query either way, so the device rows stand alone
 * and no failure can reach the screen.
 */
export function useMergedSavedSearches(active = true): MergedSavedSearches {
  const deviceSearches = useAllSavedSearches();
  const identity = useSearchIdentity();
  const runs = useServerSavedSearches("runs", identity, active);
  const files = useServerSavedSearches("files", identity, active);
  const signals = useServerSavedSearches("signals", identity, active);
  const workOrders = useServerSavedSearches("work-orders", identity, active);
  const requirements = useServerSavedSearches("requirements", identity, active);
  const server: Record<SavedSearchScope, ReturnType<typeof useServerSavedSearches>> = {
    runs,
    files,
    signals,
    "work-orders": workOrders,
    requirements,
  };

  const serverRows: MergedSavedSearch[] = SAVED_SEARCH_SCOPES.flatMap((scope) =>
    (server[scope].data?.items ?? []).map((entry) => ({
      key: `server:${entry.search_id}`,
      name: entry.name,
      /* The scope of the read, never the scope on the row: the row's own field
         still misses `work-orders`, and a wrong scope sends a person to the
         wrong screen. */
      scope,
      query: entry.query,
    })),
  );

  const deviceRows: MergedSavedSearch[] = deviceSearches.map((entry) => ({
    key: `device:${entry.scope}:${entry.id}`,
    name: entry.name,
    scope: entry.scope,
    query: entry.query,
  }));

  return {
    rows: [...serverRows, ...deviceRows],
    serverFailed: SAVED_SEARCH_SCOPES.some((scope) => server[scope].isError),
  };
}
