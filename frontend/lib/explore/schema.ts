/**
 * Display-only type hints for the lake table's five columns.
 *
 * Column NAMES come from the physical-schema resolver
 * (lib/explore/lake-schema.ts — the exact spellings the lake table uses), but
 * no endpoint anywhere exposes column TYPES, and the UI never runs an
 * information_schema probe of its own just to label a hint. This map mirrors
 * the writer at api/ingest/lake.py (the time column is epoch milliseconds,
 * kept a plain integer) and carries every KNOWN physical spelling:
 * `timestamp` / `filename` for the identity tables and `ts_ms` / `file_name`
 * for `test_signal_samples_v3`. It is a UI hint, not a contract: a column
 * name missing here simply renders without a type.
 */
export const EXPLORE_COLUMN_TYPES: Readonly<Record<string, string>> = {
  run_id: "varchar",
  signal: "varchar",
  timestamp: "bigint · epoch ms",
  ts_ms: "bigint · epoch ms",
  value: "double",
  filename: "varchar",
  file_name: "varchar",
};
