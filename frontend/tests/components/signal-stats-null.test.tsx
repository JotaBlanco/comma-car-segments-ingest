import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { FileSignal } from "@/types";

const { rows } = vi.hoisted(() => ({ rows: { items: [] as unknown[] } }));

// The tab reads the run signals through react-query. Stub the hooks, so the test
// states its own rows and needs no provider.
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
    data: { items: rows.items, total: rows.items.length, page: 1, page_size: 100, total_pages: 1 },
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
  useSignals: () => ({
    data: { items: [], total: 0, page: 1, page_size: 100, total_pages: 1 },
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
  usePatchSignal: () => ({ mutate: vi.fn(), isPending: false }),
  // The unit autocomplete reads the whole catalog's units (§14b).
  useSignalFacets: () => ({ data: { units: [], rates: [], rigs: [] }, isPending: false, isError: false, isSuccess: true }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { FileSignalsTable } from "@/components/screens/files/file-signals-table";
import { SignalsTab } from "@/components/screens/run-detail/signals-tab";

const DASH = "—";

function makeSignal(name: string, stats: FileSignal["stats"]): FileSignal {
  return { name, unit: "C", unit_source: "embedded", rate_hz: 100, dtype: "float64", stats };
}

const measured = makeSignal("HV_Batt_Cell_Temp_Max", { min: 18.2, max: 47.9, mean: 33.4, std: 6.21 });
const unmeasured = makeSignal("HV_Batt_Pack_Voltage", null);

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe("a signal row with stats: null", () => {
  it("renders the file signals table with dashes, and never a zero", () => {
    render(<FileSignalsTable signals={[measured, unmeasured]} signalCount={2} />);

    const blank = rowOf("HV_Batt_Pack_Voltage");
    expect(within(blank).getAllByText(DASH)).toHaveLength(3);
    expect(blank.textContent).not.toContain("0.0");

    const filled = rowOf("HV_Batt_Cell_Temp_Max");
    expect(within(filled).getByText("18.2")).toBeInTheDocument();
  });

  it("renders the run signals tab with dashes, and never a zero", () => {
    rows.items = [measured, unmeasured];
    render(<SignalsTab runId="TAS-90001" signalCount={2} selected={[]} onSelectedChange={() => {}} />);

    const blank = rowOf("HV_Batt_Pack_Voltage");
    // Five number columns since 21 Aug 2026: Min, Max, Mean, σ and RMS.
    expect(within(blank).getAllByText(DASH)).toHaveLength(5);
    expect(blank.textContent).not.toContain("0.0");

    const filled = rowOf("HV_Batt_Cell_Temp_Max");
    // σ shares `fmt` with min/max/mean now, so 6.21 rounds to one decimal.
    expect(within(filled).getByText("6.2")).toBeInTheDocument();
  });
});
