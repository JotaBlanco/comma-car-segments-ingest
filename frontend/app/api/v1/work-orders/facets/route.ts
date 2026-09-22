import { getDb, workOrderFacets } from "@/lib/mock/db";
import { withApi } from "../../_lib/http";

/* Contract §10b. The static segment wins over the `[woId]` segment, so this
   route answers before the work-order detail reads "facets" as an id. */
export async function GET(request: Request): Promise<Response> {
  return withApi(request, () => Response.json(workOrderFacets(getDb())));
}
