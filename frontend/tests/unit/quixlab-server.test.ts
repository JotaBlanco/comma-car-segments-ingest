/**
 * The server-side QuixLab resolver.
 *
 * `app/layout.tsx` calls this before it renders, so two rules matter more than
 * the happy path:
 *
 *   1. every failure returns "" and hides every control, so no screen promises
 *      a destination the server could not resolve;
 *   2. the bearer token goes to the registry API and nowhere else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveQuixLabUrl } from "@/lib/quixlab-server";

const BASE = "https://quixlab-abc123.dev.quix.io";
const TOKEN = "test-token-not-a-secret";

let calls: { url: string; init: RequestInit | undefined }[];

function answer(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
}

beforeEach(() => {
  calls = [];
  vi.stubEnv("API_URL", "http://tm-api");
  vi.stubEnv("TM_BE_URL", "");
  vi.stubEnv("TM_API_TOKEN", TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveQuixLabUrl", () => {
  it("asks the registry API and returns the site root it answers", async () => {
    answer(200, { url: BASE });

    expect(await resolveQuixLabUrl()).toBe(BASE);
    expect(calls[0].url).toBe("http://tm-api/api/v1/integrations/quixlab-url");
  });

  it("sends the bearer token the API needs", async () => {
    answer(200, { url: BASE });

    await resolveQuixLabUrl();

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("reads a 409 not-configured answer as no QuixLab", async () => {
    answer(409, { detail: "no QuixLab is configured", code: "quixlab_not_configured" });

    expect(await resolveQuixLabUrl()).toBe("");
  });

  it("reads an unreachable API as no QuixLab", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("connect refused"))));

    expect(await resolveQuixLabUrl()).toBe("");
  });

  it("reads an answer with no url field as no QuixLab", async () => {
    answer(200, { detail: "something else" });

    expect(await resolveQuixLabUrl()).toBe("");
  });

  it("falls back to TM_BE_URL when API_URL names nothing", async () => {
    vi.stubEnv("API_URL", "");
    vi.stubEnv("TM_BE_URL", "http://tm-api");
    answer(200, { url: BASE });

    expect(await resolveQuixLabUrl()).toBe(BASE);
    expect(calls[0].url).toBe("http://tm-api/api/v1/integrations/quixlab-url");
  });

  it("calls nothing at all when no backend is configured", async () => {
    vi.stubEnv("API_URL", "");
    vi.stubEnv("TM_BE_URL", "");
    answer(200, { url: BASE });

    expect(await resolveQuixLabUrl()).toBe("");
    expect(calls).toEqual([]);
  });

  it("calls nothing at all when no token is configured", async () => {
    vi.stubEnv("TM_API_TOKEN", "");
    answer(200, { url: BASE });

    expect(await resolveQuixLabUrl()).toBe("");
    expect(calls).toEqual([]);
  });
});
