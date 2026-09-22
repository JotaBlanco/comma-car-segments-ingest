// List filters, pagination envelopes and global search
// (contract §B #2 /test-runs, #12 /files, #14 /signals, #19 /search).
//
// Multi-value filters, sort params and view_counts land per
// plans/design/TABLE-FILTERS-{FE,BE}-draft.md.

import { beforeEach, describe, expect, it } from "vitest";
import {
  FILES_SORT_DEFAULTS,
  filesViewCounts,
  getDb,
  listFiles,
  listRuns,
  listSignals,
  listWorkOrders,
  resetDb,
  RUNS_SORT_DEFAULTS,
  runsViewCounts,
  search,
  SIGNALS_SORT_DEFAULTS,
  signalsViewCounts,
  toggleSync,
  workOrdersViewCounts,
} from "@/lib/mock/db";
import { HERO_RUN_ID, SYNC_WO_ID, type MockState } from "@/lib/mock/seed";
import { page } from "./utils";

let state: MockState;

beforeEach(() => {
  resetDb();
  state = getDb();
});

describe("listRuns filters", () => {
  it("returns all 15 seeded runs sorted by first_data_at desc when unfiltered", () => {
    const result = listRuns(state, {}, page());
    expect(result.total).toBe(15);
    const dates = result.items.map((r) => r.first_data_at);
    expect(dates).toEqual([...dates].sort((a, b) => b.localeCompare(a)));
    expect(result.items[0]?.run_id).toBe(HERO_RUN_ID);
  });

  it.each([
    ["status complete", { status: ["complete"] } as const, 13],
    ["status awaiting_work_order", { status: ["awaiting_work_order"] } as const, 1],
    ["status invalid", { status: ["invalid"] } as const, 1],
    ["rig", { rig: ["RIG-02"] }, 2],
    ["project", { project: ["EC40"] }, 1],
    ["definition", { definition: "TD-BAT-114" }, 6],
    ["work_order", { work_order: "WO-2026-0812" }, 8],
  ])("filters by %s", (_label, filters, expectedTotal) => {
    const result = listRuns(state, filters, page());
    expect(result.total).toBe(expectedTotal);
    expect(result.items).toHaveLength(expectedTotal);
  });

  it("multi-value status is OR within key (Needs attention = awaiting + invalid)", () => {
    const result = listRuns(
      state,
      { status: ["awaiting_work_order", "invalid"] },
      page(),
    );
    expect(result.total).toBe(2);
    const statuses = result.items.map((r) => r.status).sort();
    expect(statuses).toEqual(["awaiting_work_order", "invalid"]);
  });

  it("multi-value rig ORs values within the rig key", () => {
    const result = listRuns(state, { rig: ["RIG-02", "RIG-07"] }, page());
    expect(result.total).toBe(3);
    for (const item of result.items) {
      expect(["RIG-02", "RIG-07"]).toContain(item.rig_id);
    }
  });

  it("distinct filter keys are ANDed together", () => {
    const result = listRuns(
      state,
      { status: ["complete"], rig: ["RIG-02"] },
      page(),
    );
    expect(result.total).toBe(2);
    for (const item of result.items) {
      expect(item.rig_id).toBe("RIG-02");
      expect(item.status).toBe("complete");
    }
    // Distinct rigs return zero when AND with status excludes them.
    const empty = listRuns(state, { status: ["invalid"], rig: ["RIG-02"] }, page());
    expect(empty.total).toBe(0);
  });

  it("empty filter array behaves like an absent filter", () => {
    expect(listRuns(state, { status: [] }, page()).total).toBe(15);
    expect(listRuns(state, { rig: [] }, page()).total).toBe(15);
  });

  it("filters by signal name via per-run stats (drives 'View as run filter')", () => {
    const result = listRuns(state, { signal: "HV_Batt_Cell_Temp_Max" }, page());
    expect(result.total).toBe(12);
  });

  it("filters by signal name via file inventories when no stats row exists", () => {
    const result = listRuns(state, { signal: "EM_Rotor_Temp" }, page());
    expect(result.items.map((r) => r.run_id)).toEqual(["TAS-88213"]);
  });

  it("combines filters (work_order + definition)", () => {
    const result = listRuns(state, { work_order: "WO-2026-0812", definition: "TD-BAT-102" }, page());
    expect(result.items.map((r) => r.run_id)).toEqual(["TAS-88177", "TAS-88168", "TAS-88141"]);
  });

  it("matches q as a case-insensitive substring over id/description/rig/definition/work-order", () => {
    expect(listRuns(state, { q: "8821" }, page()).items.map((r) => r.run_id)).toEqual([
      "TAS-88214",
      "TAS-88213",
    ]);
    expect(listRuns(state, { q: "INVERTER" }, page()).items.map((r) => r.run_id)).toEqual(["TAS-88209"]);
    expect(listRuns(state, { q: "TD-EM-201" }, page()).total).toBe(2);
    expect(listRuns(state, { q: "no-such-thing" }, page()).total).toBe(0);
  });

  it("sorts by first_data_at asc when explicitly requested", () => {
    const asc = listRuns(state, {}, page(), { key: "first_data_at", order: "asc" });
    const dates = asc.items.map((r) => r.first_data_at);
    expect(dates).toEqual([...dates].sort((a, b) => a.localeCompare(b)));
  });

  it("emits view_counts (whole-table, filter-independent)", () => {
    // Unfiltered.
    const unfiltered = listRuns(state, {}, page());
    expect(unfiltered.view_counts).toEqual({ all: 15, attention: 2, invalid: 1 });
    // With filters applied — same counts, because view_counts ignores filters.
    const filtered = listRuns(state, { status: ["invalid"], rig: ["RIG-07"] }, page());
    expect(filtered.view_counts).toEqual({ all: 15, attention: 2, invalid: 1 });
  });

  it("runsViewCounts matches the emitted view_counts", () => {
    expect(runsViewCounts(state)).toEqual({ all: 15, attention: 2, invalid: 1 });
  });
});

