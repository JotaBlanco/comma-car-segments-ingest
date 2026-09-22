/**
 * `listQuixLabs` waits for the viewer's Portal token before it asks.
 *
 * **The demo is the case this exists for.** The route reads the viewer's own
 * Portal token, and that token lands AFTER a caller mounts: one commit later
 * standalone, and after a postMessage handshake of up to three seconds when
 * the Portal frames this app (`lib/portal/use-portal-auth.ts:105-128`).
 *
 * Two callers mount with the app and are not `useQuery` calls, so
 * `components/providers/query-provider.tsx` does not hold them: the sidebar,
 * which resolves the Portal embedded view of QuixLab, and the run detail panel
 * when a person deep-links to a run. Without the wait both send the call with
 * no token, the route answers an empty list, and both keep the direct QuixLab
 * link for the whole session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ api: { get } }));

import { listQuixLabs } from "@/lib/api/integrations";
import { setActivePortalToken } from "@/lib/portal/token-store";

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({ items: [] });
  setActivePortalToken(null);
});

afterEach(() => {
  setActivePortalToken(null);
});

describe("listQuixLabs", () => {
  it("asks at once when the viewer token is already in the holder", async () => {
    setActivePortalToken("viewer-token");

    await listQuixLabs();

    expect(get).toHaveBeenCalledWith("/integrations/quixlabs");
  });

  it("holds the call until the token arrives", async () => {
    const answer = listQuixLabs();

    // The token is not here yet, so nothing may leave.
    await Promise.resolve();
    expect(get).not.toHaveBeenCalled();

    setActivePortalToken("viewer-token");
    await answer;

    expect(get).toHaveBeenCalledWith("/integrations/quixlabs");
  });

  it("gives up and asks anyway, so a signed-out viewer never hangs", async () => {
    vi.useFakeTimers();
    try {
      const answer = listQuixLabs();
      await vi.advanceTimersByTimeAsync(6_000);
      await answer;
    } finally {
      vi.useRealTimers();
    }

    expect(get).toHaveBeenCalledWith("/integrations/quixlabs");
  });
});
