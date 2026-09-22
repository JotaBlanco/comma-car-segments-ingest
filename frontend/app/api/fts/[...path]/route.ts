/* The station's API, served from this origin: `/api/fts/<path>` forwards to
   `<TM_FTS_URL>/api/<path>` with the viewer's Portal token as the bearer the
   station's backend reads. The station's front end runs inside the Test
   Manager (`station/`), so the browser talks to this handler only, and the
   station's own host never appears in a page. Streams pass through whole,
   which the `/api/events` push stream needs. */

import { viewerToken } from "@/app/api/proxy/[...path]/route";
import { errorBody, firstEnv } from "@/lib/lake/proxy";

export const FTS_URL_VARS = ["TM_FTS_URL"] as const;

const TIMEOUT_MS = 60_000;

type Context = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const base = firstEnv(FTS_URL_VARS);
  if (base === undefined) {
    return Response.json(
      errorBody(`The Flight Test Station is not configured. Set ${FTS_URL_VARS[0]}.`, "fts_unavailable"),
      { status: 503 },
    );
  }
  const { path } = await params;
  const url = new URL(request.url);
  const target = `${base.replace(/\/+$/, "")}/api/${path.map(encodeURIComponent).join("/")}${url.search}`;
  const token = viewerToken(request);
  const headers: Record<string, string> = { Accept: request.headers.get("accept") ?? "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  let upstream: Response;
  try {
    // The push stream stays open past any timeout; only a one-shot answer gets one.
    const streaming = path[0] === "events";
    upstream = await fetch(target, {
      headers,
      cache: "no-store",
      signal: streaming ? request.signal : AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return Response.json(errorBody("The station did not answer in time.", "fts_timeout"), {
        status: 504,
      });
    }
    return Response.json(
      errorBody(`Could not reach the station at ${new URL(target).host}.`, "fts_unavailable"),
      { status: 503 },
    );
  }
  const out = new Headers();
  out.set("content-type", upstream.headers.get("content-type") ?? "application/json");
  out.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
