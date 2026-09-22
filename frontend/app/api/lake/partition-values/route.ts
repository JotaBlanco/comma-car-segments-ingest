/* GET /api/lake/partition-values?table=&column=&where= — distinct values of one
   partition column, `where` a JSON object pinning ancestor columns. */
import { catalogGet, withLake } from "@/lib/lake/console";
import { mockPartitionValues } from "@/lib/lake/mock-tree";
import { validTable } from "@/lib/lake/proxy";

const EMPTY = { values: [] };

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const table = url.searchParams.get("table");
  const column = url.searchParams.get("column") ?? "";
  if (!validTable(table) || column === "") {
    return Response.json({ ...EMPTY, error: "table and column are required" }, { status: 422 });
  }
  let where: Record<string, unknown> = {};
  try {
    const raw = url.searchParams.get("where");
    if (raw) where = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Response.json({ ...EMPTY, error: "where is not JSON" }, { status: 422 });
  }
  return withLake(
    request,
    EMPTY,
    () => Response.json({ values: mockPartitionValues(column, where), fast: true }),
    async (target) => {
      const q = new URLSearchParams({ table, column });
      for (const [k, v] of Object.entries(where)) if (v !== null && v !== undefined) q.set(k, String(v));
      const got = await catalogGet(target, `partition-values?${q}`, EMPTY);
      if (got instanceof Response) return got;
      const raw = Array.isArray(got.body.values) ? got.body.values : Array.isArray(got.body) ? got.body : [];
      const values = (raw as unknown[]).map(String).sort();
      return Response.json({ values, fast: true });
    },
  );
}
