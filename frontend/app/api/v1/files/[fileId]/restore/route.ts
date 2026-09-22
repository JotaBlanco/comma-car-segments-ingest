import { getDb, restoreFile } from "@/lib/mock/db";
import { decodeParam, readJsonBody, withApi } from "../../../_lib/http";

type Context = { params: Promise<{ fileId: string }> };

/**
 * Bring an archived or deleted file back — `POST /files/{id}/restore`.
 * Never touches `status`: a quarantined file restores to quarantined.
 */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { fileId } = await params;
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    return Response.json(restoreFile(getDb(), decodeParam(fileId), body.actor, body.note));
  });
}
