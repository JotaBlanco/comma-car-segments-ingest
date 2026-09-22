import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { TestRunListItem } from "@/types";

const { rows, facets } = vi.hoisted(() => ({
  rows: { items: [] as unknown[] },
  facets: { value: { rigs: [] as string[], projects: [] as string[] } },
}));

// The screen reads the runs through react-query. Stub the hook, so the test
// states its own rows and needs no provider.
vi.mock("@/lib/hooks", () => ({
  // The detail screens set the window title through this hook.
  usePageTitle: () => undefined,
  // Every write control reads the actor from the signed-in Portal identity.
  useActor: () => "Test Engineer",
  usePatchSignal: () => ({ mutate: vi.fn(), isPending: false }),
  useFlagInvalid: () => ({ mutate: vi.fn(), isPending: false }),
  useClearInvalid: () => ({ mutate: vi.fn(), isPending: false }),
  useAddRunNote: () => ({ mutate: vi.fn(), isPending: false }),
  usePatchRun: () => ({ mutate: vi.fn(), isPending: false }),
  useRuns: () => ({
    data: {
      items: rows.items,
      total: rows.items.length,
      page: 1,
      page_size: 20,
      total_pages: 1,
      view_counts: { all: rows.items.length, attention: 0, invalid: 0 },
    },
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
  // The filter options come from the whole-table facets route (§2b), not
  // from the loaded page.
  useRunFacets: () => ({
    data: facets.value,
    isPending: false,
    isError: false,
    isSuccess: true,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { RunsScreen } from "@/components/screens/runs/runs-screen";

/* The saved-search control reads the signed-in Portal identity, and that hook
   needs a query client. It sits below the mocked `@/lib/hooks` barrel, so the
   mock above cannot stand in for it. No token reaches this test, so the
   control stays on its device-local list and sends no request. */
function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}


function makeRun(runId: string, rigId: string, project: string | null): TestRunListItem {
  return {
    run_id: runId,
    description: "HV battery thermal soak",
    definition_id: "TD-4471",
    work_order_id: "WO-8821",
    project,
    rig_id: rigId,
    test_cell: "TC-2",
    file_count: 2,
    signal_count: 186,
    first_data_at: "2026-08-19T07:15:00Z",
    status: "complete",
    invalid: { flagged: false, reason: null, actor: null, at: null },
  };
}

describe("the runs filter options", () => {
  it("offers every rig and project the facets serve, not a typed list", async () => {
    const user = userEvent.setup();
    // RIG-01 and EX30 exist in the table. The old typed lists held neither,
    // and the newest-200 page this replaced could drop an idle rig too.
    rows.items = [
      makeRun("TAS-90001", "RIG-01", "EX30"),
      makeRun("TAS-90002", "RIG-02", "EX90"),
    ];
    facets.value = { rigs: ["RIG-01", "RIG-02"], projects: ["EX30", "EX90"] };
    render(<RunsScreen />, { wrapper: Wrapper });

    // The rig filter sits in the Filters panel, which starts shut.
    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    await user.click(screen.getByRole("button", { name: /Rig/ }));
    expect(await screen.findByText("RIG-01")).toBeInTheDocument();
    expect(screen.getByText("RIG-02")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: /Project/ }));
    expect(await screen.findByText("EX30")).toBeInTheDocument();
  });

  it("states that no value exists when the facets are empty", async () => {
    const user = userEvent.setup();
    rows.items = [];
    facets.value = { rigs: [], projects: [] };
    render(<RunsScreen />, { wrapper: Wrapper });

    // The rig filter sits in the Filters panel, which starts shut.
    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    await user.click(screen.getByRole("button", { name: /Rig/ }));
    expect(await screen.findByText("No values in the loaded rows.")).toBeInTheDocument();
  });
});
