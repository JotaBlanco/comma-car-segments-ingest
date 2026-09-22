/* One snippet's rows: GET ?table=&limit= forwards `GET {lake}/tables/{table}/snippets/{id}/data`
   and hands back `{columns, rows, row_count, limit}` with the columns as names. */

import { viewerToken } from "@/app/api/proxy/[...path]/route";
import { errorBody, lakeGetJson, lakeTarget, mockIsDeliberate, validTable } from "@/lib/lake/proxy";

const MAX_LIMIT = 10_000;

interface Context {
  params: Promise<{ id: string }>;
}

/** The lake's `columns` may be names or `{name}` objects, its rows lists or objects. */
export function normaliseData(raw: unknown, limit: number) {
  const body = (raw ?? {}) as { columns?: unknown; rows?: unknown; row_count?: unknown };
  const columns: string[] = Array.isArray(body.columns)
    ? body.columns.map((c) =>
        typeof c === "string" ? c : String((c as { name?: unknown })?.name ?? ""),
      )
    : [];
  const rows: string[][] = Array.isArray(body.rows)
    ? body.rows.map((r) => {
        const cells = Array.isArray(r)
          ? r
          : columns.map((c) => (r as Record<string, unknown>)?.[c]);
        return cells.map((v) => (v === null || v === undefined ? "" : String(v)));
      })
    : [];
  return { columns, rows, row_count: rows.length, limit };
}

function mockRows(id: string, limit: number) {
  const n = Math.min(limit, 40);
  const t0 = 1_737_821_514_758;
  const rows = Array.from({ length: n }, (_, i) => [
    String(t0 + i * 20),
    "INS1",
    "inertial_altitude",
    (1926 + (i === 12 ? -1263 : Math.sin(i / 3) * 4)).toFixed(3),
    "Feet",
    `snippet-${id}`,
  ]);
  return { columns: ["timestamp", "bus", "signal", "value", "unit", "source"], rows, row_count: n, limit };
}

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { id } = await params;
  const url = new URL(request.url);
  const table = url.searchParams.get("table");
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, MAX_LIMIT));
  if (!validTable(table) || !/^\d+$/.test(id)) {
    return Response.json(errorBody("The table and snippet id are required.", "invalid_query"), {
      status: 422,
    });
  }
  if (mockIsDeliberate()) return Response.json(mockRows(id, limit));
  if (viewerToken(request) === null) {
    return Response.json(
      errorBody("This endpoint serves a signed-in Test Manager viewer only.", "unauthorized"),
      { status: 401 },
    );
  }
  const target = lakeTarget();
  if (target instanceof Response) return target;
  const answer = await lakeGetJson(
    target,
    `tables/${encodeURIComponent(table)}/snippets/${id}/data?limit=${limit}`,
  );
  if (answer instanceof Response) return answer;
  return Response.json(normaliseData(answer.body, limit));
}
