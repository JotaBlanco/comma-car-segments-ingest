"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { getCurrentUser, PortalApiError } from "./client";
import {
  clearStoredToken,
  getStoredToken,
  isEmbedded,
  onParentTokenPush,
  requestTokenFromParent,
  setActivePortalToken,
  setStoredToken,
  takeTokenFromFragment,
} from "./token-store";

export type PortalAuthPhase = "resolving" | "authenticated" | "signed-out";

/**
 * How the token reached this app.
 *
 * `"handshake"` means the Portal sent it over postMessage, and
 * `token-store.ts` accepted it only from a Portal origin. So the platform
 * identified the person. `"pasted"` means a person typed a token into the
 * dialog, and it proves much less. `"url"` means a `#token=...` fragment in
 * the link carried it, and it proves as little as a paste: anybody who holds
 * the link holds the token. Only a token that really arrived over postMessage
 * may read `"handshake"`.
 */
export type PortalTokenSource = "handshake" | "url" | "pasted";

/**
 * Every mounted `usePortalAuth` instance.
 *
 * The hook runs in several components at once (account menu, signed-out
 * screen, upload dialog, actor hooks), and each one keeps its own React
 * state. So a sign-in in one component left the others signed out, and the
 * screens that read the token showed nothing. Every instance now publishes a
 * sign-in and a sign-out here, and every instance listens.
 */
type AuthUpdate = { token: string | null; source: PortalTokenSource | null };

const authListeners = new Set<(update: AuthUpdate) => void>();

function publishAuth(update: AuthUpdate): void {
  for (const listener of authListeners) listener(update);
}

export interface PortalAuth {
  token: string | null;
  phase: PortalAuthPhase;
  embedded: boolean;
  /** How the token arrived. Null when no token is present. */
  source: PortalTokenSource | null;
  /** Store a PAT (standalone mode) and switch to the authenticated state. */
  connect: (token: string) => void;
  /** Clear the token and return to the signed-out state. */
  disconnect: () => void;
}

export const PORTAL_ME_KEY = ["portal", "me"] as const;

/**
 * Resolves the portal token once on mount: embedded → postMessage handshake
 * with the parent (localStorage PAT as fallback); standalone → localStorage
 * PAT only. Never blocks rendering — the phase just settles to "signed-out"
 * when nothing is available.
 */
