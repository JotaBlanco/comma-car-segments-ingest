// Invalid-flag semantics (contract §B #5).
//
// reason required (422 reason_required after strip), 409 already_flagged on
// re-flag, status derives to invalid with precedence over awaiting_work_order,
// journal change entry run.invalid_flag false → true, and the flag surfaces
// in the runs list filter and the home needs_attention counts.

import { beforeEach, describe, expect, it } from "vitest";
import {
  flagInvalid,
  getDb,
  getHomeSummary,
  getRun,
  getRunJournal,
  listRuns,
  resetDb,
} from "@/lib/mock/db";
import { HERO_RUN_ID, type MockState } from "@/lib/mock/seed";
import { expectMockDbError, page } from "./utils";

const SEEDED_INVALID_RUN = "TAS-88209";
const REASON = "Coolant flow sensor drifted after cycle 14 — data unusable beyond 10:40";

let state: MockState;

beforeEach(() => {
  resetDb();
  state = getDb();
});

describe("flagging with a reason", () => {
  it("sets invalid.flagged with reason, actor and timestamp", () => {
    const updated = flagInvalid(state, HERO_RUN_ID, REASON, "e.lindqvist");
    expect(updated.invalid).toEqual({
      flagged: true,
      reason: REASON,
      actor: "e.lindqvist",
      at: expect.any(String),
    });
    expect(updated.updated_at).toBe(updated.invalid.at);
  });

  it("derives status invalid with precedence over awaiting_work_order (the amber hero)", () => {
    // TAS-88214 has no work order yet — without the flag it is awaiting_work_order.
    expect(getRun(state, HERO_RUN_ID).status).toBe("awaiting_work_order");
    const updated = flagInvalid(state, HERO_RUN_ID, REASON, "e.lindqvist");
    expect(updated.status).toBe("invalid");
    expect(getRun(state, HERO_RUN_ID).status).toBe("invalid");
  });

  it("derives status invalid with precedence over complete", () => {
    // TAS-88213 has a work order — without the flag it is complete.
    expect(getRun(state, "TAS-88213").status).toBe("complete");
    expect(flagInvalid(state, "TAS-88213", "Rig vibration spike", "e.lindqvist").status).toBe("invalid");
  });

  it("writes a run.invalid_flag journal change entry with the reason as note", () => {
    const before = getRunJournal(state, HERO_RUN_ID, undefined, page()).total;
    flagInvalid(state, HERO_RUN_ID, REASON, "e.lindqvist");
    const journal = getRunJournal(state, HERO_RUN_ID, undefined, page());
    expect(journal.total).toBe(before + 1);
    const entry = journal.items.find((j) => j.field === "run.invalid_flag");
    expect(entry).toMatchObject({
      entity_type: "run",
      entity_id: HERO_RUN_ID,
      kind: "change",
      old: "false",
      new: "true",
      source: "manual",
      actor: "e.lindqvist",
      note: REASON,
    });
  });

  it("strips surrounding whitespace from the reason", () => {
    const updated = flagInvalid(state, HERO_RUN_ID, `  ${REASON}  `, "e.lindqvist");
    expect(updated.invalid.reason).toBe(REASON);
  });

  it("falls back to actor 'unknown' when no actor is supplied", () => {
    const updated = flagInvalid(state, HERO_RUN_ID, REASON, undefined);
    expect(updated.invalid.actor).toBe("unknown");
  });

  it("returns 404 run_not_found for an unknown run", () => {
    expectMockDbError(() => flagInvalid(state, "TAS-99999", REASON, "e.lindqvist"), 404, "run_not_found");
  });
});

describe("reason validation (422 reason_required)", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank after strip", "   "],
    ["non-string", 42],
  ])("rejects a %s reason", (_label, reason) => {
    expectMockDbError(() => flagInvalid(state, HERO_RUN_ID, reason, "e.lindqvist"), 422, "reason_required");
  });

  it("leaves the run and journal untouched on a rejected flag", () => {
    const before = structuredClone(getRun(state, HERO_RUN_ID));
    expectMockDbError(() => flagInvalid(state, HERO_RUN_ID, "  ", "e.lindqvist"), 422, "reason_required");
    expect(structuredClone(getRun(state, HERO_RUN_ID))).toEqual(before);
    expect(getRun(state, HERO_RUN_ID).status).toBe("awaiting_work_order");
  });
});

describe("re-flagging (409 already_flagged)", () => {
  it("rejects a second flag on a freshly flagged run", () => {
    flagInvalid(state, HERO_RUN_ID, REASON, "e.lindqvist");
    expectMockDbError(() => flagInvalid(state, HERO_RUN_ID, "another reason", "a.bergstrom"), 409, "already_flagged");
  });

  it("rejects a flag on the seeded already-invalid run and preserves its original flag", () => {
    const before = structuredClone(getRun(state, SEEDED_INVALID_RUN).invalid);
    expectMockDbError(() => flagInvalid(state, SEEDED_INVALID_RUN, "new reason", "someone"), 409, "already_flagged");
    expect(getRun(state, SEEDED_INVALID_RUN).invalid).toEqual(before);
  });
});

describe("flag visibility in lists and counts", () => {
  it("makes the flagged run appear under the status=invalid filter", () => {
    const beforeIds = listRuns(state, { status: ["invalid"] }, page()).items.map((r) => r.run_id);
    expect(beforeIds).toEqual([SEEDED_INVALID_RUN]);
    flagInvalid(state, HERO_RUN_ID, REASON, "e.lindqvist");
    const after = listRuns(state, { status: ["invalid"] }, page());
    expect(after.total).toBe(2);
    expect(after.items.map((r) => r.run_id)).toEqual(
      expect.arrayContaining([HERO_RUN_ID, SEEDED_INVALID_RUN]),
    );
    // …and disappear from the awaiting_work_order filter it previously matched.
    expect(listRuns(state, { status: ["awaiting_work_order"] }, page()).total).toBe(0);
  });

  it("bumps home needs_attention.invalid_runs and drops awaiting_work_order", () => {
    expect(getHomeSummary(state).needs_attention).toEqual({
      awaiting_work_order: 1,
      quarantined_files: 2,
      invalid_runs: 1,
      orphaned_definitions: 1, // TD-INV-081
    });
    flagInvalid(state, HERO_RUN_ID, REASON, "e.lindqvist");
    expect(getHomeSummary(state).needs_attention).toEqual({
      awaiting_work_order: 0,
      quarantined_files: 2,
      invalid_runs: 2,
      orphaned_definitions: 1, // TD-INV-081
    });
  });
});
