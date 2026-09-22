import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/proxy/[...path]/route";
import { api } from "@/lib/api/client";
import { PORTAL_TOKEN_HEADER, setActivePortalToken } from "@/lib/portal/token-store";

/* The shared TM_API_TOKEN names one person for everybody, so every journal row
   read the same name and the audit proved nothing. The browser now states the
   viewer's own Quix Portal token on the request, and the proxy prefers it.
   These tests pin both halves: the viewer's token when one exists, and the
   shared token when none does. */

const ORIGIN = "http://tm.example";
const BACKEND = "http://tm-api";
const SHARED_TOKEN = "tm-demo-4711";
const VIEWER_TOKEN = "viewer-portal-token";

const params = (path: string[]) => ({ params: Promise.resolve({ path }) });

/** A request the way the app's own page sends it. */
function browserRequest(path = "/api/proxy/home/summary", init: RequestInit = {}): Request {
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

describe("the proxy prefers the viewer's own Portal token", () => {
  it("sends the viewer's token when the browser states one", async () => {
    const response = await GET(
      browserRequest("/api/proxy/home/summary", {
        headers: { [PORTAL_TOKEN_HEADER]: VIEWER_TOKEN },
      }),
      params(["home", "summary"]),
    );

    expect(response.status).toBe(200);
    expect(sentHeaders().Authorization).toBe(`Bearer ${VIEWER_TOKEN}`);
  });

  it("sends the viewer's token on a write, so the journal names the viewer", async () => {
    await POST(
      browserRequest("/api/proxy/test-runs/r-1", {
        method: "POST",
        body: JSON.stringify({ actor: "e.lindqvist" }),
        headers: {
          "content-type": "application/json",
          [PORTAL_TOKEN_HEADER]: VIEWER_TOKEN,
        },
      }),
      params(["test-runs", "r-1"]),
    );

    expect(sentHeaders().Authorization).toBe(`Bearer ${VIEWER_TOKEN}`);
  });

  it("sends the shared token when the browser states none", async () => {
    await GET(browserRequest(), params(["home", "summary"]));

    expect(sentHeaders().Authorization).toBe(`Bearer ${SHARED_TOKEN}`);
  });

  it("sends the shared token when the header is empty", async () => {
    await GET(
      browserRequest("/api/proxy/home/summary", { headers: { [PORTAL_TOKEN_HEADER]: "  " } }),
      params(["home", "summary"]),
    );

    expect(sentHeaders().Authorization).toBe(`Bearer ${SHARED_TOKEN}`);
  });

  it("refuses a header value that is not a bearer token", async () => {
    // A space cannot appear in a bearer token. It must never be pasted into an
    // Authorization header, so the proxy falls back to the shared token.
    await GET(
      browserRequest("/api/proxy/home/summary", {
        headers: { [PORTAL_TOKEN_HEADER]: "token with spaces" },
      }),
      params(["home", "summary"]),
    );

    expect(sentHeaders().Authorization).toBe(`Bearer ${SHARED_TOKEN}`);
  });

  it("sends the viewer's token even when no shared token is configured", async () => {
    delete process.env.TM_API_TOKEN;

    await GET(
      browserRequest("/api/proxy/home/summary", {
        headers: { [PORTAL_TOKEN_HEADER]: VIEWER_TOKEN },
      }),
      params(["home", "summary"]),
    );

    expect(sentHeaders().Authorization).toBe(`Bearer ${VIEWER_TOKEN}`);
  });

  it("sends no Authorization header when neither token exists", async () => {
    delete process.env.TM_API_TOKEN;

    await GET(browserRequest(), params(["home", "summary"]));

    expect(sentHeaders().Authorization).toBeUndefined();
  });

  it("still refuses a caller that does not look like our own page", async () => {
    // The viewer header must not become a second way in. It is a request
    // header, so any client can set it. The guard runs first, always.
    const response = await GET(
      new Request(`${ORIGIN}/api/proxy/home/summary`, {
        headers: { [PORTAL_TOKEN_HEADER]: VIEWER_TOKEN },
      }),
      params(["home", "summary"]),
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* The viewer's token goes to our own API and nowhere else.
 *
 * **This block replaces an assertion that was wrong.** Commit `0119704`
 * ("Send the viewer's own Portal token to the API", 19 Aug 2026) added a test
 * named "never passes the viewer header itself on to the API". It read the
 * headers the proxy sent and required that `x-portal-token` was absent.
 *
 * That assertion stated the rule too widely, and it was written before the
 * route existed that needs the header. Commit `2a7f1e0` ("feat: Ask AI mode on
 * the Explore tab", 19 Aug 2026) added `POST /test-runs/{id}/explore/chat`.
 * `api/api/routers/explore_chat.py:90` reads `x-portal-token` and hands the
 * value to Quix.AI as the viewer's own credential
 * (`api/api/services/ai_client.py:_headers`). The Authorization header cannot
 * carry the token there. `api/api/auth.py` verifies that header and keeps an
 * `Identity`; it never hands the token on. So a second channel is the only
 * channel, and `0119704` closed it. Ask AI answered 403 for every viewer.
 *
 * The real rule is narrower: the token goes to our own API, on one request,
 * and it reaches nothing else. The tests below pin every part of that.
 */
describe("the viewer's token goes to our own API and nowhere else", () => {
  it("forwards the header to the API, because Ask AI reads it there", async () => {
    await POST(
      browserRequest("/api/proxy/test-runs/r-1/explore/chat", {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
        headers: {
          "content-type": "application/json",
          [PORTAL_TOKEN_HEADER]: VIEWER_TOKEN,
        },
      }),
      params(["test-runs", "r-1", "explore", "chat"]),
    );

    expect(sentHeaders()[PORTAL_TOKEN_HEADER]).toBe(VIEWER_TOKEN);
  });

  it("sends it on one request, to the backend the proxy resolved", async () => {
    await GET(
      browserRequest("/api/proxy/home/summary", {
        headers: { [PORTAL_TOKEN_HEADER]: VIEWER_TOKEN },
      }),
      params(["home", "summary"]),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target] = fetchMock.mock.calls[0] as [string];
    expect(target).toBe(`${BACKEND}/api/v1/home/summary`);
  });

  it("follows no redirect, so no third party receives the header", async () => {
    // `fetch` repeats the request headers at a Location it follows. It drops
    // Authorization on a cross-origin hop and it keeps a custom header, so a
    // followed redirect would hand the viewer's token to another host.
    await GET(
      browserRequest("/api/proxy/home/summary", {
        headers: { [PORTAL_TOKEN_HEADER]: VIEWER_TOKEN },
      }),
      params(["home", "summary"]),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("manual");
  });

  it("never lets the backend echo the header back to the browser", async () => {
    // A response carrying a live credential is a credential the page reads.
    // Our API never sends this header. The proxy drops it whatever arrives.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", [PORTAL_TOKEN_HEADER]: VIEWER_TOKEN },
      }),
    );

    const response = await GET(
      browserRequest("/api/proxy/home/summary", {
        headers: { [PORTAL_TOKEN_HEADER]: VIEWER_TOKEN },
      }),
      params(["home", "summary"]),
    );

    expect(response.headers.get(PORTAL_TOKEN_HEADER)).toBeNull();
  });

  it("never writes the viewer's token into the server log", async () => {
    // The one log line this route writes names the configuration and never a
    // credential. A pod log outlives the token in it.
    delete process.env.API_URL;

    const response = await GET(
      browserRequest("/api/proxy/home/summary", {
        headers: { [PORTAL_TOKEN_HEADER]: VIEWER_TOKEN },
      }),
      params(["home", "summary"]),
    );

    expect(response.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join(" ");
    expect(logged).not.toContain(VIEWER_TOKEN);
  });

  it("never sends the shared token under the viewer's header", async () => {
    // The header names the viewer. The static token names nobody, so a route
    // that reads this header must never receive it and call it a person.
    await GET(browserRequest(), params(["home", "summary"]));

    expect(sentHeaders().Authorization).toBe(`Bearer ${SHARED_TOKEN}`);
    expect(sentHeaders()[PORTAL_TOKEN_HEADER]).toBeUndefined();
  });

  it("forwards no value it refused as a bearer token", async () => {
    // `viewerToken` refuses a value with a space. The refusal must cover both
    // headers, or the API would read a value the proxy already called bad.
    await GET(
      browserRequest("/api/proxy/home/summary", {
        headers: { [PORTAL_TOKEN_HEADER]: "token with spaces" },
      }),
      params(["home", "summary"]),
    );

    expect(sentHeaders()[PORTAL_TOKEN_HEADER]).toBeUndefined();
  });

  it("refuses a caller with no browser mark before it forwards anything", async () => {
    // `isOwnPage` runs first, always. The header is a request header, so any
    // client can set it, and it must never become a second way in.
    const response = await GET(
      new Request(`${ORIGIN}/api/proxy/test-runs/r-1/explore/chat`, {
        headers: { [PORTAL_TOKEN_HEADER]: VIEWER_TOKEN },
      }),
      params(["test-runs", "r-1", "explore", "chat"]),
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the browser states the viewer token on the call it sends", () => {
  afterEach(() => setActivePortalToken(null));

  it("sets the header when the browser holds a token", async () => {
    setActivePortalToken(VIEWER_TOKEN);

    await api.get("/home/summary");

    const [url, init] = fetchMock.mock.calls[0];
    // A relative path. The header reaches our own origin and no other host.
    expect(url).toBe("/api/proxy/home/summary");
    expect((init.headers as Record<string, string>)[PORTAL_TOKEN_HEADER]).toBe(VIEWER_TOKEN);
  });

  it("sets no header when the browser holds no token", async () => {
    setActivePortalToken(null);

    await api.get("/home/summary");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).not.toHaveProperty(PORTAL_TOKEN_HEADER);
  });
});
