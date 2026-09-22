import { getDb, signalFacets } from "@/lib/mock/db";
import { withApi } from "../../_lib/http";

/* Contract §14b. The static segment wins over the `[name]` segment, so this
   route answers before the catalog detail reads "facets" as a signal name. */
export async function GET(request: Request): Promise<Response> {
  return withApi(request, () => Response.json(signalFacets(getDb())));
}
