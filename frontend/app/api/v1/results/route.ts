import { getDb, listResults } from "@/lib/mock/db";
import { parseBool, parsePagination } from "@/lib/mock/helpers";
import type { ResultListFilters } from "@/types";
import { withApi } from "../_lib/http";

export async function GET(request: Request): Promise<Response> {
  return withApi(request, () => {
    const sp = new URL(request.url).searchParams;
    const filters: ResultListFilters = {
      run: sp.get("run") ?? undefined,
      result_key: sp.get("result_key") ?? undefined,
      latest_only: parseBool(sp.get("latest_only")) ?? false,
    };
    return Response.json(listResults(getDb(), filters, parsePagination(sp)));
  });
}
