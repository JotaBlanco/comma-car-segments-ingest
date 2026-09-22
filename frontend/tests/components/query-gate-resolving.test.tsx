/**
 * No request leaves while the Portal token is still on its way.
 *
 * `lib/api/client.ts` states the viewer's token on every call, and
 * `usePortalAuth` writes that token to the holder one commit after the mount.
 * Embedded, the handshake takes up to three seconds on top. So the first
 * request of a page load used to leave with no token at all.
 *
 * `QueryProvider` now holds every query until the phase leaves `"resolving"`.
 * These tests drive the real provider, the real hook and the real handshake.
 * Only `isEmbedded` is a stub, because jsdom runs the page in no frame.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryProvider } from "@/components/providers/query-provider";
import { useHomeSummary } from "@/lib/hooks/use-home";
import { setPortalApiBase } from "@/lib/portal/client";
import { PORTAL_TOKEN_HEADER, setActivePortalToken } from "@/lib/portal/token-store";

// The failed-handshake case waits for the real 3 s timeout to expire.
vi.setConfig({ testTimeout: 30_000 });

/** `vi.hoisted` runs before the mock factory, so the flag exists in time. */
const frame = vi.hoisted(() => ({ embedded: false }));

vi.mock("@/lib/portal/token-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal/token-store")>();
  return { ...actual, isEmbedded: () => frame.embedded };
});

const PORTAL_API = "https://portal-api.dev.quix.io";
const PORTAL_APP_ORIGIN = "https://portal.dev.quix.io";
const VIEWER_TOKEN = "viewer-portal-token";

let fetchMock: ReturnType<typeof vi.fn>;

/** Every call the app made to its own server proxy, in order. */
function proxyCalls(): [string, RequestInit][] {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/proxy")) as [
    string,
    RequestInit,
  ][];
}

/** Answer the app the way the Quix Portal answers, from the Portal origin. */
function portalPostsToken(token: string): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "AUTH_TOKEN", token },
      origin: PORTAL_APP_ORIGIN,
    }),
  );
}

/** One screen, reading one real query hook. */
function Screen() {
  useHomeSummary();
  return null;
}

function renderScreen(): void {
  render(
    <QueryProvider>
      <Screen />
    </QueryProvider>,
  );
}

/** Let the mount effects and their promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  frame.embedded = true;
  setPortalApiBase(PORTAL_API);
  window.localStorage.clear();
  // The holder is a module singleton, so one case must never seed the next.
  setActivePortalToken(null);
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ counts: {}, planning_sync: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  setPortalApiBase(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  setActivePortalToken(null);
});

describe("the query gate holds until the token resolves", () => {
  it("sends nothing while the handshake runs, then sends the viewer's token", async () => {
    renderScreen();

    await settle();
    expect(proxyCalls()).toHaveLength(0);

    portalPostsToken(VIEWER_TOKEN);

    await waitFor(() => expect(proxyCalls()).toHaveLength(1));
    const [url, init] = proxyCalls()[0];
    expect(url).toBe("/api/proxy/home/summary");
    expect((init.headers as Record<string, string>)[PORTAL_TOKEN_HEADER]).toBe(VIEWER_TOKEN);
  });

  it("runs the queries when the handshake never answers", async () => {
    // The Portal stays silent. `requestTokenFromParent` times out after 3 s,
    // the phase becomes "signed-out" and the gate opens. The request then
    // carries no token and the API answers 401 — the honest answer. A gate
    // that waited for ever would be worse than the error it prevents.
    renderScreen();

    await settle();
    expect(proxyCalls()).toHaveLength(0);

    await waitFor(() => expect(proxyCalls()).toHaveLength(1), { timeout: 10_000 });
    const [, init] = proxyCalls()[0];
    expect(init.headers).not.toHaveProperty(PORTAL_TOKEN_HEADER);
  });

  it("holds nothing when no Portal is configured", async () => {
    // The local stack and the mock run this way: no Portal, so no viewer can
    // sign in and there is no handshake to wait for.
    setPortalApiBase(null);

    renderScreen();

    await waitFor(() => expect(proxyCalls()).toHaveLength(1));
  });
});
