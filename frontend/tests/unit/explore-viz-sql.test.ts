/**
 * Pure Explore logic (node env — no DOM):
 *  - time_bucket SQL building (Visualise mode) — physical spellings in,
 *    physical spellings out: the builders emit exactly the table and column
 *    names the resolved LakeSchema carries, so what the editor shows is what
 *    the lake receives
 *  - auto bucket-width maths (container px × DPR → ~1 point per pixel)
 *  - CSV export escaping (RFC 4180)
 */

import { describe, expect, it } from "vitest";
import { resolveLakeSchema } from "@/lib/explore/lake-schema";
import {
  BUCKET_STEPS_MS,
  bucketInterval,
  bucketLabel,
  buildSeedSql,
  buildSnippets,
  buildVizSql,
  computeBucketMs,
  sqlQuote,
  VIZ_ROW_LIMIT,
} from "@/lib/explore/viz-sql";
import { escapeCsvField, toCsv } from "@/lib/explore/csv";

/** The v3 physical spelling — ts_ms / file_name (explore_guard._PHYSICAL_COLUMNS). */
const V3 = resolveLakeSchema("test_signal_samples_v3");

describe("sqlQuote", () => {
  it("wraps in single quotes and doubles embedded quotes", () => {
    expect(sqlQuote("brake_temp_FL")).toBe("'brake_temp_FL'");
    expect(sqlQuote("o'neill")).toBe("'o''neill'");
  });
});

describe("computeBucketMs", () => {
  it("targets ~1 point per device pixel and snaps UP to a nice step", () => {
    // 45 min over 1350 device px (675 CSS px × DPR 2) → exactly 2000 ms.
    expect(computeBucketMs(2_700_000, 675, 2)).toBe(2_000);
    // 45 min over 560 device px → raw ≈ 4821 ms → snaps up to 5 s.
    expect(computeBucketMs(2_700_000, 560, 1)).toBe(5_000);
  });

  it("clamps to the smallest step for tiny ranges", () => {
    expect(computeBucketMs(100, 1000, 1)).toBe(BUCKET_STEPS_MS[0]);
  });

  it("falls back to the largest step for very long ranges", () => {
    expect(computeBucketMs(36_000_000, 100, 1)).toBe(BUCKET_STEPS_MS[BUCKET_STEPS_MS.length - 1]);
  });

  it("treats sub-1 DPR as 1 so buckets never exceed one per CSS pixel", () => {
    expect(computeBucketMs(2_700_000, 675, 0.5)).toBe(computeBucketMs(2_700_000, 675, 1));
  });
});

describe("bucketInterval / bucketLabel", () => {
  it("renders millisecond, second and minute intervals", () => {
    expect(bucketInterval(250)).toBe("INTERVAL 250 MILLISECOND");
    expect(bucketInterval(2_000)).toBe("INTERVAL 2 SECOND");
    expect(bucketInterval(120_000)).toBe("INTERVAL 2 MINUTE");
  });

  it("labels match the interval unit", () => {
    expect(bucketLabel(250)).toBe("250 ms");
    expect(bucketLabel(5_000)).toBe("5 s");
    expect(bucketLabel(60_000)).toBe("1 min");
  });
});

describe("buildVizSql", () => {
  it("builds the lakeside time_bucket aggregate for the selected signals", () => {
    const sql = buildVizSql({
      signals: ["brake_temp_FL", "brake_temp_FR"],
      aggregate: "avg",
      bucketMs: 1_000,
    });
    expect(sql).toBe(
      "SELECT signal,\n" +
        "       epoch_ms(time_bucket(INTERVAL 1 SECOND, to_timestamp(timestamp / 1000.0))) AS ts,\n" +
        "       avg(value) AS value\n" +
        "FROM test_signal_samples\n" +
        "WHERE signal IN ('brake_temp_FL', 'brake_temp_FR')\n" +
        "GROUP BY signal, ts\n" +
        "ORDER BY ts\n" +
        "LIMIT 200000",
    );
  });

  it("carries a row-limit backstop even though the bucket maths bounds the count", () => {
    const sql = buildVizSql({ signals: ["brake_temp_FL"], aggregate: "avg", bucketMs: 10 });
    expect(sql.endsWith(`LIMIT ${VIZ_ROW_LIMIT}`)).toBe(true);
  });

  it("adds a BETWEEN window in epoch milliseconds for the drag-zoom re-query", () => {
    const sql = buildVizSql({
      signals: ["brake_temp_FL"],
      aggregate: "max",
      bucketMs: 250,
      timeFrom: "2026-08-14T09:41:07Z",
      timeTo: "2026-08-14T09:52:00Z",
    });
    expect(sql).toContain("max(value) AS value");
    expect(sql).toContain("time_bucket(INTERVAL 250 MILLISECOND, to_timestamp(timestamp / 1000.0))");
    // The time column holds epoch milliseconds, so the window compares
    // milliseconds against milliseconds — never an ISO string.
    expect(sql).toContain(
      `  AND timestamp BETWEEN ${Date.parse("2026-08-14T09:41:07Z")} AND ${Date.parse("2026-08-14T09:52:00Z")}`,
    );
  });

  it("escapes quotes in signal names", () => {
    const sql = buildVizSql({ signals: ["o'neill"], aggregate: "min", bucketMs: 1_000 });
    expect(sql).toContain("WHERE signal IN ('o''neill')");
  });

  it("spells the time column and table the v3 physical way", () => {
    const sql = buildVizSql(
      {
        signals: ["brake_temp_FL"],
        aggregate: "avg",
        bucketMs: 1_000,
        timeFrom: "2026-08-14T09:41:07Z",
        timeTo: "2026-08-14T09:52:00Z",
      },
      V3,
    );
    expect(sql).toContain(
      "epoch_ms(time_bucket(INTERVAL 1 SECOND, to_timestamp(ts_ms / 1000.0))) AS ts",
    );
    expect(sql).toContain("FROM test_signal_samples_v3");
    expect(sql).toContain(
      `  AND ts_ms BETWEEN ${Date.parse("2026-08-14T09:41:07Z")} AND ${Date.parse("2026-08-14T09:52:00Z")}`,
    );
    // Only the identifiers change spelling — never the expression shape.
    // (to_timestamp is the conversion, not a column: the raw word
    // "timestamp" must not appear as an identifier.)
    expect(sql).not.toContain(" timestamp ");
  });
});

