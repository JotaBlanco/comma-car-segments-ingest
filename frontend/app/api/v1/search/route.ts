import { getDb, search } from "@/lib/mock/db";
import { validation } from "@/lib/mock/errors";
import { withApi } from "../_lib/http";

export async function GET(request: Request): Promise<Response> {
  return withApi(request, () => {
    const sp = new URL(request.url).searchParams;
    const q = sp.get("q");
    if (q === null || q.trim().length === 0) {
      throw validation("validation_error", "q is required (min 1 character)", [
        { loc: ["query", "q"], msg: "field required", type: "value_error.missing" },
      ]);
    }
    const rawLimit = Number(sp.get("limit_per_group") ?? 5);
    const limit = Number.isInteger(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 10) : 5;
    return Response.json(search(getDb(), q, limit));
  });
}
