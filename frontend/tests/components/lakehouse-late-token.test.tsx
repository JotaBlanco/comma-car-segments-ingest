/**
 * The sidebar's Lakehouse item survives a Portal token that lands late.
 *
 * **Why this file is not `lakehouse-link.test.tsx`.** That file mocks the whole
 * of `@/lib/api/integrations`, so `getLakehouseUrl` answers there and then and
 * no token ever matters. It proves the markup. It cannot prove the call.
 *
 * **What breaks on the real screen.** The route itself needs no viewer token,
 * but every `/api/v1` route sits behind `Depends(require_token)`
 * (`api/api/main.py:563`). A deployed front end sets `Quix__Portal__Api`, so
 * `sharedTokenIsTheOnlyKey()` is false and the proxy lends no shared token
 * (`app/api/proxy/[...path]/route.ts`). A call that carries no
 * `x-portal-token` therefore reaches the API with no Authorization header at
 * all, and the API answers 401.
 *
 * `usePortalAuth` writes the token one commit after the mount, and embedded it
 * first runs a postMessage handshake of up to three seconds. The sidebar
 * mounts with the app. So the call must wait for the token, the way
 * `listQuixLabs` waits.
 *
 * This file therefore mocks the transport and not the call, so the real
 * `getLakehouseUrl` runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/runs",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/hooks", () => ({
  useHomeSummary: () => ({ data: undefined }),
  usePlanningSyncStatus: () => ({ data: undefined }),
}));

/* The transport, not the call. `get` refuses a caller that holds no viewer
   token, which is what the deployed stack does. */
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ api: { get } }));

import { Sidebar } from "@/components/shell/sidebar";
import { setQuixLabPortalUrl, setQuixLabUrl } from "@/lib/quixlab";
import { getActivePortalToken, setActivePortalToken } from "@/lib/portal/token-store";

const QUIXLAB = "https://quixlab-abc123.dev.quix.io";
const LAKEHOUSE = "https://portal.dev.quix.io/lakehouse?workspace=quixdev-testmanagerdemo-dev";

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (path: string) => {
    // No viewer token means no Authorization header, and the API answers 401.
    if (getActivePortalToken() === null) throw new Error("invalid or missing token");
    if (path === "/integrations/lakehouse-url") return { url: LAKEHOUSE };
    return { items: [] };
  });
  setActivePortalToken(null);
  // The Analysis section exists when a QuixLab is configured.
  setQuixLabUrl(QUIXLAB);
});

afterEach(() => {
  setActivePortalToken(null);
  setQuixLabUrl(null);
  setQuixLabPortalUrl(null);
});

describe("the sidebar Lakehouse item, with a late Portal token", () => {
  it("appears when the token lands after the mount", async () => {
    const view = render(<Sidebar />);

    // The Portal handshake finishes after the sidebar mounted.
    await new Promise((resolve) => setTimeout(resolve, 30));
    setActivePortalToken("viewer-token");

    // The row leads to /lakehouse, not the URL the API answered — that URL
    // only decides the row's VISIBILITY. See lakehouse-link.test.tsx.
    const link = await view.findByRole("link", { name: /Lakehouse/ }, { timeout: 5_000 });
    expect(link.getAttribute("href")).toBe("/lakehouse");
  });

  it("shows no item and holds up no other row when nobody signs in", async () => {
    vi.useFakeTimers();
    try {
      const view = render(<Sidebar />);

      // The rest of the sidebar is on the screen at once. Nothing waits.
      expect(view.getByRole("link", { name: /Home/ })).toBeTruthy();

      // Past the five-second give-up, so the call left and answered.
      await vi.advanceTimersByTimeAsync(8_000);

      expect(get).toHaveBeenCalledWith("/integrations/lakehouse-url");
      expect(view.queryByRole("link", { name: /Lakehouse/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
