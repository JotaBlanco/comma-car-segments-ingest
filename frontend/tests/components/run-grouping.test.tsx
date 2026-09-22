import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { RunGroup, TestRunListItem } from "@/types";

/**
 * FR-DM-108 — the Group-by control and the grouped answer on the runs screen.
 *
 * The screen must keep the flat list untouched, so these tests check both
 * halves: no group selected shows the run table, a group selected shows the
 * counts, and the grouped call carries the same filters the list carries.
 */

const { rows, groups, seen } = vi.hoisted(() => ({
  rows: { items: [] as unknown[] },
  groups: { items: [] as RunGroup[], total: 0, total_pages: 1, page: 1, page_size: 20 },
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
  useRunFacets: () => ({ data: { rigs: [], projects: [] }, isPending: false, isError: false }),
  // Record what the panel asked for. The agreement between the grouped and
  // the flat answer rests on the two calls carrying one filter set.
  useRunGroups: (filters: Record<string, unknown>) => {
    seen.groupFilters = filters;
    return {
      data: { items: groups.items, total: groups.total, page: groups.page, page_size: groups.page_size, total_pages: groups.total_pages },
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
  seen.groupFilters = undefined;
});

describe("the Group by control", () => {
  /* Group by lives in the Filters panel, which starts shut when the URL
     carries no filter. Opening it is what a person does, so the tests do it
     too. A URL that already names `group_by` opens the panel on arrival, so
     the tests below that arrive grouped need no click. */
  async function openOptions(): Promise<void> {
    await userEvent.setup().click(screen.getByRole("button", { name: /^Filters/ }));
  }

  it("offers the three fields a run document holds, and None", async () => {
    render(<RunsScreen />, { wrapper: Wrapper });
    await openOptions();

    const select = screen.getByLabelText("Group by");
    const labels = [...select.querySelectorAll("option")].map((option) => option.textContent);
    // `vehicle` and `bench` are the two workbook fields no run holds.
    expect(labels).toEqual(["None", "Project", "Test cell", "Rig"]);
  });

  it("writes the chosen field into the URL, so a grouped view is shareable", async () => {
    const user = userEvent.setup();
    render(<RunsScreen />, { wrapper: Wrapper });
    await openOptions();

    await user.selectOptions(screen.getByLabelText("Group by"), "test_cell");

    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push.mock.calls[0][0]).toBe("/runs?group_by=test_cell");
  });

  it("shows the flat run table while no field is chosen", () => {
    render(<RunsScreen />, { wrapper: Wrapper });

    expect(screen.getByRole("table", { name: "Test runs" })).toBeInTheDocument();
    expect(screen.getByText("TAS-90001")).toBeInTheDocument();
  });
});

describe("the grouped answer", () => {
  it("renders one row per group, with its key and its count", () => {
    nav.params = new URLSearchParams("group_by=project");
    groups.items = [
      { value: "EX90", count: 12 },
      { value: "EC40", count: 5 },
    ];
    groups.total = 2;
    render(<RunsScreen />, { wrapper: Wrapper });

    const table = screen.getByRole("table", { name: "Test runs grouped by project" });
    expect(table).toBeInTheDocument();
    expect(screen.getByText("EX90")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("EC40")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    // The list shape stays untouched: the run table is simply not on screen.
    expect(screen.queryByRole("table", { name: "Test runs" })).toBeNull();
  });

  it("names the group of runs that hold no value", () => {
    nav.params = new URLSearchParams("group_by=project");
    groups.items = [{ value: null, count: 3 }];
    groups.total = 1;
    render(<RunsScreen />, { wrapper: Wrapper });

    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("sends every filter the caller already set", () => {
    nav.params = new URLSearchParams("group_by=rig&status=invalid&project=EX90&q=soak");
    render(<RunsScreen />, { wrapper: Wrapper });

    expect(seen.groupFilters).toMatchObject({
      group_by: "rig",
      status: ["invalid"],
      project: ["EX90"],
      q: "soak",
    });
  });

  it("never sends the list sort, which has no meaning over groups", () => {
    nav.params = new URLSearchParams("group_by=rig&sort=first_data_at&order=asc");
    render(<RunsScreen />, { wrapper: Wrapper });

    expect(seen.groupFilters).not.toHaveProperty("sort");
    expect(seen.groupFilters).not.toHaveProperty("order");
  });

  it("pages over groups, so the pager states the group total", () => {
    nav.params = new URLSearchParams("group_by=test_cell");
    groups.items = [{ value: "TC-1", count: 40 }];
    groups.total = 3;
    groups.page_size = 10;
    groups.total_pages = 1;
    render(<RunsScreen />, { wrapper: Wrapper });

    // 3 groups over 40+ runs. The pager counts the groups it pages.
    const pager = screen.getByRole("navigation", { name: "Pagination" });
    expect(pager).toHaveTextContent("Showing 1–3 of 3");
  });

  it("keeps the page in the URL when the reader turns to the next page", async () => {
    const user = userEvent.setup();
    nav.params = new URLSearchParams("group_by=project");
    groups.items = [{ value: "EX90", count: 1 }];
    groups.total = 45;
    groups.total_pages = 3;
    render(<RunsScreen />, { wrapper: Wrapper });

    await user.click(screen.getByRole("button", { name: "Page 2" }));

    expect(nav.push.mock.calls[0][0]).toBe("/runs?group_by=project&page=2");
  });

  it("clears the grouping from its filter pill", async () => {
    const user = userEvent.setup();
    nav.params = new URLSearchParams("group_by=test_cell");
    render(<RunsScreen />, { wrapper: Wrapper });

    // The pill names the field in display text, not in its wire name.
    const remove = screen.getByRole("button", { name: "Remove filter: Group by Test cell" });
    await user.click(remove);

    expect(nav.push.mock.calls[0][0]).toBe("/runs");
  });
});
