// Orphaned test definitions (TR-001).
//
// An orphan is a mirrored definition that names no work order, or one whose
// work order this registry does not mirror. The Home panel counts them and
// the /definitions screen lists them.

import { beforeEach, describe, expect, it } from "vitest";
import { getDb, getHomeSummary, listTestDefinitions, resetDb, toggleSync } from "@/lib/mock/db";
import { ORPHAN_TD_ID, type MockState } from "@/lib/mock/seed";
import { page } from "./utils";

let state: MockState;

beforeEach(() => {
  resetDb();
  state = getDb();
});

describe("getHomeSummary orphan count", () => {
  it("counts the one seeded orphan", () => {
    expect(getHomeSummary(state).needs_attention.orphaned_definitions).toBe(1);
  });

  it("keeps the count after a planning sync pass", () => {
    toggleSync(state, true);
    expect(getHomeSummary(state).needs_attention.orphaned_definitions).toBe(1);
  });
});

describe("listTestDefinitions", () => {
  it("returns every mirrored definition when no filter is stated", () => {
    const result = listTestDefinitions(state, {}, page());
    expect(result.total).toBe(6);
    expect(result.items.map((d) => d.td_id)).toContain(ORPHAN_TD_ID);
  });

  it("returns only the orphans when orphaned is true", () => {
    const result = listTestDefinitions(state, { orphaned: true }, page());
    expect(result.total).toBe(1);
    expect(result.items[0]?.td_id).toBe(ORPHAN_TD_ID);
  });

  it("names no work order on an orphan and flags it", () => {
    const orphan = listTestDefinitions(state, { orphaned: true }, page()).items[0];
    expect(orphan.work_order_id).toBeNull();
    expect(orphan.orphaned).toBe(true);
    expect(orphan.planned_runs).toBe(0);
  });

  it("names the mirrored work order on a linked definition", () => {
    const items = listTestDefinitions(state, {}, page()).items;
    const linked = items.find((d) => d.td_id === "TD-EM-201");
    expect(linked?.work_order_id).toBe("WO-2026-0847");
    expect(linked?.orphaned).toBe(false);
  });

  it("hides a definition the registry does not mirror", () => {
    const items = listTestDefinitions(state, {}, page()).items;
    expect(items.map((d) => d.td_id)).not.toContain("TD-BAT-118");
  });

  it("shows the once-hidden definition after a sync pass, linked", () => {
    toggleSync(state, true);
    const items = listTestDefinitions(state, {}, page()).items;
    const synced = items.find((d) => d.td_id === "TD-BAT-118");
    expect(synced?.orphaned).toBe(false);
    expect(synced?.work_order_id).toBe("WO-2026-0851");
  });
});
