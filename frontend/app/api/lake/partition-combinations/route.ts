/* GET /api/lake/partition-combinations?table=&where=&limit= — distinct value
   combinations from the catalog's index, `where` a JSON object of pinned columns. */
import { catalogGet, withLake } from "@/lib/lake/console";
import { validTable } from "@/lib/lake/proxy";

const EMPTY = { combinations: [] };

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const table = url.searchParams.get("table");
  const limit = Math.max(1, Math.min(10_000, Number(url.searchParams.get("limit") ?? 1000) || 1000));
  if (!validTable(table)) return Response.json({ ...EMPTY, error: "table is required" }, { status: 422 });
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
    () => Response.json(EMPTY),
    async (target) => {
      const q = new URLSearchParams({ table, limit: String(limit) });
      for (const [k, v] of Object.entries(where)) if (v !== null && v !== undefined) q.append("filter", `${k}:${String(v)}`);
      const got = await catalogGet(target, `partition-combinations?${q}`, EMPTY);
      if (got instanceof Response) return got;
      const body = got.body;
      return Response.json(Array.isArray(body) ? { combinations: body } : body);
    },
  );
}
