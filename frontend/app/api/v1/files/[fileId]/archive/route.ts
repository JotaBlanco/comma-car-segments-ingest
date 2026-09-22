import { archiveFile, getDb } from "@/lib/mock/db";
import { decodeParam, readJsonBody, withApi } from "../../../_lib/http";

type Context = { params: Promise<{ fileId: string }> };

/** Move one file out of the daily table — `POST /files/{id}/archive`. */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { fileId } = await params;
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    return Response.json(archiveFile(getDb(), decodeParam(fileId), body.actor, body.note));
  });
}
