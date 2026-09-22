import { getDb, listRunSignals } from "@/lib/mock/db";
import { parsePagination } from "@/lib/mock/helpers";
import { decodeParam, withApi } from "../../../_lib/http";

type Context = { params: Promise<{ runId: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { runId } = await params;
  return withApi(request, () => {
    const sp = new URL(request.url).searchParams;
    return Response.json(listRunSignals(getDb(), decodeParam(runId), parsePagination(sp)));
  });
}
