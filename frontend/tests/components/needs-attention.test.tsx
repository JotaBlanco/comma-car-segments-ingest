import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MouseEvent, ReactNode } from "react";
import { NeedsAttentionPanel } from "@/components/screens/home/needs-attention-panel";
import type { AttentionRows, NeedsAttention } from "@/types";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

// The rows navigate via next/link; stub it so a click drives the router push spy.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a
      href={href}
      className={className}
      onClick={(event: MouseEvent) => {
        event.preventDefault();
        push(href);
      }}
    >
      {children}
    </a>
  ),
}));

function renderPanel(
  attention: NeedsAttention | undefined,
  extra?: { isPending?: boolean; isError?: boolean; rows?: AttentionRows }
) {
  return render(
    <NeedsAttentionPanel
      attention={attention}
      rows={extra?.rows}
      isPending={extra?.isPending ?? false}
      isError={extra?.isError ?? false}
      onRetry={vi.fn()}
    />
  );
}

/** One named entity per category — the payload the API sends since 26 Aug. */
const NAMED_ROWS: AttentionRows = {
  awaiting_work_order: [{ run_id: "TAS-88214", rig_id: "RIG-04", reason: null }],
  quarantined_files: [
    {
      file_id: "f-9a41c2d0",
      filename: "rig04_20260824_113512.tdms",
      quarantine_reason: "Checksum mismatch",
    },
  ],
  invalid_runs: [{ run_id: "TAS-88209", rig_id: "RIG-01", reason: "Sensor drift on channel 3" }],
  orphaned_definitions: [{ td_id: "TD-EM-900", title: "Coastdown" }],
};

