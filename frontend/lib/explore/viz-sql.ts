/**
 * Pure query-building logic for the Explore tab (SQL seed, snippets, and the
 * Visualise mode's time_bucket SQL). No DOM, no React — unit-tested in the
 * node environment (tests/unit/explore-viz-sql.test.ts).
 *
 * Every builder takes a resolved {@link LakeSchema} and emits the PHYSICAL
 * table and column spellings (lib/explore/lake-schema.ts) — what the editor
 * shows is exactly the statement the lake receives, with no hidden renaming
 * in between. The default schema is the local-stack fallback, for the moment
 * before the server-read table name reaches the caller.
 */

import { DEFAULT_LAKE_SCHEMA, type LakeSchema } from "./lake-schema";

export type VizAggregate = "avg" | "min" | "max";

/** Escape a value for a single-quoted SQL string literal. */
export function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Nice bucket widths (ms) the auto-bucketing snaps onto — sub-second steps
 * up to minutes. The lake groups with `time_bucket(INTERVAL …)`.
 */
export const BUCKET_STEPS_MS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000,
] as const;

/**
 * Bucket width for ~1 point per device pixel: the visible range divided by
 * (container CSS px × devicePixelRatio), snapped UP to the next nice step so
 * the query never returns more points than pixels.
 */
export function computeBucketMs(rangeMs: number, containerPx: number, dpr: number): number {
  const pixels = Math.max(1, Math.floor(containerPx * Math.max(1, dpr)));
  const raw = rangeMs / pixels;
  for (const step of BUCKET_STEPS_MS) {
    if (step >= raw) return step;
  }
  return BUCKET_STEPS_MS[BUCKET_STEPS_MS.length - 1];
}

/** Render a bucket width as a DuckDB INTERVAL clause. */
export function bucketInterval(bucketMs: number): string {
  if (bucketMs % 60_000 === 0) return `INTERVAL ${bucketMs / 60_000} MINUTE`;
  if (bucketMs % 1_000 === 0) return `INTERVAL ${bucketMs / 1_000} SECOND`;
  return `INTERVAL ${bucketMs} MILLISECOND`;
}

/** Human label for the bucket select, e.g. "auto · 250 ms" / "auto · 2 s". */
export function bucketLabel(bucketMs: number): string {
  if (bucketMs % 60_000 === 0) return `${bucketMs / 60_000} min`;
  if (bucketMs % 1_000 === 0) return `${bucketMs / 1_000} s`;
  return `${bucketMs} ms`;
}

/**
 * Hard row ceiling on the chart's aggregate. `computeBucketMs` already keeps
 * the count under one point per device pixel, so this never binds in practice
 * — it is the backstop for the day that maths is wrong, matching the LIMIT
 * `buildSeedSql` carries. A 4K screen with ten series stays well beneath it.
 */
export const VIZ_ROW_LIMIT = 200_000;

export interface VizSqlOptions {
  signals: readonly string[];
  aggregate: VizAggregate;
  bucketMs: number;
  /**
   * The run the statement is scoped to. On the direct lake path no server
   * injects the scope, so the WHERE line must state it — an unscoped
   * aggregate would silently mix every run's samples for these signals.
   */
  runId?: string;
  /** Optional narrowed window (drag-zoom re-query) — ISO-8601 Z strings. */
  timeFrom?: string;
  timeTo?: string;
}

/**
 * The Visualise mode's lakeside aggregate (plan §4 — always time_bucket).
 *
 * The time column is a BIGINT of epoch milliseconds on every known lake
 * table (`lake-schema.ts` documents the invariant), and DuckDB's
 * `time_bucket` only takes DATE/TIMESTAMP — feeding it the raw bigint is a
 * binder error. So the statement converts on the way in
 * (`to_timestamp(col / 1000.0)`) and back on the way out (`epoch_ms(...)`),
 * keeping `ts` a plain epoch-ms number for the chart. The zoom window
 * compares milliseconds against milliseconds for the same reason.
 */
