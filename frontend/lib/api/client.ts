import { getActivePortalToken, PORTAL_TOKEN_HEADER } from "@/lib/portal/token-store";
import type { ApiErrorBody } from "@/types";

/* Browser calls go through the server-side proxy, which adds the
   Authorization header. The shared TM_API_TOKEN never reaches the browser.

   The viewer's own Quix Portal token travels the other way. The browser holds
   it and the proxy runs on the server, so the browser states it on the
   request. The proxy then sends the viewer's token instead of the shared one,
   and the API names a real person in the journal. The path is relative, so
   the header goes to our own origin and to no other host. */
const BASE_PATH = "/api/proxy";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
    public readonly code: string,
    public readonly errors: unknown[] = [],
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

export type QueryParamValue =
  | string
  | number
  | boolean
  | undefined
  | readonly (string | number)[];

export type QueryParams = Record<string, QueryParamValue>;

/**
 * Build the query string of a call: `?a=1&b=2`, or the empty string.
 *
 * Exported because the server-side export builds its own URL from the same
 * filters object the list call uses (`components/shared/export-button.tsx`).
 * A second builder would encode a filter differently, and the file would then
 * hold different rows from the table.
 */
export function buildQuery(params?: QueryParams): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      // Multi-value filters: repeat the key once per entry (contract §1.1).
      for (const entry of value as readonly (string | number)[]) {
        sp.append(key, String(entry));
      }
    } else {
      sp.set(key, String(value));
    }
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

/**
 * The viewer's Portal token, when the browser holds one.
 *
 * `lib/api/lake.ts` exports its calls through this helper too. That route
 * refuses a caller with no token, so the browser must state it there as well.
 */
export function viewerHeaders(): Record<string, string> {
  const portalToken = getActivePortalToken();
  return portalToken === null ? {} : { [PORTAL_TOKEN_HEADER]: portalToken };
}

/** Build the ApiError of a refused answer. The §A body names the code. */
async function errorFrom(response: Response): Promise<ApiError> {
  let errorBody: ApiErrorBody = {
    detail: `Request failed with status ${response.status}`,
    code: "unknown_error",
    errors: [],
  };
  try {
    errorBody = (await response.json()) as ApiErrorBody;
  } catch {
    // non-JSON error body — keep fallback
  }
  return new ApiError(response.status, errorBody.detail, errorBody.code, errorBody.errors);
}

/* DELETE carries a body here. The unflag route reads a reason from it
   (`api/api/routers/test_runs.py`), so the helper sends one. The proxy
   exports DELETE, so the method reaches the API. */
async function request<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: { params?: QueryParams; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...viewerHeaders() };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${BASE_PATH}${path}${buildQuery(options.params)}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) throw await errorFrom(response);
  return (await response.json()) as T;
}

/**
 * Send a DELETE that answers 204 and reads nothing back.
 *
 * `request` parses every answer as JSON. A 204 carries no body, so that parse
 * throws on a call that in fact succeeded. `DELETE /saved-searches/{id}`
 * answers 204 (contract §D DS-9), so it comes through here.
 */
async function deleteVoid(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${BASE_PATH}${path}`, {
    method: "DELETE",
    headers: { ...viewerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await errorFrom(response);
}

/** The parts of an upload answer a caller reads: the body and the checksum. */
export interface FormAnswer<T> {
  body: T;
  /** The SHA-256 the server computed over the stored bytes, or null. */
  checksum: string | null;
}

/**
 * Post a multipart body.
 *
 * This helper sets **no** Content-Type header on purpose. A multipart body
 * needs the boundary the browser picked, and only the browser knows it. A
 * hand-written header loses the boundary and the server then reads no part.
 * The proxy copies the header the browser wrote, so the boundary survives.
 */
async function postForm<T>(path: string, form: FormData): Promise<FormAnswer<T>> {
  const response = await fetch(`${BASE_PATH}${path}`, {
    method: "POST",
    headers: { ...viewerHeaders() },
    body: form,
  });
  if (!response.ok) throw await errorFrom(response);
  return {
    body: (await response.json()) as T,
    checksum: response.headers.get("X-Checksum-SHA256"),
  };
}

export const api = {
  get: <T>(path: string, params?: QueryParams) => request<T>("GET", path, { params }),
  post: <T>(path: string, body: unknown) => request<T>("POST", path, { body }),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, { body }),
  delete: <T>(path: string, body: unknown) => request<T>("DELETE", path, { body }),
  deleteVoid: (path: string, body: unknown) => deleteVoid(path, body),
  postForm: <T>(path: string, form: FormData) => postForm<T>(path, form),
};
