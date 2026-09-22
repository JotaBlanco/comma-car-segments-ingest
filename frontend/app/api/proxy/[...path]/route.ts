/**
 * Server-side proxy for the browser client.
 * The browser never holds TM_API_TOKEN — this handler adds the
 * Authorization header on the server (contract §A: the FE reads the
 * token server-side and proxies requests).
 *
 * Two guards sit in front of that. Both exist because this route hands out
 * our credential, so it must know where it sends the request and who asked.
 *
 * 1. A real backend must answer. API_URL names one directly; TM_BE_URL names
 *    one through the next.config.ts rewrite. With neither, the route used to
 *    fall back to the built-in mock and answer 200 with seed numbers a person
 *    cannot tell from real ones. It now refuses. The mock stays reachable, but
 *    only behind a variable that says so: TM_USE_MOCK_API=1, or TM_TEST_HOOKS=1
 *    for the end-to-end rig.
 *
 * 2. The caller must look like our own page. The app has no login, so the only
 *    caller it can tell apart is a browser fetch from a document on this
 *    origin. See `isOwnPage` for what that covers and what it does not.
 *
 * `app/ready/route.ts` imports the three resolver functions below, so the
 * readiness probe reports the backend this route really uses. A second copy of
 * the rule would let the probe pass while the data path served the mock.
 */

// The browser sets this header and this handler reads it. One constant, so the
// two sides cannot drift. A drift here would be a silent fall back to the
// shared token, and every journal row would name one person again.
import { PORTAL_TOKEN_HEADER } from "@/lib/portal/token-store";

type Context = { params: Promise<{ path: string[] }> };

function errorResponse(status: number, code: string, detail: string): Response {
  return Response.json({ detail, code, errors: [] }, { status });
}

/**
 * Response headers this proxy must not copy on to the browser.
 *
 * The first eight are the hop-by-hop headers (RFC 9110 §7.6.1, and the list in
 * RFC 7230 §6.1). Each one describes a single connection, so it belongs to the
 * hop that sent it and never to the next hop.
 *
 * `content-encoding` and `content-length` join the set for a second reason.
 * `fetch` already decoded the backend body, and this route builds a new
 * response around it, so both values describe bytes we no longer hold.
 *
 * `access-control-allow-origin` and `access-control-allow-credentials` join it
 * for a third reason. `isOwnPage` below records that a cross-site read fails
 * because this route sends no allow-origin header. A backend that later adds
 * CORS must not cancel that record through this copy.
 *
 * `PORTAL_TOKEN_HEADER` joins it for a fourth reason. This route sends the
 * viewer's Portal token to the API, so the token must travel one way only. A
 * backend that echoed the header back would put a live credential in a
 * response the browser reads. Our API never echoes it. This drop makes that
 * true whatever the backend does.
 */
const HEADERS_A_PROXY_DROPS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  PORTAL_TOKEN_HEADER,
]);

/**
 * Copy the backend response headers, minus the ones a proxy must drop.
 *
 * The route kept `Content-Type` alone before. The backend sends
 * `Content-Disposition`, `X-Checksum-SHA256` and `X-Journal-Id` on the file
 * download (`api/api/routers/files.py`) and the last two on the result upload
 * (`api/api/routers/results.py`). All three died here, so the browser could
 * neither name the downloaded file nor verify a checksum nor walk to the
 * journal entry.
 */
function forwardedHeaders(source: Headers): Headers {
  const headers = new Headers();
  // `forEach` yields every name in lower case, which is what the set holds.
  source.forEach((value, name) => {
    if (!HEADERS_A_PROXY_DROPS.has(name)) headers.set(name, value);
  });
  // The old behavior for a backend that names no type. Every route we call
  // answers JSON or octet-stream, so this is a floor and not a rewrite.
  if (!headers.has("content-type")) headers.set("Content-Type", "application/json");
  return headers;
}

/**
 * True when this app's own /api/v1 path reaches a real backend.
 *
 * next.config.ts rewrites /api/v1/* to TM_BE_URL, in beforeFiles, so the
 * rewrite wins over the mock handlers. When TM_BE_URL holds a value, a call to
 * our own origin therefore lands on the real registry API, not on the mock.
 * That is the documented local setup: .env.example says to leave API_URL unset.
 */
export function rewriteReachesBackend(): boolean {
  const rewriteTarget = process.env.TM_BE_URL?.trim();
  return rewriteTarget !== undefined && rewriteTarget.length > 0;
}

/** True when this process deliberately serves the in-app mock under /api/v1. */
export function mockIsDeliberate(): boolean {
  // TM_USE_MOCK_API names itself, for a developer running the front end alone.
  // TM_TEST_HOOKS already marks a test rig (it gates POST /api/test/reset), and
  // playwright.config.ts sets it for the whole suite. Neither is ever set in a
  // deployed image, so neither can reopen the silent fallback on stage.
  return process.env.TM_USE_MOCK_API === "1" || process.env.TM_TEST_HOOKS === "1";
}