export function buildVizSql(
  { signals, aggregate, bucketMs, runId, timeFrom, timeTo }: VizSqlOptions,
  schema: LakeSchema = DEFAULT_LAKE_SCHEMA,
): string {
  const signalList = signals.map(sqlQuote).join(", ");
  const bucketed = `time_bucket(${bucketInterval(bucketMs)}, to_timestamp(${schema.timeColumn} / 1000.0))`;
  const scope = runId === undefined ? [] : [`WHERE run_id = ${sqlQuote(runId)}`];
  const signalClause = `${scope.length === 0 ? "WHERE" : "  AND"} signal IN (${signalList})`;
  const lines = [
    `SELECT signal,`,
    `       epoch_ms(${bucketed}) AS ts,`,
    `       ${aggregate}(value) AS value`,
    `FROM ${schema.table}`,
    ...scope,
    signalClause,
  ];
  if (timeFrom !== undefined && timeTo !== undefined) {
    lines.push(
      `  AND ${schema.timeColumn} BETWEEN ${Date.parse(timeFrom)} AND ${Date.parse(timeTo)}`,
    );
  }
  lines.push(`GROUP BY signal, ts`, `ORDER BY ts`, `LIMIT ${VIZ_ROW_LIMIT}`);
  return lines.join("\n");
}

/**
 * The editor's first-open seed — a raw first look at the run's samples,
 * useful on the very first Run: it returns rows for any run that has lake
 * data, names every projected column (teaching the schema), and carries its
 * own LIMIT. On the direct lake path no server rewrites the SQL, so the
 * caller passes the run id and the WHERE line states the scope in the text
 * the editor shows. The per-signal summary this replaced lives on as the
 * "Per-signal stats" snippet chip, one click away.
 */
export function buildSeedSql(schema: LakeSchema = DEFAULT_LAKE_SCHEMA, runId?: string): string {
  // No leading comment on purpose. The habit dates from the deleted backend
  // guard (it refused `--` outright), but it still earns its keep: the seed
  // teaches by being nothing but runnable SQL, and a comment would be the
  // first thing every user deletes.
  const lines = [
    `SELECT signal, ${schema.timeColumn}, value, ${schema.fileColumn}`,
    `FROM ${schema.table}`,
  ];
  if (runId !== undefined) lines.push(`WHERE run_id = ${sqlQuote(runId)}`);
  lines.push(`ORDER BY ${schema.timeColumn}`, `LIMIT 100`);
  return lines.join("\n");
}

export interface SqlSnippet {
  label: string;
  sql: string;
}

/** Snippet chips under the editor, parameterised with the run's signal names. */
export function buildSnippets(
  signals: readonly string[],
  schema: LakeSchema = DEFAULT_LAKE_SCHEMA,
  runId?: string,
): SqlSnippet[] {
  const first = signals[0];
  const second = signals[1];
  // On the direct lake path no server injects the run scope, so every chip
  // states it. Without a run id (builder tests, previews) the clause is
  // simply absent and the first condition takes the WHERE.
  const scope = runId === undefined ? null : `run_id = ${sqlQuote(runId)}`;
  const where = (...conditions: string[]): string => {
    const all = scope === null ? conditions : [scope, ...conditions];
    return all.map((cond, index) => `${index === 0 ? "WHERE" : "  AND"} ${cond}`).join("\n");
  };
  const snippets: SqlSnippet[] = [];
  if (first !== undefined) {
    snippets.push({
      label: "Signal over time",
      sql:
        `SELECT ${schema.timeColumn}, value\n` +
        `FROM ${schema.table}\n` +
        `${where(`signal = ${sqlQuote(first)}`)}\n` +
        `ORDER BY ${schema.timeColumn}`,
    });
  }
  snippets.push({
    label: "Per-signal stats",
    sql:
      `SELECT signal,\n` +
      `       min(value) AS min, max(value) AS max,\n` +
      `       avg(value) AS mean, count(*) AS samples\n` +
      `FROM ${schema.table}\n` +
      (scope === null ? "" : `${where()}\n`) +
      `GROUP BY signal\n` +
      `ORDER BY signal`,
  });
  if (first !== undefined && second !== undefined) {
    snippets.push({
      label: `Compare ${first} / ${second}`,
      sql: buildVizSql(
        { signals: [first, second], aggregate: "avg", bucketMs: 1_000, runId },
        schema,
      ),
    });
  }
  snippets.push({
    label: "Sample-rate check",
    sql:
      `SELECT signal,\n` +
      `       count(*) / 60.0 AS samples_per_min\n` +
      `FROM ${schema.table}\n` +
      (scope === null ? "" : `${where()}\n`) +
      `GROUP BY signal\n` +
      `ORDER BY samples_per_min DESC`,
  });
  if (first !== undefined) {
    snippets.push({
      label: "Values out of range",
      sql:
        `SELECT ${schema.timeColumn}, value\n` +
        `FROM ${schema.table}\n` +
        `${where(`signal = ${sqlQuote(first)}`, `(value IS NULL OR abs(value) > 1e6)`)}\n` +
        `ORDER BY ${schema.timeColumn}`,
    });
  }
  return snippets;
}
