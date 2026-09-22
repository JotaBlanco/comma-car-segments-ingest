/* GET /api/lake/tables?include_metadata= — the lake's tables, as QuixLab's Explorer lists them. */
import { catalogGet, withLake } from "@/lib/lake/console";
import { lakeTable } from "@/lib/explore/lake-schema";

const EMPTY = { tables: [] };

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const meta = url.searchParams.get("include_metadata") !== "false";
  return withLake(
    request,
    EMPTY,
    () => Response.json({ tables: [{ name: lakeTable() }] }),
    async (target) => {
      const got = await catalogGet(target, `tables?include_metadata=${meta ? "true" : "false"}`, EMPTY);
      if (got instanceof Response) return got;
      const raw = (Array.isArray(got.body.tables) ? got.body.tables : got.body) as unknown;
      const list = Array.isArray(raw) ? raw : [];
      const tables = list.flatMap((t) => {
        if (typeof t === "string") return [{ name: t }];
        if (typeof t === "object" && t !== null) {
          const o = t as Record<string, unknown>;
          return [{ ...o, name: String(o.name ?? o.table ?? "") }];
        }
        return [];
      });
      return Response.json({ tables });
    },
  );
}
