/**
 * lake-schema — the physical table/column resolver every Explore surface
 * reads, and the server wiring that feeds it.
 *
 *  - the resolver mirrors the backend map (explore_guard._PHYSICAL_COLUMNS):
 *    `test_signal_samples_v3` spells `ts_ms` / `file_name`, everything else
 *    keeps `timestamp` / `filename`
 *  - unset/empty falls back to the local stack's physical name
 *  - the table name reaches the browser the way `Quix__Portal__Api` does:
 *    the server reads `TM_LAKE_TABLE` at request time, a provider hands it
 *    down, and no `NEXT_PUBLIC_` name exists anywhere
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LAKE_SCHEMA,
  DEFAULT_LAKE_TABLE,
  KNOWN_LAKE_TABLES,
  lakeTable,
  resolveLakeSchema,
  setLakeTable,
} from "@/lib/explore/lake-schema";

describe("resolveLakeSchema", () => {
  it("keeps the identity spellings for the local-stack table", () => {
    const schema = resolveLakeSchema("test_signal_samples");
    expect(schema.table).toBe("test_signal_samples");
    expect(schema.columns).toEqual(["run_id", "signal", "timestamp", "value", "filename"]);
    expect(schema.timeColumn).toBe("timestamp");
    expect(schema.fileColumn).toBe("filename");
  });

  it("maps test_signal_samples_v3 to ts_ms / file_name, like the backend guard", () => {
    const schema = resolveLakeSchema("test_signal_samples_v3");
    expect(schema.table).toBe("test_signal_samples_v3");
    expect(schema.columns).toEqual(["run_id", "signal", "ts_ms", "value", "file_name"]);
    expect(schema.timeColumn).toBe("ts_ms");
    expect(schema.fileColumn).toBe("file_name");
  });

  it("maps test_signal_samples_v4 the same way — the project variable moved to v4", () => {
    const schema = resolveLakeSchema("test_signal_samples_v4");
    expect(schema.table).toBe("test_signal_samples_v4");
    expect(schema.columns).toEqual(["run_id", "signal", "ts_ms", "value", "file_name"]);
    expect(schema.timeColumn).toBe("ts_ms");
    expect(schema.fileColumn).toBe("file_name");
  });

  it("maps tm_signals the same way — the project variable moved to tm_signals", () => {
    const schema = resolveLakeSchema("tm_signals");
    expect(schema.table).toBe("tm_signals");
    expect(schema.columns).toEqual(["run_id", "signal", "ts_ms", "value", "file_name"]);
    expect(schema.timeColumn).toBe("ts_ms");
    expect(schema.fileColumn).toBe("file_name");
  });

  it("gives an unmapped table the identity spellings — the lake then answers a binder error, never other data", () => {
    const schema = resolveLakeSchema("some_future_table");
    expect(schema.table).toBe("some_future_table");
    expect(schema.timeColumn).toBe("timestamp");
    expect(schema.fileColumn).toBe("filename");
  });

  it("falls back to the local-stack table for a blank name", () => {
    expect(resolveLakeSchema("").table).toBe(DEFAULT_LAKE_TABLE);
    expect(resolveLakeSchema("   ").table).toBe(DEFAULT_LAKE_TABLE);
    expect(DEFAULT_LAKE_SCHEMA.table).toBe(DEFAULT_LAKE_TABLE);
  });

  it("lists every mapped table (and the fallback) as a known seed spelling", () => {
    expect(KNOWN_LAKE_TABLES).toContain(DEFAULT_LAKE_TABLE);
    expect(KNOWN_LAKE_TABLES).toContain("test_signal_samples_v3");
    expect(KNOWN_LAKE_TABLES).toContain("test_signal_samples_v4");
    expect(KNOWN_LAKE_TABLES).toContain("tm_signals");
  });
});

describe("setLakeTable / lakeTable", () => {
  afterEach(() => {
    setLakeTable("");
  });

  it("falls back to the local-stack table until the server hands a value down", () => {
    expect(lakeTable()).toBe(DEFAULT_LAKE_TABLE);
  });

  it("returns the configured table, trimmed", () => {
    setLakeTable("  test_signal_samples_v3  ");
    expect(lakeTable()).toBe("test_signal_samples_v3");
  });

  it("treats an empty or whitespace value as unset", () => {
    setLakeTable("test_signal_samples_v3");
    setLakeTable("   ");
    expect(lakeTable()).toBe(DEFAULT_LAKE_TABLE);
  });
});

/* Source pins, like portal-base-comes-from-the-server.test.ts: no behavior
   test renders `app/layout.tsx` (it imports next/font/google), so the wiring
   is pinned by reading the source. */
const FRONTEND_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function read(relative: string): string {
  return readFileSync(join(FRONTEND_ROOT, relative), "utf8");
}

describe("the Next server reads TM_LAKE_TABLE", () => {
  const layout = read("app/layout.tsx");

  it("reads the variable at request time, after the prerender stops", () => {
    expect(layout).toMatch(/await connection\(\);[\s\S]*process\.env\.TM_LAKE_TABLE/);
  });

  it("passes the value to the provider that reaches the browser", () => {
    expect(layout).toMatch(/<LakeConfigProvider[\s\S]*?table=\{lakeTable\}/);
  });

  it("reads no TM_DIRECT_LAKE switch anywhere — direct lake is the only path", () => {
    // The flag was removed by decision of the product owner; a reappearing
    // read would mean the guarded path is creeping back in.
    for (const relative of [
      "app/layout.tsx",
      "components/providers/lake-config-provider.tsx",
      "lib/explore/lake-schema.ts",
      "lib/explore/lake-partitions.ts",
    ]) {
      expect(read(relative)).not.toContain("TM_DIRECT_LAKE");
    }
  });

  it("hands the value to the plain module the browser code reads", () => {
    const provider = read("components/providers/lake-config-provider.tsx");
    expect(provider).toContain("setLakeTable(table)");
  });

  it("reads the session split the same way, and hands it down the same wire", () => {
    // The two pickers read different halves of one partition tree, and which
    // half is which is the operator's statement. It travels exactly like the
    // table name: server-read at request time, handed to the provider.
    expect(layout).toMatch(/await connection\(\);[\s\S]*process\.env\.TM_LAKE_SESSION_PARTITIONS/);
    expect(layout).toMatch(/await connection\(\);[\s\S]*process\.env\.TM_LAKE_DATA_PARTITIONS/);
    expect(layout).toMatch(/<LakeConfigProvider[\s\S]*?sessionPartitions=\{lakeSessionPartitions\}/);
    expect(layout).toMatch(/<LakeConfigProvider[\s\S]*?dataPartitions=\{lakeDataPartitions\}/);
    expect(read("components/providers/lake-config-provider.tsx")).toContain(
      "setLakePartitions(sessionPartitions, dataPartitions)",
    );
  });

  it("names no NEXT_PUBLIC variant anywhere in the wiring", () => {
    // Comments may NAME the banned pattern (the history of why it is banned
    // lives there, on purpose) — code may not. Same rule as the portal pin.
    const withoutComments = (text: string): string =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
    for (const relative of [
      "app/layout.tsx",
      "components/providers/lake-config-provider.tsx",
      "lib/explore/lake-schema.ts",
      "lib/explore/lake-partitions.ts",
    ]) {
      expect(withoutComments(read(relative))).not.toContain("NEXT_PUBLIC");
    }
  });
});