describe("NeedsAttentionPanel", () => {
  beforeEach(() => {
    push.mockClear();
  });

  it("hides rows whose count is zero", () => {
    renderPanel({ awaiting_work_order: 2, quarantined_files: 0, invalid_runs: 1, orphaned_definitions: 0 });
    expect(screen.getByText("Runs awaiting work order")).toBeInTheDocument();
    expect(screen.getByText("Invalid-flagged runs")).toBeInTheDocument();
    expect(screen.queryByText("Quarantined files")).not.toBeInTheDocument();
  });

  it("renders 'Nothing needs attention.' when every count is zero", () => {
    renderPanel({ awaiting_work_order: 0, quarantined_files: 0, invalid_runs: 0, orphaned_definitions: 0 });
    expect(screen.getByText("Nothing needs attention.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("0 items")).toBeInTheDocument();
  });

  it("displays each row's count and the total in the panel head", () => {
    renderPanel({ awaiting_work_order: 4, quarantined_files: 2, invalid_runs: 1, orphaned_definitions: 0 });
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("7 items")).toBeInTheDocument();
  });

  it("uses the singular 'item' for a total of one", () => {
    renderPanel({ awaiting_work_order: 1, quarantined_files: 0, invalid_runs: 0, orphaned_definitions: 0 });
    expect(screen.getByText("1 item")).toBeInTheDocument();
  });

  it("navigates to the filtered runs list when clicking 'Runs awaiting work order'", async () => {
    const user = userEvent.setup();
    renderPanel({ awaiting_work_order: 3, quarantined_files: 1, invalid_runs: 1, orphaned_definitions: 0 });
    await user.click(screen.getByRole("link", { name: /Runs awaiting work order/ }));
    expect(push).toHaveBeenCalledWith("/runs?status=awaiting_work_order");
  });

  it("navigates to the filtered files list when clicking 'Quarantined files'", async () => {
    const user = userEvent.setup();
    renderPanel({ awaiting_work_order: 0, quarantined_files: 5, invalid_runs: 0, orphaned_definitions: 0 });
    await user.click(screen.getByRole("link", { name: /Quarantined files/ }));
    expect(push).toHaveBeenCalledWith("/files?status=quarantined");
  });

  it("navigates to the invalid runs list when clicking 'Invalid-flagged runs'", async () => {
    const user = userEvent.setup();
    renderPanel({ awaiting_work_order: 0, quarantined_files: 0, invalid_runs: 2, orphaned_definitions: 0 });
    await user.click(screen.getByRole("link", { name: /Invalid-flagged runs/ }));
    expect(push).toHaveBeenCalledWith("/runs?status=invalid");
  });

  it("shows the orphaned test definitions row with its count", () => {
    renderPanel({ awaiting_work_order: 0, quarantined_files: 0, invalid_runs: 0, orphaned_definitions: 3 });
    expect(screen.getByText("Orphaned test definitions")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("hides the orphaned test definitions row when the count is zero", () => {
    renderPanel({ awaiting_work_order: 2, quarantined_files: 0, invalid_runs: 0, orphaned_definitions: 0 });
    expect(screen.queryByText("Orphaned test definitions")).not.toBeInTheDocument();
  });

  it("counts the orphaned test definitions in the panel total", () => {
    renderPanel({ awaiting_work_order: 4, quarantined_files: 2, invalid_runs: 1, orphaned_definitions: 3 });
    expect(screen.getByText("10 items")).toBeInTheDocument();
  });

  it("navigates to the orphaned definitions list when clicking 'Orphaned test definitions'", async () => {
    const user = userEvent.setup();
    renderPanel({ awaiting_work_order: 0, quarantined_files: 0, invalid_runs: 0, orphaned_definitions: 2 });
    await user.click(screen.getByRole("link", { name: /Orphaned test definitions/ }));
    expect(push).toHaveBeenCalledWith("/definitions?orphaned=true");
  });

  it("names the entities under each category and links each to its screen", () => {
    renderPanel(
      { awaiting_work_order: 1, quarantined_files: 1, invalid_runs: 1, orphaned_definitions: 1 },
      { rows: NAMED_ROWS }
    );

    // The awaiting run: id plus its rig, linking to the run.
    expect(screen.getByRole("link", { name: /^TAS-88214/ })).toHaveAttribute(
      "href",
      "/runs/TAS-88214"
    );
    expect(screen.getByText("RIG-04")).toBeInTheDocument();

    // The quarantined file: named by its filename, linking to the file,
    // with the reason a person can act on.
    expect(screen.getByRole("link", { name: /rig04_20260824_113512\.tdms/ })).toHaveAttribute(
      "href",
      "/files/f-9a41c2d0"
    );
    expect(screen.getByText("Checksum mismatch")).toBeInTheDocument();

    // The invalid run: id plus the engineer's reason, linking to the run.
    expect(screen.getByRole("link", { name: /^TAS-88209/ })).toHaveAttribute(
      "href",
      "/runs/TAS-88209"
    );
    expect(screen.getByText("Sensor drift on channel 3")).toBeInTheDocument();

    // The orphaned definition: id plus title, linking to the definition.
    expect(screen.getByRole("link", { name: /^TD-EM-900/ })).toHaveAttribute(
      "href",
      "/definitions/TD-EM-900"
    );
  });

  it("navigates to the entity when a person clicks a named row", async () => {
    const user = userEvent.setup();
    renderPanel(
      { awaiting_work_order: 0, quarantined_files: 0, invalid_runs: 1, orphaned_definitions: 0 },
      { rows: { ...NAMED_ROWS, awaiting_work_order: [], quarantined_files: [], orphaned_definitions: [] } }
    );

    await user.click(screen.getByRole("link", { name: /^TAS-88209/ }));

    expect(push).toHaveBeenCalledWith("/runs/TAS-88209");
  });

  it("says how many rows the cap holds back, and keeps the count the true total", () => {
    // The API sent three rows and the true count of five. The head shows 5,
    // three rows print, and the line says two are hidden.
    renderPanel(
      { awaiting_work_order: 5, quarantined_files: 0, invalid_runs: 0, orphaned_definitions: 0 },
      {
        rows: {
          awaiting_work_order: [
            { run_id: "TAS-1", rig_id: "RIG-01", reason: null },
            { run_id: "TAS-2", rig_id: "RIG-02", reason: null },
            { run_id: "TAS-3", rig_id: "RIG-03", reason: null },
          ],
          quarantined_files: [],
          invalid_runs: [],
          orphaned_definitions: [],
        },
      }
    );

    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^TAS-1/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^TAS-3/ })).toBeInTheDocument();
    const more = screen.getByRole("link", { name: "2 more — view all" });
    expect(more).toHaveAttribute("href", "/runs?status=awaiting_work_order");
  });

  it("caps a longer list at three rows even if the API sends more", () => {
    renderPanel(
      { awaiting_work_order: 5, quarantined_files: 0, invalid_runs: 0, orphaned_definitions: 0 },
      {
        rows: {
          awaiting_work_order: [1, 2, 3, 4, 5].map((n) => ({
            run_id: `TAS-${n}`,
            rig_id: null,
            reason: null,
          })),
          quarantined_files: [],
          invalid_runs: [],
          orphaned_definitions: [],
        },
      }
    );

    expect(screen.queryByRole("link", { name: /^TAS-4$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "2 more — view all" })).toBeInTheDocument();
  });

  it("shows no hidden-count line when every row is on screen", () => {
    renderPanel(
      { awaiting_work_order: 1, quarantined_files: 0, invalid_runs: 0, orphaned_definitions: 0 },
      {
        rows: {
          awaiting_work_order: [{ run_id: "TAS-88214", rig_id: null, reason: null }],
          quarantined_files: [],
          invalid_runs: [],
          orphaned_definitions: [],
        },
      }
    );

    expect(screen.queryByText(/more — view all/)).not.toBeInTheDocument();
  });

  it("shows the counts alone when the API sends no rows", () => {
    // An API older than 26 Aug 2026 sends counts only. The panel keeps
    // today's look: the category line, the count, and no row or hidden line.
    renderPanel({ awaiting_work_order: 2, quarantined_files: 0, invalid_runs: 0, orphaned_definitions: 0 });

    expect(screen.getByText("Runs awaiting work order")).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByText(/more — view all/)).not.toBeInTheDocument();
  });

  it("keeps the empty state when every count is zero, rows present or not", () => {
    renderPanel(
      { awaiting_work_order: 0, quarantined_files: 0, invalid_runs: 0, orphaned_definitions: 0 },
      {
        rows: {
          awaiting_work_order: [],
          quarantined_files: [],
          invalid_runs: [],
          orphaned_definitions: [],
        },
      }
    );

    expect(screen.getByText("Nothing needs attention.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders no rows or empty state while data is undefined", () => {
    renderPanel(undefined, { isPending: true });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing needs attention.")).not.toBeInTheDocument();
  });
});
