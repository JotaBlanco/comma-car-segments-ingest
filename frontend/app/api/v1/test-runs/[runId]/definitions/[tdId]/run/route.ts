import { getDb, getRun, getTestDefinition } from "@/lib/mock/db";
import { PORTAL_TOKEN_HEADER } from "@/lib/portal/token-store";
import { decodeParam, errorResponse, withApi } from "../../../../../_lib/http";

/**
 * The mock of `api/api/routers/definition_runs.py`.
 *
 * The built-in mock starts no QuixLab Job, so it answers the refusals the API gives
 * in the same order: the Portal token first, then the run and the definition.
 */

type Context = { params: Promise<{ runId: string; tdId: string }> };

function missingToken(request: Request): Response | null {
  if ((request.headers.get(PORTAL_TOKEN_HEADER) ?? "").trim().length > 0) return null;
  return errorResponse(
    401,
    "quixlab_needs_login",
    "no portal token; a definition run is started as the person who asked for it",
  );
}

export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { runId, tdId } = await params;
  return withApi(request, () => {
    const refused = missingToken(request);
    if (refused) return refused;
    const db = getDb();
    getRun(db, decodeParam(runId));
    const definition = getTestDefinition(db, decodeParam(tdId));
    if (!(definition.implementation?.blob_path ?? "").trim()) {
      return errorResponse(
        404,
        "implementation_not_found",
        `Test definition ${definition.td_id} carries no implementation`,
      );
    }
    return errorResponse(409, "quixlab_no_template", "the built-in mock starts no QuixLab Job");
  });
}

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { runId, tdId } = await params;
  return withApi(request, () => {
    const refused = missingToken(request);
    if (refused) return refused;
    const db = getDb();
    const run = getRun(db, decodeParam(runId));
    const definition = getTestDefinition(db, decodeParam(tdId));
    return errorResponse(
      404,
      "run_job_not_found",
      `no run of ${definition.td_id} on ${run.run_id}`,
    );
  });
}
