import { getDb, getEntityJournal } from "@/lib/mock/db";
import { parsePagination } from "@/lib/mock/helpers";
import type { JournalKind } from "@/types";
import { decodeParam, withApi } from "../../../_lib/http";

type Context = { params: Promise<{ name: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { name } = await params;
  return withApi(request, () => {
    const sp = new URL(request.url).searchParams;
    const kind = (sp.get("kind") as JournalKind | null) ?? undefined;
    return Response.json(
      getEntityJournal(getDb(), "signal", decodeParam(name), kind, parsePagination(sp, 50)),
    );
  });
}
