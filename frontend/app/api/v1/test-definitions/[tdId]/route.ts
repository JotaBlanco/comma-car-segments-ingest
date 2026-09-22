import { getDb, getTestDefinition } from "@/lib/mock/db";
import { decodeParam, withApi } from "../../_lib/http";

type Context = { params: Promise<{ tdId: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { tdId } = await params;
  return withApi(request, () => Response.json(getTestDefinition(getDb(), decodeParam(tdId))));
}
