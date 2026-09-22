import { getDb, requestAccess } from "@/lib/mock/db";
import { readJsonBody, withApi } from "../_lib/http";

/**
 * Record one request for access to one entity (§D-Access, UC-003 step 4) —
 * `POST /access-requests`. Answers 201 with the journal entry it wrote.
 *
 * **It grants nothing**, exactly like the real route. The registry holds no
 * scoped access, so the entry is the record of the ask and a person acts on
 * it outside the system.
 */
export async function POST(request: Request): Promise<Response> {
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    return Response.json(requestAccess(getDb(), body), { status: 201 });
  });
}
