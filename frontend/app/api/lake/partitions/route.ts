/* GET /api/lake/partitions?table=&path= — one level of the partition tree. */
import { catalogGet, withLake } from "@/lib/lake/console";
import { mockPartitionLevel } from "@/lib/lake/mock-tree";
import { validTable } from "@/lib/lake/proxy";

const EMPTY = { partitions: [] };

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const table = url.searchParams.get("table");
  const path = url.searchParams.get("path") ?? "";
  if (!validTable(table)) return Response.json({ ...EMPTY, error: "table is required" }, { status: 422 });
  return withLake(
    request,
    EMPTY,
    () => Response.json({ partitions: mockPartitionLevel(path) }),
    async (target) => {
      const q = new URLSearchParams({ table, path, include_sizes: "true" });
      const got = await catalogGet(target, `partitions?${q}`, EMPTY);
      if (got instanceof Response) return got;
      return Response.json({ partitions: Array.isArray(got.body.partitions) ? got.body.partitions : [] });
    },
  );
}
