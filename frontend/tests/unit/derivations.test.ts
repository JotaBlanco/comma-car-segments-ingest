// Derived state (contract §B #1 /home/summary, §A status derivation) and the
// client-side sourced() adapter over the field_sources map (types/source.ts).

import { beforeEach, describe, expect, it, test } from "vitest";
import {
  flagInvalid,
  getDb,
  getHomeSummary,
  getRun,
  resetDb,
  toggleSync,
} from "@/lib/mock/db";
import { HERO_RUN_ID, SYNC_WO_ID, VANITY_COUNTS, type MockState } from "@/lib/mock/seed";
import { sourced } from "@/types";

let state: MockState;

beforeEach(() => {
  resetDb();
  state = getDb();
});

describe("home summary", () => {
  it("derives needs_attention counts from the seed state", () => {
    expect(getHomeSummary(state).needs_attention).toEqual({
      awaiting_work_order: 1, // TAS-88214
      quarantined_files: 2,
      invalid_runs: 1, // TAS-88209
      orphaned_definitions: 1, // TD-INV-081
    });
  });

  it("lists the 5 latest runs by first_data_at with derived statuses", () => {
    const recent = getHomeSummary(state).recent_runs;
    expect(recent.map((r) => r.run_id)).toEqual([
      "TAS-88214",
      "TAS-88213",
      "TAS-88209",
      "TAS-88207",
      "TAS-88201",
    ]);
    expect(recent.map((r) => r.status)).toEqual([
      "awaiting_work_order",
      "complete",
      "invalid",
      "complete",
      "complete",
    ]);
  });

  it("re-derives after the sync toggle: awaiting drops to 0, planning goes online", () => {
    expect(getHomeSummary(state).planning_sync).toEqual({ online: false, last_sync_at: null });

    toggleSync(state, true);
    const summary = getHomeSummary(state);
    expect(summary.needs_attention.awaiting_work_order).toBe(0);
    expect(summary.needs_attention.invalid_runs).toBe(1); // untouched by sync
    expect(summary.planning_sync.online).toBe(true);
    expect(summary.planning_sync.last_sync_at).toEqual(expect.any(String));
    const hero = summary.recent_runs.find((r) => r.run_id === HERO_RUN_ID);
    expect(hero).toMatchObject({ status: "complete", work_order_id: SYNC_WO_ID });

    // Toggle OFF only stops the sync. The backfill stays, so the attention
    // count stays at 0 and the summary still remembers the last sync.
    toggleSync(state, false);
    const offline = getHomeSummary(state);
    expect(offline.needs_attention.awaiting_work_order).toBe(0);
    expect(offline.planning_sync).toEqual({
      online: false,
      last_sync_at: summary.planning_sync.last_sync_at,
    });
  });

  it("re-derives after an invalid flag: invalid_runs up, awaiting_work_order down", () => {
    flagInvalid(state, HERO_RUN_ID, "sensor fault", "e.lindqvist");
    const summary = getHomeSummary(state);
    expect(summary.needs_attention).toEqual({
      awaiting_work_order: 0,
      quarantined_files: 2,
      invalid_runs: 2,
      orphaned_definitions: 1, // TD-INV-081
    });
    expect(summary.recent_runs.find((r) => r.run_id === HERO_RUN_ID)?.status).toBe("invalid");
  });

  it("serves the fixed prototype vanity counts", () => {
    // NB: runs_today / files_today are vanity literals here — see the .fails
    // test below for the contract-mandated live derivation.
    expect(getHomeSummary(state).counts).toEqual(VANITY_COUNTS);
    expect(getHomeSummary(state).counts).toEqual({
      test_runs: 128,
      files: 512,
      signals: 6412,
      work_orders: 42,
      test_definitions: 7,
      runs_today: 6,
      files_today: 31,
      rig_count: 4,
    });
  });

  // Contract §1 (v1.1, BE-PLAN-AUDIT F4): "runs_today compares first_data_at,
  // and files_today compares registered_at, against the server's current UTC
  // date — computed live, never seeded as literals." The mock returns the
  // vanity literals 6/31 regardless of state. Executable TODO: derive both
  // counts from state, then drop .fails.
  test.fails("computes runs_today/files_today live against the current UTC date (contract §1 v1.1)", () => {
    const today = new Date().toISOString().slice(0, 10);
    const liveRunsToday = state.runs.filter((r) => r.first_data_at.startsWith(today)).length;
    const liveFilesToday = state.files.filter((f) => f.registered_at.startsWith(today)).length;
    const counts = getHomeSummary(state).counts;
    expect(counts.runs_today).toBe(liveRunsToday);
    expect(counts.files_today).toBe(liveFilesToday);
  });
});

