/**
 * The token source clue.
 *
 * A demo claims that the platform identified the person. Only the postMessage
 * handshake proves that. A pasted token proves much less. These tests pin two
 * things: `usePortalAuth` reports the true source, and the account menu shows
 * it without ever inventing a name.
 *
 * The tests drive the real handshake. Only `isEmbedded` is a stub, because
 * jsdom runs the page in no frame. `requestTokenFromParent` and
 * `onParentTokenPush` stay real, so a token reads `"handshake"` only when it
 * really arrives over postMessage from a Portal origin.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "@/components/account/account-menu";
import { PORTAL_TOKEN_STORAGE_KEY } from "@/lib/portal/token-store";
import { usePortalAuth } from "@/lib/portal/use-portal-auth";
import { setPortalApiBase } from "@/lib/portal/client";

// The stored-token fallback waits for the 3 s handshake timeout to expire.
vi.setConfig({ testTimeout: 30_000 });

/** `vi.hoisted` runs before the mock factory, so the flag exists in time. */
const frame = vi.hoisted(() => ({ embedded: false }));

vi.mock("@/lib/portal/token-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal/token-store")>();
  return { ...actual, isEmbedded: () => frame.embedded };
});

// `portalOrigins()` maps `portal-api.{domain}` to `portal.{domain}`. See
// `frontend/lib/portal/client.ts` and `auth-cookie.service.ts:11-12` in
// `Quix.Portal.Frontend`.
const PORTAL_API = "https://portal-api.dev.quix.io";
const PORTAL_APP_ORIGIN = "https://portal.dev.quix.io";
const HANDSHAKE_TEXT = "Verified by Portal handshake";
const PASTED_TEXT = "Pasted token, not verified by the Portal";
const NO_NAME_TEXT = "Token connected, but the profile names nobody.";

const savedEnv = { ...process.env };

/** Answer the app the way the Quix Portal answers, from the Portal origin. */
function portalPostsToken(token: string): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "AUTH_TOKEN", token },
      origin: PORTAL_APP_ORIGIN,
    }),
  );
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Serve the Portal profile routes. `profile` decides what the menu can show. */
function stubPortal(profile: Record<string, unknown>): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/profile")) return Promise.resolve(json(profile));
    if (url.endsWith("/organisations/current")) return Promise.resolve(json(null, 204));
    return Promise.reject(new Error(`unexpected request ${url}`));
  });
}

beforeEach(() => {
  frame.embedded = false;
  setPortalApiBase(PORTAL_API);
  window.localStorage.clear();
});

