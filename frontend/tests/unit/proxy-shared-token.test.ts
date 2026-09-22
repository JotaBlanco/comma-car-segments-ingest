/**
 * The proxy never upgrades an anonymous caller.
 *
 * `isOwnPage` reads `sec-fetch-site` and `Referer`. Both are request headers,
 * and a client sets its own headers, so one curl flag passes that guard. The
 * route used to answer that caller with the shared `TM_API_TOKEN`, which
 * carries full access to the registry API, and `quix.yaml` publishes this
 * front end to the internet.
 *
 * The rule these tests pin: a caller who signed in nowhere reaches the API
 * with no Authorization header, so the API refuses it. The one place the
 * shared token still travels is a stack where it is the only key — the local
 * stack and the mock, where `Quix__Portal__Api` is unset and nobody can sign
 * in at all. `tests/unit/proxy-viewer-token.test.ts` covers that stack.
 *
 * Config: `vitest.unit.config.ts` takes `tests/unit/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/proxy/[...path]/route";
import { PORTAL_TOKEN_HEADER } from "@/lib/portal/token-store";

const ORIGIN = "http://tm.example";
const BACKEND = "http://tm-api";
const SHARED_TOKEN = "tm-demo-4711";
const VIEWER_TOKEN = "viewer-portal-token";
/* The platform injects this name into every deployment, so a deployed front
   end always identifies its viewers. */
const PORTAL_API = "https://portal-api.dev.quix.io";

const params = (path: string[]) => ({ params: Promise.resolve({ path }) });

/** A request that carries the browser mark any client can type. */
function forgedRequest(path = "/api/proxy/home/summary", init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: { "sec-fetch-site": "same-origin", ...(init.headers ?? {}) },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
const saved = { ...process.env };

/** The headers the proxy sent on to the API. */
function sentHeaders(): Record<string, string> {
  return fetchMock.mock.calls[0][1].headers as Record<string, string>;
}

beforeEach(() => {
  delete process.env.TM_BE_URL;
  delete process.env.TM_USE_MOCK_API;
  delete process.env.TM_TEST_HOOKS;
  process.env.API_URL = BACKEND;
  process.env.TM_API_TOKEN = SHARED_TOKEN;
  process.env.Quix__Portal__Api = PORTAL_API;
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe("a caller who signed in nowhere gets no shared token", () => {
  it("sends no Authorization header on a read", async () => {
    await GET(forgedRequest(), params(["home", "summary"]));

    expect(sentHeaders().Authorization).toBeUndefined();
  });

  it("sends no Authorization header on a write", async () => {
    await POST(
      forgedRequest("/api/proxy/journal", {
        method: "POST",
        body: JSON.stringify({ actor: "anonymous-attacker" }),
        headers: { "content-type": "application/json" },
      }),
      params(["journal"]),
    );

    expect(sentHeaders().Authorization).toBeUndefined();
  });

  it("sends no Authorization header when the caller forges a Referer instead", async () => {
    const request = new Request(`${ORIGIN}/api/proxy/home/summary`, {
      headers: { referer: `${ORIGIN}/runs` },
    });

    await GET(request, params(["home", "summary"]));

    expect(sentHeaders().Authorization).toBeUndefined();
  });

  it("names the shared token nowhere on that request", async () => {
    await GET(forgedRequest(), params(["home", "summary"]));

    const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(target).not.toContain(SHARED_TOKEN);
    expect(JSON.stringify(init.headers)).not.toContain(SHARED_TOKEN);
  });

  it("still sends the viewer's own token", async () => {
    await GET(
      forgedRequest("/api/proxy/home/summary", {
        headers: { [PORTAL_TOKEN_HEADER]: VIEWER_TOKEN },
      }),
      params(["home", "summary"]),
    );

    expect(sentHeaders().Authorization).toBe(`Bearer ${VIEWER_TOKEN}`);
  });

  it("keeps the shared token where it is the only key", async () => {
    // The local stack runs the real API with no Portal, so no viewer can sign
    // in and the static token opens every route. See `api/api/auth.py`.
    delete process.env.Quix__Portal__Api;

    await GET(forgedRequest(), params(["home", "summary"]));

    expect(sentHeaders().Authorization).toBe(`Bearer ${SHARED_TOKEN}`);
  });

  it("keeps the shared token for the end-to-end rig", async () => {
    process.env.TM_TEST_HOOKS = "1";

    await GET(forgedRequest(), params(["home", "summary"]));

    expect(sentHeaders().Authorization).toBe(`Bearer ${SHARED_TOKEN}`);
  });
});