/**
 * Resolve the backend base URL, or return null when nothing real answers.
 *
 * Two configurations reach a real backend, and both are supported:
 *   - API_URL names it directly. Any host works, including a compose-internal
 *     name with no dot, such as http://api:8000.
 *   - API_URL is unset and TM_BE_URL is set. The call goes to our own origin
 *     and the next.config.ts rewrite carries it to the real backend.
 *
 * Null means no real backend answers, so the in-app mock would. That is the
 * one case this route refuses, because mock numbers read exactly like real
 * ones and nobody in a demo room can tell them apart.
 */
export function resolveBackend(requestUrl: URL): string | null {
  const configured = process.env.API_URL?.trim();

  // Our own origin is a real target when the rewrite forwards it, and a mock
  // when it does not.
  const ownOrigin =
    rewriteReachesBackend() || mockIsDeliberate() ? requestUrl.origin : null;

  if (configured === undefined || configured.length === 0) return ownOrigin;

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return null;
  }
  // "tm-api:8000" parses: URL reads "tm-api:" as the scheme. fetch would then
  // throw on an unsupported protocol, long after the guard could say why.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // Pointing at ourselves is the same case as an unset API_URL.
  if (parsed.origin === requestUrl.origin) return ownOrigin;
  return configured.replace(/\/+$/, "");
}

/**
 * True when the request looks like a fetch from this app's own page.
 *
 * What it covers: a bare `curl http://host/api/proxy/...` from the room or the
 * network now gets 401 instead of our data, and so does a URL pasted into the
 * address bar (a navigation reports `sec-fetch-site: none`). That is the
 * exposure the security review measured.
 *
 * What it does NOT cover: an attacker who sets the header. Both marks are
 * request headers, so any client can forge them. This is not authentication
 * and it is not a substitute for one. So it decides nothing about the
 * credential: a caller that passes it and carries no Portal token still
 * reaches the API with no Authorization header. See `sharedTokenIsTheOnlyKey`.
 * A cross-site browser call was already impossible: the route sends no
 * allow-origin header, so CORS refuses the read.
 *
 * The Referer branch exists for a browser too old to send Sec-Fetch-*. It adds
 * no weakness, because a forged Referer costs an attacker exactly as little.
 */
function isOwnPage(request: Request, requestUrl: URL): boolean {
  // The end-to-end rig drives the proxy through Playwright's API request
  // context, which sends neither mark. TM_TEST_HOOKS is off in every image.
  if (process.env.TM_TEST_HOOKS === "1") return true;
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;
  const referer = request.headers.get("referer");
  if (referer !== null) {
    try {
      if (new URL(referer).origin === requestUrl.origin) return true;
    } catch {
      // A malformed Referer proves nothing. Fall through to the refusal.
    }
  }
  return false;
}

/**
 * True when the shared TM_API_TOKEN is the only key this stack has.
 *
 * `api/api/auth.py` reads `Quix__Portal__Api` and picks one of two paths with
 * it. Without that name the API cannot ask the platform about a viewer's
 * token, so the static token is the only key that opens it. The local stack
 * (`docker-compose.local.yml`) and the built-in mock both run that way, and
 * nobody can sign in on either, so the proxy still carries the shared token
 * there. `mockIsDeliberate` names the mock and the end-to-end rig, and the rig
 * sets a Portal name that answers nothing.
 *
 * With `Quix__Portal__Api` set, every viewer carries a token of their own, so
 * the shared token has no job left on a browser request. The platform injects
 * that name into every deployment, so a deployed front end always takes this
 * path.
 */
function sharedTokenIsTheOnlyKey(): boolean {
  if (mockIsDeliberate()) return true;
  return (process.env.Quix__Portal__Api ?? "").trim().length === 0;
}

/**
 * The viewer's own Quix Portal token, when the browser sent one.
 *
 * The shared TM_API_TOKEN names one person for everybody, so every journal
 * row reads the same name and the audit proves nothing. The viewer's token
 * names the viewer. `api/api/auth.py` accepts both: it compares the static
 * token first, and it asks the platform about anything else when
 * Quix__Portal__Api is set. The platform injects that name into every
 * deployment, so a deployed API always asks. So the proxy sends the viewer's
 * token, and it falls back to the shared one only where that shared token is
 * the only key (see `sharedTokenIsTheOnlyKey`).
 *
 * **How the token crosses.** It lives in the browser and this handler runs on
 * the server, so the browser states it on the request.
 * `frontend/lib/api/client.ts` reads it from the in-memory holder in
 * `lib/portal/token-store.ts` and sets this header. The path it calls is
 * relative, so the header reaches our own origin and no other host.
 *
 * **Why that is safe.** A custom header is never ambient. A browser attaches
 * it only when our own code asks, so a cross-site page cannot make the browser
 * send it, and the name is not CORS-safelisted, so a cross-origin attempt
 * needs a preflight this route does not answer. The header also grants
 * nothing on its own: it only chooses which token the proxy sends, and the API
 * still verifies that token with the platform. A forged value fails there.
 *
 * A value with a space or a newline is not a bearer token. It is refused here
 * rather than pasted into an Authorization header.
 *
 * `app/api/lake/query/route.ts` imports this function, the way
 * `app/ready/route.ts` imports the resolvers above. That route holds the lake
 * credential, so it must read the caller's credential the same way this one
 * does. A second copy of the rule would let the two drift apart.
 */