afterEach(() => {
  setPortalApiBase(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  process.env = { ...savedEnv };
});

describe("usePortalAuth reports how the token arrived", () => {
  it("names the handshake when the Portal posts the token", async () => {
    frame.embedded = true;
    const { result } = renderHook(() => usePortalAuth(), { wrapper });

    await act(async () => {
      portalPostsToken("handshake-token");
    });

    await waitFor(() => expect(result.current.phase).toBe("authenticated"));
    expect(result.current.source).toBe("handshake");
    expect(result.current.token).toBe("handshake-token");
  });

  it("names a paste when the parent stays silent and a stored token answers", async () => {
    frame.embedded = true;
    window.localStorage.setItem(PORTAL_TOKEN_STORAGE_KEY, "stored-token");

    const { result } = renderHook(() => usePortalAuth(), { wrapper });

    await waitFor(() => expect(result.current.phase).toBe("authenticated"), {
      timeout: 10_000,
    });
    expect(result.current.source).toBe("pasted");
    expect(result.current.token).toBe("stored-token");
  });

  it("names a paste for a stored token in standalone mode", async () => {
    window.localStorage.setItem(PORTAL_TOKEN_STORAGE_KEY, "stored-token");

    const { result } = renderHook(() => usePortalAuth(), { wrapper });

    await waitFor(() => expect(result.current.phase).toBe("authenticated"));
    expect(result.current.source).toBe("pasted");
  });

  it("names a paste for the token the dialog connects", async () => {
    const { result } = renderHook(() => usePortalAuth(), { wrapper });

    await waitFor(() => expect(result.current.phase).toBe("signed-out"));
    expect(result.current.source).toBeNull();

    act(() => {
      result.current.connect("pasted-token");
    });

    expect(result.current.source).toBe("pasted");
    expect(result.current.token).toBe("pasted-token");
  });

  it("names the handshake when the Portal pushes a refreshed token", async () => {
    frame.embedded = true;
    window.localStorage.setItem(PORTAL_TOKEN_STORAGE_KEY, "stored-token");

    const { result } = renderHook(() => usePortalAuth(), { wrapper });

    await waitFor(() => expect(result.current.source).toBe("pasted"), { timeout: 10_000 });

    await act(async () => {
      portalPostsToken("pushed-token");
    });

    expect(result.current.source).toBe("handshake");
    expect(result.current.token).toBe("pushed-token");
  });

  it("names no source after a disconnect", async () => {
    window.localStorage.setItem(PORTAL_TOKEN_STORAGE_KEY, "stored-token");
    const { result } = renderHook(() => usePortalAuth(), { wrapper });

    await waitFor(() => expect(result.current.source).toBe("pasted"));

    act(() => {
      result.current.disconnect();
    });

    expect(result.current.source).toBeNull();
    expect(result.current.token).toBeNull();
  });
});

describe("the account menu shows the token source", () => {
  // A handshake only happens inside the Portal frame, and there the Portal
  // already shows the person. So the menu shows nobody a second time. The
  // source itself stays pinned by the `usePortalAuth` tests above.
  it("shows nobody after a handshake, because the Portal frames this app", async () => {
    frame.embedded = true;
    stubPortal({ userId: "u-1", email: "e.lindqvist@volvo.com", firstName: "Erika", lastName: "Lindqvist" });

    render(<AccountMenu />, { wrapper });
    await act(async () => {
      portalPostsToken("handshake-token");
    });

    expect(screen.queryByRole("button", { name: /Account menu/ })).toBeNull();
    expect(screen.queryByText(/Erika Lindqvist/)).toBeNull();
    expect(screen.queryByText(HANDSHAKE_TEXT)).toBeNull();
  });

  it("calls a stored token unverified", async () => {
    window.localStorage.setItem(PORTAL_TOKEN_STORAGE_KEY, "stored-token");
    stubPortal({ userId: "u-1", email: "e.lindqvist@volvo.com", firstName: "Erika", lastName: "Lindqvist" });

    render(<AccountMenu />, { wrapper });

    const trigger = await screen.findByRole("button", { name: /Erika Lindqvist/ });
    await userEvent.click(trigger);

    expect(await screen.findByText(PASTED_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(HANDSHAKE_TEXT)).toBeNull();
  });

  it("names nobody when the profile carries no name and no email", async () => {
    window.localStorage.setItem(PORTAL_TOKEN_STORAGE_KEY, "stored-token");
    // `lib/portal/client.ts` turns this profile into the display name
    // "Quix user". `api/api/provenance.py` refuses that string.
    stubPortal({ userId: "u-1" });

    render(<AccountMenu />, { wrapper });

    const trigger = await screen.findByRole("button", { name: new RegExp(NO_NAME_TEXT) });
    await userEvent.click(trigger);

    expect(await screen.findByText(NO_NAME_TEXT)).toBeInTheDocument();
    expect(screen.getByText(PASTED_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(/quix user/i)).toBeNull();
  });

  it("shows no source clue while signed out", async () => {
    stubPortal({ userId: "u-1" });

    render(<AccountMenu />, { wrapper });

    const trigger = await screen.findByRole("button", { name: /Not signed in/ });
    expect(trigger).not.toHaveAccessibleName(new RegExp(PASTED_TEXT));

    await userEvent.click(trigger);
    expect(await screen.findByText("Not signed in to Quix.")).toBeInTheDocument();
    expect(screen.queryByText(PASTED_TEXT)).toBeNull();
    expect(screen.queryByText(HANDSHAKE_TEXT)).toBeNull();
  });
});
