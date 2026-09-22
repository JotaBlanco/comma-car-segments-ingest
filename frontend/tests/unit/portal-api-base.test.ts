import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCurrentUser,
  PortalNotConfiguredError,
  portalApiBase,
  portalOrigins,
  setPortalApiBase,
} from "@/lib/portal/client";

/* The Portal API base URL used to come from `NEXT_PUBLIC_QUIX_PORTAL_API`,
   with `https://portal-api.platform.quix.io` as its default. `next build`
   inlines a `NEXT_PUBLIC_` name, so one image served one environment only. The
   default named a host that does not exist, so an unset value failed slowly
   and quietly instead of loudly. Both went on 19 Aug 2026. These tests pin
   what replaced them. */

const PORTAL_API = "https://portal-api.dev.quix.io";

afterEach(() => {
  setPortalApiBase(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the server hands the Portal API base URL down", () => {
  it("returns the value the server set", () => {
    setPortalApiBase(PORTAL_API);

    expect(portalApiBase()).toBe(PORTAL_API);
  });

  it("drops a trailing slash, so one path never doubles a separator", () => {
    setPortalApiBase(`${PORTAL_API}/`);

    expect(portalApiBase()).toBe(PORTAL_API);
  });

  it("treats an empty string as no Portal at all", () => {
    setPortalApiBase("");

    expect(() => portalApiBase()).toThrow(PortalNotConfiguredError);
  });

  it("treats blank space as no Portal at all", () => {
    setPortalApiBase("   ");

    expect(() => portalApiBase()).toThrow(PortalNotConfiguredError);
  });
});

describe("an absent value fails loudly, and never reaches a dead host", () => {
  it("throws rather than return a default host", () => {
    expect(() => portalApiBase()).toThrow(PortalNotConfiguredError);
  });

  it("names no host at all in the failure", () => {
    // The old default was `https://portal-api.platform.quix.io`. No platform
    // source names that host, so nothing may call it and nothing may suggest
    // it. Production is `portal-api.cloud.quix.io`
    // (`Quix.Portal.Frontend/shared/constants/constants.ts:14`).
    let message = "";
    try {
      portalApiBase();
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("Quix__Portal__Api");
    expect(message).not.toContain("platform.quix.io");
    expect(message).not.toContain("http");
  });

  it("opens no socket when the account menu asks for the current user", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCurrentUser("portal-token")).rejects.toBeInstanceOf(
      PortalNotConfiguredError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("trusts no message origin, so the handshake stays closed", () => {
    // `token-store.ts` checks `event.origin` against this list. An empty list
    // refuses every token. Trust nothing rather than everything.
    expect(portalOrigins()).toEqual([]);
  });
});

describe("the retired names configure nothing", () => {
  it("ignores NEXT_PUBLIC_QUIX_PORTAL_API", () => {
    process.env.NEXT_PUBLIC_QUIX_PORTAL_API = PORTAL_API;
    try {
      expect(() => portalApiBase()).toThrow(PortalNotConfiguredError);
    } finally {
      delete process.env.NEXT_PUBLIC_QUIX_PORTAL_API;
    }
  });

  it("ignores the injected name in the browser bundle", () => {
    // The browser never receives `Quix__Portal__Api`. Only the Next server
    // reads it, and it passes the value down through `PortalConfigProvider`.
    // A client-side read here would be a second source of truth.
    process.env.Quix__Portal__Api = PORTAL_API;
    try {
      expect(() => portalApiBase()).toThrow(PortalNotConfiguredError);
    } finally {
      delete process.env.Quix__Portal__Api;
    }
  });
});
