/**
 * `usePortalAuth` reports `embedded` on the FIRST render.
 *
 * The hook kept the answer in a ref and it wrote that ref inside its mount
 * effect. React runs an effect after the render that reads it, so the first
 * render reported `false` inside a frame. A caller that branches on `embedded`
 * during render therefore drew the standalone case for one paint, and Strict
 * Mode's second render hid the fault in development.
 *
 * This test reads the value the render itself saw, not the value after the
 * effects flush. `renderHook` flushes them before it returns, so it cannot see
 * the fault at all.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePortalAuth } from "@/lib/portal/use-portal-auth";

/** `vi.hoisted` runs before the mock factory, so the flag exists in time. */
const frame = vi.hoisted(() => ({ embedded: false }));

vi.mock("@/lib/portal/token-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal/token-store")>();
  return { ...actual, isEmbedded: () => frame.embedded };
});

/** Every value the render pass read, in order. */
const seen: boolean[] = [];

function Probe() {
  const { embedded } = usePortalAuth();
  seen.push(embedded);
  return null;
}

function renderProbe(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  seen.length = 0;
  frame.embedded = false;
  window.localStorage.clear();
});

describe("the embedded answer settles before the first paint", () => {
  it("reports true on the first render inside a frame", () => {
    frame.embedded = true;

    renderProbe();

    expect(seen[0]).toBe(true);
  });

  it("reports false on the first render outside a frame", () => {
    renderProbe();

    expect(seen[0]).toBe(false);
  });
});
