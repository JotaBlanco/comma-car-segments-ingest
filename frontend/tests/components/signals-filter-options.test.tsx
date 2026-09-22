import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { SignalCatalogEntry, SignalFacets } from "@/types";

const { rows } = vi.hoisted(() => ({
  rows: {
    signals: [] as unknown[],
    signalTotal: 0,
    facets: { units: [], rates: [], rigs: [] } as SignalFacets,
  },
}));

/* The screen reads the catalog page and the facets through react-query.
   Stub the hooks, so the test states its own rows and needs no provider.

   The two stubs answer DIFFERENT data on purpose. The page is what the old
   screen derived its filters from, and the facets are the whole catalog.
   A test that fed both the same rows could not tell the two apart. */
vi.mock("@/lib/hooks", () => ({
  // The detail screens set the window title through this hook.
  usePageTitle: () => undefined,
  useActor: () => "Test Engineer",
  usePatchSignal: () => ({ mutate: vi.fn(), isPending: false }),
  useSignals: () => ({
    data: {
      items: rows.signals,
      total: rows.signalTotal,
      page: 1,
      page_size: 20,
      total_pages: 1,
      view_counts: { all: rows.signalTotal, missing_unit: 0 },
    },
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
  useSignalFacets: () => ({
    data: rows.facets,
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { SignalsScreen } from "@/components/screens/signals/signals-screen";

/* The saved-search control reads the signed-in Portal identity, and that hook
   needs a query client. It sits below the mocked `@/lib/hooks` barrel, so the
   mock above cannot stand in for it. No token reaches this test, so the
   control stays on its device-local list and sends no request. */
function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}


function makeSignal(name: string, unit: string | null, rateHz: number): SignalCatalogEntry {
  return {
    name,
    description: "Cataloged at ingestion",
    unit,
    unit_source: unit === null ? null : "manual",
    dtype: "float64",
    typical_rate_hz: rateHz,
    run_count: 3,
    first_seen: "2026-06-02T08:14:20Z",
    last_seen: "2026-08-19T09:41:33Z",
  };
}

function setUp(facets: SignalFacets, signals: SignalCatalogEntry[] = []): void {
  rows.facets = facets;
  rows.signals = signals;
  rows.signalTotal = signals.length;
}

// Open one filter popover and return a scope over it. The popover is a dialog,
// and the screen prints the same values in the table. `expanded` picks the
// filter trigger: the sortable column head carries the same word.
/* Every signals filter sits in the Filters panel, which starts shut when the
   URL carries none. A person opens the panel before narrowing, so the helper
   does too. It is idempotent: the button toggles, so a second call on an open
   panel would shut it. */
async function openFiltersPanel(user: UserEvent): Promise<void> {
  const toggle = screen.getByRole("button", { name: /^Filters/ });
  if (toggle.getAttribute("aria-expanded") === "true") return;
  await user.click(toggle);
}

async function openFilter(user: UserEvent, label: string) {
  await openFiltersPanel(user);
  await user.click(screen.getByRole("button", { name: new RegExp(`^${label}`), expanded: false }));
  return within(await screen.findByRole("dialog", { name: `${label} filter` }));
}

describe("the signals filter options", () => {
  it("offers a unit of the whole catalog that the loaded page does not hold", async () => {
    const user = userEvent.setup();
    /* This is the bug. The page sorts `last_seen` desc and
       `PATCH /signals/{name}` does not move `last_seen`. A person corrects
       the unit of an OLD signal, so that unit never reaches the page. The
       facets route reads the whole catalog, so the filter still offers it. */
    setUp({ units: ["%RH", "rpm", "°C"], rates: [1, 100], rigs: ["RIG-01"] }, [
      makeSignal("Chamber_Ambient_Temp", "°C", 1),
    ]);
    render(<SignalsScreen />, { wrapper: Wrapper });

    // The table prints "°C", so every assertion reads the popover.
    const unit = await openFilter(user, "Unit");
    expect(unit.getByText("rpm")).toBeInTheDocument();
    expect(unit.getByText("%RH")).toBeInTheDocument();
    expect(unit.getByText("°C")).toBeInTheDocument();
  });

  it("offers a rate of the whole catalog that the loaded page does not hold", async () => {
    const user = userEvent.setup();
    setUp({ units: ["km/h"], rates: [1, 12.5, 100], rigs: [] }, [
      makeSignal("Wheel_Speed_FL", "km/h", 1),
    ]);
    render(<SignalsScreen />, { wrapper: Wrapper });

    const rate = await openFilter(user, "Rate");
    expect(rate.getByText("12.5 Hz")).toBeInTheDocument();
    expect(rate.getByText("100 Hz")).toBeInTheDocument();
  });

  it("offers a rig of the whole catalog, not the rigs of one page of runs", async () => {
    const user = userEvent.setup();
    // The rigs come from `rig_ids` now. The screen no longer reads the runs.
    setUp({ units: [], rates: [], rigs: ["RIG-01", "RIG-04", "RIG-07"] });
    render(<SignalsScreen />, { wrapper: Wrapper });

    const rig = await openFilter(user, "Rig");
    expect(rig.getByText("RIG-01")).toBeInTheDocument();
    expect(rig.getByText("RIG-07")).toBeInTheDocument();
  });

  it("keeps the order the route states", async () => {
    const user = userEvent.setup();
    // The route sorts ascending. The screen must not re-sort and must not
    // reverse, or the popover order would differ from the contract.
    setUp({ units: ["%RH", "rpm", "°C"], rates: [1, 12.5, 100], rigs: [] });
    render(<SignalsScreen />, { wrapper: Wrapper });

    const rate = await openFilter(user, "Rate");
    const labels = rate.getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"));
    expect(labels).toEqual(["1", "12.5", "100"]);
  });

  it("claims no page cover, because the facets read the whole catalog", async () => {
    const user = userEvent.setup();
    // The old screen printed "From the newest 500 of 6412 cataloged signals."
    // under each list. The facets route covers all three lists, so the note
    // would now be a false warning.
    setUp({ units: ["rpm"], rates: [100], rigs: ["RIG-01"] }, [
      makeSignal("EM_Shaft_Speed", "rpm", 100),
    ]);
    render(<SignalsScreen />, { wrapper: Wrapper });

    for (const label of ["Unit", "Rate", "Rig"]) {
      const filter = await openFilter(user, label);
      expect(filter.queryByText(/From the newest/)).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
    }
  });

  it("states that no value exists when the catalog holds none", async () => {
    const user = userEvent.setup();
    // The facets route reads the whole catalog, so the empty line must not
    // blame the loaded rows.
    setUp({ units: [], rates: [], rigs: [] });
    render(<SignalsScreen />, { wrapper: Wrapper });

    const unit = await openFilter(user, "Unit");
    expect(unit.getByText("No values in the catalog.")).toBeInTheDocument();
    expect(unit.queryByText(/loaded rows/)).not.toBeInTheDocument();
  });
});
