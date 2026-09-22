import { getDb, listTestDefinitions } from "@/lib/mock/db";
import { parseBool, parsePagination } from "@/lib/mock/helpers";
import { withApi } from "../_lib/http";

export async function GET(request: Request): Promise<Response> {
  return withApi(request, () => {
    const sp = new URL(request.url).searchParams;
    // The param stays absent when the caller states none, and then no filter runs.
    const orphaned = parseBool(sp.get("orphaned"));
    return Response.json(listTestDefinitions(getDb(), { orphaned }, parsePagination(sp)));
  });
}
