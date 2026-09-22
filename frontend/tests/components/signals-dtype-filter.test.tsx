import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { SignalCatalogEntry, SignalFacets } from "@/types";

/* FR-DM-111. The workbook asks to query signals by name, unit, source and
   type. The unit filter already shipped. These two are the other halves:
   `dtype`, which the catalog always stored and no screen could filter, and
   `source_system`, which the catalog row grew from the file that produced it.

   Both controls copy the Unit filter exactly: options from
   `GET /signals/facets`, repeated query params, one pill per applied value. */

const { rows, push } = vi.hoisted(() => ({
  rows: {
    signals: [] as unknown[],
    facets: { units: [], rates: [], rigs: [] } as SignalFacets,
  },
  push: vi.fn(),
}));

vi.mock("@/lib/hooks", () => ({
  usePageTitle: () => undefined,
  useActor: () => "Test Engineer",
  usePatchSignal: () => ({ mutate: vi.fn(), isPending: false }),
  useSignals: () => ({
    data: {
      items: rows.signals,
      total: rows.signals.length,
      page: 1,
      page_size: 20,
      total_pages: 1,
      view_counts: { all: rows.signals.length, missing_unit: 0 },
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
  useRouter: () => ({ push, replace: vi.fn() }),
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

function makeSignal(name: string, dtype: string): SignalCatalogEntry {
  return {
    name,
    description: "Cataloged at ingestion",
    unit: "°C",
    unit_source: "embedded",
    dtype,
    typical_rate_hz: 100,
    run_count: 3,
    first_seen: "2026-06-02T08:14:20Z",
    last_seen: "2026-08-19T09:41:33Z",
  };
}

function setUp(facets: SignalFacets, signals: SignalCatalogEntry[] = []): void {
  rows.facets = facets;
  rows.signals = signals;
  push.mockClear();
}

/* The checkbox carries the option value on `aria-label`, and the row label
   wraps it. `signals-filter-options.test.tsx` reads the same attribute. */
function boxFor(scope: ReturnType<typeof within>, value: string): HTMLElement {
  const box = scope
    .getAllByRole("checkbox")
    .find((candidate: HTMLElement) => candidate.getAttribute("aria-label") === value);
  if (box === undefined) throw new Error(`no checkbox for ${value}`);
  return box;
}

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
  await user.click(
    screen.getByRole("button", { name: new RegExp(`^${label}`), expanded: false })
  );
  return within(await screen.findByRole("dialog", { name: `${label} filter` }));
}

describe("the signals data-type filter", () => {
  it("offers every data type the whole catalog holds", async () => {
    const user = userEvent.setup();
    setUp({
      units: [],
      rates: [],
      rigs: [],
      dtypes: ["float32", "float64", "int32"],
      source_systems: [],
    });
    render(<SignalsScreen />, { wrapper: Wrapper });

    const dtype = await openFilter(user, "Data type");
    expect(dtype.getByText("float32")).toBeInTheDocument();
    expect(dtype.getByText("float64")).toBeInTheDocument();
    expect(dtype.getByText("int32")).toBeInTheDocument();
  });

  it("writes the selected type to the URL as a `dtype` param", async () => {
    const user = userEvent.setup();
    setUp({ units: [], rates: [], rigs: [], dtypes: ["int32"], source_systems: [] });
    render(<SignalsScreen />, { wrapper: Wrapper });

    const dtype = await openFilter(user, "Data type");
    await user.click(boxFor(dtype, "int32"));

    expect(push).toHaveBeenCalledWith("/signals?dtype=int32", { scroll: false });
  });

  it("states that no value exists when the catalog holds none", async () => {
    const user = userEvent.setup();
    setUp({ units: [], rates: [], rigs: [], dtypes: [], source_systems: [] });
    render(<SignalsScreen />, { wrapper: Wrapper });

    const dtype = await openFilter(user, "Data type");
    expect(dtype.getByText("No values in the catalog.")).toBeInTheDocument();
  });

  it("keeps working when the facets state no data types at all", async () => {
    // An API older than 24 Aug 2026 answers three lists, not five. The
    // control must open and say so, never crash the screen.
    const user = userEvent.setup();
    setUp({ units: ["°C"], rates: [100], rigs: ["RIG-04"] }, [
      makeSignal("HV_Batt_Cell_Temp_Max", "float64"),
    ]);
    render(<SignalsScreen />, { wrapper: Wrapper });

    const dtype = await openFilter(user, "Data type");
    expect(dtype.getByText("No values in the catalog.")).toBeInTheDocument();
  });
});

describe("the signals source-system filter", () => {
  it("offers every producing system the whole catalog holds", async () => {
    const user = userEvent.setup();
    setUp({
      units: [],
      rates: [],
      rigs: [],
      dtypes: [],
      source_systems: ["INCA", "TAS", "ifile"],
    });
    render(<SignalsScreen />, { wrapper: Wrapper });

    const system = await openFilter(user, "Source system");
    expect(system.getByText("INCA")).toBeInTheDocument();
    expect(system.getByText("TAS")).toBeInTheDocument();
    expect(system.getByText("ifile")).toBeInTheDocument();
  });

  it("writes the selected system to the URL as a `source_system` param", async () => {
    const user = userEvent.setup();
    setUp({ units: [], rates: [], rigs: [], dtypes: [], source_systems: ["TAS"] });
    render(<SignalsScreen />, { wrapper: Wrapper });

    const system = await openFilter(user, "Source system");
    await user.click(boxFor(system, "TAS"));

    expect(push).toHaveBeenCalledWith("/signals?source_system=TAS", { scroll: false });
  });
});
