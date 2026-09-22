/**
 * The link token and the signed-out screen.
 *
 * A person opens a Test Manager link in a new tab. That tab has no parent
 * frame, so it gets no postMessage handshake. Two paths bring it back: a
 * `#token=...` fragment in the link, and the paste box on the signed-out
 * screen. These tests pin both, and they pin what each path may claim.
 *
 * The fragment is the only URL carrier this app reads. A fragment never
 * leaves the browser, so the token stays out of the server log, out of the
 * proxy and out of the `Referer` header.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignedOutScreen } from "@/components/account/signed-out-screen";
import { setPortalApiBase } from "@/lib/portal/client";
import { clearStoredToken, PORTAL_TOKEN_STORAGE_KEY } from "@/lib/portal/token-store";
import { usePortalAuth } from "@/lib/portal/use-portal-auth";

// The embedded fallback waits for the 3 s handshake timeout to expire.
vi.setConfig({ testTimeout: 30_000 });

/** `vi.hoisted` runs before the mock factory, so the flag exists in time. */
const frame = vi.hoisted(() => ({ embedded: false }));

vi.mock("@/lib/portal/token-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal/token-store")>();
  return { ...actual, isEmbedded: () => frame.embedded };
});

const PORTAL_API = "https://portal-api.dev.quix.io";
const PORTAL_APP_ORIGIN = "https://portal.dev.quix.io";
const LINK_TOKEN = "token-from-the-link";
const INPUT_LABEL = "Personal Access Token";

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

/** Serve the Portal profile routes with a fixed status. */
function stubPortal(status: number): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/profile")) {
      if (status !== 200) return Promise.resolve(json({ message: "no" }, status));
      return Promise.resolve(json({ userId: "u-1", firstName: "Erika", lastName: "Lindqvist" }));
    }
    if (url.endsWith("/organisations/current")) return Promise.resolve(json(null, 204));
    return Promise.reject(new Error(`unexpected request ${url}`));
  });
}

/** Put the token in the address bar, the way a shared link carries it. */
function openLinkWithToken(token: string, rest = ""): void {
  window.history.replaceState(null, "", `/runs/TAS-88214#token=${token}${rest}`);
}

beforeEach(() => {
  frame.embedded = false;
  setPortalApiBase(PORTAL_API);
  window.localStorage.clear();
  // Drops the token this module read out of an earlier test's fragment.
  clearStoredToken();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  setPortalApiBase(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  clearStoredToken();
  window.history.replaceState(null, "", "/");
});

describe("a token in the URL fragment", () => {
  it("signs the person in", async () => {
    openLinkWithToken(LINK_TOKEN);

    const { result } = renderHook(() => usePortalAuth(), { wrapper });

    await waitFor(() => expect(result.current.phase).toBe("authenticated"));
    expect(result.current.token).toBe(LINK_TOKEN);
  });

  it("leaves the fragment out of the URL right after the read", async () => {
    openLinkWithToken(LINK_TOKEN);

    const { result } = renderHook(() => usePortalAuth(), { wrapper });

    await waitFor(() => expect(result.current.phase).toBe("authenticated"));
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(LINK_TOKEN);
    // The path and the query survive. Only the token goes.
    expect(window.location.pathname).toBe("/runs/TAS-88214");
  });

  it("keeps every other fragment entry", async () => {
    openLinkWithToken(LINK_TOKEN, "&tab=files");

    const { result } = renderHook(() => usePortalAuth(), { wrapper });

    await waitFor(() => expect(result.current.phase).toBe("authenticated"));
    expect(window.location.hash).toBe("#tab=files");
  });

  it("never names the token in a log call", async () => {
    openLinkWithToken(LINK_TOKEN);
    const calls: unknown[] = [];
    for (const name of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
        calls.push(...args);
      });
    }

    const { result } = renderHook(() => usePortalAuth(), { wrapper });
    await waitFor(() => expect(result.current.phase).toBe("authenticated"));

    expect(calls.map((entry) => String(entry)).join(" ")).not.toContain(LINK_TOKEN);
  });

  it("never claims the handshake", async () => {
    openLinkWithToken(LINK_TOKEN);

    const { result } = renderHook(() => usePortalAuth(), { wrapper });

    await waitFor(() => expect(result.current.phase).toBe("authenticated"));
    expect(result.current.source).toBe("url");
    expect(result.current.source).not.toBe("handshake");
  });

  it("stores the token, so the second tab starts signed in", async () => {
    openLinkWithToken(LINK_TOKEN);
    const first = renderHook(() => usePortalAuth(), { wrapper });
    await waitFor(() => expect(first.result.current.phase).toBe("authenticated"));
    first.unmount();

    // The second tab: same storage, no fragment, no parent frame.
    expect(window.localStorage.getItem(PORTAL_TOKEN_STORAGE_KEY)).toBe(LINK_TOKEN);
    window.history.replaceState(null, "", "/runs/TAS-88214");

    const second = renderHook(() => usePortalAuth(), { wrapper });

    await waitFor(() => expect(second.result.current.phase).toBe("authenticated"));
    expect(second.result.current.token).toBe(LINK_TOKEN);
    expect(second.result.current.source).not.toBe("handshake");
  });
});

