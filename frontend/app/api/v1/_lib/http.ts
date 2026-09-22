import { MockDbError } from "@/lib/mock/errors";
import { delay } from "@/lib/mock/helpers";
import type { ApiErrorBody } from "@/types";

export function errorResponse(status: number, code: string, detail: string, errors: unknown[] = []): Response {
  const body: ApiErrorBody = { detail, code, errors };
  return Response.json(body, { status });
}

function checkAuth(request: Request): Response | null {
  const token = process.env.TM_API_TOKEN;
  const header = request.headers.get("authorization");
  if (!token || header !== `Bearer ${token}`) {
    return errorResponse(401, "unauthorized", "invalid or missing token");
  }
  return null;
}

export async function withApi(request: Request, fn: () => Response | Promise<Response>): Promise<Response> {
  const denied = checkAuth(request);
  if (denied) return denied;
  await delay(120);
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MockDbError) {
      return errorResponse(error.status, error.code, error.detail, error.errors);
    }
    const detail = error instanceof Error ? error.message : "internal server error";
    return errorResponse(500, "internal_error", detail);
  }
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new MockDbError(422, "validation_error", "request body must be a JSON object", [
    { loc: ["body"], msg: "invalid JSON object", type: "value_error" },
  ]);
}

export function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
