import { clearInvalidFlag, flagInvalid, getDb } from "@/lib/mock/db";
import { decodeParam, readJsonBody, withApi } from "../../../_lib/http";

type Context = { params: Promise<{ runId: string }> };

export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { runId } = await params;
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    return Response.json(flagInvalid(getDb(), decodeParam(runId), body.reason, body.actor));
  });
}

/**
 * Undo an invalid flag — the counterpart of the POST above. Without this
 * export no mock screen could reach it, so a flag raised in an e2e rehearsal
 * stayed for ever (`api/api/routers/test_runs.py clear_run_invalid`).
 */
export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  const { runId } = await params;
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    return Response.json(clearInvalidFlag(getDb(), decodeParam(runId), body.reason, body.actor));
  });
}
