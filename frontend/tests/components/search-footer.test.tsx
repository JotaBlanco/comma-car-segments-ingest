import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

// cmdk observes its list box. jsdom ships no ResizeObserver, so the test states one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

const emptyPage = {
  data: { items: [], total: 0, page: 1, page_size: 10, total_pages: 0 },
  isPending: false,
  isError: false,
  isSuccess: true,
  isFetching: false,
  refetch: vi.fn(),
};

vi.mock("@/lib/hooks", () => ({
  // The detail screens set the window title through this hook.
  usePageTitle: () => undefined,
  // Every write control reads the actor from the signed-in Portal identity.
  useActor: () => "Test Engineer",
  usePatchSignal: () => ({ mutate: vi.fn(), isPending: false }),
  useFlagInvalid: () => ({ mutate: vi.fn(), isPending: false }),
  useClearInvalid: () => ({ mutate: vi.fn(), isPending: false }),
  useAddRunNote: () => ({ mutate: vi.fn(), isPending: false }),
  usePatchRun: () => ({ mutate: vi.fn(), isPending: false }),
  useSearch: () => ({ data: undefined, isError: false, isFetching: false }),
  useRuns: () => emptyPage,
  useWorkOrders: () => emptyPage,
  useFiles: () => emptyPage,
  useSignals: () => emptyPage,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { GlobalSearch } from "@/components/search/global-search";

describe("the search overlay footer", () => {
  it("claims no coverage it cannot hold", async () => {
    render(<GlobalSearch />);
    await act(async () => {
      window.dispatchEvent(new Event("open-global-search"));
    });

    // The overlay reads the collections the route offers, and that set changes.
    // So the footer names no entity at all.
    const footer = await screen.findByText(/grouped by type/);
    expect(footer).toHaveTextContent("one box — grouped by type");
    expect(footer.textContent).not.toContain("every entity");
  });
});
