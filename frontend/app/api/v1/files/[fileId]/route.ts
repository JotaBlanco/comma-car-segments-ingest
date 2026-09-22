import { getDb, getFile, patchFile, softDeleteFile } from "@/lib/mock/db";
import { decodeParam, readJsonBody, withApi } from "../../_lib/http";

type Context = { params: Promise<{ fileId: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { fileId } = await params;
  return withApi(request, () => {
    const sp = new URL(request.url).searchParams;
    const rawLimit = Number(sp.get("signals_limit") ?? 200);
    const signalsLimit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 200;
    return Response.json(getFile(getDb(), decodeParam(fileId), signalsLimit));
  });
}

/**
 * The manual run link and the stage outcomes — `PATCH /files/{id}`. A run
 * link that repairs a "no run key" quarantine also ends it; a stage outcome
 * never does.
 */
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const { fileId } = await params;
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    return Response.json(patchFile(getDb(), decodeParam(fileId), body));
  });
}

/**
 * A SOFT delete — `DELETE /files/{id}` writes `lifecycle: "deleted"` and
 * nothing else. Every byte stays; a restore brings the file back.
 */
export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  const { fileId } = await params;
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    return Response.json(softDeleteFile(getDb(), decodeParam(fileId), body.actor, body.note));
  });
}
