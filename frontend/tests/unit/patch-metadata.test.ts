// Manual metadata edits (contract §B #4 PATCH /test-runs/{run_id} and
// #17 PATCH /signals/{name}).
//
// Per changed field: value set, field_sources.<field> = {source:"manual",
// actor, at}, journal change entry with old/new display strings. Unchanged
// fields are skipped (no journal noise). Empty body → 400 no_fields_to_update.

import { beforeEach, describe, expect, it, test } from "vitest";
import {
  getDb,
  getRun,
  getRunJournal,
  getSignal,
  listSignals,
  patchRun,
  patchSignal,
  resetDb,
} from "@/lib/mock/db";
import { HERO_RUN_ID, SYNC_WO_ID, type MockState } from "@/lib/mock/seed";
import type { RunPatchBody } from "@/types";
import { expectMockDbError, page } from "./utils";

// TAS-88213: operator is null (renders "(empty)" as journal old), description set.
const RUN_ID = "TAS-88213";
// EM_Shaft_Torque: unit null / unit_source null — the catalog missing-unit case.
const MISSING_UNIT_SIGNAL = "EM_Shaft_Torque";

let state: MockState;

beforeEach(() => {
  resetDb();
  state = getDb();
});

describe("patchRun", () => {
  it("updates the field and records field_sources[field] = manual with actor and at", () => {
    const updated = patchRun(state, RUN_ID, { operator: "S. Vidal", actor: "s.vidal" });
    expect(updated.operator).toBe("S. Vidal");
    expect(updated.field_sources.operator).toEqual({
      source: "manual",
      actor: "s.vidal",
      at: expect.any(String),
    });
    expect(updated.updated_at).toBe(updated.field_sources.operator.at);
  });

  it("writes a journal change entry with old '(empty)' for a previously null field", () => {
    patchRun(state, RUN_ID, { operator: "S. Vidal", actor: "s.vidal", note: "set from shift roster" });
    const entry = getRunJournal(state, RUN_ID, undefined, page()).items.find(
      (j) => j.field === "run.operator",
    );
    expect(entry).toMatchObject({
      entity_type: "run",
      entity_id: RUN_ID,
      kind: "change",
      old: "(empty)",
      new: "S. Vidal",
      source: "manual",
      actor: "s.vidal",
      note: "set from shift roster",
    });
  });

  it("writes the previous value as journal old when the field already had one", () => {
    const previous = getRun(state, RUN_ID).description;
    patchRun(state, RUN_ID, { description: "E-machine efficiency map — rerun", actor: "s.vidal" });
    const entry = getRunJournal(state, RUN_ID, undefined, page()).items.find(
      (j) => j.field === "run.description",
    );
    expect(entry).toMatchObject({ old: previous, new: "E-machine efficiency map — rerun" });
  });

  it("patches multiple fields in one call with one journal entry per field", () => {
    const before = getRunJournal(state, RUN_ID, undefined, page()).total;
    const updated = patchRun(state, RUN_ID, {
      operator: "S. Vidal",
      bench_sw: "TAS 7.4.3 · fw 2.12",
      actor: "s.vidal",
    });
    expect(updated.operator).toBe("S. Vidal");
    expect(updated.bench_sw).toBe("TAS 7.4.3 · fw 2.12");
    expect(getRunJournal(state, RUN_ID, undefined, page()).total).toBe(before + 2);
  });

  it("skips unchanged fields — no journal noise, no field_sources overwrite", () => {
    const run = getRun(state, RUN_ID);
    const before = structuredClone(run);
    const updated = patchRun(state, RUN_ID, {
      description: run.description ?? undefined, // identical value
      actor: "s.vidal",
    });
    expect(structuredClone(updated)).toEqual(before);
    expect(getRunJournal(state, RUN_ID, undefined, page()).total).toBe(before.journal_count);
  });

  it("treats null field values as not provided (only strings are patchable)", () => {
    // The contract offers no null-to-clear semantics on #4 — a body whose only
    // candidate fields are null carries nothing to update.
    expectMockDbError(
      () => patchRun(state, RUN_ID, { operator: null, actor: "s.vidal" } as never),
      400,
      "no_fields_to_update",
    );
    expect(getRun(state, RUN_ID).operator).toBeNull();
  });

  it("rejects an empty body with 400 no_fields_to_update", () => {
    expectMockDbError(() => patchRun(state, RUN_ID, { actor: "s.vidal" }), 400, "no_fields_to_update");
  });

  it("rejects a missing or blank actor with 422 validation_error", () => {
    expectMockDbError(
      () => patchRun(state, RUN_ID, { operator: "S. Vidal" } as never),
      422,
      "validation_error",
    );
    expectMockDbError(
      () => patchRun(state, RUN_ID, { operator: "S. Vidal", actor: "  " }),
      422,
      "validation_error",
    );
  });

  it("returns 404 run_not_found for an unknown run", () => {
    expectMockDbError(
      () => patchRun(state, "TAS-99999", { operator: "X", actor: "s.vidal" }),
      404,
      "run_not_found",
    );
  });

  // Contract §A (v1.1): "write bodies reject unknown fields with 422 naming the
  // field (Pydantic extra='forbid' on every request model)". The mock silently
  // ignores unknown fields and answers 400 no_fields_to_update instead.
  // Executable TODO: align the mock with the contract, then drop .fails.
  test.fails("rejects a body containing only unknown fields with 422 (contract §A v1.1, extra=forbid)", () => {
    expectMockDbError(
      () => patchRun(state, RUN_ID, { rig_id: "RIG-99", actor: "s.vidal" } as never),
      422,
      "validation_error",
    );
  });
});

