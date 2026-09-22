/**
 * Mock lake (lib/mock/db.ts runLakeQuery) — the in-memory answer behind
 * POST /api/lake/query when TM_USE_MOCK_API / TM_TEST_HOOKS is set.
 *
 * The SQL arrives VERBATIM (the guarded backend path and its sql_rejected
 * emulation are gone), so what this pins is lake realism: the run scope and
 * LIMIT are read from the SQL text, an unknown run matches nothing, and a
 * non-SELECT statement comes back as the lake's own read-only refusal
 * (lake_query_error), never a guard verdict.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDb, runLakeQuery } from "@/lib/mock/db";
import { MockDbError } from "@/lib/mock/errors";
import { HERO_RUN_ID } from "@/lib/mock/seed";
import type { MockState } from "@/lib/mock/seed";

let state: MockState;

beforeEach(() => {
  resetDb();
  state = getDb();
});

function refusalOf(sql: string): MockDbError {
  try {
    runLakeQuery(state, sql);
  } catch (error) {
    if (error instanceof MockDbError) return error;
    throw error;
  }
  throw new Error(`expected a lake refusal for: ${sql}`);
}

describe("runLakeQuery — run scope and LIMIT live in the SQL text", () => {
  it("answers rows for a SELECT scoped to a seeded run", () => {
    const result = runLakeQuery(
      state,
      `SELECT signal, timestamp, value FROM test_signal_samples WHERE run_id = '${HERO_RUN_ID}' ORDER BY timestamp LIMIT 100`,
    );
    expect(result.row_count).toBeGreaterThan(0);
    expect(result.rows.length).toBe(result.row_count);
    expect(result.columns.map((column) => column.name)).toEqual(["signal", "timestamp", "value"]);
  });

  it("honors the SQL's own LIMIT without flagging truncation — that is the lake's job, not a cap", () => {
    const result = runLakeQuery(
      state,
      `SELECT signal, timestamp, value FROM test_signal_samples WHERE run_id = '${HERO_RUN_ID}' LIMIT 10`,
    );
    expect(result.row_count).toBeLessThanOrEqual(10);
    expect(result.truncated).toBe(false);
  });

  it("matches nothing for a run id the lake does not hold — zero rows, not an error", () => {
    const result = runLakeQuery(
      state,
      "SELECT * FROM test_signal_samples WHERE run_id = 'RUN-DOES-NOT-EXIST'",
    );
    expect(result.row_count).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("falls back to the seeded hero run when the SQL names no run", () => {
    const result = runLakeQuery(state, "SELECT signal, timestamp, value FROM test_signal_samples LIMIT 20");
    expect(result.row_count).toBeGreaterThan(0);
  });
});

describe("runLakeQuery — the BETWEEN window narrows the answered slice", () => {
  function heroRun() {
    const run = state.runs.find((r) => r.run_id === HERO_RUN_ID);
    if (run === undefined) throw new Error("hero run missing from seed");
    return run;
  }

  it("honors an unquoted epoch-ms BETWEEN — the shape buildVizSql emits on drag-zoom", () => {
    const startMs = Date.parse(heroRun().started_at);
    const fromMs = startMs + 60_000;
    const toMs = startMs + 120_000;
    // The viz panel's requery names the physical time column (ts_ms here)
    // and compares plain epoch-ms numbers. The mock must read that window,
    // or zoom is a silent no-op in mock/e2e mode.
    const sql = [
      "SELECT signal,",
      "       epoch_ms(time_bucket(INTERVAL 1 SECOND, to_timestamp(ts_ms / 1000.0))) AS ts,",
      "       avg(value) AS value",
      "FROM test_signal_samples_v3",
      `WHERE run_id = '${HERO_RUN_ID}'`,
      "  AND signal IN ('HV_Batt_Cell_Temp_Max')",
      `  AND ts_ms BETWEEN ${fromMs} AND ${toMs}`,
      "GROUP BY signal, ts",
      "ORDER BY ts",
    ].join("\n");
    const result = runLakeQuery(state, sql);
    expect(result.row_count).toBeGreaterThan(0);
    const tsIndex = result.columns.findIndex((column) => column.name === "ts");
    for (const row of result.rows) {
      const ts = Date.parse(row[tsIndex]);
      expect(ts).toBeGreaterThanOrEqual(fromMs);
      expect(ts).toBeLessThanOrEqual(toMs);
    }
  });

  it("keeps the quoted-ISO BETWEEN branch for hand-written SQL", () => {
    const startMs = Date.parse(heroRun().started_at);
    const from = new Date(startMs + 60_000).toISOString();
    const to = new Date(startMs + 120_000).toISOString();
    const result = runLakeQuery(
      state,
      `SELECT signal, timestamp, value FROM test_signal_samples WHERE run_id = '${HERO_RUN_ID}' AND timestamp BETWEEN '${from}' AND '${to}' LIMIT 50`,
    );
    expect(result.row_count).toBeGreaterThan(0);
    const tsIndex = result.columns.findIndex((column) => column.name === "timestamp");
    for (const row of result.rows) {
      const ts = Date.parse(row[tsIndex]);
      expect(ts).toBeGreaterThanOrEqual(startMs + 60_000);
      expect(ts).toBeLessThanOrEqual(startMs + 120_000);
    }
  });
});

describe("runLakeQuery — the only refusal left is the lake's read-only connection", () => {
  it("refuses DDL as a lake query error, not a guard verdict", () => {
    const error = refusalOf("DROP TABLE test_signal_samples");
    expect(error.status).toBe(400);
    expect(error.code).toBe("lake_query_error");
    expect(error.detail).toMatch(/DROP/);
    expect(error.detail).toMatch(/read-only/);
  });

  it("refuses DML the same way", () => {
    expect(refusalOf("DELETE FROM test_signal_samples").code).toBe("lake_query_error");
  });
});
