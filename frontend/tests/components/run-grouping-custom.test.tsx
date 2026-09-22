import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { RunGroup, TestRunListItem } from "@/types";

/**
 * FR-DM-108 — a person defines their own grouping criterion in the UI.
 *
 * The row asks that "users can define or customise grouping criteria". The
 * criterion is a custom property of the run, so the Group-by control must
 * offer the keys the current runs table really holds. A person then PICKS a
 * key; nobody types one, and nobody meets an empty column.
 */

const { rows, groups, facets, seen } = vi.hoisted(() => ({
  rows: { items: [] as unknown[] },
  groups: { items: [] as RunGroup[], total: 0, total_pages: 1, page: 1, page_size: 20 },
  facets: { keys: [] as string[] },
  seen: { groupFilters: undefined as Record<string, unknown> | undefined },
}));

vi.mock("@/lib/hooks", () => ({
  usePageTitle: () => undefined,
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
  // GET /test-runs/facets names the custom property keys the table holds.
  useRunFacets: () => ({
    data: { rigs: [], projects: [], custom_property_keys: facets.keys },
    isPending: false,
    isError: false,
  }),
  useRunGroups: (filters: Record<string, unknown>) => {
    seen.groupFilters = filters;
    return {
      data: {
        items: groups.items,
        total: groups.total,
        page: groups.page,
        page_size: groups.page_size,
        total_pages: groups.total_pages,
      },
      isPending: false,
      isError: false,
      isSuccess: true,
      refetch: vi.fn(),
    };
  },
}));

const { nav } = vi.hoisted(() => ({
  nav: { push: vi.fn(), replace: vi.fn(), params: new URLSearchParams() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => nav.params,
}));

import { RunsScreen } from "@/components/screens/runs/runs-screen";

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function makeRun(runId: string): TestRunListItem {
  return {
    run_id: runId,
    description: "HV battery thermal soak",
    definition_id: "TD-4471",
    work_order_id: "WO-8821",
    project: "EX90",
    rig_id: "RIG-04",
    test_cell: "TC-2",
    file_count: 2,
    signal_count: 186,
    first_data_at: "2026-08-19T07:15:00Z",
    status: "complete",
    invalid: { flagged: false, reason: null, actor: null, at: null },
  };
}

beforeEach(() => {
  nav.push.mockClear();
  nav.params = new URLSearchParams();
  rows.items = [makeRun("TAS-90001"), makeRun("TAS-90002")];
  groups.items = [];
  groups.total = 0;
  groups.total_pages = 1;
  groups.page = 1;
  groups.page_size = 20;
  facets.keys = ["coolant", "rig-owner"];
  seen.groupFilters = undefined;
});

async function openOptions(): Promise<void> {
  await userEvent.setup().click(screen.getByRole("button", { name: /^Filters/ }));
}

describe("the Group by control offers a criterion of the person's own", () => {
  it("lists the custom property keys the runs table holds", async () => {
    render(<RunsScreen />, { wrapper: Wrapper });
    await openOptions();

    const select = screen.getByLabelText("Group by");
    const labels = [...select.querySelectorAll("option")].map((option) => option.textContent);
    expect(labels).toEqual(["None", "Project", "Test cell", "Rig", "coolant", "rig-owner"]);
  });

  it("keeps the fixed three alone when no run carries a property", async () => {
    facets.keys = [];
    render(<RunsScreen />, { wrapper: Wrapper });
    await openOptions();

    const select = screen.getByLabelText("Group by");
    const labels = [...select.querySelectorAll("option")].map((option) => option.textContent);
    expect(labels).toEqual(["None", "Project", "Test cell", "Rig"]);
  });

  it("names the custom keys under their own group, so a fixed field never reads as one", async () => {
    render(<RunsScreen />, { wrapper: Wrapper });
    await openOptions();

    const group = screen.getByLabelText("Group by").querySelector("optgroup");
    expect(group?.label).toBe("Custom property");
    expect([...(group?.querySelectorAll("option") ?? [])].map((o) => o.getAttribute("value"))).toEqual(
      ["custom:coolant", "custom:rig-owner"],
    );
  });

  it("writes the prefixed key into the URL, so a grouped view is shareable", async () => {
    const user = userEvent.setup();
    render(<RunsScreen />, { wrapper: Wrapper });
    await openOptions();

    await user.selectOptions(screen.getByLabelText("Group by"), "custom:rig-owner");

    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push.mock.calls[0][0]).toBe("/runs?group_by=custom%3Arig-owner");
  });
});

describe("the grouped answer for a custom property", () => {
  it("sends the prefixed value to the grouped route with every filter", () => {
    nav.params = new URLSearchParams("group_by=custom:rig-owner&status=invalid&q=soak");
    render(<RunsScreen />, { wrapper: Wrapper });

    expect(seen.groupFilters).toMatchObject({
      group_by: "custom:rig-owner",
      status: ["invalid"],
      q: "soak",
    });
  });

  it("heads the table with the key itself, not with a wire name", () => {
    nav.params = new URLSearchParams("group_by=custom:rig-owner");
    groups.items = [
      { value: "powertrain", count: 7 },
      { value: "chassis", count: 2 },
    ];
    groups.total = 2;
    render(<RunsScreen />, { wrapper: Wrapper });

    const table = screen.getByRole("table", { name: "Test runs grouped by rig-owner" });
    expect(table).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "rig-owner" })).toBeInTheDocument();
    expect(screen.getByText("powertrain")).toBeInTheDocument();
  });

  it("says no run carries the property when the key answers no groups", () => {
    nav.params = new URLSearchParams("group_by=custom:nobody-uses-this");
    render(<RunsScreen />, { wrapper: Wrapper });

    expect(screen.getByText("No run carries this property.")).toBeInTheDocument();
  });

  it("keeps showing a key the table no longer holds, so the URL never lies", async () => {
    nav.params = new URLSearchParams("group_by=custom:retired-key");
    render(<RunsScreen />, { wrapper: Wrapper });

    const select = screen.getByLabelText("Group by") as HTMLSelectElement;
    expect(select.value).toBe("custom:retired-key");
  });
});
