import { editRequirementsFile, getDb, removeRequirementsFile } from "@/lib/mock/db";
import { decodeParam, readJsonBody, withApi } from "../../../../_lib/http";

type Context = { params: Promise<{ tdId: string; name: string }> };

/**
 * Remove one manual requirements document. Answers 204. The route refuses a
 * planning document, because the planning system owns it.
 */
export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  const { tdId, name } = await params;
  return withApi(request, () => {
    removeRequirementsFile(getDb(), decodeParam(tdId), decodeParam(name));
    return new Response(null, { status: 204 });
  });
}

/**
 * Change the text of one manual TEXT document. Answers 200 with the document.
 * The route never renames one: the path names it. It refuses a planning
 * document and a binary document.
 */
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const { tdId, name } = await params;
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    return Response.json(
      editRequirementsFile(getDb(), decodeParam(tdId), decodeParam(name), body),
    );
  });
}
