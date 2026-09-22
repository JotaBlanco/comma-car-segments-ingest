/**
 * Resolve the Flight Test Station URL on the server, from the registry API.
 *
 * The API deployment holds `TM_FTS_URL` and answers
 * `GET /api/v1/integrations/fts-url`, so one name configures both sides.
 * Asking here and not in the browser means "Open in a tab" has nothing to
 * await, and `TM_API_TOKEN` stays on the server.
 *
 * Every failure reads as "no station" and the panel renders nothing. Server
 * only — no client component may import this. `app/layout.tsx` is its caller.
 */

/** How long the layout waits for the API before it hides the panel. */
const TIMEOUT_MS = 2_000;

/** How long one answer serves. A newly configured station appears within this. */
const REVALIDATE_SECONDS = 60;

export interface FtsConfig {
  /** The station's site root, or "" when this deployment has none. */
  url: string;
  /** The origin a parent posts the token to, or "" with no station. */
  origin: string;
}

const NO_STATION: FtsConfig = { url: "", origin: "" };

function apiBase(): string | null {
  const configured =
    process.env.API_URL?.trim() || process.env.TM_BE_URL?.trim();
  if (!configured) return null;
  return configured.replace(/\/+$/, "");
}

/** Where the station is, or empty strings when this deployment has none. */
export async function resolveFtsConfig(): Promise<FtsConfig> {
  const base = apiBase();
  const token = process.env.TM_API_TOKEN;
  if (base === null || !token) return NO_STATION;

  try {
    const response = await fetch(`${base}/api/v1/integrations/fts-url`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      next: { revalidate: REVALIDATE_SECONDS },
    });
    // 409 fts_not_configured is the ordinary answer: no station.
    if (!response.ok) return NO_STATION;
    const body = (await response.json()) as { url?: unknown; origin?: unknown };
    return {
      url: typeof body.url === "string" ? body.url : "",
      origin: typeof body.origin === "string" ? body.origin : "",
    };
  } catch {
    return NO_STATION;
  }
}
