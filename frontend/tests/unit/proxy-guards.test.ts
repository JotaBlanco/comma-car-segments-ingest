import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/proxy/[...path]/route";

/* The proxy hands out TM_API_TOKEN, so it guards two things: where it sends the
   request, and who asked. These tests pin both. */

const ORIGIN = "http://tm.example";
const BACKEND = "http://tm-api";

const params = (path: string[]) => ({ params: Promise.resolve({ path }) });

/** A request the way the app's own page sends it. */
function browserRequest(path = "/api/proxy/home/summary", init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: { "sec-fetch-site": "same-origin", ...(init.headers ?? {}) },
  });
}

/** A request the way curl sends it — no browser mark of any kind. */
function bareRequest(path = "/api/proxy/home/summary", init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

let fetchMock: ReturnType<typeof vi.fn>;
const saved = { ...process.env };

beforeEach(() => {
  delete process.env.API_URL;
  delete process.env.TM_BE_URL;
  delete process.env.TM_USE_MOCK_API;
  delete process.env.TM_TEST_HOOKS;
  process.env.TM_API_TOKEN = "tm-demo-4711";
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

describe("the proxy refuses a caller it cannot recognize", () => {
  it("answers 401 for a request with no browser mark, and sends no token", async () => {
    process.env.API_URL = BACKEND;

    const response = await GET(bareRequest(), params(["home", "summary"]));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 401 for a write, so no journal entry can be forged", async () => {
    process.env.API_URL = BACKEND;

    const response = await POST(
      bareRequest("/api/proxy/journal", {
        method: "POST",
        body: JSON.stringify({ actor: "anonymous-attacker" }),
        headers: { "content-type": "application/json" },
      }),
      params(["journal"]),
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 401 for a URL typed into the address bar", async () => {
    process.env.API_URL = BACKEND;
    // A navigation reports "none", never "same-origin".
    const request = new Request(`${ORIGIN}/api/proxy/home/summary`, {
      headers: { "sec-fetch-site": "none" },
    });

    expect((await GET(request, params(["home", "summary"]))).status).toBe(401);
  });

  it("answers 401 for a fetch from another site", async () => {
    process.env.API_URL = BACKEND;
    const request = new Request(`${ORIGIN}/api/proxy/home/summary`, {
      headers: { "sec-fetch-site": "cross-site", referer: "http://evil.example/x" },
    });

    expect((await GET(request, params(["home", "summary"]))).status).toBe(401);
  });

  it("serves the app's own page, and attaches the bearer token there", async () => {
    process.env.API_URL = BACKEND;

    const response = await GET(browserRequest(), params(["home", "summary"]));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(target).toBe(`${BACKEND}/api/v1/home/summary`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tm-demo-4711");
  });

  it("accepts a browser too old for Sec-Fetch-Site when the Referer is ours", async () => {
    process.env.API_URL = BACKEND;
    const request = new Request(`${ORIGIN}/api/proxy/home/summary`, {
      headers: { referer: `${ORIGIN}/files` },
    });

    expect((await GET(request, params(["home", "summary"]))).status).toBe(200);
  });
});

describe("the proxy refuses to serve mock data as real", () => {
  it("answers 500 when API_URL is unset, and never answers 200", async () => {
    const response = await GET(browserRequest(), params(["home", "summary"]));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "backend_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 500 when API_URL is an empty string", async () => {
    process.env.API_URL = "";

    expect((await GET(browserRequest(), params(["home", "summary"]))).status).toBe(500);
  });

  it("answers 500 when API_URL points back at this app and no rewrite exists", async () => {
    // The old fallback did exactly this, and the in-app mock then answered 200.
    process.env.API_URL = ORIGIN;

    const response = await GET(browserRequest(), params(["home", "summary"]));

    expect(response.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 500 when API_URL is not a URL", async () => {
    process.env.API_URL = "tm-api:8000";

    expect((await GET(browserRequest(), params(["home", "summary"]))).status).toBe(500);
  });

  it("accepts a compose-internal host, which carries no dot", async () => {
    // http://api:8000 is what docker-compose.local.yml:351 really sets. A
    // hostname with no dot is a valid host, and the guard must never read it
    // as "no backend".
    process.env.API_URL = "http://api:8000";

    const response = await GET(browserRequest(), params(["test-runs"]));

    expect(response.status).toBe(200);
    const [target] = fetchMock.mock.calls[0] as [string];
    expect(target).toBe("http://api:8000/api/v1/test-runs");
  });

  it("accepts a host with no port and a host with a trailing slash", async () => {
    process.env.API_URL = "http://tm-api/";

    const response = await GET(browserRequest(), params(["test-runs"]));

    expect(response.status).toBe(200);
    const [target] = fetchMock.mock.calls[0] as [string];
    expect(target).toBe("http://tm-api/api/v1/test-runs");
  });

  it("accepts TM_BE_URL alone, because the rewrite reaches the real backend", async () => {
    // .env.example:27-29 tells a developer to leave API_URL unset. next.config
    // then rewrites /api/v1/* to TM_BE_URL, so our own origin is a real target.
    process.env.TM_BE_URL = "http://localhost:8010";

    const response = await GET(browserRequest(), params(["test-runs"]));

    expect(response.status).toBe(200);
    const [target] = fetchMock.mock.calls[0] as [string];
    expect(target).toBe(`${ORIGIN}/api/v1/test-runs`);
  });

  it("accepts an API_URL that names this app when the rewrite carries it on", async () => {
    process.env.API_URL = ORIGIN;
    process.env.TM_BE_URL = "http://localhost:8010";

    expect((await GET(browserRequest(), params(["test-runs"]))).status).toBe(200);
  });

  it("serves the mock only when a variable asks for it by name", async () => {
    process.env.TM_USE_MOCK_API = "1";

    const response = await GET(browserRequest(), params(["home", "summary"]));

    expect(response.status).toBe(200);
    const [target] = fetchMock.mock.calls[0] as [string];
    expect(target).toBe(`${ORIGIN}/api/v1/home/summary`);
  });

  it("lets the end-to-end rig drive the mock through TM_TEST_HOOKS", async () => {
    // playwright.config.ts sets TM_TEST_HOOKS=1 and leaves API_URL unset, and
    // its setup calls carry no browser mark. Both guards must yield there.
    process.env.TM_TEST_HOOKS = "1";

    const response = await GET(bareRequest(), params(["home", "summary"]));

    expect(response.status).toBe(200);
    const [target] = fetchMock.mock.calls[0] as [string];
    expect(target).toBe(`${ORIGIN}/api/v1/home/summary`);
  });
});
