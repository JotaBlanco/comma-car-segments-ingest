/**
 * Portal-token resolution order for the sidebar chat (the 21 Aug 2026 bug).
 *
 * Inside the Portal's iframe, localStorage is restricted — the handshake
 * token lives only in memory (`getActivePortalToken`). The sidebar once read
 * storage alone, sent no `x-portal-token`, and every chat answered 403
 * `ai_unavailable` while the Explore chat (which reads the active token)
 * worked. These tests pin the order: explicit token, then active, then
 * stored. If the order regresses, the sidebar breaks ONLY when embedded in
 * the real Portal — no e2e rig reproduces that — so this is the guard.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { streamAssistantChat } from "@/lib/api/assistant";
import { getActivePortalToken, getStoredToken } from "@/lib/portal/token-store";

vi.mock("@/lib/portal/token-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal/token-store")>();
  return {
    ...actual,
    getActivePortalToken: vi.fn(() => null as string | null),
    getStoredToken: vi.fn(() => null as string | null),
  };
});

/** Stub fetch, run one chat call, and return the headers it sent. */
async function sentHeaders(token: string | null): Promise<Record<string, string>> {
  let captured: Record<string, string> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      captured = (init?.headers ?? {}) as Record<string, string>;
      // A non-OK answer ends the call right after the headers are captured.
      return Response.json({ code: "ai_unavailable" }, { status: 403 });
    }),
  );
  await streamAssistantChat({ message: "hi", token, onFrame: () => {} });
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(getActivePortalToken).mockReturnValue(null);
  vi.mocked(getStoredToken).mockReturnValue(null);
});

describe("sidebar chat portal-token resolution", () => {
  it("the in-memory handshake token beats the stored PAT (the Portal-iframe case)", async () => {
    vi.mocked(getActivePortalToken).mockReturnValue("handshake-jwt");
    vi.mocked(getStoredToken).mockReturnValue("stored-pat");
    const headers = await sentHeaders(null);
    expect(headers["x-portal-token"]).toBe("handshake-jwt");
  });

  it("falls back to the stored PAT when no handshake token exists (standalone)", async () => {
    vi.mocked(getStoredToken).mockReturnValue("stored-pat");
    const headers = await sentHeaders(null);
    expect(headers["x-portal-token"]).toBe("stored-pat");
  });

  it("an explicit token wins over both", async () => {
    vi.mocked(getActivePortalToken).mockReturnValue("handshake-jwt");
    vi.mocked(getStoredToken).mockReturnValue("stored-pat");
    const headers = await sentHeaders("explicit-token");
    expect(headers["x-portal-token"]).toBe("explicit-token");
  });

  it("sends no token header when none exists — the API answers ai_unavailable", async () => {
    const headers = await sentHeaders(null);
    expect(headers["x-portal-token"]).toBeUndefined();
  });
});
