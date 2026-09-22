import { getDb, listFileVersions, registerFileVersion } from "@/lib/mock/db";
import { decodeParam, readJsonBody, withApi } from "../../../_lib/http";

type Context = { params: Promise<{ fileId: string }> };

/** The whole version chain, oldest first — `GET /files/{id}/versions`. */
export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { fileId } = await params;
  return withApi(request, () => Response.json(listFileVersions(getDb(), decodeParam(fileId))));
}

/**
 * Append a new version — `POST /files/{id}/versions`. A body whose checksum
 * matches the newest version REPLAYS: 200 with that version, nothing written
 * (the real route's retry-safety rule). A new version answers 201.
 */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { fileId } = await params;
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    const { file, replayed } = registerFileVersion(getDb(), decodeParam(fileId), body);
    return Response.json(file, { status: replayed ? 200 : 201 });
  });
}
