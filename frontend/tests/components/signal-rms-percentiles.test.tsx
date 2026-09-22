/**
 * RMS and the three percentiles on the two statistics screens (FR-DM-014).
 *
 * The run-detail Signals tab reads the registry, and the registry merges an
 * RMS over the files of a run. It cannot merge a percentile, so that tab
 * carries an RMS column and no percentile column.
 *
 * The signal detail reads `GET /signals/{name}/stats`, which asks the lake.
 * The lake reads every sample, so it states all four, and the table prints
 * all four. A row that carries none of them prints a dash, never a zero.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { FileSignal, SignalDetail, SignalRunStat } from "@/types";

const { rows, stats } = vi.hoisted(() => ({
  rows: { items: [] as unknown[] },
  stats: { items: [] as unknown[] },
}));

function signal(): SignalDetail {
  return {
    name: "HV_Batt_Cell_Temp_Max",
    description: "Highest cell temperature",
    unit: "°C",
    unit_source: "embedded",
    dtype: "float64",
    typical_rate_hz: 100,
    run_count: 12,
    first_seen: "2026-07-01T08:00:00Z",
    last_seen: "2026-08-19T08:00:00Z",
    sensor_ref: null,
    catalogue_ref: null,
    rig_ids: ["RIG-04"],
    field_sources: {},
  };
}

vi.mock("@/lib/hooks", () => ({
  usePageTitle: () => undefined,
  useActor: () => "Test Engineer",
  useFlagInvalid: () => ({ mutate: vi.fn(), isPending: false }),
  useClearInvalid: () => ({ mutate: vi.fn(), isPending: false }),
  useAddRunNote: () => ({ mutate: vi.fn(), isPending: false }),
  usePatchRun: () => ({ mutate: vi.fn(), isPending: false }),
  usePatchSignal: () => ({ mutate: vi.fn(), isPending: false }),
  useSignalFacets: () => ({
    data: { units: [], rates: [], rigs: [] },
    isPending: false,
    isError: false,
    isSuccess: true,
  }),
  useSignal: () => ({ data: signal(), isPending: false, isError: false, refetch: vi.fn() }),
  useSignalJournal: () => ({
    data: { items: [], total: 0, page: 1, page_size: 50, total_pages: 1 },
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
  useSignalRunStats: () => ({
    data: {
      name: signal().name,
      unit: "°C",
      window: "run",
      items: stats.items,
      total: stats.items.length,
      page: 1,
      page_size: 200,
      total_pages: 1,
    },
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
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
  useRuns: () => ({
    data: { items: [], total: 0, page: 1, page_size: 100, total_pages: 0 },
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { SignalsTab } from "@/components/screens/run-detail/signals-tab";
import { SignalDetailScreen } from "@/components/screens/signals/signal-detail-screen";

const NAME = "HV_Batt_Cell_Temp_Max";
const DASH = "—";

function makeSignal(stats: FileSignal["stats"]): FileSignal {
  return { name: NAME, unit: "°C", unit_source: "embedded", rate_hz: 100, dtype: "float64", stats };
}

function makeStat(extra: Partial<SignalRunStat>): SignalRunStat {
  return {
    run_id: "TAS-88214",
    definition_id: "TD-BAT-114",
    rig_id: "RIG-04",
    run_date: "2026-08-19",
    status: "complete",
    min: 18.2,
    max: 47.9,
    mean: 33.4,
    std: 6.21,
    ...extra,
  };
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe("the run signals tab carries the merged RMS", () => {
  it("prints the RMS the API merged over the files of the run", () => {
    rows.items = [makeSignal({ min: 18.2, max: 47.9, mean: 33.4, std: 6.21, rms: 34.0 })];
    render(
      <SignalsTab runId="TAS-88214" signalCount={1} selected={[]} onSelectedChange={() => {}} />,
    );

    expect(screen.getByText("RMS")).toBeInTheDocument();
    expect(within(rowOf(NAME)).getByText("34.0")).toBeInTheDocument();
  });

  it("prints a dash when no file measured an RMS, and never a zero", () => {
    rows.items = [makeSignal({ min: 18.2, max: 47.9, mean: 33.4, std: 6.21, rms: null })];
    render(
      <SignalsTab runId="TAS-88214" signalCount={1} selected={[]} onSelectedChange={() => {}} />,
    );

    const row = rowOf(NAME);
    expect(within(row).getAllByText(DASH)).toHaveLength(1);
    expect(row.textContent).not.toContain("0.0 ");
  });

  it("shows no percentile column, because a percentile does not merge", () => {
    rows.items = [makeSignal({ min: 18.2, max: 47.9, mean: 33.4, std: 6.21, rms: 34.0 })];
    render(
      <SignalsTab runId="TAS-88214" signalCount={1} selected={[]} onSelectedChange={() => {}} />,
    );

    expect(screen.queryByText("p50")).toBeNull();
    expect(screen.queryByText("p95")).toBeNull();
    expect(screen.queryByText("p99")).toBeNull();
  });
});

describe("the signal detail prints the four lake quantities", () => {
  it("prints the RMS and all three percentiles of a lake row", () => {
    stats.items = [makeStat({ rms: 34.0, p50: 33.1, p95: 45.8, p99: 47.2 })];
    render(<SignalDetailScreen name={NAME} />);

    expect(screen.getByText("RMS")).toBeInTheDocument();
    expect(screen.getByText("p50")).toBeInTheDocument();
    expect(screen.getByText("p95")).toBeInTheDocument();
    expect(screen.getByText("p99")).toBeInTheDocument();
    const row = rowOf("TAS-88214");
    expect(within(row).getByText("34.0")).toBeInTheDocument();
    expect(within(row).getByText("33.1")).toBeInTheDocument();
    expect(within(row).getByText("45.8")).toBeInTheDocument();
    expect(within(row).getByText("47.2")).toBeInTheDocument();
  });

  it("prints a dash where a registry row could state no percentile", () => {
    stats.items = [makeStat({ rms: 34.0, p50: null, p95: null, p99: null })];
    render(<SignalDetailScreen name={NAME} />);

    const row = rowOf("TAS-88214");
    expect(within(row).getAllByText(DASH)).toHaveLength(3);
    expect(row.textContent).not.toContain("0.0 ");
  });
});
