import {
  getDb,
  listRuns,
  RUNS_SORT_DEFAULTS,
  RUNS_SORT_WHITELIST,
} from "@/lib/mock/db";
import { parseMulti, parsePagination, parseSort } from "@/lib/mock/helpers";
import type { RunListFilters, RunStatus, SourceTag } from "@/types";
import { withApi } from "../_lib/http";

export async function GET(request: Request): Promise<Response> {
  return withApi(request, () => {
    const sp = new URL(request.url).searchParams;
    const filters: RunListFilters = {
      status: parseMulti(sp, "status") as RunStatus[] | undefined,
      rig: parseMulti(sp, "rig"),
      project: parseMulti(sp, "project"),
      test_cell: parseMulti(sp, "test_cell"),
      source: parseMulti(sp, "source") as SourceTag[] | undefined,
      definition: sp.get("definition") ?? undefined,
      work_order: sp.get("work_order") ?? undefined,
      signal: sp.get("signal") ?? undefined,
      q: sp.get("q") ?? undefined,
    };
    const sort = parseSort(sp, RUNS_SORT_WHITELIST, "first_data_at", RUNS_SORT_DEFAULTS);
    return Response.json(listRuns(getDb(), filters, parsePagination(sp), sort));
  });
}
