import { getDb, getEntityJournal } from "@/lib/mock/db";
import { parsePagination } from "@/lib/mock/helpers";
import type { JournalKind } from "@/types";
import { decodeParam, withApi } from "../../../_lib/http";

type Context = { params: Promise<{ resultId: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { resultId } = await params;
  return withApi(request, () => {
    const sp = new URL(request.url).searchParams;
    const kind = (sp.get("kind") as JournalKind | null) ?? undefined;
    return Response.json(
      getEntityJournal(getDb(), "result", decodeParam(resultId), kind, parsePagination(sp, 50)),
    );
  });
}
