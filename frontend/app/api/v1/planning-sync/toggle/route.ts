import { getDb, toggleSync } from "@/lib/mock/db";
import { readJsonBody, withApi } from "../../_lib/http";

export async function POST(request: Request): Promise<Response> {
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    return Response.json(toggleSync(getDb(), body.online));
  });
}
