import { getDb, getHomeSummary } from "@/lib/mock/db";
import { withApi } from "../../_lib/http";

export async function GET(request: Request): Promise<Response> {
  return withApi(request, () => Response.json(getHomeSummary(getDb())));
}
