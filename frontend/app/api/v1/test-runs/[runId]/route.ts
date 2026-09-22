import { getDb, getRun, patchRun } from "@/lib/mock/db";
import type { RunPatchBody } from "@/types";
import { decodeParam, readJsonBody, withApi } from "../../_lib/http";

type Context = { params: Promise<{ runId: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { runId } = await params;
  return withApi(request, () => Response.json(getRun(getDb(), decodeParam(runId))));
}

export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const { runId } = await params;
  return withApi(request, async () => {
    const body = (await readJsonBody(request)) as Partial<RunPatchBody>;
    return Response.json(patchRun(getDb(), decodeParam(runId), body as RunPatchBody));
  });
}