export function usePortalAuth(): PortalAuth {
  const [token, setToken] = useState<string | null>(null);
  const [source, setSource] = useState<PortalTokenSource | null>(null);
  const [phase, setPhase] = useState<PortalAuthPhase>("resolving");
  // A ref written in the effect below could not answer this hook's own return
  // value: React runs the effect AFTER the render that reads it, so the first
  // render reported `false` in a frame, and Strict Mode's second render then
  // hid the fault in development. A state initializer runs DURING the render,
  // so every render reads a settled value. `isEmbedded()` reads
  // `window.parent`, which the server does not have, and it answers `false`
  // there — the same answer the server gave before.
  const [embedded] = useState(isEmbedded);
  const queryClient = useQueryClient();

  useEffect(() => {
    let canceled = false;

    // A link may carry the token in its fragment. Read it first, because the
    // read also strips the fragment from the address bar. The read stores the
    // token too, so the next tab starts signed in.
    const fromUrl = takeTokenFromFragment();

    if (!embedded) {
      const resolved = fromUrl ?? getStoredToken();
      // The holder first, and in this effect, not in the one below. See the
      // comment on that effect: it runs one commit later, and by then the gate
      // in `query-provider.tsx` has already opened and the first query has
      // already read an empty holder.
      if (resolved !== null) setActivePortalToken(resolved);
      setToken(resolved);
      setSource(fromUrl !== null ? "url" : resolved !== null ? "pasted" : null);
      setPhase(resolved !== null ? "authenticated" : "signed-out");
      return;
    }

    // Embedded: ask the Portal, fall back to the link or a stored PAT if it
    // stays silent.
    void requestTokenFromParent()
      // The phase gates every query (`components/providers/query-provider.tsx`),
      // so it must settle on every path. `postMessage` throws on a malformed
      // origin, and that throw would leave the phase "resolving" for ever.
      .catch(() => null)
      .then((received) => {
        if (canceled) return;
        const resolved = received ?? fromUrl ?? getStoredToken();
        // The holder first, for the reason the branch above states.
        if (resolved !== null) setActivePortalToken(resolved);
        setToken(resolved);
        // Only the token the parent posted is a handshake token. A link proves
        // no more than a paste, so it never claims the handshake.
        setSource(
          received !== null
            ? "handshake"
            : fromUrl !== null
              ? "url"
              : resolved !== null
                ? "pasted"
                : null,
        );
        setPhase(resolved !== null ? "authenticated" : "signed-out");
      });

    // The Portal may push refreshed tokens proactively.
    const unsubscribe = onParentTokenPush((pushed) => {
      if (canceled) return;
      setActivePortalToken(pushed);
      setToken((previous) => (previous === pushed ? previous : pushed));
      setSource("handshake");
      setPhase("authenticated");
    });

    return () => {
      canceled = true;
      unsubscribe();
    };
    // `embedded` never changes after the first render, so this effect still
    // runs exactly once.
  }, [embedded]);

  // Follow the sign-ins and sign-outs the other instances publish. See the
  // `authListeners` comment above.
  useEffect(() => {
    const listener = (update: AuthUpdate): void => {
      setToken(update.token);
      setSource(update.source);
      setPhase(update.token === null ? "signed-out" : "authenticated");
    };
    authListeners.add(listener);
    return () => {
      authListeners.delete(listener);
    };
  }, []);

  // The catch-all holder write, for the sign-ins the effect above never sees:
  // `connect` in another instance, and a push this instance did not receive.
  // It runs one commit AFTER the token arrives, so the resolution effect above
  // writes the holder itself — the first query of the page load reads the
  // holder in the commit that opens the gate.
  //
  // The proxy runs on the server and cannot read React state, so the browser
  // must state the token on every call it sends. See PORTAL_TOKEN_HEADER.
  //
  // The holder is a module singleton and this hook runs in several components
  // at once (upload dialog, actor hooks). Every instance mounts with
  // `token === null` before its own resolution settles, so an unguarded write
  // here let a newly-mounted instance wipe the live token — requests in that
  // window lost the x-portal-token header and the journal named the shared
  // token holder. Only a real token propagates; the one legitimate clear is
  // `disconnect`, which clears the holder directly below.
  useEffect(() => {
    if (token !== null) setActivePortalToken(token);
  }, [token]);

  const connect = useCallback(
    (newToken: string) => {
      setStoredToken(newToken);
      queryClient.removeQueries({ queryKey: PORTAL_ME_KEY });
      publishAuth({ token: newToken, source: "pasted" });
      // Every query on the screen behind the dialog failed with 401, and an
      // error card stays until a manual retry or a window refocus. The new
      // token answers every one of them, so mark them all stale: the mounted
      // ones refetch at once and the rest refetch when they mount. The dialog
      // checks the token with the Portal BEFORE it calls this, so a refused
      // token never reaches here and never refetches anything.
      void queryClient.invalidateQueries();
    },
    [queryClient],
  );

  const disconnect = useCallback(() => {
    clearStoredToken();
    queryClient.removeQueries({ queryKey: PORTAL_ME_KEY });
    // The token effect above never writes null (see its comment), so the
    // sign-out clears the shared holder itself.
    setActivePortalToken(null);
    publishAuth({ token: null, source: null });
  }, [queryClient]);

  return { token, phase, embedded, source, connect, disconnect };
}

/**
 * Current-user query. Enabled only while a token is present; a 401 is not
 * retried (the caller clears the token instead), other failures retry once.
 */
export function usePortalUser(token: string | null) {
  return useQuery({
    queryKey: PORTAL_ME_KEY,
    queryFn: () => {
      if (token === null) throw new Error("Portal token missing");
      return getCurrentUser(token);
    },
    enabled: token !== null,
    staleTime: 5 * 60_000,
    retry: (failureCount, error) => {
      if (error instanceof PortalApiError && error.status === 401) return false;
      return failureCount < 1;
    },
  });
}
