import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { FileSignal } from "@/types";

const { rows } = vi.hoisted(() => ({ rows: { items: [] as unknown[] } }));

// The tab reads the run signals through react-query. Stub the hooks, so each
// test states its own rows and needs no provider.
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

// The pipeline measures the numbers, so the caption names the pipeline.
const AT_INGESTION = /Statistics measured at ingestion/;

// A real measured value carries every digit the float holds. The table must round it.
const rawFloat: FileSignal = {
  name: "Coolant_Inlet_Temp",
  unit: "°C",
  unit_source: "embedded",
  rate_hz: 10,
  dtype: "float64",
  stats: { min: 30.2, max: 59.899982150171, mean: 47.885619959641005, std: 9.81 },
};

describe("the run signals tab rounds a measured value", () => {
  it("prints one decimal, and never the raw float", () => {
    rows.items = [rawFloat];
    render(<SignalsTab runId="TAS-88214" signalCount={1} selected={[]} onSelectedChange={() => {}} />);

    const row = screen.getByText("Coolant_Inlet_Temp").closest("tr") as HTMLElement;
    expect(within(row).getByText("59.9")).toBeInTheDocument();
    expect(within(row).getByText("47.9")).toBeInTheDocument();
    expect(row.textContent).not.toContain("59.899982150171");
    expect(row.textContent).not.toContain("47.885619959641005");
  });

  it("rounds the same way as the file signals table", () => {
    render(<FileSignalsTable signals={[rawFloat]} signalCount={1} />);

    const row = screen.getByText("Coolant_Inlet_Temp").closest("tr") as HTMLElement;
    expect(within(row).getByText("59.9")).toBeInTheDocument();
    expect(within(row).getByText("47.9")).toBeInTheDocument();
  });
});

// The pipeline states the exact measured rate, float artefact and all —
// 100.00166697227826 Hz sat beside a neighbour reading 10 Hz. The cell rounds
// it through formatRate; the stored value never changes.
const floatRateSignal: FileSignal = {
  name: "Chassis_Accel_X",
  unit: "g",
  unit_source: "embedded",
  rate_hz: 100.00166697227826,
  dtype: "float64",
  stats: null,
};

describe("both signal tables round the sample rate for display", () => {
  it("rounds the rate on the run signals tab, and never prints the raw float", () => {
    rows.items = [floatRateSignal];
    render(<SignalsTab runId="TAS-88214" signalCount={1} selected={[]} onSelectedChange={() => {}} />);

    const row = screen.getByText("Chassis_Accel_X").closest("tr") as HTMLElement;
    expect(within(row).getByText("100 Hz")).toBeInTheDocument();
    expect(row.textContent).not.toContain("100.00166697227826");
  });

  it("rounds the rate in the file signals table, and never prints the raw float", () => {
    render(<FileSignalsTable signals={[floatRateSignal]} signalCount={1} />);

    const row = screen.getByText("Chassis_Accel_X").closest("tr") as HTMLElement;
    expect(within(row).getByText("100 Hz")).toBeInTheDocument();
    expect(row.textContent).not.toContain("100.00166697227826");
  });

  it("keeps a clean rate clean in both tables", () => {
    rows.items = [rawFloat];
    render(<SignalsTab runId="TAS-88214" signalCount={1} selected={[]} onSelectedChange={() => {}} />);
    const runRow = screen.getByText("Coolant_Inlet_Temp").closest("tr") as HTMLElement;
    expect(within(runRow).getByText("10 Hz")).toBeInTheDocument();

    render(<FileSignalsTable signals={[rawFloat]} signalCount={1} />);
    const fileRow = screen.getAllByText("Coolant_Inlet_Temp").map((cell) => cell.closest("tr"))[1] as HTMLElement;
    expect(within(fileRow).getByText("10 Hz")).toBeInTheDocument();
  });
});

describe("the run signals tab with no rows", () => {
  it("states that the run has signals but no measured statistics", () => {
    rows.items = [];
    render(<SignalsTab runId="TAS-70003" signalCount={12} selected={[]} onSelectedChange={() => {}} />);

    expect(screen.getByText("No statistics yet")).toBeInTheDocument();
    expect(
      screen.getByText(/The run registers 12 signals\. No registered file of this run has reported them yet\./)
    ).toBeInTheDocument();
  });

  it("states that no signal is cataloged when the run registers none", () => {
    rows.items = [];
    render(<SignalsTab runId="TAS-88213" signalCount={0} selected={[]} onSelectedChange={() => {}} />);

    expect(screen.getByText("No signals cataloged")).toBeInTheDocument();
    expect(screen.queryByText("No statistics yet")).not.toBeInTheDocument();
  });

  it("never shows a zero for a statistic it does not hold", () => {
    rows.items = [];
    render(<SignalsTab runId="TAS-70003" signalCount={12} selected={[]} onSelectedChange={() => {}} />);

    const table = screen.getByRole("table");
    expect(table.textContent).not.toContain("0.0");
  });

  it("never prints the measured caption over an empty table", () => {
    rows.items = [];
    render(<SignalsTab runId="TAS-70003" signalCount={12} selected={[]} onSelectedChange={() => {}} />);

    expect(screen.queryByText(AT_INGESTION)).not.toBeInTheDocument();
  });

  it("prints the measured caption once rows arrive", () => {
    rows.items = [rawFloat];
    render(<SignalsTab runId="TAS-88214" signalCount={1} selected={[]} onSelectedChange={() => {}} />);

    expect(screen.getByText(AT_INGESTION)).toBeInTheDocument();
    expect(screen.queryByText("No statistics yet")).not.toBeInTheDocument();
  });
});
