/* GET /api/lake/partition-info?table= — the partition columns, outermost first. */
import { catalogGet, withLake } from "@/lib/lake/console";
import { validTable } from "@/lib/lake/proxy";

const EMPTY = { partition_columns: [] };

export async function GET(request: Request): Promise<Response> {
  const table = new URL(request.url).searchParams.get("table");
  if (!validTable(table)) return Response.json({ ...EMPTY, error: "table is required" }, { status: 422 });
  return withLake(
    request,
    EMPTY,
    () => Response.json({ table_name: table, is_partitioned: false, partition_columns: [] }),
    async (target) => {
      const got = await catalogGet(target, `partition-info?table=${encodeURIComponent(table)}`, EMPTY);
      if (got instanceof Response) return got;
      return Response.json(got.body);
    },
  );
}
