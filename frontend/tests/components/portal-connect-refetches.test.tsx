/**
 * A sign-in must clear the error cards it makes answerable.
 *
 * A viewer who arrives with no token sees every screen fail with 401. The
 * dialog then takes a Personal Access Token, and `connect` stores it. The
 * failed queries used to hold their error card until a manual retry or a
 * window refocus, because `connect` cleared the `portal/me` query alone.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPortalApiBase } from "@/lib/portal/client";
import { usePortalAuth } from "@/lib/portal/use-portal-auth";

const PORTAL_API = "https://portal-api.dev.quix.io";

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  setPortalApiBase(PORTAL_API);
  window.localStorage.clear();
});

afterEach(() => {
  setPortalApiBase(null);
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("connect makes the failed screens answer again", () => {
  it("refetches a query that already failed with 401", async () => {
    const runs = vi
      .fn()
      .mockRejectedValueOnce(new Error("401 unauthorized"))
      .mockResolvedValue("the runs");

    const { result } = renderHook(
      () => ({
        auth: usePortalAuth(),
        runs: useQuery({ queryKey: ["test-runs"], queryFn: runs }),
      }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.runs.isError).toBe(true));
    await waitFor(() => expect(result.current.auth.phase).toBe("signed-out"));

    act(() => {
      result.current.auth.connect("pasted-token");
    });

    // The screen recovers by itself. Nobody pressed Retry.
    await waitFor(() => expect(result.current.runs.data).toBe("the runs"));
    expect(runs).toHaveBeenCalledTimes(2);
  });
});
