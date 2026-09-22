import { getDb, getResult, patchResult } from "@/lib/mock/db";
import { decodeParam, readJsonBody, withApi } from "../../_lib/http";

type Context = { params: Promise<{ resultId: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { resultId } = await params;
  return withApi(request, () => Response.json(getResult(getDb(), decodeParam(resultId))));
}

/**
 * Correct the label or the provenance of one stored result —
 * `PATCH /results/{result_id}`. The answer carries the `edited` mark.
 */
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const { resultId } = await params;
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    return Response.json(patchResult(getDb(), decodeParam(resultId), body));
  });
}
