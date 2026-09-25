// The run Signals tab must print the unit the API sends.
//
// GET /test-runs/{run_id}/signals applies the precedence rule itself
// (api/api/services/queries_stats.py). The tab held a second rule: it read one
// page of 100 of the 6,412-row catalog and overlaid a manual unit on the run
// rows. A run holds 186 signals, so most corrections never reached the screen.
// These tests pin the overlay's removal: no catalog call, and the row wins.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { FileSignal } from "@/types";

const row = (over: Partial<FileSignal> = {}): FileSignal => ({
  name: "Coolant_Inlet_Temp",
  unit: "bar",
  unit_source: "manual",
  rate_hz: 10,
  dtype: "float64",
  stats: { min: 1, max: 2, mean: 1.5, std: 0.5 },
  ...over,
});

const items: FileSignal[] = [row(), row({ name: "Chamber_Ambient_Temp", unit: "°C", unit_source: "embedded" })];

// The tab must call no catalog hook. vi.mock hoists, so the spy hoists too.
const { useSignals } = vi.hoisted(() => ({
  useSignals: vi.fn(() => {
    throw new Error("the tab must not read the signal catalog");
  }),
}));

vi.mock("@/lib/hooks", () => ({
  // The detail screens set the window title through this hook.
  usePageTitle: () => undefined,
  // Every write control reads the actor from the signed-in Portal identity.
  useActor: () => "Test Engineer",
  useFlagInvalid: () => ({ mutate: vi.fn(), isPending: false }),
  useClearInvalid: () => ({ mutate: vi.fn(), isPending: false }),
  useAddRunNote: () => ({ mutate: vi.fn(), isPending: false }),
  usePatchRun: () => ({ mutate: vi.fn(), isPending: false }),
  useRunSignals: () => ({
    data: { items, total: items.length, page: 1, page_size: 200, total_pages: 1 },
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
  useSignals,
  usePatchSignal: () => ({ mutate: vi.fn(), isPending: false }),
  // The unit autocomplete reads the whole catalog's units (§14b).
  useSignalFacets: () => ({ data: { units: [], rates: [], rigs: [] }, isPending: false, isError: false, isSuccess: true }),
}));

import { SignalsTab } from "@/components/screens/run-detail/signals-tab";

const cellOf = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

describe("the run signals tab renders the unit the API sends", () => {
  it("prints the manual unit of the row", () => {
    render(<SignalsTab runId="TAS-90001" signalCount={items.length} selected={[]} onSelectedChange={() => {}} />);

    expect(cellOf("Coolant_Inlet_Temp")).toHaveTextContent("bar");
  });

  it("keeps the embedded unit when the row carries no manual one", () => {
    render(<SignalsTab runId="TAS-90001" signalCount={items.length} selected={[]} onSelectedChange={() => {}} />);

    expect(cellOf("Chamber_Ambient_Temp")).toHaveTextContent("°C");
  });

  it("reads no catalog page, so no row depends on the first 100 of 6,412", () => {
    render(<SignalsTab runId="TAS-90001" signalCount={items.length} selected={[]} onSelectedChange={() => {}} />);

    expect(useSignals).not.toHaveBeenCalled();
  });
});
