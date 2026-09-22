/**
 * Resolve the QuixLab URL on the server, from the registry API.
 *
 * **Why the API owns the value.** No control that opens or frames QuixLab may
 * guess a host, and one value must not carry two names. The API deployment
 * holds `TM_QUIXLAB_URL` and answers `GET /api/v1/integrations/quixlab-url`.
 * This front end asks that route. So an operator sets one name, on one
 * deployment, and the two sides can never disagree.
 *
 * **Why the server asks, and not the browser.** A browser blocks a
 * `window.open` that a fetch answer triggers. `app/layout.tsx` resolves the URL
 * before the page renders, so the click opens the tab with nothing to await.
 * The bearer token also stays on the server, the same rule the proxy follows.
 *
 * **Every failure reads as "no QuixLab".** A refused call, an unreachable API
 * and an unconfigured deployment all return an empty string, and every control
 * then stays hidden. A screen never promises a destination this function could
 * not resolve.
 *
 * **This module runs on the server only.** It reads `TM_API_TOKEN`, so no client
 * component may import it. `app/layout.tsx` is its one caller.
 */

/** How long the layout waits for the API before it gives up and hides the controls. */
const TIMEOUT_MS = 2_000;

/** How long one answer serves. A newly configured QuixLab appears within this. */
const REVALIDATE_SECONDS = 60;

/**
 * The registry API, for a call this server makes itself.
 *
 * `API_URL` names it directly. `TM_BE_URL` names the same host for the
 * `next.config.ts` rewrite, and a server-side call reaches it directly, so it
 * serves as the fallback. The proxy's own `resolveBackend` needs a request
 * origin and there is none here, so this stays a separate, smaller rule.
 */
function apiBase(): string | null {
  const configured = process.env.API_URL?.trim() || process.env.TM_BE_URL?.trim();
  if (!configured) return null;
  return configured.replace(/\/+$/, "");
}

/** The QuixLab site root, or "" when this deployment has no QuixLab. */
export async function resolveQuixLabUrl(): Promise<string> {
  const base = apiBase();
  const token = process.env.TM_API_TOKEN;
  if (base === null || !token) return "";

  try {
    const response = await fetch(`${base}/api/v1/integrations/quixlab-url`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      next: { revalidate: REVALIDATE_SECONDS },
    });
    // 409 quixlab_not_configured is the ordinary answer of a deployment with
    // no QuixLab. It is a state, not a fault, so it logs nothing.
    if (!response.ok) return "";
    const body = (await response.json()) as { url?: unknown };
    return typeof body.url === "string" ? body.url : "";
  } catch {
    return "";
  }
}
