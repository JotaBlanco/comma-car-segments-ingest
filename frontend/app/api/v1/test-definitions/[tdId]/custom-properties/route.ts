import { getDb, setDefinitionCustomProperties } from "@/lib/mock/db";
import { decodeParam, readJsonBody, withApi } from "../../../_lib/http";

type Context = { params: Promise<{ tdId: string }> };

/**
 * Replace the custom property map of one definition. Answers 200 with the map.
 * The map goes whole, so an empty object clears every property.
 */
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const { tdId } = await params;
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    return Response.json(setDefinitionCustomProperties(getDb(), decodeParam(tdId), body));
  });
}