export function viewerToken(request: Request): string | null {
  const sent = request.headers.get(PORTAL_TOKEN_HEADER);
  if (sent === null) return null;
  const token = sent.trim();
  if (token.length === 0) return null;
  if (/\s/.test(token)) return null;
  return token;
}

async function forward(request: Request, { params }: Context): Promise<Response> {
  const { path } = await params;
  const url = new URL(request.url);

  if (!isOwnPage(request, url)) {
    return errorResponse(
      401,
      "unauthorized",
      "this endpoint serves the Test Manager UI only",
    );
  }

  const base = resolveBackend(url);
  if (base === null) {
    // Loud on the server too, so whoever reads the pod log finds the cause.
    console.error(
      `[proxy] No real backend answers. API_URL=${process.env.API_URL ?? "(unset)"}, ` +
        `TM_BE_URL=${process.env.TM_BE_URL ?? "(unset)"}. Set API_URL to the registry ` +
        "API, or set TM_BE_URL so the rewrite reaches it, or set TM_USE_MOCK_API=1 to " +
        "serve the built-in mock on purpose.",
    );
    return errorResponse(
      500,
      "backend_not_configured",
      "no backend is configured — the front end refuses to serve mock data as real",
    );
  }

  const target = `${base}/api/v1/${path.map(encodeURIComponent).join("/")}${url.search}`;

  const headers: Record<string, string> = {};
  const portalToken = viewerToken(request);
  // `isOwnPage` above reads request headers only, and a browser sets its own
  // headers, so a caller can pass that guard with one curl flag. The route
  // therefore never lends the shared token to a caller who signed in nowhere:
  // the request goes on with no Authorization header and the API answers 401.
  // That refusal is the honest answer, and it is the answer the guard's own
  // comment says the guard cannot give by itself.
  const token = portalToken ?? (sharedTokenIsTheOnlyKey() ? process.env.TM_API_TOKEN : undefined);
  if (token) headers.Authorization = `Bearer ${token}`;
  // The viewer's Portal token also crosses under its own name, because one
  // route needs the token itself and not the identity behind it. Ask AI opens
  // a Quix.AI session as the viewer, so `api/api/routers/explore_chat.py:90`
  // reads this header and hands the value to the Portal. The Authorization
  // header cannot carry it there: `api/api/auth.py` verifies that header and
  // keeps only an identity, and it never gives the token back.
  //
  // The rule is not "never forward". The rule is that the viewer's token goes
  // to our own API and nowhere else. So the value goes on this one request, to
  // the backend `resolveBackend` named, after `isOwnPage` accepted the caller.
  // Only a value `viewerToken` accepted crosses, never the shared token.
  if (portalToken) headers[PORTAL_TOKEN_HEADER] = portalToken;
  const contentType = request.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;

  // Stream the request bytes through, unchanged. `request.text()` decoded them
  // as UTF-8 and replaced every invalid sequence, so a multipart upload that
  // carried a parquet file or a workbook reached the server damaged, and the
  // server then checksummed the damage. GET and HEAD carry no body.
  const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;

  let response: Response;
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body,
      // Node sends a streamed body only when the caller names the duplex mode.
      // The DOM `RequestInit` type declares no such field, so the cast stays.
      duplex: "half",
      cache: "no-store",
      // One hop, always. `fetch` follows a redirect by itself and it repeats the
      // request headers at the new location. It drops `Authorization` on a
      // cross-origin hop, and it keeps a custom header, so a redirect would hand
      // the viewer's Portal token to whatever host the Location named. The API
      // declares no redirect, so this option changes no working call.
      redirect: "manual",
    } as RequestInit & { duplex: "half" });
  } catch {
    // A configured backend that does not answer (down, DNS, refused) used to
    // crash this handler into Next's opaque 500 page. Answer the same error
    // shape every other guard here answers — the lake route's unreachable
    // branch (app/api/lake/query/route.ts) is the model — so the client's
    // ApiError path can show a readable message.
    return errorResponse(
      502,
      "backend_unreachable",
      `Could not reach the registry API at ${new URL(target).host}.`,
    );
  }

  // Stream the answer back too. A registered file reaches 100 MB, and the old
  // `arrayBuffer()` held all of it in this process before the browser saw a byte.
  return new Response(response.body, {
    status: response.status,
    headers: forwardedHeaders(response.headers),
  });
}

export const GET = forward;
export const HEAD = forward;
export const POST = forward;
export const PATCH = forward;
// The unflag route is `DELETE /test-runs/{run_id}/invalid-flag`
// (`api/api/routers/test_runs.py`). Without this export no screen reaches it,
// so a flag raised in a rehearsal stays for ever.
export const DELETE = forward;
// The API declares no PUT route, so this file exports no PUT. Next answers
// OPTIONS by itself when the file defines none.
