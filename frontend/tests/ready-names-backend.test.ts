import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/ready/route";
import { resolveBackend } from "@/app/api/proxy/[...path]/route";

/* The readiness probe answered a constant `{"status":"ok"}` before. It passed
   while the proxy served the built-in mock, so a wrong wiring looked healthy and
   a demo screen showed seed numbers as real ones. These tests pin the two things
   the probe now does: it names the backend it resolved, and it fails loudly when
   no real backend answers. */

const ORIGIN = "http://tm.example";
const BACKEND = "http://tm-api";

const probe = () => new Request(`${ORIGIN}/ready`);

const saved = { ...process.env };

beforeEach(() => {
  delete process.env.API_URL;
  delete process.env.TM_BE_URL;
  delete process.env.TM_USE_MOCK_API;
  delete process.env.TM_TEST_HOOKS;
});

afterEach(() => {
  process.env = { ...saved };
});

describe("the readiness probe names the backend it resolved", () => {
  it("answers 200 and the API_URL the proxy forwards to", async () => {
    process.env.API_URL = BACKEND;

    const response = GET(probe());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      backend: BACKEND,
      mock: false,
    });
  });

  it("drops a trailing slash, so the name matches the proxy target", async () => {
    process.env.API_URL = "http://tm-api/";

    expect((await GET(probe()).json()).backend).toBe(BACKEND);
  });

  it("names our own origin when TM_BE_URL alone carries the rewrite", async () => {
    // .env.example tells a developer to leave API_URL unset. next.config.ts then
    // rewrites /api/v1/* to TM_BE_URL, so our own origin is a real target.
    process.env.TM_BE_URL = "http://localhost:8010";

    const response = GET(probe());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      backend: ORIGIN,
      mock: false,
    });
  });

  it("reports the same backend the proxy resolves", async () => {
    // One rule, one copy. A second copy would let the probe pass while the data
    // path served something else.
    process.env.API_URL = "http://api:8000";

    const body = await GET(probe()).json();

    expect(body.backend).toBe(resolveBackend(new URL(`${ORIGIN}/ready`)));
  });
});

describe("the readiness probe fails when no real backend answers", () => {
  it("answers 503 when neither variable is set, and never says ok", async () => {
    const response = GET(probe());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      backend: null,
    });
  });

  it("answers 503 when API_URL is an empty string", () => {
    process.env.API_URL = "";

    expect(GET(probe()).status).toBe(503);
  });

  it("answers 503 when API_URL points back at this app and no rewrite exists", () => {
    // This is the silent cell of the truth table. The mock used to answer 200
    // here, and the probe used to agree.
    process.env.API_URL = ORIGIN;

    expect(GET(probe()).status).toBe(503);
  });

  it("answers 503 when API_URL is not a URL", () => {
    process.env.API_URL = "tm-api:8000";

    expect(GET(probe()).status).toBe(503);
  });
});

describe("the readiness probe marks the deliberate mock", () => {
  it("says mock true when TM_USE_MOCK_API asks for the mock by name", async () => {
    process.env.TM_USE_MOCK_API = "1";

    const response = GET(probe());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      backend: ORIGIN,
      mock: true,
    });
  });

  it("stays 200 under TM_TEST_HOOKS, so the Playwright gate still opens", async () => {
    // playwright.config.ts waits on ${BASE_URL}/ready and sets TM_TEST_HOOKS=1
    // with an empty TM_BE_URL. A 503 there would hang the whole e2e suite.
    process.env.TM_TEST_HOOKS = "1";
    process.env.TM_BE_URL = "";

    const response = GET(probe());

    expect(response.status).toBe(200);
    expect((await response.json()).mock).toBe(true);
  });
});
