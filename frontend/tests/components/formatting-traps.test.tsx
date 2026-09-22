import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SignalDetail, SignalRunStat } from "@/types";

const { stats, files } = vi.hoisted(() => ({
  stats: { items: [] as unknown[], total: 0 },
  files: { items: [] as unknown[] },
}));

const signal: SignalDetail = {
  name: "Veh_LatAccel",
  description: "Lateral acceleration",
  unit: "g",
  unit_source: "embedded",
  dtype: "float64",
  typical_rate_hz: 100,
  run_count: 120,
  first_seen: "2026-07-01T08:00:00Z",
  last_seen: "2026-08-19T08:00:00Z",
  sensor_ref: null,
  catalogue_ref: null,
  rig_ids: ["RIG-01"],
  field_sources: {},
};

vi.mock("@/lib/hooks", () => ({
  // The detail screens set the window title through this hook.
  usePageTitle: () => undefined,
  // Every write control reads the actor from the signed-in Portal identity.
  useActor: () => "Test Engineer",
  usePatchSignal: () => ({ mutate: vi.fn(), isPending: false }),
  // The unit autocomplete reads the whole catalog's units (§14b).
  useSignalFacets: () => ({ data: { units: [], rates: [], rigs: [] }, isPending: false, isError: false, isSuccess: true }),
  useFlagInvalid: () => ({ mutate: vi.fn(), isPending: false }),
  useClearInvalid: () => ({ mutate: vi.fn(), isPending: false }),
  useAddRunNote: () => ({ mutate: vi.fn(), isPending: false }),
  usePatchRun: () => ({ mutate: vi.fn(), isPending: false }),
  useSignal: () => ({ data: signal, isPending: false, isError: false, refetch: vi.fn() }),
  useSignalJournal: () => ({ data: { items: [], total: 0, page: 1, page_size: 50, total_pages: 1 }, isPending: false, isError: false, isSuccess: true, refetch: vi.fn() }),
  useSignalRunStats: () => ({
    data: {
      name: signal.name,
      unit: "g",
      window: "run",
      items: stats.items,
      total: stats.total,
      page: 1,
      page_size: 200,
      total_pages: 2,
    },
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
  useRunFiles: () => ({
    data: { items: files.items, total: files.items.length, page: 1, page_size: 20, total_pages: 1 },
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
import { FilesTab } from "@/components/screens/run-detail/files-tab";

function makeStat(index: number): SignalRunStat {
  return {
    run_id: `TAS-9000${index}`,
    definition_id: "TD-4471",
    rig_id: "RIG-01",
    run_date: "2026-08-19",
    status: "complete",
    min: -0.02,
    max: 0.94,
    mean: 0.02,
    std: 0.31,
  };
}

describe("numbers and labels on real data", () => {
  it("keeps a small statistic readable instead of printing 0.0", () => {
    stats.items = [makeStat(1)];
    stats.total = 1;
    render(<SignalDetailScreen name={signal.name} />);

    expect(screen.getByText("0.02")).toBeInTheDocument();
    expect(screen.getByText("-0.02")).toBeInTheDocument();
    expect(screen.queryByText("0.0")).not.toBeInTheDocument();
  });

  it("states how many rows the table shows when the header counts more", () => {
    stats.items = Array.from({ length: 2 }, (_, index) => makeStat(index));
    stats.total = 260;
    render(<SignalDetailScreen name={signal.name} />);

    expect(screen.getByText("Statistics from 260 runs")).toBeInTheDocument();
    expect(screen.getByText("Showing 2 of 260 runs.")).toBeInTheDocument();
  });

  it("prints no line about rows when the table holds every run", () => {
    stats.items = [makeStat(1)];
    stats.total = 1;
    render(<SignalDetailScreen name={signal.name} />);

    expect(screen.queryByText(/Showing 1 of/)).not.toBeInTheDocument();
  });

  it("prints the name of a source system the label map does not know", () => {
    files.items = [
      {
        file_id: "FILE-1",
        filename: "bat_soak.mf4",
        format: "MF4",
        source_system: "CANape",
        size_bytes: 1_240_000,
        signal_count: 186,
        checksum_sha256: "a".repeat(64),
        status: "registered",
        received_at: "2026-08-19T07:15:00Z",
      },
    ];
    render(<FilesTab runId="TAS-90001" />);

    expect(screen.getByText("MF4 · CANape")).toBeInTheDocument();
  });
});
