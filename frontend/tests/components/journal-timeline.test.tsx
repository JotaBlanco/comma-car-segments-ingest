import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { JournalTimeline } from "@/components/shared/journal-timeline";
import type { JournalEntry } from "@/types";

let sequence = 0;
function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  sequence += 1;
  return {
    id: `J-${sequence}`,
    entity_type: "run",
    entity_id: "RUN-1",
    field: null,
    kind: "event",
    old: null,
    new: null,
    source: "embedded",
    actor: "system",
    actor_id: null,
    note: null,
    at: "2026-08-10T09:30:00Z",
    ...overrides,
  };
}

function entryRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(":scope > div > div"));
}

describe("JournalTimeline", () => {
  it("renders the empty state for an empty entry list", () => {
    render(<JournalTimeline entries={[]} />);
    expect(screen.getByText("No journal entries")).toBeInTheDocument();
    expect(screen.getByText("Changes and events will appear here.")).toBeInTheDocument();
  });

  it("styles the timeline dot per source kind", () => {
    const { container } = render(
      <JournalTimeline
        entries={[
          makeEntry({ source: "manual", actor: "j.smith" }),
          makeEntry({ source: "api:planning", actor: "planning-sync" }),
          makeEntry({ source: "embedded", actor: "system" }),
        ]}
      />
    );
    const dots = Array.from(container.querySelectorAll(".rounded-full"));
    expect(dots).toHaveLength(3);
    expect(dots[0]).toHaveClass("bg-amber-bg", "text-amber");
    expect(dots[1]).toHaveClass("bg-accent-soft", "text-primary");
    expect(dots[2]).toHaveClass("bg-surface-2", "text-ink-3");
  });

  it("renders the field name in mono text alongside the source badge and actor", () => {
    render(
      <JournalTimeline
        entries={[makeEntry({ kind: "change", field: "work_order_id", source: "api:planning", actor: "planning-sync" })]}
      />
    );
    const field = screen.getByText("work_order_id");
    expect(field).toHaveClass("font-mono");
    expect(screen.getByText("api:planning")).toBeInTheDocument();
    expect(screen.getByText(/planning-sync ·/)).toBeInTheDocument();
  });

  it("renders old→new diff pills when both values are present on a change", () => {
    render(
      <JournalTimeline
        entries={[makeEntry({ kind: "change", field: "status", old: "awaiting_work_order", new: "complete" })]}
      />
    );
    const oldPill = screen.getByText("awaiting_work_order");
    const newPill = screen.getByText("complete");
    expect(oldPill).toHaveClass("bg-red-bg", "line-through");
    expect(newPill).toHaveClass("bg-green-bg");
    expect(screen.getByText("→")).toBeInTheDocument();
  });

  // BUG?: the spec says diff pills should appear "only when both present", but the
  // component renders them whenever EITHER old or new is non-null on a change,
  // substituting "(empty)" for the missing side. Testing current behavior.
  it("renders an '(empty)' pill when only one side of a change is present", () => {
    render(<JournalTimeline entries={[makeEntry({ kind: "change", field: "rig_id", old: null, new: "RIG-04" })]} />);
    expect(screen.getByText("(empty)")).toHaveClass("bg-red-bg");
    expect(screen.getByText("RIG-04")).toHaveClass("bg-green-bg");
  });

  it("does not render diff pills for non-change entries", () => {
    render(<JournalTimeline entries={[makeEntry({ kind: "event", field: "status" })]} />);
    expect(screen.queryByText("→")).not.toBeInTheDocument();
    expect(screen.queryByText("(empty)")).not.toBeInTheDocument();
  });

  it("renders the note when present", () => {
    render(
      <JournalTimeline
        entries={[makeEntry({ kind: "note", source: "manual", actor: "j.smith", note: "Sensor drift observed on channel 3." })]}
      />
    );
    expect(screen.getByText("Sensor drift observed on channel 3.")).toBeInTheDocument();
  });

  it("preserves entry ordering as given", () => {
    const { container } = render(
      <JournalTimeline
        entries={[
          makeEntry({ kind: "change", field: "first_field", new: "a" }),
          makeEntry({ kind: "change", field: "second_field", new: "b" }),
          makeEntry({ kind: "change", field: "third_field", new: "c" }),
        ]}
      />
    );
    const rows = entryRows(container);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("first_field")).toBeInTheDocument();
    expect(within(rows[1]).getByText("second_field")).toBeInTheDocument();
    expect(within(rows[2]).getByText("third_field")).toBeInTheDocument();
  });
});
