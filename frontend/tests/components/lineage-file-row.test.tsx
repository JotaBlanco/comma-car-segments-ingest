import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { LineageFile, LineageResponse } from "@/types";

const { lineage } = vi.hoisted(() => ({ lineage: { files: [] as unknown[] } }));

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
  useRunLineage: () => ({
    data: {
      work_order: null,
      definition: null,
      run: {
        run_id: "TAS-88214",
        rig_id: "RIG-04",
        test_cell: "TC-2",
        first_data_at: "2026-08-19T07:15:00Z",
        file_count: lineage.files.length,
        signal_count: 186,
        status: "complete",
      },
      files: lineage.files,
      results: [],
    } as unknown as LineageResponse,
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
}));

import { LineageScreen } from "@/components/screens/lineage/lineage-screen";

function makeFile(index: number): LineageFile {
  return {
    file_id: `FILE-${index}`,
    filename: `bat_soak_part${index}.mf4`,
    source_system: "TAS",
    size_bytes: 1_240_000,
    signal_count: 186,
  };
}

describe("the lineage file row", () => {
  it("wraps, so many files keep a readable card width", () => {
    // The hero run carries 8 files today. One non-wrapping row makes slivers.
    lineage.files = Array.from({ length: 8 }, (_, index) => makeFile(index));
    render(<LineageScreen runId="TAS-88214" />);

    const card = screen.getByText("bat_soak_part0.mf4").closest("a");
    expect(card).not.toBeNull();
    const column = (card as HTMLElement).parentElement as HTMLElement;
    // jsdom computes no layout, so the test reads the rule that prevents slivers.
    expect(column.className).toContain("min-w-[168px]");
    const row = column.parentElement as HTMLElement;
    expect(row.className).toContain("flex-wrap");
    expect(screen.getByText("bat_soak_part7.mf4")).toBeInTheDocument();
  });
});
