/* POST /api/lake/preview {query, max_rows} — one SELECT's rows as records, capped
   at 1000 unless `max_rows` says otherwise (0 means uncapped: a bucketed
   aggregate bounds its own rows). QuixLab's shape: {columns, rows, shape, error}. */
import { lakeRecords, mockRecords, withLake, type Records } from "@/lib/lake/console";
import { isSingleStatement } from "@/lib/explore/sql-statements";

const EMPTY = { columns: [], rows: [], shape: [0, 0] };

function answer(r: Records): Response {
  return Response.json({ columns: r.columns, rows: r.rows, shape: [r.rows.length, r.columns.length], error: null });
}

export async function POST(request: Request): Promise<Response> {
  let payload: { query?: unknown; max_rows?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return Response.json({ ...EMPTY, error: "The request body is not JSON." }, { status: 400 });
  }
  let query = typeof payload.query === "string" ? payload.query.trim() : "";
  if (query === "") return Response.json({ ...EMPTY, error: "query is required" }, { status: 422 });
  if (!isSingleStatement(query)) {
    return Response.json({ ...EMPTY, error: "One statement at a time." }, { status: 400 });
  }
  let cap = 1000;
  if ("max_rows" in payload) cap = Math.max(0, Number(payload.max_rows) || 0);
  if (cap > 0 && !/\bLIMIT\b/i.test(query)) query = `${query.replace(/;\s*$/, "")} LIMIT ${cap}`;
  return withLake(
    request,
    EMPTY,
    () => {
      try {
        const r = mockRecords(query);
        return answer(cap > 0 ? { ...r, rows: r.rows.slice(0, cap) } : r);
      } catch (error) {
        return Response.json({ ...EMPTY, error: error instanceof Error ? error.message : String(error) });
      }
    },
    async (target) => {
      try {
        const r = await lakeRecords(target, query);
        return answer(cap > 0 ? { ...r, rows: r.rows.slice(0, cap) } : r);
      } catch (error) {
        return Response.json({ ...EMPTY, error: error instanceof Error ? error.message : String(error) });
      }
    },
  );
}