describe("the embedded handshake", () => {
  it("still works and still reports the handshake", async () => {
    frame.embedded = true;

    const { result } = renderHook(() => usePortalAuth(), { wrapper });

    await act(async () => {
      portalPostsToken("handshake-token");
    });

    await waitFor(() => expect(result.current.phase).toBe("authenticated"));
    expect(result.current.token).toBe("handshake-token");
    expect(result.current.source).toBe("handshake");
  });

  it("beats a token the link carried", async () => {
    frame.embedded = true;
    openLinkWithToken(LINK_TOKEN);

    const { result } = renderHook(() => usePortalAuth(), { wrapper });

    await act(async () => {
      portalPostsToken("handshake-token");
    });

    await waitFor(() => expect(result.current.source).toBe("handshake"));
    expect(result.current.token).toBe("handshake-token");
  });
});

describe("the signed-out screen", () => {
  it("shows the paste box when the phase is signed-out", async () => {
    render(<SignedOutScreen />, { wrapper });

    const input = await screen.findByLabelText(INPUT_LABEL);
    // A shoulder never reads the secret.
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("stays hidden while the handshake resolves", async () => {
    frame.embedded = true;

    render(<SignedOutScreen />, { wrapper });

    // The handshake runs, so the phase is "resolving" and nothing shows.
    expect(screen.queryByLabelText(INPUT_LABEL)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    // It appears only after the handshake times out and the phase settles.
    await screen.findByLabelText(INPUT_LABEL, undefined, { timeout: 10_000 });
  });

  it("stays hidden when a token already signed the person in", async () => {
    window.localStorage.setItem(PORTAL_TOKEN_STORAGE_KEY, "stored-token");

    render(<SignedOutScreen />, { wrapper });

    await waitFor(() => expect(screen.queryByLabelText(INPUT_LABEL)).toBeNull());
  });

  it("signs the person in when the Portal accepts the token", async () => {
    stubPortal(200);
    render(<SignedOutScreen />, { wrapper });

    await userEvent.type(await screen.findByLabelText(INPUT_LABEL), "good-token");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.queryByLabelText(INPUT_LABEL)).toBeNull());
    expect(window.localStorage.getItem(PORTAL_TOKEN_STORAGE_KEY)).toBe("good-token");
  });

  it("submits on Enter", async () => {
    stubPortal(200);
    render(<SignedOutScreen />, { wrapper });

    await userEvent.type(await screen.findByLabelText(INPUT_LABEL), "good-token{Enter}");

    await waitFor(() => expect(screen.queryByLabelText(INPUT_LABEL)).toBeNull());
  });

  it("shows the error and does not sign in when the Portal refuses the token", async () => {
    stubPortal(401);
    render(<SignedOutScreen />, { wrapper });

    const input = await screen.findByLabelText(INPUT_LABEL);
    await userEvent.type(input, "bad-token");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/refused that token/i);
    // The message never names the token.
    expect(alert.textContent).not.toContain("bad-token");
    // The screen stays, and nothing reached storage.
    expect(screen.getByLabelText(INPUT_LABEL)).toBeInTheDocument();
    expect(window.localStorage.getItem(PORTAL_TOKEN_STORAGE_KEY)).toBeNull();
    // A screen reader hears the error, and the field says it is invalid.
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", alert.id);
  });
});
