/* PUT /api/lake/snippets/{id} — write one snippet's tags and note back to the lake.

   The one write this product makes to the lake, and it serves one purpose: moving an issue
   between open, resolved and closed. The caller sends the WHOLE new tag list and note, as
   QuixLab's own writer does (`quixlab/lake_sync.py` update_snippet), and this forwards them
   to `PUT {lake}/tables/{table}/snippets/{id}` with the server-held credential. The SQL and
   the partitions are never sent, so a state change cannot move what a snippet selects. */

import { viewerToken } from "@/app/api/proxy/[...path]/route";
import { errorBody, lakeTarget, mockIsDeliberate, validTable } from "@/lib/lake/proxy";

const TIMEOUT_MS = 30_000;

interface Context {
  params: Promise<{ id: string }>;
}

export async function PUT(request: Request, { params }: Context): Promise<Response> {
  const { id } = await params;
  let payload: { table?: unknown; tags?: unknown; markdown?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return Response.json(errorBody("The request body is not JSON.", "invalid_body"), { status: 400 });
  }
  const table = typeof payload.table === "string" ? payload.table : null;
  const tags = Array.isArray(payload.tags) ? payload.tags.filter((t) => typeof t === "string") : null;
  const markdown = typeof payload.markdown === "string" ? payload.markdown : null;
  if (!validTable(table) || !/^\d+$/.test(id) || tags === null || markdown === null) {
    return Response.json(
      errorBody("The table, the snippet id, the tags and the markdown are required.", "invalid_query"),
      { status: 422 },
    );
  }
  if (mockIsDeliberate()) return Response.json({ id: Number(id), tags, markdown });
  if (viewerToken(request) === null) {
    return Response.json(
      errorBody("This endpoint serves a signed-in Test Manager viewer only.", "unauthorized"),
      { status: 401 },
    );
  }
  const target = lakeTarget();
  if (target instanceof Response) return target;
  const url = `${target.base}/tables/${encodeURIComponent(table)}/snippets/${id}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ tags, markdown }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return Response.json(errorBody("The lake did not answer within 30 s.", "lake_timeout"), {
        status: 504,
      });
    }
    return Response.json(
      errorBody(`Could not reach the lake at ${new URL(url).host}.`, "lake_unavailable"),
      { status: 503 },
    );
  }
  if (upstream.status === 401 || upstream.status === 403) {
    return Response.json(errorBody("The lake refused the token.", "lake_refused"), { status: 502 });
  }
  const text = await upstream.text();
  if (!upstream.ok) {
    const detail = text.trim().slice(0, 500) || `The lake answered ${upstream.status}.`;
    return Response.json(errorBody(detail, "lake_error"), { status: upstream.status === 404 ? 404 : 502 });
  }
  return Response.json({ id: Number(id), tags, markdown });
}
