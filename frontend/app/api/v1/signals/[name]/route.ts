import { getDb, getSignal, patchSignal } from "@/lib/mock/db";
import type { SignalPatchBody } from "@/types";
import { decodeParam, readJsonBody, withApi } from "../../_lib/http";

type Context = { params: Promise<{ name: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { name } = await params;
  return withApi(request, () => Response.json(getSignal(getDb(), decodeParam(name))));
}

export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const { name } = await params;
  return withApi(request, async () => {
    const body = (await readJsonBody(request)) as Partial<SignalPatchBody>;
    return Response.json(patchSignal(getDb(), decodeParam(name), body as SignalPatchBody));
  });
}
