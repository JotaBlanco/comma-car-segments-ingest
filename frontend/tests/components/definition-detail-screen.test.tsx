import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { JournalEntry, Paginated, TestDefinitionDetail } from "@/types";

/**
 * The definition detail screen — the node that closed the traceability chain.
 *
 * The screen reads one definition through react-query. Stub the hook, so each
 * test states its own definition and needs no provider.
 */

const { detail, state, journal } = vi.hoisted(() => ({
  detail: { value: null as unknown },
  state: { error: null as unknown, isPending: false },
  journal: { value: undefined as unknown, isPending: false, isError: false },
}));

vi.mock("@/lib/hooks", () => ({
  useTestDefinition: () => ({
    data: detail.value,
    isPending: state.isPending,
    error: state.error,
    refetch: vi.fn(),
  }),
  useTestDefinitionJournal: () => ({
    data: journal.value,
    isPending: journal.isPending,
    isError: journal.isError,
    refetch: vi.fn(),
  }),
  // The Requirements panel and its dialog write through these two, and the
  // Custom properties panel writes through the third. The screen test never
  // writes, so all three stay inert here.
  useAddRequirementsFile: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveRequirementsFile: () => ({ mutate: vi.fn(), isPending: false }),
  useSetDefinitionCustomProperties: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { DefinitionDetailScreen } from "@/components/screens/definitions/definition-detail-screen";

function makeDetail(overrides: Partial<TestDefinitionDetail> = {}): TestDefinitionDetail {
  return {
    td_id: "TD-BAT-114",
    title: "HV battery thermal cycling",
    work_order_id: "WO-2026-0851",
    planned_runs: 4,
    actual_runs: 1,
    status: "awaiting_data",
    orphaned: false,
    synced_at: "2026-08-19T07:15:00Z",
    work_order: {
      wo_id: "WO-2026-0851",
      title: "HV battery thermal validation",
      project: "EX90",
      status: "active",
    },
    runs: [
      {
        run_id: "TAS-88214",
        definition_id: "TD-BAT-114",
        rig_id: "RIG-04",
        test_cell: "TC-2",
        first_data_at: "2026-08-14T09:41:00Z",
        file_count: 3,
        signal_count: 142,
        status: "complete",
      },
    ],
    requirements_files: [],
    custom_properties: {},
    ...overrides,
  };
}

/** One mirror entry, the shape `api/api/planning_sync.py` writes. */
function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: "j-1",
    entity_type: "test_definition",
    entity_id: "TD-BAT-114",
    field: "test_definition.planned_runs",
    kind: "change",
    old: "2",
    new: "4",
    source: "api:planning",
    actor: "planning-sync",
    actor_id: null,
    note: "Changed by planning.",
    at: "2026-08-13T07:44:00Z",
    ...overrides,
  };
}

function makeJournal(items: JournalEntry[]): Paginated<JournalEntry> {
  return { items, total: items.length, page: 1, page_size: 50, total_pages: 1 };
}

function renderDetail(
  definition: TestDefinitionDetail | null,
  entries: JournalEntry[] = [],
): void {
  detail.value = definition;
  state.error = null;
  state.isPending = definition === null;
  journal.value = makeJournal(entries);
  journal.isPending = false;
  journal.isError = false;
  render(<DefinitionDetailScreen tdId="TD-BAT-114" />);
}

describe("the definition detail screen", () => {
  it("names the definition and its planning title", () => {
    renderDetail(makeDetail());

    expect(screen.getAllByText("TD-BAT-114").length).toBeGreaterThan(0);
    // The title prints twice: once under the heading, once in the metadata.
    expect(screen.getAllByText(/HV battery thermal cycling/).length).toBe(2);
  });

  it("links the work order in the breadcrumb", () => {
    renderDetail(makeDetail());

    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: /WO-2026-0851/ })).toHaveAttribute(
      "href",
      "/work-orders/WO-2026-0851",
    );
  });

  it("lists the runs that carry the definition, each one a link", () => {
    renderDetail(makeDetail());

    /* The row stays a real table row; the link lives on the run id in the
       first cell and addresses the run. */
    const runRow = screen.getByText("TAS-88214").closest("tr") as HTMLElement;
    expect(runRow).not.toHaveAttribute("role");
    expect(within(runRow).getByRole("link", { name: "TAS-88214" })).toHaveAttribute(
      "href",
      "/runs/TAS-88214",
    );
    expect(within(runRow).getByText("RIG-04 / TC-2")).toBeInTheDocument();
  });

  it("states that no run arrived yet when the definition carries none", () => {
    renderDetail(makeDetail({ actual_runs: 0, runs: [] }));

    expect(
      screen.getByText("No runs recorded under this definition yet."),
    ).toBeInTheDocument();
  });

  it("flags an orphan that names no work order, and says so", () => {
    renderDetail(makeDetail({ work_order_id: null, work_order: null, orphaned: true }));

    expect(screen.getAllByText("Orphaned").length).toBeGreaterThan(0);
    expect(screen.getByText(/This definition names no work order\./)).toBeInTheDocument();
  });

  it("flags an orphan whose work order this registry does not mirror", () => {
    renderDetail(makeDetail({ work_order_id: "WO-2026-0899", work_order: null, orphaned: true }));

    expect(
      screen.getByText(/names WO-2026-0899, which this registry does not mirror/),
    ).toBeInTheDocument();
  });

  it("keeps the work-order crumb dashed when the mirror holds no work order", () => {
    renderDetail(makeDetail({ work_order_id: null, work_order: null, orphaned: true }));

    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).queryByRole("link")).toBeNull();
    expect(within(crumbs).getByText("no work order")).toBeInTheDocument();
  });

  it("names the definition when the registry answers 404", async () => {
    const { ApiError } = await import("@/lib/api/client");
    detail.value = undefined;
    state.isPending = false;
    state.error = new ApiError(404, "Test definition TD-BAT-114 not found", "td_not_found");
    render(<DefinitionDetailScreen tdId="TD-BAT-114" />);

    expect(screen.getByText("Test definition TD-BAT-114 not found.")).toBeInTheDocument();
  });
});