describe("run status derivation precedence (invalid > awaiting_work_order > complete)", () => {
  it("no work order and not flagged → awaiting_work_order", () => {
    expect(getRun(state, HERO_RUN_ID).status).toBe("awaiting_work_order");
  });

  it("work order linked and not flagged → complete", () => {
    expect(getRun(state, "TAS-88213").status).toBe("complete");
  });

  it("flagged wins over awaiting_work_order", () => {
    flagInvalid(state, HERO_RUN_ID, "sensor fault", "e.lindqvist");
    expect(getRun(state, HERO_RUN_ID).status).toBe("invalid");
  });

  it("flagged wins over complete", () => {
    expect(getRun(state, "TAS-88209").work_order_id).not.toBeNull();
    expect(getRun(state, "TAS-88209").status).toBe("invalid");
  });

  it("a flagged run stays invalid even after the sync backfills its work order", () => {
    flagInvalid(state, HERO_RUN_ID, "sensor fault", "e.lindqvist");
    toggleSync(state, true);
    const hero = getRun(state, HERO_RUN_ID);
    expect(hero.work_order_id).toBe(SYNC_WO_ID);
    expect(hero.status).toBe("invalid");
  });
});

describe("sourced() adapter (types/source.ts)", () => {
  it("maps a field with a field_sources entry to its source/actor/at", () => {
    const run = getRun(state, HERO_RUN_ID);
    expect(sourced(run, "operator")).toEqual({
      value: "A. Bergström",
      source: "manual",
      actor: "a.bergstrom",
      at: "2026-08-14T09:58:00Z",
    });
    expect(sourced(run, "bench_sw").source).toBe("api:config");
    expect(sourced(run, "rig_id").source).toBe("embedded");
  });

  it("defaults an absent field_sources entry to source null (actor/at undefined)", () => {
    const run = getRun(state, HERO_RUN_ID);
    // description has a value but no provenance entry in the seed.
    expect(sourced(run, "description")).toEqual({
      value: "HV battery thermal cycling",
      source: null,
      actor: undefined,
      at: undefined,
    });
  });

  it("maps null value + absent entry to the 'awaiting sync' empty state", () => {
    const run = getRun(state, HERO_RUN_ID);
    expect(sourced(run, "work_order_id")).toEqual({
      value: null,
      source: null,
      actor: undefined,
      at: undefined,
    });
  });

  it("handles an entity without a field_sources map at all", () => {
    const bare = { name: "X" } as { name: string; field_sources?: never };
    expect(sourced(bare, "name")).toEqual({
      value: "X",
      source: null,
      actor: undefined,
      at: undefined,
    });
  });

  it("picks up api:planning provenance after the sync backfill", () => {
    toggleSync(state, true);
    const run = getRun(state, HERO_RUN_ID);
    expect(sourced(run, "work_order_id")).toEqual({
      value: SYNC_WO_ID,
      source: "api:planning",
      actor: "planning-sync",
      at: expect.any(String),
    });
    expect(sourced(run, "project").source).toBe("api:planning");
  });
});
