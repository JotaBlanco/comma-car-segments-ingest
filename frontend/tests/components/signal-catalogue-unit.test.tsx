// When a signal's unit was resolved from the catalogue, the signal detail
// screen says so in plain text. This is the only remaining place in the
// product where unit origin is surfaced after the SourceBadge sweep.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SignalDetail } from "@/types";

function signal(overrides: Partial<SignalDetail> = {}): SignalDetail {
  return {
    name: "HV_Batt_Cell_Temp_Max",
    description: null,
    unit: "°C",
    unit_source: "api:catalogue",
    dtype: "float64",
    typical_rate_hz: 100,
    run_count: 4,
    first_seen: "2026-08-01T08:00:00Z",
    last_seen: "2026-08-14T11:00:00Z",
    sensor_ref: null,
    catalogue_ref: null,
    rig_ids: ["RIG-04"],
    field_sources: {
      unit: { source: "api:catalogue", actor: "catalogue-sync", at: "2026-08-01T00:00:00Z" },
    },
    ...overrides,
  };
}

const { useSignal } = vi.hoisted(() => ({
  useSignal: vi.fn(() => ({
    data: signal(),
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  })),
}));

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
  useSignal,
  useSignalJournal: () => ({
    data: { items: [], total: 0, page: 1, page_size: 50, total_pages: 1 },
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
  useSignalRunStats: () => ({
    data: {
      name: "HV_Batt_Cell_Temp_Max",
      unit: "°C",
      window: "run",
      items: [],
      total: 0,
      page: 1,
      page_size: 200,
      total_pages: 0,
    },
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
  useRunSignals: () => ({
    data: { items: [], total: 0, page: 1, page_size: 100, total_pages: 1 },
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

import { SignalDetailScreen } from "@/components/screens/signals/signal-detail-screen";

const NAME = "HV_Batt_Cell_Temp_Max";

describe("signal detail — unit origin note", () => {
  it("prints 'mapped from the catalogue' when the unit came from the catalogue", () => {
    useSignal.mockReturnValue({
      data: signal(),
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<SignalDetailScreen name={NAME} />);
    expect(screen.getByText("mapped from the catalogue")).toBeInTheDocument();
  });

  it("does not print the catalogue note when the unit is embedded", () => {
    useSignal.mockReturnValue({
      data: signal({
        unit_source: "embedded",
        field_sources: { unit: { source: "embedded", actor: "ingest", at: "2026-08-01T00:00:00Z" } },
      }),
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<SignalDetailScreen name={NAME} />);
    expect(screen.queryByText("mapped from the catalogue")).not.toBeInTheDocument();
  });
});
