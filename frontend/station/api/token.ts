/**
 * The station's token seam, over the Test Manager's own Portal token.
 *
 * The station asked the Portal SDK, a relaying parent or a pasted PAT for its
 * token. Inside the Test Manager the viewer's token is already in
 * `lib/portal/token-store`, so every function here reads or follows that one
 * value and the embed paths answer "no". The names are the station's, so
 * `store/session.ts` and `api/events.ts` stay as they are.
 */
import { getActivePortalToken } from '@/lib/portal/token-store';

let token: string | null = null;
const listeners = new Set<(t: string | null) => void>();
const portalListeners = new Set<(t: string) => void>();

export function getToken(): string | null {
  return getActivePortalToken() ?? token;
}

export function setToken(t: string | null): void {
  token = t;
  for (const l of listeners) l(t);
}

export function onToken(cb: (t: string | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Portal tokens only; a PAT is not interchangeable with one. */
export function onPortalToken(cb: (t: string) => void): () => void {
  portalListeners.add(cb);
  return () => portalListeners.delete(cb);
}

/** The Test Manager frames nothing here: the station is a page of it. */
export function isEmbedded(): boolean {
  return false;
}

export function workspaceId(): string | null {
  return null;
}

/** No Portal SDK of its own: the Test Manager's handshake already ran. */
export async function initPluginSdk(): Promise<boolean> {
  return false;
}

export function setPortalToken(t: string): void {
  setToken(t);
  for (const l of portalListeners) l(t);
}

export async function initParentRelay(): Promise<boolean> {
  return false;
}

/** The Test Manager's token stands in for a stored PAT. */
export function loadStoredPat(): string | null {
  return getActivePortalToken();
}

export function storePat(t: string): void {
  setToken(t);
}

export function clearStoredPat(): void {
  token = null;
}
