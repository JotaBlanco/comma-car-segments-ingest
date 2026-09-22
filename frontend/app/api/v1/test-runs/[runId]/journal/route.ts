import { addRunNote, getDb, getRunJournal } from "@/lib/mock/db";
import { parsePagination } from "@/lib/mock/helpers";
import type { JournalKind } from "@/types";
import { decodeParam, readJsonBody, withApi } from "../../../_lib/http";

type Context = { params: Promise<{ runId: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { runId } = await params;
  return withApi(request, () => {
    const sp = new URL(request.url).searchParams;
    const kind = (sp.get("kind") as JournalKind | null) ?? undefined;
    return Response.json(getRunJournal(getDb(), decodeParam(runId), kind, parsePagination(sp, 50)));
  });
}

/** Append a free-text note (★) — `POST /test-runs/{id}/journal`, answers 201. */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { runId } = await params;
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    return Response.json(addRunNote(getDb(), decodeParam(runId), body.note, body.actor), {
      status: 201,
    });
  });
}
