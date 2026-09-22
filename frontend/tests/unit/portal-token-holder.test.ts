/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "http://localhost:3000"}
 *
 * vitest.unit.config.ts sets the node environment for this folder, and the
 * hook under test needs a DOM. The docblock above changes the environment for
 * this one file, so the file still matches `tests/unit/**` and still runs.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PORTAL_TOKEN_STORAGE_KEY,
  getActivePortalToken,
  setActivePortalToken,
} from "@/lib/portal/token-store";
import { usePortalAuth } from "@/lib/portal/use-portal-auth";
import { MemoryStorage } from "../support/memory-storage";

/* Node 26's experimental global `localStorage` is undefined without
   --localstorage-file and shadows jsdom's own — the same shim
   tests/components/setup.ts installs for the component suite (this config has
   no setup file, so the file installs it itself). */
if (window.localStorage === undefined) {
  const storage = new MemoryStorage();
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
}

/* The active-token holder is a module singleton, and `usePortalAuth` runs in
   several components at once (upload dialog, actor hooks). Every instance
   mounts with `token === null` before its own resolution settles, so an
   unguarded holder write let a fresh mount wipe the live token: requests in
   that window lost the x-portal-token header and the journal named the shared
   token holder instead of the person. These tests pin the two sides of the
   fix: a null mount never clears, and only `disconnect` does. */

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  window.localStorage.clear();
  setActivePortalToken(null);
});

afterEach(() => {
  window.localStorage.clear();
  setActivePortalToken(null);
});

describe("the shared portal token holder", () => {
  it("keeps the live token when a second instance mounts with none", () => {
    // First instance signs in — the holder carries the live token.
    const first = renderHook(() => usePortalAuth(), { wrapper });
    act(() => {
      first.result.current.connect("live-token");
    });
    expect(getActivePortalToken()).toBe("live-token");

    /* A handshake token never sits in localStorage, so a later mount resolves
       nothing of its own. Drop the stored copy to model that, then mount the
       second instance — the way opening the upload dialog does. */
    window.localStorage.removeItem(PORTAL_TOKEN_STORAGE_KEY);
    const second = renderHook(() => usePortalAuth(), { wrapper });

    expect(second.result.current.token).toBeNull();
    // The second instance found no token, and it must not clear the holder.
    expect(getActivePortalToken()).toBe("live-token");

    second.unmount();
    first.unmount();
  });

  it("propagates a token an instance really resolves", () => {
    // The guard must not stop real tokens: a mount that finds a stored token
    // still writes it to the holder.
    window.localStorage.setItem(PORTAL_TOKEN_STORAGE_KEY, "stored-token");
    const { unmount } = renderHook(() => usePortalAuth(), { wrapper });

    expect(getActivePortalToken()).toBe("stored-token");
    unmount();
  });

  it("clears the holder on an explicit disconnect", () => {
    const { result, unmount } = renderHook(() => usePortalAuth(), { wrapper });
    act(() => {
      result.current.connect("live-token");
    });
    expect(getActivePortalToken()).toBe("live-token");

    act(() => {
      result.current.disconnect();
    });

    // The guarded effect never writes null, so disconnect clears directly.
    expect(getActivePortalToken()).toBeNull();
    expect(result.current.phase).toBe("signed-out");
    unmount();
  });
});
