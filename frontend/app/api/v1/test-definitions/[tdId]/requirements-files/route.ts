import { addRequirementsFile, getDb } from "@/lib/mock/db";
import { decodeParam, readJsonBody, withApi } from "../../../_lib/http";

type Context = { params: Promise<{ tdId: string }> };

/**
 * Add one requirements document to a definition. Answers 201 with the
 * document. The document always carries the source `manual`.
 */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { tdId } = await params;
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    return Response.json(addRequirementsFile(getDb(), decodeParam(tdId), body), { status: 201 });
  });
}
