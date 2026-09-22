/**
 * Quix Portal token acquisition.
 *
 * Two modes, mirroring the original Test Manager frontend:
 * - Embedded (iframe plugin inside the Quix Portal): postMessage handshake —
 *   the child posts REQUEST_AUTH_TOKEN to the parent, the parent replies with
 *   an AUTH_TOKEN message carrying a short-lived JWT.
 * - Standalone (local dev): a Personal Access Token pasted by the user and
 *   kept in localStorage.
 *
 * This is entirely separate from the app's own TM_API_TOKEN mock auth
 * (lib/api/client.ts) — the portal token only identifies the user.
 */

import { portalOrigins } from "./client";

export const PORTAL_TOKEN_STORAGE_KEY = "tm.portal.token";

/**
 * Header that carries the viewer's Portal token to our own server proxy.
 *
 * The token lives in the browser and the proxy runs on the server, so the
 * browser states the token on the request. The call goes to a relative path
 * on our own origin, so the header reaches our server and nobody else. A
 * custom header is never ambient: a browser attaches it only when our code
 * asks, so a cross-site page cannot make the browser send it.
 */
export const PORTAL_TOKEN_HEADER = "x-portal-token";

const REQUEST_MESSAGE_TYPE = "REQUEST_AUTH_TOKEN";
const RESPONSE_MESSAGE_TYPE = "AUTH_TOKEN";

interface AuthTokenMessage {
  type?: unknown;
  token?: unknown;
}

/**
 * Read a token out of a message, or return null.
 *
 * The origin check comes first and it is the point of this function. A token
 * is a credential. Any page may frame this app and post a well-shaped
 * message, so the shape proves nothing about the sender. Only `event.origin`
 * does, because the browser sets it and no sender can forge it.
 */
function tokenFromPortalMessage(event: MessageEvent<AuthTokenMessage>): string | null {
  if (!portalOrigins().includes(event.origin)) return null;
  const data = event.data;
  if (typeof data !== "object" || data === null) return null;
  if (data.type !== RESPONSE_MESSAGE_TYPE) return null;
  if (typeof data.token !== "string" || data.token.length === 0) return null;
  return data.token;
}

/** True when running inside another frame (Quix Portal plugin mode). */
export function isEmbedded(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.parent !== window;
  } catch {
    // Cross-origin access to window.parent throwing still means "framed".
    return true;
  }
}

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(PORTAL_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string): void {
  try {
    window.localStorage.setItem(PORTAL_TOKEN_STORAGE_KEY, token);
  } catch {
    // Storage unavailable (private mode / iframe restrictions) — session-only.
  }
}

export function clearStoredToken(): void {
  // Drop the fragment answer too. Without this a component that mounts after
  // the sign-out reads the old token again and signs the person back in.
  fragmentToken = null;
  fragmentRead = false;
  try {
    window.localStorage.removeItem(PORTAL_TOKEN_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * The fragment key a Quix link carries the token in: `#token=...`.
 *
 * The app reads the fragment and never a query parameter. A fragment stays in
 * the browser: the browser does not put it in the HTTP request. So the token
 * stays out of the server log, out of the proxy and out of the `Referer`
 * header. A query parameter does the opposite. QuixLake, the dev-session
 * plugins and the Lakehouse UI all take a token from the URL this way.
 */
const FRAGMENT_TOKEN_KEY = "token";

/**
 * The token the fragment carried on this page load.
 *
 * `usePortalAuth` runs in several components at once, and the read strips the
 * fragment. So only the first caller could ever see the token. This module
 * holds the answer and every caller gets the same one.
 */
let fragmentToken: string | null = null;
let fragmentRead = false;

/**
 * Take the token out of the URL fragment, and strip the fragment at once.
 *
 * The strip runs in the first effect, before any render a person can
 * screenshot. So the token never stays in the address bar, in the history or
 * in a bookmark. The token also goes to localStorage, so a second tab starts
 * signed in.
 *
 * Never log this value. Never put it in an error message. Never send it to
 * any analytics.
 */
export function takeTokenFromFragment(): string | null {
  if (fragmentRead) return fragmentToken;
  if (typeof window === "undefined") return null;
  fragmentRead = true;

  const hash = window.location.hash;
  if (!hash.startsWith("#")) return null;

  const params = new URLSearchParams(hash.slice(1));
  const token = params.get(FRAGMENT_TOKEN_KEY);
  if (token === null || token.length === 0) return null;

  // Keep every other fragment entry. Only the token goes.
  params.delete(FRAGMENT_TOKEN_KEY);
  const rest = params.toString();
  const { pathname, search } = window.location;
  const url = `${pathname}${search}${rest === "" ? "" : `#${rest}`}`;
  try {
    window.history.replaceState(window.history.state, "", url);
  } catch {
    // A blocked history API must not stop the sign-in.
  }

  fragmentToken = token;
  setStoredToken(token);
  return token;
}

/**
 * Ask the parent frame (Quix Portal) for an auth token. Resolves null on
 * timeout so the app never blocks when the parent does not implement the
 * handshake (e.g. opened standalone inside some other iframe).
 *
 * The request names the Portal origin. It used to name `"*"`, which told the
 * browser to deliver the message to whatever page framed us.
 */
export function requestTokenFromParent(timeoutMs = 3000): Promise<string | null> {
  const [portalAppOrigin] = portalOrigins();
  // No known origin means no safe target. Never fall back to "*".
  if (portalAppOrigin === undefined) return Promise.resolve(null);

  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      window.removeEventListener("message", handleMessage);
      resolve(null);
    }, timeoutMs);

    function handleMessage(event: MessageEvent<AuthTokenMessage>): void {
      const token = tokenFromPortalMessage(event);
      if (token === null) return;
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", handleMessage);
      resolve(token);
    }

    window.addEventListener("message", handleMessage);
    window.parent.postMessage({ type: REQUEST_MESSAGE_TYPE }, portalAppOrigin);
  });
}

/**
 * Subscribe to proactive AUTH_TOKEN pushes from the parent frame (the Portal
 * re-sends tokens when it refreshes them). Returns an unsubscribe function.
 */
export function onParentTokenPush(callback: (token: string) => void): () => void {
  function handleMessage(event: MessageEvent<AuthTokenMessage>): void {
    const token = tokenFromPortalMessage(event);
    if (token !== null) callback(token);
  }
  window.addEventListener("message", handleMessage);
  return () => window.removeEventListener("message", handleMessage);
}

/**
 * The token the browser holds right now, for the proxy call to carry.
 *
 * `usePortalAuth` keeps the token in React state, and `lib/api/client.ts` is a
 * plain module with no access to that state. This holder joins the two. It
 * holds the token in memory only, so no other page and no extension reads it
 * out of storage.
 */
let activePortalToken: string | null = null;

export function setActivePortalToken(token: string | null): void {
  activePortalToken = token;
}

export function getActivePortalToken(): string | null {
  return activePortalToken;
}
