// The run Signals tab must reach every signal of a real Honda drive.
// The band TAS-90001..TAS-90006 registers 186 signals per run, so 186 is the
// number this file tests. A round number would hide an off-by-one page slice.
// The tab pages at 20 by default — the same default as the file signals
// table — so 186 signals span ten pages, and the last page holds 6.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FileSignal } from "@/types";

const SIGNAL_COUNT = 186;

const names = Array.from({ length: SIGNAL_COUNT }, (_, index) => `Signal_${index.toString().padStart(3, "0")}`);

const row = (name: string): FileSignal => ({
  name,
  unit: "°C",
  unit_source: "embedded",
  rate_hz: 10,
  dtype: "float64",
  stats: { min: 1, max: 2, mean: 1.5, std: 0.5 },
});

// The stub pages the same way the route does, so the tab's page and page_size
// decide what the table receives. A stub that ignores them proves nothing.
vi.mock("@/lib/hooks", () => ({
  // The detail screens set the window title through this hook.
  usePageTitle: () => undefined,
  // Every write control reads the actor from the signed-in Portal identity.
  useActor: () => "Test Engineer",
  useFlagInvalid: () => ({ mutate: vi.fn(), isPending: false }),
  useClearInvalid: () => ({ mutate: vi.fn(), isPending: false }),
  useAddRunNote: () => ({ mutate: vi.fn(), isPending: false }),
  usePatchRun: () => ({ mutate: vi.fn(), isPending: false }),
  useRunSignals: (_runId: string, params: { page?: number; page_size?: number }) => {
    const page = params.page ?? 1;
    const pageSize = params.page_size ?? 20;
    const start = (page - 1) * pageSize;
    return {
      data: {
        items: names.slice(start, start + pageSize).map(row),
        total: names.length,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(names.length / pageSize),
      },
      isPending: false,
      isError: false,
      isSuccess: true,
      refetch: vi.fn(),
    };
  },
  useSignals: () => ({
    data: { items: [], total: 0, page: 1, page_size: 100, total_pages: 0 },
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
  usePatchSignal: () => ({ mutate: vi.fn(), isPending: false }),
  // The unit autocomplete reads the whole catalog's units (§14b).
  useSignalFacets: () => ({ data: { units: [], rates: [], rigs: [] }, isPending: false, isError: false, isSuccess: true }),
}));

import { SignalsTab } from "@/components/screens/run-detail/signals-tab";

const nameCells = () => screen.getAllByText(/^Signal_\d{3}$/);
const pager = () => screen.getByRole("navigation", { name: "Pagination" });

describe("the run signals tab on a real run of 186 signals", () => {
  it("pages at 20 by default, and the last page reaches the last signal", async () => {
    const user = userEvent.setup();
    render(<SignalsTab runId="TAS-90001" signalCount={SIGNAL_COUNT} selected={[]} onSelectedChange={() => {}} />);

    expect(nameCells()).toHaveLength(20);
    expect(screen.getByText("Signal_000")).toBeInTheDocument();
    expect(screen.queryByText("Signal_020")).not.toBeInTheDocument();

    // Every signal stays reachable: 186 over pages of 20 ends on page 10.
    await user.click(screen.getByLabelText("Page 10"));
    expect(nameCells()).toHaveLength(6);
    expect(screen.getByText("Signal_185")).toBeInTheDocument();
    expect(pager()).toHaveTextContent(/Showing\s*181–186\s*of\s*186/);
  });

  it("states the truth about what the table holds", () => {
    render(<SignalsTab runId="TAS-90001" signalCount={SIGNAL_COUNT} selected={[]} onSelectedChange={() => {}} />);

    expect(pager()).toHaveTextContent(/Showing\s*1–20\s*of\s*186/);
    // The old footer claimed a cap of 100 over a run of 186.
    expect(screen.getByRole("table").textContent).not.toMatch(/the table holds/i);
  });

  it("pins the column headers — the table sits in the shared scroll region", () => {
    render(<SignalsTab runId="TAS-90001" signalCount={SIGNAL_COUNT} selected={[]} onSelectedChange={() => {}} />);

    // globals.css keys the sticky thead on this opt-in class.
    expect(screen.getByRole("table").closest(".table-scroll")).not.toBeNull();
    // The pager stays OUTSIDE the scroll region, so it is always reachable.
    expect(pager().closest(".table-scroll")).toBeNull();
  });

  it("pages honestly when one page holds less than the run", async () => {
    const user = userEvent.setup();
    render(<SignalsTab runId="TAS-90001" signalCount={SIGNAL_COUNT} selected={[]} onSelectedChange={() => {}} />);

    await user.selectOptions(screen.getByLabelText("Rows per page"), "100");
    expect(nameCells()).toHaveLength(100);
    expect(pager()).toHaveTextContent(/Showing\s*1–100\s*of\s*186/);

    await user.click(screen.getByLabelText("Page 2"));
    expect(nameCells()).toHaveLength(86);
    expect(screen.getByText("Signal_185")).toBeInTheDocument();
    expect(pager()).toHaveTextContent(/Showing\s*101–186\s*of\s*186/);
  });
});
