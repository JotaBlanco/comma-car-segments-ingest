import { getDb, groupRuns } from "@/lib/mock/db";
import { validation } from "@/lib/mock/errors";
import { parseMulti, parsePagination } from "@/lib/mock/helpers";
import { CUSTOM_GROUP_PREFIX } from "@/types";
import type { RunGroupBy, RunGroupByField, RunListFilters, RunStatus, SourceTag } from "@/types";
import { withApi } from "../../_lib/http";

/* Contract §2c. The static segment wins over the `[runId]` segment, so this
   route answers before the run detail reads "groups" as a run id. */

const GROUP_FIELDS: readonly RunGroupByField[] = ["project", "test_cell", "rig"];

/* FR-DM-108. A person names their own criterion with `custom:<property key>`.
   The key obeys the rules of a stored property key, so a blank one is refused
   here the way the API refuses it. The 64-character cap lives in the API. */
function accepted(groupBy: string | null): groupBy is RunGroupBy {
  if (groupBy === null) return false;
  if (GROUP_FIELDS.includes(groupBy as RunGroupByField)) return true;
  return groupBy.startsWith(CUSTOM_GROUP_PREFIX)
    ? groupBy.slice(CUSTOM_GROUP_PREFIX.length).trim() !== ""
    : false;
}

export async function GET(request: Request): Promise<Response> {
  return withApi(request, () => {
    const sp = new URL(request.url).searchParams;
    const groupBy = sp.get("group_by");
    // Required, and no silent default: the API answers 422 for both cases.
    if (!accepted(groupBy)) {
      throw validation("validation_error", `invalid group_by: ${groupBy}`, [
        {
          loc: ["query", "group_by"],
          msg: `must be one of ${GROUP_FIELDS.join(", ")}, or ${CUSTOM_GROUP_PREFIX}<property key>`,
          type: "value_error",
        },
      ]);
    }
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
    return Response.json(
      groupRuns(getDb(), groupBy, filters, parsePagination(sp)),
    );
  });
}
