// Planning-sync toggle semantics (contract §B #20/#21).
//
// Toggle ON runs a real sync pass: WO-2026-0851 (+ its definitions) become
// mirrored, TAS-88214 is backfilled with source api:planning, one journal
// entry is appended, status re-derives to complete.
// Toggle OFF only stops the sync. A registry never un-remembers, so every
// mirrored row, every backfilled field and every journal entry stays.
// Toggling to the current state is a no-op 200.
//
// These tests double as the backend team's acceptance spec for the real
// FastAPI implementation of #21.

import { beforeEach, describe, expect, it } from "vitest";
import {
  getDb,
  getRun,
  getRunJournal,
  getSyncStatus,
  getWorkOrder,
  listRuns,
  listWorkOrders,
  resetDb,
  toggleSync,
} from "@/lib/mock/db";
import {
  HERO_RUN_ID,
  SYNC_PROJECT,
  SYNC_TD_ID,
  SYNC_WO_ID,
  WORK_ORDERS_MIRRORED,
  type MockState,
} from "@/lib/mock/seed";
import { expectMockDbError, page } from "./utils";

let state: MockState;

beforeEach(() => {
  resetDb();
  state = getDb();
});

/** Everything the sync pass touches, deep-cloned for byte-parity checks. */
function affectedSnapshot(current: MockState) {
  return structuredClone({
    heroRun: getRun(current, HERO_RUN_ID),
    workOrders: listWorkOrders(current, {}, page()),
    heroJournal: getRunJournal(current, HERO_RUN_ID, undefined, page()),
    syncStatus: getSyncStatus(current),
  });
}

describe("toggle ON (sync pass)", () => {
  it("starts offline with WO-2026-0851 hidden and TAS-88214 awaiting_work_order", () => {
    expect(getSyncStatus(state)).toEqual({
      online: false,
      last_sync_at: null,
      last_sync_result: null,
      work_orders_mirrored: WORK_ORDERS_MIRRORED,
    });
    const woIds = listWorkOrders(state, {}, page()).items.map((w) => w.wo_id);
    expect(woIds).not.toContain(SYNC_WO_ID);
    expectMockDbError(() => getWorkOrder(state, SYNC_WO_ID), 404, "wo_not_found");
    const hero = getRun(state, HERO_RUN_ID);
    expect(hero.status).toBe("awaiting_work_order");
    expect(hero.work_order_id).toBeNull();
    expect(hero.definition_id).toBeNull();
    expect(hero.project).toBeNull();
  });

  it("mirrors WO-2026-0851 into the work-order list and detail", () => {
    toggleSync(state, true);
    const list = listWorkOrders(state, {}, page());
    const mirrored = list.items.find((w) => w.wo_id === SYNC_WO_ID);
    expect(mirrored).toBeDefined();
    expect(mirrored).toMatchObject({
      title: "HV battery thermal validation — winter cycle",
      project: SYNC_PROJECT,
      status: "active",
      definition_count: 2,
      run_count: 1, // the backfilled hero run
    });

    const detail = getWorkOrder(state, SYNC_WO_ID);
    expect(detail.runs.map((r) => r.run_id)).toEqual([HERO_RUN_ID]);
    expect(detail.definitions).toEqual([
      expect.objectContaining({ td_id: SYNC_TD_ID, planned_runs: 4, actual_runs: 1, status: "awaiting_data" }),
      expect.objectContaining({ td_id: "TD-BAT-118", planned_runs: 2, actual_runs: 0, status: "awaiting_data" }),
    ]);
  });

  it("backfills TAS-88214 work_order_id/definition_id/project with field_sources api:planning", () => {
    toggleSync(state, true);
    const hero = getRun(state, HERO_RUN_ID);
    expect(hero.work_order_id).toBe(SYNC_WO_ID);
    expect(hero.definition_id).toBe(SYNC_TD_ID);
    expect(hero.project).toBe(SYNC_PROJECT);
    for (const field of ["work_order_id", "definition_id", "project"] as const) {
      expect(hero.field_sources[field]).toEqual({
        source: "api:planning",
        actor: "planning-sync",
        at: expect.any(String),
      });
    }
  });

  it("re-derives TAS-88214 status to complete (the amber → green beat)", () => {
    toggleSync(state, true);
    expect(getRun(state, HERO_RUN_ID).status).toBe("complete");
    // The list view agrees: nothing is left awaiting a work order.
    expect(listRuns(state, { status: ["awaiting_work_order"] }, page()).total).toBe(0);
    const listed = listRuns(state, {}, page()).items.find((r) => r.run_id === HERO_RUN_ID);
    expect(listed?.status).toBe("complete");
  });

  it("appends a run.work_order journal change entry with source api:planning", () => {
    const before = getRunJournal(state, HERO_RUN_ID, undefined, page());
    toggleSync(state, true);
    const after = getRunJournal(state, HERO_RUN_ID, undefined, page());
    expect(after.total).toBe(before.total + 1);
    const entry = after.items.find((j) => j.field === "run.work_order");
    expect(entry).toMatchObject({
      entity_type: "run",
      entity_id: HERO_RUN_ID,
      kind: "change",
      old: "(empty)",
      new: SYNC_WO_ID,
      source: "api:planning",
      actor: "planning-sync",
    });
    // Internal bookkeeping never leaks onto the wire shape.
    expect(entry).not.toHaveProperty("sync_generated");
    expect(entry).not.toHaveProperty("context_run_id");
  });

  it("reports status online with last_sync_result counts", () => {
    const response = toggleSync(state, true);
    expect(response.online).toBe(true);
    expect(response.last_sync_at).toEqual(expect.any(String));
    expect(response.last_sync_result).toEqual({
      work_orders: 5,
      // 7 since the seed carries an orphan definition (TR-001).
      definitions: 7,
      runs_backfilled: 1,
    });
    expect(response.work_orders_mirrored).toBe(WORK_ORDERS_MIRRORED);
    // GET /planning-sync/status agrees with the toggle response.
    expect(getSyncStatus(state)).toEqual({
      online: true,
      last_sync_at: response.last_sync_at,
      last_sync_result: response.last_sync_result,
      work_orders_mirrored: WORK_ORDERS_MIRRORED,
    });
  });
});