describe("patchSignal", () => {
  it("sets the unit on a missing-unit signal with unit_source manual", () => {
    const before = getSignal(state, MISSING_UNIT_SIGNAL);
    expect(before.unit).toBeNull();
    expect(before.unit_source).toBeNull();

    const updated = patchSignal(state, MISSING_UNIT_SIGNAL, {
      unit: "Nm",
      actor: "a.bergstrom",
      note: "Unit absent from file header — set from rig sensor sheet.",
    });
    expect(updated.unit).toBe("Nm");
    expect(updated.unit_source).toBe("manual");
    expect(updated.field_sources.unit).toEqual({
      source: "manual",
      actor: "a.bergstrom",
      at: expect.any(String),
    });
  });

  it("writes a journal change entry with field signal.<name>.unit and old '(missing)'", () => {
    patchSignal(state, MISSING_UNIT_SIGNAL, { unit: "Nm", actor: "a.bergstrom" });
    const entry = state.journal.find((j) => j.field === `signal.${MISSING_UNIT_SIGNAL}.unit`);
    expect(entry).toMatchObject({
      entity_type: "signal",
      entity_id: MISSING_UNIT_SIGNAL,
      kind: "change",
      old: "(missing)",
      new: "Nm",
      source: "manual",
      actor: "a.bergstrom",
    });
  });

  it("is visible in signal detail and stops matching the catalog missing_unit filter", () => {
    const namesBefore = listSignals(state, { missing_unit: true }, page()).items.map((s) => s.name);
    expect(namesBefore).toContain(MISSING_UNIT_SIGNAL);

    patchSignal(state, MISSING_UNIT_SIGNAL, { unit: "Nm", actor: "a.bergstrom" });

    expect(getSignal(state, MISSING_UNIT_SIGNAL).unit).toBe("Nm");
    const after = listSignals(state, { missing_unit: true }, page());
    expect(after.items.map((s) => s.name)).not.toContain(MISSING_UNIT_SIGNAL);
    expect(after.total).toBe(namesBefore.length - 1);
    // …and now matches the unit filter instead.
    expect(listSignals(state, { unit: ["Nm"] }, page()).items.map((s) => s.name)).toEqual([
      MISSING_UNIT_SIGNAL,
    ]);
  });

  it("surfaces a context_run_id edit in that run's journal (contract §8)", () => {
    const before = getRunJournal(state, HERO_RUN_ID, undefined, page()).total;
    patchSignal(state, "Chamber_Humidity", {
      unit: "%RH",
      actor: "a.bergstrom",
      context_run_id: HERO_RUN_ID,
    });
    const journal = getRunJournal(state, HERO_RUN_ID, undefined, page());
    expect(journal.total).toBe(before + 1);
    const entry = journal.items.find((j) => j.field === "signal.Chamber_Humidity.unit");
    expect(entry).toBeDefined();
    // The wire shape stays canonical — context attribution is server-internal.
    expect(entry).not.toHaveProperty("context_run_id");
  });

  it("rejects an unknown context_run_id with 404 run_not_found", () => {
    expectMockDbError(
      () =>
        patchSignal(state, "Chamber_Humidity", {
          unit: "%RH",
          actor: "a.bergstrom",
          context_run_id: "TAS-99999",
        }),
      404,
      "run_not_found",
    );
  });

  it("does not change unit_source when patching description only", () => {
    const updated = patchSignal(state, "HV_Batt_Cell_Temp_Max", {
      description: "Hottest cell temperature across the pack",
      actor: "a.bergstrom",
    });
    expect(updated.unit_source).toBe("embedded");
    expect(updated.field_sources.description).toEqual({
      source: "manual",
      actor: "a.bergstrom",
      at: expect.any(String),
    });
  });

  it("rejects an empty body with 400 and a missing actor with 422", () => {
    expectMockDbError(
      () => patchSignal(state, MISSING_UNIT_SIGNAL, { actor: "a.bergstrom" }),
      400,
      "no_fields_to_update",
    );
    expectMockDbError(
      () => patchSignal(state, MISSING_UNIT_SIGNAL, { unit: "Nm" } as never),
      422,
      "validation_error",
    );
  });

  it("returns 404 signal_not_found for an unknown signal", () => {
    expectMockDbError(
      () => patchSignal(state, "No_Such_Signal", { unit: "Nm", actor: "a.bergstrom" }),
      404,
      "signal_not_found",
    );
  });
});

