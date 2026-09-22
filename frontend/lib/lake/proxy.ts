/* Server-side helpers shared by the /api/lake route handlers.

   The lake interface is the one `api/api/services/lake.py` documents; the
   env names and their order are copied from there so every path reads the
   same operator configuration. `API_AUTH_TOKEN` is deliberately absent: it
   authenticates but carries no identity, so the lake answers 200 with zero
   rows. The lake credential never reaches the browser: the browser talks to
   these handlers, and only they hold the token. */

export const LAKE_URL_VARS = ["Quix__Lakehouse__Query__Url", "QUIX_LAKE_URL"] as const;
export const LAKE_TOKEN_VARS = ["Quix__Lakehouse__Query__AuthToken", "Quix__Sdk__Token"] as const;

export function firstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

export function errorBody(detail: string, code: string): Record<string, unknown> {
  return { detail, code, errors: [] };
}

/* Same gate as the proxy route's mockIsDeliberate(): TM_USE_MOCK_API names
   itself for a developer running the front end alone, TM_TEST_HOOKS marks
   the e2e rig. Neither is ever set in a deployed image. */
export function mockIsDeliberate(): boolean {
  return process.env.TM_USE_MOCK_API === "1" || process.env.TM_TEST_HOOKS === "1";
}

export interface LakeTarget {
  base: string;
  token: string;
}

/** The lake's base URL and token, or the 503 that says which is missing. */
export function lakeTarget(): LakeTarget | Response {
  const base = firstEnv(LAKE_URL_VARS);
  if (base === undefined) {
    return Response.json(
      errorBody(`The lake is not configured. Set ${LAKE_URL_VARS[0]}.`, "lake_unavailable"),
      { status: 503 },
    );
  }
  const token = firstEnv(LAKE_TOKEN_VARS);
  if (token === undefined) {
    return Response.json(
      errorBody(`The lake token is not configured. Set ${LAKE_TOKEN_VARS[0]}.`, "lake_unavailable"),
      { status: 503 },
    );
  }
  return { base: base.replace(/\/+$/, ""), token };
}

const TIMEOUT_MS = 60_000;

/** GET one lake JSON endpoint; a failure comes back as the Response to return. */
export async function lakeGetJson(
  target: LakeTarget,
  path: string,
): Promise<{ body: unknown } | Response> {
  const url = `${target.base}/${path.replace(/^\/+/, "")}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${target.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return Response.json(errorBody("The lake did not answer within 60 s.", "lake_timeout"), {
        status: 504,
      });
    }
    return Response.json(
      errorBody(`Could not reach the lake at ${new URL(url).host}.`, "lake_unavailable"),
      { status: 503 },
    );
  }
  if (upstream.status === 401 || upstream.status === 403) {
    return Response.json(errorBody("The lake refused the token.", "lake_refused"), {
      status: 502,
    });
  }
  const text = await upstream.text();
  if (!upstream.ok) {
    const detail = text.trim().slice(0, 500) || `The lake answered ${upstream.status}.`;
    return Response.json(errorBody(detail, "lake_error"), {
      status: upstream.status === 404 ? 404 : 502,
    });
  }
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    return Response.json(errorBody("The lake answered with malformed JSON.", "lake_error"), {
      status: 502,
    });
  }
}

/** A table name safe to place in a lake path. */
export function validTable(table: string | null): table is string {
  return table !== null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(table);
}