describe("buildSeedSql / buildSnippets", () => {
  it("seeds a raw first-look at the samples with its own LIMIT and no comment", () => {
    const sql = buildSeedSql();
    // The real guard rejects comments — the seed must run as-is on the lake.
    expect(sql).not.toContain("--");
    expect(sql.startsWith("SELECT signal, timestamp, value, filename")).toBe(true);
    expect(sql).toContain("ORDER BY timestamp");
    expect(sql.trimEnd().endsWith("LIMIT 100")).toBe(true);
  });

  it("carries no WHERE without a run id — valid for any run", () => {
    expect(buildSeedSql()).not.toContain("WHERE");
  });

  it("scopes the seed to the run when a run id is passed (direct lake path)", () => {
    expect(buildSeedSql(V3, "TAS-88214")).toBe(
      "SELECT signal, ts_ms, value, file_name\n" +
        "FROM test_signal_samples_v3\n" +
        "WHERE run_id = 'TAS-88214'\n" +
        "ORDER BY ts_ms\n" +
        "LIMIT 100",
    );
  });

  it("seeds with the fallback physical spellings when no schema is passed", () => {
    expect(buildSeedSql(undefined, "TAS-88214")).toBe(
      "SELECT signal, timestamp, value, filename\n" +
        "FROM test_signal_samples\n" +
        "WHERE run_id = 'TAS-88214'\n" +
        "ORDER BY timestamp\n" +
        "LIMIT 100",
    );
  });

  it("parameterises snippets with real signal names", () => {
    const snippets = buildSnippets(["sig_one", "sig_two"]);
    const compare = snippets.find((snippet) => snippet.label === "Compare sig_one / sig_two");
    expect(compare?.sql).toContain("WHERE signal IN ('sig_one', 'sig_two')");
    const overTime = snippets.find((snippet) => snippet.label === "Signal over time");
    expect(overTime?.sql).toContain("WHERE signal = 'sig_one'");
  });

  it("spells every snippet with the resolved schema's physical names", () => {
    const snippets = buildSnippets(["sig_one", "sig_two"], V3);
    for (const snippet of snippets) {
      expect(snippet.sql).toContain("FROM test_signal_samples_v3");
      expect(snippet.sql).not.toContain(" timestamp ");
      expect(snippet.sql).not.toContain("filename");
    }
    const overTime = snippets.find((snippet) => snippet.label === "Signal over time");
    expect(overTime?.sql).toContain("SELECT ts_ms, value");
    expect(overTime?.sql).toContain("ORDER BY ts_ms");
  });
});

describe("CSV export escaping", () => {
  it("passes plain fields through untouched", () => {
    expect(escapeCsvField("brake_temp_FL")).toBe("brake_temp_FL");
  });

  it("quotes fields containing commas, quotes or line breaks", () => {
    expect(escapeCsvField("x,y")).toBe('"x,y"');
    expect(escapeCsvField('he said "hi"')).toBe('"he said ""hi"""');
    expect(escapeCsvField("line\nbreak")).toBe('"line\nbreak"');
  });

  it("exports null cells as empty fields — never a placeholder glyph", () => {
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField(undefined)).toBe("");
  });

  it("builds the full document with a header row and CRLF endings", () => {
    const csv = toCsv(
      [{ name: "signal" }, { name: "value" }],
      [
        ["a,b", "1.5"],
        [null, 'say "hi"'],
      ],
    );
    expect(csv).toBe('signal,value\r\n"a,b",1.5\r\n,"say ""hi"""\r\n');
  });
});

describe("run scope on the direct lake path", () => {
  it("buildVizSql states the run scope first, then the signal filter", () => {
    const sql = buildVizSql(
      { signals: ["sig_one"], aggregate: "avg", bucketMs: 1_000, runId: "TAS-88214" },
      V3,
    );
    expect(sql).toContain("WHERE run_id = 'TAS-88214'\n  AND signal IN ('sig_one')");
  });

  it("every snippet carries the run scope when a run id is passed", () => {
    const snippets = buildSnippets(["sig_one", "sig_two"], V3, "TAS-88214");
    for (const snippet of snippets) {
      expect(snippet.sql).toContain("run_id = 'TAS-88214'");
    }
  });
});