/**
 * The history panel — contract §8b.
 *
 * The mirror journalled a definition from the day the type existed, and no
 * route and no screen served those entries. The panel is the same one the
 * file, signal and work-order screens show.
 */
describe("the definition history panel", () => {
  it("shows what planning moved, and who moved it", () => {
    renderDetail(makeDetail(), [makeEntry()]);

    expect(screen.getByRole("heading", { name: "History" })).toBeInTheDocument();
    expect(screen.getByText("test_definition.planned_runs")).toBeInTheDocument();
    expect(screen.getByText(/planning-sync/)).toBeInTheDocument();
    expect(screen.getByText("1 entry")).toBeInTheDocument();
  });

  it("states that nothing happened yet on a definition the mirror never moved", () => {
    renderDetail(makeDetail(), []);

    expect(screen.getByText("No journal entries")).toBeInTheDocument();
  });

  it("says the history could not load when the read fails", () => {
    detail.value = makeDetail();
    state.error = null;
    state.isPending = false;
    journal.value = undefined;
    journal.isPending = false;
    journal.isError = true;
    render(<DefinitionDetailScreen tdId="TD-BAT-114" />);

    expect(screen.getByText("Could not load the history of this definition.")).toBeInTheDocument();
  });
});

describe("the requirements panel on the definition detail screen", () => {
  it("renders the document the definition carries", () => {
    renderDetail(
      makeDetail({
        requirements_files: [
          {
            name: "acceptance-criteria.md",
            content: "# Acceptance\n\n1. The pack reaches +40 °C.",
            source: "planning",
            updated_at: "2026-08-13T07:44:00Z",
            updated_by: null,
          },
        ],
      }),
    );

    expect(screen.getByRole("heading", { name: "Requirements" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Acceptance", level: 3 })).toBeInTheDocument();
  });

  it("states that no requirements document exists yet", () => {
    renderDetail(makeDetail());

    expect(
      screen.getByText("No requirements document sits on this definition yet."),
    ).toBeInTheDocument();
  });
});