describe("pagination envelope", () => {
  it("slices with page/page_size and reports total across pages", () => {
    const first = listRuns(state, {}, page(1, 10));
    expect(first.items).toHaveLength(10);
    expect(first).toMatchObject({ total: 15, page: 1, page_size: 10, total_pages: 2 });

    const second = listRuns(state, {}, page(2, 10));
    expect(second.items).toHaveLength(5);
    expect(second).toMatchObject({ total: 15, page: 2, page_size: 10, total_pages: 2 });

    const ids = [...first.items, ...second.items].map((r) => r.run_id);
    expect(new Set(ids).size).toBe(15);
  });

  it("returns an empty items array beyond the last page while keeping the envelope", () => {
    const result = listRuns(state, {}, page(3, 10));
    expect(result.items).toEqual([]);
    expect(result).toMatchObject({ total: 15, page: 3, page_size: 10, total_pages: 2 });
  });

  it("filtered totals count matches, not the page slice", () => {
    const result = listRuns(state, { work_order: "WO-2026-0812" }, page(1, 10));
    expect(result.total).toBe(8);
    expect(result.items).toHaveLength(8);
  });
});

describe("listFiles filters", () => {
  it("returns all 6 seeded files sorted by registered_at desc when unfiltered", () => {
    const result = listFiles(state, {}, page());
    expect(result.total).toBe(6);
    const dates = result.items.map((f) => f.registered_at);
    expect(dates).toEqual([...dates].sort((a, b) => b.localeCompare(a)));
  });

  it("filters by status=quarantined and keeps the quarantine reason", () => {
    const result = listFiles(state, { status: ["quarantined"] }, page());
    expect(result.total).toBe(2);
    for (const file of result.items) {
      expect(file.status).toBe("quarantined");
      expect(file.quarantine_reason).toEqual(expect.any(String));
    }
    expect(result.items.map((f) => f.filename).sort()).toEqual([
      "em_eff_20260813_1726.mf4",
      "inv_derate_20260812_1518.mf4",
    ]);
  });

  it("filters unlinked=true to files with run_id null", () => {
    const result = listFiles(state, { unlinked: true }, page());
    expect(result.total).toBe(2);
    for (const file of result.items) expect(file.run_id).toBeNull();
  });

  it("filters unlinked=false to files linked to a run", () => {
    const result = listFiles(state, { unlinked: false }, page());
    expect(result.total).toBe(4);
    for (const file of result.items) expect(file.run_id).not.toBeNull();
  });

  it("filters by run and by source_system", () => {
    expect(listFiles(state, { run: HERO_RUN_ID }, page()).total).toBe(3);
    expect(listFiles(state, { source_system: ["TAS"] }, page()).total).toBe(3);
    expect(listFiles(state, { source_system: ["ifile"] }, page()).items.map((f) => f.filename)).toEqual([
      "chamber_log_0941.csv",
    ]);
  });

  it("multi-value source_system ORs within the key", () => {
    const result = listFiles(state, { source_system: ["INCA", "ifile"] }, page());
    for (const file of result.items) {
      expect(["INCA", "ifile"]).toContain(file.source_system);
    }
    expect(result.total).toBe(3);
  });

  it("multi-value status ORs registered and quarantined together (= all)", () => {
    const result = listFiles(state, { status: ["registered", "quarantined"] }, page());
    expect(result.total).toBe(6);
  });

  it("sorts by size_bytes desc when requested", () => {
    const desc = listFiles(state, {}, page(), { key: "size_bytes", order: "desc" });
    const sizes = desc.items.map((f) => f.size_bytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it("sorts by size_bytes asc when requested", () => {
    const asc = listFiles(state, {}, page(), { key: "size_bytes", order: "asc" });
    const sizes = asc.items.map((f) => f.size_bytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  it("uses the server-default registered_at desc when sort is not specified", () => {
    expect(FILES_SORT_DEFAULTS.registered_at).toBe("desc");
  });

  it("emits view_counts (whole-table, filter-independent)", () => {
    // `archived` and `deleted` joined the set on 20 Aug 2026. The mock seeds
    // no lifecycle, so every file is active and both counts are 0.
    const counts = { all: 6, registered: 4, quarantined: 2, archived: 0, deleted: 0 };
    const unfiltered = listFiles(state, {}, page());
    expect(unfiltered.view_counts).toEqual(counts);
    const filtered = listFiles(state, { source_system: ["TAS"] }, page());
    expect(filtered.view_counts).toEqual(counts);
    expect(filesViewCounts(state)).toEqual(counts);
  });

  it("matches q over filename, checksum and run id", () => {
    expect(listFiles(state, { q: "inca_cal" }, page()).total).toBe(1);
    expect(listFiles(state, { q: "9f2c8a41" }, page()).items.map((f) => f.filename)).toEqual([
      "bat_cyc_20260814_0941.mf4",
    ]);
    expect(listFiles(state, { q: HERO_RUN_ID }, page()).total).toBe(3);
  });
});

describe("listSignals filters", () => {
  it("returns all 14 catalog signals without detail-only keys", () => {
    const result = listSignals(state, {}, page());
    expect(result.total).toBe(14);
    for (const entry of result.items) {
      expect(entry).not.toHaveProperty("sensor_ref");
      expect(entry).not.toHaveProperty("catalogue_ref");
      expect(entry).not.toHaveProperty("rig_ids");
      expect(entry).not.toHaveProperty("field_sources");
    }
  });

  it("defaults to last_seen desc when no sort is specified", () => {
    expect(SIGNALS_SORT_DEFAULTS.last_seen).toBe("desc");
    const result = listSignals(state, {}, page());
    const dates = result.items.map((s) => s.last_seen);
    expect(dates).toEqual([...dates].sort((a, b) => b.localeCompare(a)));
  });

  it("sorts by name asc when explicitly requested (matches server default direction)", () => {
    expect(SIGNALS_SORT_DEFAULTS.name).toBe("asc");
    const asc = listSignals(state, {}, page(), { key: "name", order: "asc" });
    const names = asc.items.map((s) => s.name);
    expect(names).toEqual([...names].sort());
  });

  it("sorts by run_count and typical_rate_hz", () => {
    const byRuns = listSignals(state, {}, page(), { key: "run_count", order: "desc" });
    const counts = byRuns.items.map((s) => s.run_count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));

    const byRate = listSignals(state, {}, page(), { key: "typical_rate_hz", order: "asc" });
    const rates = byRate.items.map((s) => s.typical_rate_hz);
    expect(rates).toEqual([...rates].sort((a, b) => a - b));
  });

  it("filters by unit (single-value array)", () => {
    const result = listSignals(state, { unit: ["°C"] }, page());
    expect(result.total).toBe(6);
    for (const entry of result.items) expect(entry.unit).toBe("°C");
  });

  it("multi-value unit ORs values within the key (° C or V)", () => {
    const result = listSignals(state, { unit: ["°C", "V"] }, page());
    for (const entry of result.items) {
      expect(["°C", "V"]).toContain(entry.unit);
    }
    expect(result.total).toBeGreaterThan(6);
  });

  it("filters missing_unit=true to unit:null signals and missing_unit=false to the rest", () => {
    const missing = listSignals(state, { missing_unit: true }, page());
    expect(missing.items.map((s) => s.name).sort()).toEqual(["Chamber_Humidity", "EM_Shaft_Torque"]);
    for (const entry of missing.items) expect(entry.unit).toBeNull();

    const present = listSignals(state, { missing_unit: false }, page());
    expect(present.total).toBe(12);
    for (const entry of present.items) expect(entry.unit).not.toBeNull();
  });

  it("filters by rig membership", () => {
    const result = listSignals(state, { rig: ["RIG-02"] }, page());
    expect(result.items.map((s) => s.name).sort()).toEqual([
      "Cycle_Counter",
      "EM_Rotor_Temp",
      "EM_Shaft_Torque",
    ]);
  });

  it("multi-value rig ORs rigs and returns the union", () => {
    const result = listSignals(state, { rig: ["RIG-02", "RIG-04"] }, page());
    // At least the RIG-02 set should be in the result.
    const names = result.items.map((s) => s.name);
    expect(names).toContain("EM_Rotor_Temp");
    expect(result.total).toBeGreaterThanOrEqual(3);
  });

  it("filters by exact typical rate in Hz (multi-value array)", () => {
    expect(listSignals(state, { rate: [100] }, page()).total).toBe(7);
    expect(listSignals(state, { rate: [1] }, page()).total).toBe(3);
    expect(listSignals(state, { rate: [42] }, page()).total).toBe(0);
    // OR within key: rate=100 OR rate=1.
    expect(listSignals(state, { rate: [100, 1] }, page()).total).toBe(10);
  });

  it("matches q over name and description", () => {
    expect(listSignals(state, { q: "coolant" }, page()).total).toBe(3);
    expect(listSignals(state, { q: "BMS estimate" }, page()).items.map((s) => s.name)).toEqual([
      "HV_Batt_SOC",
    ]);
  });

  it("emits view_counts (whole-table, filter-independent)", () => {
    const unfiltered = listSignals(state, {}, page());
    expect(unfiltered.view_counts).toEqual({ all: 14, missing_unit: 2 });
    const filtered = listSignals(state, { unit: ["°C"] }, page());
    expect(filtered.view_counts).toEqual({ all: 14, missing_unit: 2 });
    expect(signalsViewCounts(state)).toEqual({ all: 14, missing_unit: 2 });
  });
});

describe("listWorkOrders filters + view_counts", () => {
  it("multi-value status ORs (active + closed = all mirrored)", () => {
    const all = listWorkOrders(state, {}, page()).total;
    const both = listWorkOrders(state, { status: ["active", "closed"] }, page()).total;
    expect(both).toBe(all);
  });

  it("multi-value project ORs values within the key", () => {
    const result = listWorkOrders(state, { project: ["EX90", "EC40"] }, page());
    for (const wo of result.items) {
      expect(["EX90", "EC40"]).toContain(wo.project);
    }
  });

  it("filters status=active correctly", () => {
    const active = listWorkOrders(state, { status: ["active"] }, page());
    for (const wo of active.items) expect(wo.status).toBe("active");
  });

  it("emits view_counts (whole-table, filter-independent)", () => {
    const unfiltered = listWorkOrders(state, {}, page());
    expect(unfiltered.view_counts).toBeDefined();
    expect(unfiltered.view_counts?.all).toBeGreaterThan(0);
    // filter-independent: the counts don't change when a filter is applied.
    const filtered = listWorkOrders(state, { status: ["active"] }, page());
    expect(filtered.view_counts).toEqual(unfiltered.view_counts);
    expect(workOrdersViewCounts(state)).toEqual(unfiltered.view_counts);
  });
});

describe("view_counts presence on all four lists", () => {
  it("view_counts is present on runs, files, signals and work-orders", () => {
    expect(listRuns(state, {}, page()).view_counts).toBeDefined();
    expect(listFiles(state, {}, page()).view_counts).toBeDefined();
    expect(listSignals(state, {}, page()).view_counts).toBeDefined();
    expect(listWorkOrders(state, {}, page()).view_counts).toBeDefined();
  });
});

describe("server-side sort default directions match the contract", () => {
  it("runs first_data_at defaults to desc", () => {
    expect(RUNS_SORT_DEFAULTS.first_data_at).toBe("desc");
  });
  it("files registered_at defaults to desc, size_bytes to desc", () => {
    expect(FILES_SORT_DEFAULTS.registered_at).toBe("desc");
    expect(FILES_SORT_DEFAULTS.size_bytes).toBe("desc");
  });
  it("signals name asc, everything else desc", () => {
    expect(SIGNALS_SORT_DEFAULTS.name).toBe("asc");
    expect(SIGNALS_SORT_DEFAULTS.typical_rate_hz).toBe("desc");
    expect(SIGNALS_SORT_DEFAULTS.run_count).toBe("desc");
    expect(SIGNALS_SORT_DEFAULTS.last_seen).toBe("desc");
  });
});

describe("route-handler validation (unknown sort → 422)", () => {
  it("test-runs GET rejects an unknown sort key with a 422 body", async () => {
    const { GET } = await import("@/app/api/v1/test-runs/route");
    const req = new Request("http://tm.test/api/v1/test-runs?sort=unknown", {
      headers: { authorization: "Bearer test-token-not-a-secret" },
    });
    process.env.TM_API_TOKEN = "test-token-not-a-secret";
    const res = await GET(req);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; errors: Array<{ loc: string[] }> };
    expect(body.code).toBe("validation_error");
    expect(body.errors[0]?.loc).toEqual(["query", "sort"]);
  });

  it("files GET rejects an unknown sort key with a 422 body", async () => {
    const { GET } = await import("@/app/api/v1/files/route");
    process.env.TM_API_TOKEN = "test-token-not-a-secret";
    const req = new Request("http://tm.test/api/v1/files?sort=not_a_column", {
      headers: { authorization: "Bearer test-token-not-a-secret" },
    });
    const res = await GET(req);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation_error");
  });

  it("signals GET rejects a bad order value with a 422 body", async () => {
    const { GET } = await import("@/app/api/v1/signals/route");
    process.env.TM_API_TOKEN = "test-token-not-a-secret";
    const req = new Request("http://tm.test/api/v1/signals?order=sideways", {
      headers: { authorization: "Bearer test-token-not-a-secret" },
    });
    const res = await GET(req);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; errors: Array<{ loc: string[] }> };
    expect(body.code).toBe("validation_error");
    expect(body.errors[0]?.loc).toEqual(["query", "order"]);
  });

  it("work-orders GET rejects any sort param with a 422 body (light treatment)", async () => {
    const { GET } = await import("@/app/api/v1/work-orders/route");
    process.env.TM_API_TOKEN = "test-token-not-a-secret";
    const req = new Request("http://tm.test/api/v1/work-orders?sort=wo_id", {
      headers: { authorization: "Bearer test-token-not-a-secret" },
    });
    const res = await GET(req);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation_error");
  });

  it("test-runs GET reads repeated status params via getAll", async () => {
    const { GET } = await import("@/app/api/v1/test-runs/route");
    process.env.TM_API_TOKEN = "test-token-not-a-secret";
    const url = new URL("http://tm.test/api/v1/test-runs");
    url.searchParams.append("status", "awaiting_work_order");
    url.searchParams.append("status", "invalid");
    const res = await GET(new Request(url, { headers: { authorization: "Bearer test-token-not-a-secret" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(2);
  });
});

describe("search", () => {
  it("finds substring matches grouped by entity type, empty groups omitted", () => {
    const results = search(state, "88214", 5);
    expect(results.query).toBe("88214");
    /* Six groups since 19 Aug 2026 (contract #19): the hero run carries a
       processed result, so the result group answers the run id too. */
    expect(results.groups.map((g) => g.type)).toEqual([
      "test_runs",
      "files",
      "processed_results",
    ]);

    const runGroup = results.groups.find((g) => g.type === "test_runs");
    expect(runGroup?.items).toEqual([
      {
        id: HERO_RUN_ID,
        sub: "HV battery thermal cycling · RIG-04",
        status: "awaiting_work_order",
        nav: { run_id: HERO_RUN_ID },
      },
    ]);

    const fileGroup = results.groups.find((g) => g.type === "files");
    expect(fileGroup?.items).toHaveLength(3);
    for (const item of fileGroup?.items ?? []) {
      expect(item.sub).toContain(HERO_RUN_ID);
      expect(item.nav).toHaveProperty("file_id");
    }
  });

  it("searches all six entity types case-insensitively", () => {
    const results = search(state, "BAT", 10);
    const byType = new Map(results.groups.map((g) => [g.type, g.items]));
    expect(byType.get("test_runs")?.length).toBeGreaterThan(0);
    expect(byType.get("work_orders")?.map((w) => w.id).sort()).toEqual([
      "WO-2026-0812",
      "WO-2026-0839",
    ]);
    expect(byType.get("files")?.map((f) => f.id)).toEqual(["bat_cyc_20260814_0941.mf4"]);
    expect(byType.get("signals")?.length).toBeGreaterThan(0);
    for (const item of byType.get("signals") ?? []) expect(item.status).toBeNull();
  });

  it("caps every group at limit_per_group", () => {
    const results = search(state, "batt", 2);
    for (const group of results.groups) {
      expect(group.items.length).toBeLessThanOrEqual(2);
    }
    expect(results.groups.find((g) => g.type === "test_runs")?.items).toHaveLength(2);
  });

  it("returns empty groups (not empty items) when nothing matches", () => {
    expect(search(state, "zzz-no-match-zzz", 5)).toEqual({ query: "zzz-no-match-zzz", groups: [] });
  });

  it("treats regex metacharacters in the query as literals", () => {
    expect(search(state, ".*", 5).groups).toEqual([]);
    expect(search(state, "0941.mf4", 5).groups.map((g) => g.type)).toEqual(["files"]);
  });

  it("answers a test definition hit that navigates by the runs-list filter", () => {
    const group = search(state, "TD-EM-201", 5).groups.find(
      (g) => g.type === "test_definitions"
    );
    expect(group?.items).toEqual([
      {
        id: "TD-EM-201",
        sub: "E-machine efficiency map — WLTP points · WO-2026-0847",
        status: null,
        nav: { definition: "TD-EM-201" },
      },
    ]);
  });

  it("answers a processed result hit that navigates to its run", () => {
    const group = search(state, "thermal_summary", 5).groups.find(
      (g) => g.type === "processed_results"
    );
    expect(group?.items).toEqual([
      {
        id: "thermal_summary_v1.parquet",
        sub: `${HERO_RUN_ID} · v1`,
        status: "verified",
        nav: { run_id: HERO_RUN_ID },
      },
    ]);
  });

  it("hides unmirrored work orders until a sync pass mirrors them", () => {
    expect(search(state, SYNC_WO_ID, 5).groups).toEqual([]);
    toggleSync(state, true);
    const groups = search(state, SYNC_WO_ID, 5).groups;
    expect(groups.find((g) => g.type === "work_orders")?.items[0]?.id).toBe(SYNC_WO_ID);
  });
});
