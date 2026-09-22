/**
 * The PHYSICAL lake schema — the one table name and the five column spellings
 * every Explore surface shows and every generated statement uses.
 *
 * **Why physical, not logical.** The workbench used to speak a logical name
 * (`test_signal_samples`, columns `timestamp` / `filename`) and a hidden
 * projection renamed it to whatever table `TM_LAKE_TABLE` points at. That
 * aliasing is gone: what the user sees is exactly what the lake receives, so
 * the UI must name the real table and its real column spellings.
 *
 * **Where the table name comes from.** The operator sets `TM_LAKE_TABLE` on
 * the deployment. That variable reaches the **server** process only, so
 * `app/layout.tsx` reads it at request time (after `await connection()`, the
 * same wiring that carries `Quix__Portal__Api`) and `LakeConfigProvider`
 * hands the value to the setter below. No `NEXT_PUBLIC_` name exists and
 * `next build` bakes nothing into the image. Unset or empty, the local
 * stack's physical name `test_signal_samples` applies.
 */

/** The local stack's physical table — the fallback when `TM_LAKE_TABLE` is unset. */
export const DEFAULT_LAKE_TABLE = "test_signal_samples";

/** A physical table's five columns, resolved from its name. */
export interface LakeSchema {
  /** The physical table name — the exact identifier the lake resolves. */
  table: string;
  /** The run-scope column. Every known table spells it `run_id`. */
  runIdColumn: string;
  /** The signal-name column. Every known table spells it `signal`. */
  signalColumn: string;
  /** The time column — a bigint of epoch milliseconds under either spelling. */
  timeColumn: string;
  /** The sample-value column. Every known table spells it `value`. */
  valueColumn: string;
  /** The source-file column. */
  fileColumn: string;
  /** The five columns in projection order: run id, signal, time, value, file. */
  columns: readonly [string, string, string, string, string];
}

/**
 * Column spellings per physical table.
 *
 * **This file is the map's owner.** The backend guard (`explore_guard.py`)
 * and its `_PHYSICAL_COLUMNS` twin were deleted on 24 Aug 2026, so there is
 * nothing to keep in lockstep with any more — the backend's own SQL reads
 * only the columns every known table spells the same, and
 * `api/api/services/queries_stats.py:382-383` records that the per-table
 * spellings moved HERE. The key is the physical table name an operator puts
 * in `TM_LAKE_TABLE`; the value gives the two columns whose spelling varies.
 * A table absent from this map keeps the `timestamp` / `filename` spellings,
 * which is the identity case and covers the local stack's
 * `test_signal_samples`.
 *
 * The cost: a fourth physical table with its own spelling needs a new entry
 * here, and nowhere else. An unmapped table falls back to the identity
 * spellings, so the worst outcome is a binder error from the lake — never
 * silently different data.
 */
const PHYSICAL_COLUMN_SPELLINGS: Readonly<Record<string, { time: string; file: string }>> = {
  test_signal_samples_v3: { time: "ts_ms", file: "file_name" },
  test_signal_samples_v4: { time: "ts_ms", file: "file_name" },
  tm_signals: { time: "ts_ms", file: "file_name" },
};

/**
 * Every table this UI knows a seed spelling for — the map's keys plus the
 * fallback. The explore tab uses this to recognise a STALE untouched seed
 * (minted before `TM_LAKE_TABLE` was repointed) and upgrade it in place.
 */
export const KNOWN_LAKE_TABLES: readonly string[] = [
  DEFAULT_LAKE_TABLE,
  ...Object.keys(PHYSICAL_COLUMN_SPELLINGS),
];

/** The spellings an unmapped table keeps — the identity case. */
const IDENTITY_SPELLING = { time: "timestamp", file: "filename" } as const;

function schemaFor(name: string, timeColumn: string, fileColumn: string): LakeSchema {
  return {
    table: name,
    runIdColumn: "run_id",
    signalColumn: "signal",
    timeColumn,
    valueColumn: "value",
    fileColumn,
    columns: ["run_id", "signal", timeColumn, "value", fileColumn],
  };
}

/** Resolve a physical table name into its five column spellings. */
export function resolveLakeSchema(table: string): LakeSchema {
  const name = table.trim() || DEFAULT_LAKE_TABLE;
  const spelling = PHYSICAL_COLUMN_SPELLINGS[name] ?? IDENTITY_SPELLING;
  return schemaFor(name, spelling.time, spelling.file);
}

/**
 * The identity-spelled schema for a table — what `resolveLakeSchema` returned
 * for that table BEFORE it entered the map above.
 *
 * A table can be unmapped for a while and then mapped. Every browser that
 * opened the workbench in between minted seeds with `timestamp` / `filename`,
 * and those seeds name columns the table does not have. The explore tab needs
 * this spelling to recognise such a seed and upgrade it in place. For a table
 * that is still unmapped, this returns exactly `resolveLakeSchema(table)`.
 */
export function identityLakeSchema(table: string): LakeSchema {
  const name = table.trim() || DEFAULT_LAKE_TABLE;
  return schemaFor(name, IDENTITY_SPELLING.time, IDENTITY_SPELLING.file);
}

/**
 * The fallback schema — what the SQL builders assume before the server-read
 * table name reaches the browser. Identity spellings, local-stack table.
 */
export const DEFAULT_LAKE_SCHEMA: LakeSchema = resolveLakeSchema(DEFAULT_LAKE_TABLE);

/**
 * The table name the server read from `TM_LAKE_TABLE`.
 *
 * `setPortalApiBase` in `lib/portal/client.ts` works the same way, and for
 * the same reason: this is a plain module and it reads no React state. The
 * setter runs during `LakeConfigProvider`'s render, so children read the
 * value on their own first render.
 */
let configuredTable: string | null = null;

/** Take the table name the server read. Empty means "use the fallback". */
export function setLakeTable(table: string | null | undefined): void {
  const trimmed = (table ?? "").trim();
  configuredTable = trimmed.length > 0 ? trimmed : null;
}

/** The physical lake table this deployment queries. */
export function lakeTable(): string {
  return configuredTable ?? DEFAULT_LAKE_TABLE;
}