describe("toggle OFF (stops the sync, deletes nothing)", () => {
  it("changes every entity not at all — only the online flag moves", () => {
    toggleSync(state, true);
    const synced = affectedSnapshot(state);
    toggleSync(state, false);
    const after = affectedSnapshot(state);

    expect(after.heroRun).toEqual(synced.heroRun);
    expect(after.workOrders).toEqual(synced.workOrders);
    expect(after.heroJournal).toEqual(synced.heroJournal);
    expect(after.syncStatus).toEqual({ ...synced.syncStatus, online: false });
  });

  it("reports status offline and keeps the sync bookkeeping", () => {
    const on = toggleSync(state, true);
    const response = toggleSync(state, false);
    expect(response.online).toBe(false);
    // A registry never un-remembers when the last sync ran, or what it found.
    expect(response.last_sync_at).toBe(on.last_sync_at);
    expect(response.last_sync_result).toEqual(on.last_sync_result);
    expect(response).not.toHaveProperty("demo_reset");
  });

  it("keeps WO-2026-0851 mirrored and TAS-88214 complete", () => {
    toggleSync(state, true);
    toggleSync(state, false);
    expect(getWorkOrder(state, SYNC_WO_ID).wo_id).toBe(SYNC_WO_ID);
    expect(listWorkOrders(state, {}, page()).items.map((w) => w.wo_id)).toContain(SYNC_WO_ID);
    const hero = getRun(state, HERO_RUN_ID);
    expect(hero.status).toBe("complete");
    expect(hero.work_order_id).toBe(SYNC_WO_ID);
    expect(hero.definition_id).toBe(SYNC_TD_ID);
    expect(hero.project).toBe(SYNC_PROJECT);
    for (const field of ["work_order_id", "definition_id", "project"] as const) {
      expect(hero.field_sources[field]).toMatchObject({ source: "api:planning" });
    }
    // Nothing is left awaiting a work order, the same as while online.
    expect(listRuns(state, { status: ["awaiting_work_order"] }, page()).total).toBe(0);
  });

  it("keeps the backfill journal entry", () => {
    const before = getRunJournal(state, HERO_RUN_ID, undefined, page());
    toggleSync(state, true);
    toggleSync(state, false);
    const after = getRunJournal(state, HERO_RUN_ID, undefined, page());
    expect(after.total).toBe(before.total + 1);
    expect(after.items.filter((j) => j.field === "run.work_order")).toHaveLength(1);
  });

  it("survives repeated on/off cycles and duplicates nothing", () => {
    toggleSync(state, true);
    const afterFirstSync = affectedSnapshot(state);
    toggleSync(state, false);
    toggleSync(state, true);
    toggleSync(state, false);
    // The second ON pass finds the run already linked, so it adds no journal
    // entry and no row. The sync only re-stamps `synced_at` and `last_sync_at`.
    const after = affectedSnapshot(state);
    expect(after.heroRun).toEqual(afterFirstSync.heroRun);
    expect(after.heroJournal).toEqual(afterFirstSync.heroJournal);
    expect(after.workOrders.items.map((w) => w.wo_id)).toEqual(
      afterFirstSync.workOrders.items.map((w) => w.wo_id),
    );
  });
});

describe("idempotency", () => {
  it("toggling ON twice in a row does not duplicate journal entries or WO rows", () => {
    toggleSync(state, true);
    const afterFirst = affectedSnapshot(state);
    const secondResponse = toggleSync(state, true);
    expect(affectedSnapshot(state)).toEqual(afterFirst);
    // Contract #21: toggling to the current state is a no-op 200 — the status
    // body is returned unchanged, last_sync_at is not re-stamped.
    expect(secondResponse).toEqual(afterFirst.syncStatus);
    const workOrderEntries = getRunJournal(state, HERO_RUN_ID, undefined, page()).items.filter(
      (j) => j.field === "run.work_order",
    );
    expect(workOrderEntries).toHaveLength(1);
    const mirroredRows = listWorkOrders(state, {}, page()).items.filter((w) => w.wo_id === SYNC_WO_ID);
    expect(mirroredRows).toHaveLength(1);
  });

  it("toggling OFF while already offline is a no-op", () => {
    const before = affectedSnapshot(state);
    const response = toggleSync(state, false);
    expect(response).toEqual(before.syncStatus);
    expect(affectedSnapshot(state)).toEqual(before);
  });

  it("rejects a non-boolean online value with 422 validation_error", () => {
    expectMockDbError(() => toggleSync(state, "yes"), 422, "validation_error");
    expectMockDbError(() => toggleSync(state, undefined), 422, "validation_error");
  });
});