// The two link fields joined `_PATCHABLE_FIELDS` on 19 Aug 2026 (commit
// 6cba5e4, contract §B #4). A stated id must name a mirrored row.
describe("RunPatchBody carries the two link fields", () => {
  it("takes work_order_id and definition_id", () => {
    // `satisfies` is the proof. `tsc --noEmit` fails this file when the type
    // drops either key, because an object literal refuses an excess property.
    const body = {
      work_order_id: "WO-2026-0847",
      definition_id: "TD-EM-201",
      actor: "s.vidal",
    } satisfies RunPatchBody;
    expect(Object.keys(body).sort()).toEqual(["actor", "definition_id", "work_order_id"]);
  });

  it("takes neither project nor test_cell — no route patches them", () => {
    // `project` follows the work order and `test_cell` is embedded identity.
    // Each @ts-expect-error fails typecheck if somebody widens the type.
    // @ts-expect-error project is not patchable
    const withProject: RunPatchBody = { project: "EX90", actor: "s.vidal" };
    // @ts-expect-error test_cell is not patchable
    const withCell: RunPatchBody = { test_cell: "TC-2", actor: "s.vidal" };
    expect([withProject.actor, withCell.actor]).toEqual(["s.vidal", "s.vidal"]);
  });
});

describe("patchRun links a run by hand", () => {
  it("stores the work order, copies the project from the mirror and tags both manual", () => {
    const updated = patchRun(state, HERO_RUN_ID, {
      work_order_id: "WO-2026-0847",
      actor: "s.vidal",
    });
    expect(updated.work_order_id).toBe("WO-2026-0847");
    expect(updated.project).toBe("EX90");
    expect(updated.field_sources.work_order_id).toMatchObject({ source: "manual", actor: "s.vidal" });
    expect(updated.field_sources.project).toMatchObject({ source: "manual", actor: "s.vidal" });
  });

  it("flips the run out of the awaiting_work_order state", () => {
    expect(getRun(state, HERO_RUN_ID).status).toBe("awaiting_work_order");
    const updated = patchRun(state, HERO_RUN_ID, {
      work_order_id: "WO-2026-0847",
      actor: "s.vidal",
    });
    expect(updated.status).toBe("complete");
  });

  it("journals the link and the project it derived", () => {
    patchRun(state, HERO_RUN_ID, { work_order_id: "WO-2026-0847", actor: "s.vidal" });
    const fields = getRunJournal(state, HERO_RUN_ID, undefined, page()).items.map((j) => j.field);
    expect(fields).toContain("run.work_order_id");
    expect(fields).toContain("run.project");
  });

  it("stores a definition that names a mirrored row", () => {
    const updated = patchRun(state, HERO_RUN_ID, { definition_id: "TD-EM-201", actor: "s.vidal" });
    expect(updated.definition_id).toBe("TD-EM-201");
    expect(updated.field_sources.definition_id).toMatchObject({ source: "manual" });
  });

  it("answers 422 unknown_work_order for an id the mirror does not hold", () => {
    expectMockDbError(
      () => patchRun(state, HERO_RUN_ID, { work_order_id: "WO-9999", actor: "s.vidal" }),
      422,
      "unknown_work_order",
    );
    expect(getRun(state, HERO_RUN_ID).work_order_id).toBeNull();
  });

  it("answers 422 unknown_work_order for a work order planning has not mirrored yet", () => {
    // SYNC_WO_ID exists only in the planning system until a sync pass runs.
    expectMockDbError(
      () => patchRun(state, HERO_RUN_ID, { work_order_id: SYNC_WO_ID, actor: "s.vidal" }),
      422,
      "unknown_work_order",
    );
  });

  it("answers 422 unknown_definition for a definition the mirror does not hold", () => {
    expectMockDbError(
      () => patchRun(state, HERO_RUN_ID, { definition_id: "TD-9999", actor: "s.vidal" }),
      422,
      "unknown_definition",
    );
    expect(getRun(state, HERO_RUN_ID).definition_id).toBeNull();
  });
});
