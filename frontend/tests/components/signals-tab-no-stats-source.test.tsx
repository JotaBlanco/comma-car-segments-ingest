/**
 * The Signals tab when the run carries no measured statistics.
 *
 * The demo pod ran in exactly this state: its workspace had blob storage
 * switched off, so the Portal injected no lake, and the run on screen was
 * ingested while the statistics stage was crash-looping. The tab counted 261
 * signals and then printed "Could not load signals for this run." A working
 * registry read as a broken screen.
 *
 * The API reads the registry alone for this list now. It answers 200 with
 * every row, and it states how much of the run the ingestion pipeline
 * measured, so this file pins the three things a person must see:
 *
 * 1. The rows arrive, with a dash in every number column.
 * 2. One plain sentence names the reason, and it is NOT an error.
 * 3. The tab never claims a measurement over a column of dashes.
 *
 * A request that really fails is a different case, and it keeps the red error
 * state. The last test holds that line.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { FileSignal, RunSignalPage } from "@/types";

const RUN_ID = "TAS-90011";

const { state } = vi.hoisted(() => ({
  state: { page: null as RunSignalPage | null, failed: false },
}));

vi.mock("@/lib/hooks", () => ({
  usePageTitle: () => undefined,
  useActor: () => "Test Engineer",
  usePatchSignal: () => ({ mutate: vi.fn(), isPending: false }),
  useSignalFacets: () => ({
    data: { units: [], rates: [], rigs: [] },
    isPending: false,
    isError: false,
    isSuccess: true,
  }),
  useRunSignals: () => ({
    data: state.failed ? undefined : state.page,
    isPending: false,
    isError: state.failed,
    isSuccess: !state.failed,
    refetch: vi.fn(),
  }),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { SignalsTab } from "@/components/screens/run-detail/signals-tab";

const NOTHING_MEASURED = /No statistics measured for this run yet/;
const AT_INGESTION = /Statistics measured at ingestion/;
const SOME_BLANK = /A signal with no numbers was not measured/;
/** The old caption. Since mf4-stats the pipeline measures the numbers, so no
 *  page may claim the lake computed them. */
const LAKESIDE = /Statistics computed lakeside/;

const row = (name: string, stats: FileSignal["stats"] = null): FileSignal => ({
  name,
  unit: "°C",
  unit_source: "embedded",
  rate_hz: 100,
  dtype: "float64",
  stats,
});

const page = (items: FileSignal[], extra: Partial<RunSignalPage> = {}): RunSignalPage => ({
  items,
  total: items.length,
  page: 1,
  page_size: 200,
  total_pages: 1,
  ...extra,
});

/** The envelope the API sends when the pipeline measured nothing at all. */
const NOT_MEASURED = {
  reason: "not_measured" as const,
  detail: "No signal of this run carries measured statistics.",
};

/** The envelope the API sends when it measured some of the signals. */
const PARTLY_MEASURED = {
  reason: "partly_measured" as const,
  detail: "The ingestion pipeline measured 1 of the 2 signals of this run.",
};

function show(data: RunSignalPage | null, failed = false) {
  state.page = data;
  state.failed = failed;
  render(
    <SignalsTab runId={RUN_ID} signalCount={261} selected={[]} onSelectedChange={vi.fn()} />
  );
}

describe("the Signals tab with no measured statistics", () => {
  it("lists the registry rows instead of one red line", () => {
    show(page([row("HV_Batt_Pack_Voltage"), row("Coolant_Inlet_Temp")], {
      stats_unavailable: NOT_MEASURED,
    }));

    expect(screen.getByText("HV_Batt_Pack_Voltage")).toBeInTheDocument();
    expect(screen.getByText("Coolant_Inlet_Temp")).toBeInTheDocument();
    expect(screen.queryByText("Could not load signals for this run.")).not.toBeInTheDocument();
  });

  it("shows a dash in every number column, and never a zero", () => {
    show(page([row("HV_Batt_Pack_Voltage")], { stats_unavailable: NOT_MEASURED }));

    const line = screen.getByText("HV_Batt_Pack_Voltage").closest("tr") as HTMLElement;
    // Five number columns since 21 Aug 2026: Min, Max, Mean, σ and RMS.
    expect(within(line).getAllByText("—")).toHaveLength(5);
    expect(line.textContent).not.toContain("0.00");
  });

  it("names the reason in one plain sentence", () => {
    show(page([row("HV_Batt_Pack_Voltage")], { stats_unavailable: NOT_MEASURED }));

    expect(screen.getByText(NOTHING_MEASURED)).toBeInTheDocument();
  });

  it("claims no measurement over a column of dashes", () => {
    show(page([row("HV_Batt_Pack_Voltage")], { stats_unavailable: NOT_MEASURED }));

    expect(screen.queryByText(AT_INGESTION)).not.toBeInTheDocument();
    expect(screen.queryByText(LAKESIDE)).not.toBeInTheDocument();
  });

  it("still shows the numbers the pipeline measured", () => {
    // A mixed page: the pipeline measured one signal and not the other. The
    // measured numbers must not disappear, and the blank one keeps a reason.
    show(
      page([row("A", { min: 1, max: 2, mean: 1.5, std: 0.5 }), row("B")], {
        stats_unavailable: PARTLY_MEASURED,
      })
    );

    const measured = screen.getByText("A").closest("tr") as HTMLElement;
    expect(within(measured).getByText("1.5")).toBeInTheDocument();
    expect(screen.getByText(SOME_BLANK)).toBeInTheDocument();
  });
});

describe("the Signals tab tells the three cases apart", () => {
  it("says nothing measured this run when no signal carries numbers", () => {
    show(page([row("HV_Batt_Pack_Voltage")], { stats_unavailable: NOT_MEASURED }));

    expect(screen.getByText(NOTHING_MEASURED)).toBeInTheDocument();
    expect(screen.queryByText(SOME_BLANK)).not.toBeInTheDocument();
  });

  it("names the pipeline when every row carries numbers", () => {
    // No `stats_unavailable`: every row on this run carries measured numbers,
    // so the caption states one source for all of them.
    show(page([row("HV_Batt_Pack_Voltage", { min: 1, max: 2, mean: 1.5, std: 0.5 })]));

    expect(screen.getByText(AT_INGESTION)).toBeInTheDocument();
    expect(screen.queryByText(SOME_BLANK)).not.toBeInTheDocument();
    expect(screen.queryByText(LAKESIDE)).not.toBeInTheDocument();
  });

  it("keeps the red error state when the request really fails", () => {
    // A request that fails is a real failure. This change must not make one
    // invisible.
    show(null, true);

    expect(screen.getByText("Could not load signals for this run.")).toBeInTheDocument();
    expect(screen.queryByText(NOTHING_MEASURED)).not.toBeInTheDocument();
  });
});
