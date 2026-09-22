import { getDb, getWorkOrder } from "@/lib/mock/db";
import { decodeParam, withApi } from "../../_lib/http";

type Context = { params: Promise<{ woId: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { woId } = await params;
  return withApi(request, () => Response.json(getWorkOrder(getDb(), decodeParam(woId))));
}
