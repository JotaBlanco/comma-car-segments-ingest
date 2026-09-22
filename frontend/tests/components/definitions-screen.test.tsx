import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { TestDefinitionListItem } from "@/types";

const { rows, listSpy, searchParams } = vi.hoisted(() => ({
  rows: { items: [] as unknown[] },
  listSpy: vi.fn(),
  searchParams: { value: new URLSearchParams() },
}));

// The screen reads the definitions through react-query. Stub the hook, so each
// test states its own rows and needs no provider.
vi.mock("@/lib/hooks", () => ({
  // The detail screens set the window title through this hook.
  usePageTitle: () => undefined,
  useTestDefinitions: (filters: unknown) => {
    listSpy(filters);
    return {
      data: {
        items: rows.items,
        total: rows.items.length,
        page: 1,
        page_size: 20,
        total_pages: 1,
      },
      isPending: false,
      isError: false,
      isSuccess: true,
      refetch: vi.fn(),
    };
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => searchParams.value,
}));

import { DefinitionsScreen } from "@/components/screens/definitions/definitions-screen";

function makeDefinition(
  tdId: string,
  workOrderId: string | null,
  orphaned: boolean,
): TestDefinitionListItem {
  return {
    td_id: tdId,
    title: "HV battery thermal cycling",
    work_order_id: workOrderId,
    planned_runs: 2,
    actual_runs: 1,
    status: "awaiting_data",
    orphaned,
    synced_at: "2026-08-19T07:15:00Z",
  };
}

describe("the definitions screen", () => {
  it("renders one row per definition", () => {
    rows.items = [
      makeDefinition("TD-BAT-102", "WO-2026-0839", false),
      makeDefinition("TD-INV-081", null, true),
    ];
    render(<DefinitionsScreen />);

    expect(screen.getByText("TD-BAT-102")).toBeInTheDocument();
    expect(screen.getByText("TD-INV-081")).toBeInTheDocument();
  });

  it("marks an orphaned definition with a badge", () => {
    rows.items = [
      makeDefinition("TD-BAT-102", "WO-2026-0839", false),
      makeDefinition("TD-INV-081", null, true),
    ];
    render(<DefinitionsScreen />);

    const orphanRow = screen.getByText("TD-INV-081").closest("tr") as HTMLElement;
    const linkedRow = screen.getByText("TD-BAT-102").closest("tr") as HTMLElement;
    expect(within(orphanRow).getByText("Orphaned")).toBeInTheDocument();
    expect(within(linkedRow).queryByText("Orphaned")).not.toBeInTheDocument();
  });

  it("prints a dash when the definition names no work order", () => {
    rows.items = [makeDefinition("TD-INV-081", null, true)];
    render(<DefinitionsScreen />);

    const orphanRow = screen.getByText("TD-INV-081").closest("tr") as HTMLElement;
    expect(within(orphanRow).getByText("—")).toBeInTheDocument();
  });

  it("asks the API for orphans only when the URL states orphaned=true", () => {
    listSpy.mockClear();
    searchParams.value = new URLSearchParams("orphaned=true");
    rows.items = [];
    render(<DefinitionsScreen />);

    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ orphaned: true }));
  });

  it("asks the API for every definition when the URL states no filter", () => {
    listSpy.mockClear();
    searchParams.value = new URLSearchParams();
    rows.items = [];
    render(<DefinitionsScreen />);

    const filters = listSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(filters.orphaned).toBeUndefined();
  });

  it("states that no definition matches when the list is empty", () => {
    searchParams.value = new URLSearchParams("orphaned=true");
    rows.items = [];
    render(<DefinitionsScreen />);

    expect(screen.getByText("No orphaned test definitions.")).toBeInTheDocument();
  });
});
