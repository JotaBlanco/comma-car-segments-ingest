import { clearFileInvalidFlag, flagFileInvalid, getDb } from "@/lib/mock/db";
import { decodeParam, readJsonBody, withApi } from "../../../_lib/http";

type Context = { params: Promise<{ fileId: string }> };

/**
 * Mark one file invalid — `POST /files/{id}/invalid-flag`. It is the run
 * route of the same name, read at file level. Without this export the mock
 * answered 404 while the real API answered the call, so a demo could not
 * show the mark at all (`api/api/routers/files.py flag_file_invalid`).
 */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { fileId } = await params;
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    return Response.json(flagFileInvalid(getDb(), decodeParam(fileId), body.reason, body.actor));
  });
}

/**
 * Take the mark back — `DELETE /files/{id}/invalid-flag`. The reason stays
 * required, so the timeline keeps both halves and both reasons
 * (`api/api/routers/files.py clear_file_invalid`).
 */
export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  const { fileId } = await params;
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    return Response.json(clearFileInvalidFlag(getDb(), decodeParam(fileId), body.reason, body.actor));
  });
}
