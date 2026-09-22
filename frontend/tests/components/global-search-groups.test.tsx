import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SearchResults } from "@/types";

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

/* Contract #19 after 19 Aug 2026: `GET /search` answers six groups. A definition
   navigates by the runs-list filter, and a result navigates to its run. */
const SIX_GROUPS: SearchResults = {
  query: "e",
  groups: [
    {
      type: "test_runs",
      items: [
        {
          id: "TAS-88214",
          sub: "HV battery thermal cycling · RIG-04",
          status: "complete",
          nav: { run_id: "TAS-88214" },
        },
      ],
    },
    {
      type: "work_orders",
      items: [
        {
          id: "WO-2026-0847",
          sub: "E-machine efficiency characterisation · EX90",
          status: "active",
          nav: { wo_id: "WO-2026-0847" },
        },
      ],
    },
    {
      type: "files",
      items: [
        {
          id: "bat_cyc_20260814_0941.mf4",
          sub: "TAS-88214 · 1.2 GB · TAS",
          status: "registered",
          nav: { file_id: "f-9a41" },
        },
      ],
    },
    {
      type: "signals",
      items: [
        {
          id: "HV_Batt_Cell_Temp_Max",
          sub: "°C · 100 Hz · 12 runs",
          status: null,
          nav: { name: "HV_Batt_Cell_Temp_Max" },
        },
      ],
    },
    {
      type: "test_definitions",
      items: [
        {
          id: "TD-EM-201",
          sub: "E-machine efficiency map · WO-2026-0847",
          status: null,
          nav: { definition: "TD-EM-201" },
        },
      ],
    },
    {
      type: "processed_results",
      items: [
        {
          id: "thermal_summary_v1.parquet",
          sub: "TAS-88214 · v1",
          status: "verified",
          nav: { run_id: "TAS-88214" },
        },
      ],
    },
  ],
};

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

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
  useSearch: () => ({ data: SIX_GROUPS, isError: false, isFetching: false }),
  useRuns: () => emptyPage,
  useWorkOrders: () => emptyPage,
  useFiles: () => emptyPage,
  useSignals: () => emptyPage,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

import { GlobalSearch } from "@/components/search/global-search";

/** Opens the overlay and types one letter, so the debounced query answers hits. */
async function openWithHits() {
  const user = userEvent.setup();
  render(<GlobalSearch />);
  await act(async () => {
    window.dispatchEvent(new Event("open-global-search"));
  });
  await user.type(screen.getByRole("combobox"), "e");
  return user;
}

describe("the search overlay renders every group the route answers", () => {
  beforeEach(() => push.mockClear());

  it("labels a definition hit and links it to the filtered runs list", async () => {
    const user = await openWithHits();

    expect(await screen.findByText("Test definitions")).toBeInTheDocument();
    await user.click(screen.getByText("TD-EM-201"));

    expect(push).toHaveBeenCalledWith("/runs?definition=TD-EM-201");
  });

  it("labels a result hit and links it to its run", async () => {
    const user = await openWithHits();

    expect(await screen.findByText("Processed results")).toBeInTheDocument();
    await user.click(screen.getByText("thermal_summary_v1.parquet"));

    expect(push).toHaveBeenCalledWith("/runs/TAS-88214");
  });

  it("keeps the four older groups", async () => {
    await openWithHits();

    expect(await screen.findByText("Runs")).toBeInTheDocument();
    expect(screen.getByText("Work orders")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.getByText("Signals")).toBeInTheDocument();
  });
});
