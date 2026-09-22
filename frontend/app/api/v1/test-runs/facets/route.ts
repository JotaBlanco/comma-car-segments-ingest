import { getDb, runFacets } from "@/lib/mock/db";
import { withApi } from "../../_lib/http";

/* Contract §2b. The static segment wins over the `[runId]` segment, so this
   route answers before the run detail reads "facets" as a run id. */
export async function GET(request: Request): Promise<Response> {
  return withApi(request, () => Response.json(runFacets(getDb())));
}
