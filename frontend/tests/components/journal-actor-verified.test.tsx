import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IngestionTimeline } from "@/components/screens/files/ingestion-timeline";
import { JournalTimeline } from "@/components/shared/journal-timeline";
import type { JournalEntry } from "@/types";

const VERIFIED_LABEL = "Verified by the Quix platform";

let sequence = 0;
function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  sequence += 1;
  return {
    id: `J-${sequence}`,
    entity_type: "run",
    entity_id: "RUN-1",
    field: "run.registered",
    kind: "event",
    old: null,
    new: null,
    source: "embedded",
    actor: "ingestion",
    actor_id: null,
    note: null,
    at: "2026-08-14T09:41:33Z",
    ...overrides,
  };
}

describe("JournalTimeline actor verification", () => {
  it("marks the actor when actor_id names a verified platform user", () => {
    render(
      <JournalTimeline
        entries={[makeEntry({ source: "manual", actor: "a.bergstrom", actor_id: "usr-42" })]}
      />
    );
    expect(screen.getByRole("img", { name: VERIFIED_LABEL })).toBeInTheDocument();
  });

  it("keeps the actor name and the time beside the mark", () => {
    render(
      <JournalTimeline
        entries={[makeEntry({ source: "manual", actor: "a.bergstrom", actor_id: "usr-42" })]}
      />
    );
    expect(screen.getByText(/a\.bergstrom ·/)).toBeInTheDocument();
  });

  it("shows no mark when actor_id is null", () => {
    render(<JournalTimeline entries={[makeEntry({ actor: "ingestion", actor_id: null })]} />);
    expect(screen.queryByRole("img", { name: VERIFIED_LABEL })).not.toBeInTheDocument();
    expect(screen.getByText(/ingestion ·/)).toBeInTheDocument();
  });

  // The OpenAPI snapshot lists actor_id as optional, so an older API can omit the key.
  it("shows no mark when the API omits actor_id", () => {
    const entry = makeEntry({ actor: "ingestion" });
    delete (entry as Partial<JournalEntry>).actor_id;
    render(<JournalTimeline entries={[entry]} />);
    expect(screen.queryByRole("img", { name: VERIFIED_LABEL })).not.toBeInTheDocument();
    expect(screen.getByText(/ingestion ·/)).toBeInTheDocument();
  });
});

describe("IngestionTimeline actor verification", () => {
  it("marks the actor when actor_id names a verified platform user", () => {
    render(
      <IngestionTimeline
        entries={[
          makeEntry({
            entity_type: "file",
            field: "file.detected",
            source: "manual",
            actor: "e.lindqvist",
            actor_id: "usr-7",
          }),
        ]}
      />
    );
    expect(screen.getByRole("img", { name: VERIFIED_LABEL })).toBeInTheDocument();
    expect(screen.getByText(/e\.lindqvist ·/)).toBeInTheDocument();
  });

  it("shows no mark when actor_id is null", () => {
    render(
      <IngestionTimeline
        entries={[makeEntry({ entity_type: "file", field: "file.detected", actor_id: null })]}
      />
    );
    expect(screen.queryByRole("img", { name: VERIFIED_LABEL })).not.toBeInTheDocument();
    expect(screen.getByText(/ingestion ·/)).toBeInTheDocument();
  });
});
