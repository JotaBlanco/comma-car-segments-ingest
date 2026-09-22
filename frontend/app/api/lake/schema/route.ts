/* GET /api/lake/schema?table= — column names and types, no scan. */
import { catalogGet, mockRecords, withLake } from "@/lib/lake/console";
import { validTable } from "@/lib/lake/proxy";

const EMPTY = { columns: [] };

/** A type the Explorer can read for the mock rig's columns. */
function mockType(name: string): string {
  if (name === "timestamp") return "BIGINT";
  if (name === "value") return "DOUBLE";
  return "VARCHAR";
}

export async function GET(request: Request): Promise<Response> {
  const table = new URL(request.url).searchParams.get("table");
  if (!validTable(table)) return Response.json({ ...EMPTY, error: "table is required" }, { status: 422 });
  return withLake(
    request,
    EMPTY,
    () => {
      try {
        const { columns } = mockRecords(`SELECT * FROM ${table} LIMIT 1`);
        return Response.json({
          columns: columns.map((name) => ({ name, type: mockType(name) })),
          timestamp_column: columns.includes("timestamp") ? "timestamp" : null,
        });
      } catch (error) {
        return Response.json({ ...EMPTY, error: error instanceof Error ? error.message : String(error) });
      }
    },
    async (target) => {
      const got = await catalogGet(target, `schema?table=${encodeURIComponent(table)}`, EMPTY);
      if (got instanceof Response) return got;
      return Response.json(got.body);
    },
  );
}
