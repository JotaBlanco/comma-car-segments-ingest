import { getDb, getRunLineage } from "@/lib/mock/db";
import { decodeParam, withApi } from "../../../_lib/http";

type Context = { params: Promise<{ runId: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { runId } = await params;
  return withApi(request, () => Response.json(getRunLineage(getDb(), decodeParam(runId))));
}
