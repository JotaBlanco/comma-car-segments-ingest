/**
 * The two run counts on the signal detail screen.
 *
 * The screen shows two numbers about one signal, and they answer two
 * questions. `signal.run_count` counts the runs whose file inventory names the
 * signal (`api/api/services/queries_signals.py`). The `total` of
 * `GET /signals/{name}/stats` counts the runs the lake holds samples for
 * (`api/api/services/queries_stats.py`). A run can name the signal in its
 * inventory and hold no sample, so no backend change makes the two agree.
 * The screen must therefore label each number.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { SignalDetail, SignalRunStat } from "@/types";

const { catalog, stats } = vi.hoisted(() => ({
  catalog: { run_count: 21 },
  stats: { items: [] as unknown[], total: 0, isPending: false },
}));

const INVENTORY_RUNS = 21;
const STATISTICS_RUNS = 12;

function signal(): SignalDetail {
  return {
    name: "HV_Batt_Cell_Temp_Max",
    description: "Highest cell temperature",
    unit: "°C",
    unit_source: "embedded",
    dtype: "float64",
    typical_rate_hz: 10,
    run_count: catalog.run_count,
    first_seen: "2026-07-01T08:00:00Z",
    last_seen: "2026-08-19T08:00:00Z",
    sensor_ref: null,
    catalogue_ref: null,
    rig_ids: ["RIG-04"],
    field_sources: {},
  };
}

vi.mock("@/lib/hooks", () => ({
  // The detail screens set the window title through this hook.
  usePageTitle: () => undefined,
  useActor: () => "Test Engineer",
  usePatchSignal: () => ({ mutate: vi.fn(), isPending: false }),
  // The unit autocomplete reads the whole catalog's units (§14b).
  useSignalFacets: () => ({ data: { units: [], rates: [], rigs: [] }, isPending: false, isError: false, isSuccess: true }),
  useSignal: () => ({ data: signal(), isPending: false, isError: false, refetch: vi.fn() }),
  useSignalJournal: () => ({ data: { items: [], total: 0, page: 1, page_size: 50, total_pages: 1 }, isPending: false, isError: false, isSuccess: true, refetch: vi.fn() }),
  useSignalRunStats: () => ({
    data: stats.isPending
      ? undefined
      : {
          name: signal().name,
          unit: "°C",
          window: "run",
          items: stats.items,
          total: stats.total,
          page: 1,
          page_size: 200,
          total_pages: 1,
        },
    isPending: stats.isPending,
    isError: false,
    isSuccess: !stats.isPending,
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

import { SignalDetailScreen } from "@/components/screens/signals/signal-detail-screen";

function makeStat(index: number): SignalRunStat {
  return {
    run_id: `TAS-9000${index}`,
    definition_id: "TD-4471",
    rig_id: "RIG-04",
    run_date: "2026-08-19",
    status: "complete",
    min: 18.2,
    max: 47.9,
    mean: 33.4,
    std: 6.21,
  };
}

/** The cell the MetaGrid renders under one label. */
function metaCell(label: string): HTMLElement {
  const heading = screen.getByText(label);
  const cell = heading.parentElement;
  expect(cell).not.toBeNull();
  return cell as HTMLElement;
}

function renderScreen(): void {
  render(<SignalDetailScreen name={signal().name} />);
}

describe("the signal detail screen labels both run counts", () => {
  it("renders the inventory count and the statistics count, each under its own label", () => {
    catalog.run_count = INVENTORY_RUNS;
    stats.isPending = false;
    stats.total = STATISTICS_RUNS;
    stats.items = [makeStat(1)];
    renderScreen();

    // The inventory count sits in the "Seen in" cell and says what counts it.
    const seenIn = metaCell("Seen in");
    expect(within(seenIn).getByText(`${INVENTORY_RUNS} runs`)).toBeInTheDocument();
    expect(seenIn.textContent).toContain("the registry counts every run");

    // The statistics count heads the table and names the lake.
    expect(screen.getByText(`Statistics from ${STATISTICS_RUNS} runs`)).toBeInTheDocument();
    expect(
      screen.getByText(/A run appears here when the lake holds samples for it\./),
    ).toBeInTheDocument();

    // Neither number stands in for the other.
    expect(screen.queryByText(`Statistics from ${INVENTORY_RUNS} runs`)).toBeNull();
    expect(within(seenIn).queryByText(`${STATISTICS_RUNS} runs`)).toBeNull();
  });

  it("keeps both numbers when the lake holds samples for no run", () => {
    catalog.run_count = INVENTORY_RUNS;
    stats.isPending = false;
    stats.total = 0;
    stats.items = [];
    renderScreen();

    expect(within(metaCell("Seen in")).getByText(`${INVENTORY_RUNS} runs`)).toBeInTheDocument();
    expect(screen.getByText("Statistics from 0 runs")).toBeInTheDocument();
    expect(screen.getByText(/The registry lists it in 21 runs\./)).toBeInTheDocument();
  });

  it("names no statistics count while the statistics load", () => {
    catalog.run_count = INVENTORY_RUNS;
    stats.isPending = true;
    stats.total = 0;
    stats.items = [];
    renderScreen();

    expect(screen.getByText("Statistics per run")).toBeInTheDocument();
    // The old header fell back to the inventory count, so it presented one
    // number as the other. It must never do that again.
    expect(screen.queryByText(`Statistics from ${INVENTORY_RUNS} runs`)).toBeNull();
  });
});
