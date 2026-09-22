/**
 * The seven `/api/lake/*` answers QuixLab's Explorer provider reads, on the mock rig, and
 * the refusal an anonymous real call gets in the provider's own shape.
 *
 * Two of them also feed the sessions dialog's tree, so the mock rig folds the
 * seeded runs into the session address instead of answering nothing: a
 * developer running the front end alone, and the e2e suite, both pick sessions
 * from it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as tables } from "@/app/api/lake/tables/route";
import { GET as partitions } from "@/app/api/lake/partitions/route";
import { GET as schema } from "@/app/api/lake/schema/route";
import { GET as partitionInfo } from "@/app/api/lake/partition-info/route";
import { GET as partitionValues } from "@/app/api/lake/partition-values/route";
import { GET as combinations } from "@/app/api/lake/partition-combinations/route";
import { POST as preview } from "@/app/api/lake/preview/route";
import { cellValue, parseCsv, toRecords } from "@/lib/lake/console";
import { getDb } from "@/lib/mock/db";

const env = process.env;
beforeEach(() => {
  process.env = { ...env, TM_USE_MOCK_API: "1" };
});
afterEach(() => {
  process.env = env;
});

const get = (path: string) => new Request(`http://tm.test${path}`);

describe("the Explorer's lake answers on the mock rig", () => {
  it("lists the one table, its columns, and no partitions", async () => {
    const t = (await (await tables(get("/api/lake/tables?include_metadata=false"))).json()) as { tables: { name: string }[] };
    expect(t.tables).toHaveLength(1);
    const table = t.tables[0].name;
    const s = (await (await schema(get(`/api/lake/schema?table=${table}`))).json()) as { columns: { name: string; type: string }[] };
    expect(s.columns.map((c) => c.name)).toContain("timestamp");
    expect(s.columns.find((c) => c.name === "timestamp")?.type).toBe("BIGINT");
    const info = (await (await partitionInfo(get(`/api/lake/partition-info?table=${table}`))).json()) as { partition_columns: string[] };
    expect(info.partition_columns).toEqual([]);
    expect((await (await combinations(get(`/api/lake/partition-combinations?table=${table}`))).json()) as unknown).toEqual({ combinations: [] });
  });
  it("folds the seeded runs into the session tree the dialog walks", async () => {
    const table = "test_signal_samples";
    const level = (await (await partitions(get(`/api/lake/partitions?table=${table}&path=`))).json()) as {
      partitions: { name: string; path: string; has_children: boolean }[];
    };
    // The first level of the default session address, one folder per project.
    const projects = [...new Set(getDb().runs.map((r) => r.project ?? "__None__"))].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
    expect(level.partitions.map((p) => p.name)).toEqual(projects.map((p) => `platform=${p}`));
    expect(level.partitions.every((p) => p.has_children)).toBe(true);

    // And the sessions under one of them are that project's runs, by id.
    const first = level.partitions[0];
    const under = (await (
      await partitionValues(
        get(
          `/api/lake/partition-values?table=${table}&column=run_id&where=${encodeURIComponent(
            JSON.stringify({ platform: first.name.slice("platform=".length) }),
          )}`,
        ),
      )
    ).json()) as { values: string[] };
    const expected = getDb()
      .runs.filter((r) => (r.project ?? "__None__") === first.name.slice("platform=".length))
      .map((r) => r.run_id)
      .sort();
    expect(under.values).toEqual(expected);
    expect(under.values.length).toBeGreaterThan(0);

    // A level INSIDE a session is the Explorer's half: the mock holds none.
    expect((await (await partitionValues(get(`/api/lake/partition-values?table=${table}&column=signal`))).json()) as unknown).toEqual({ values: [], fast: true });
  });
  it("previews a SELECT as records with numbers, and reports a bad statement as an error field", async () => {
    const t = (await (await tables(get("/api/lake/tables"))).json()) as { tables: { name: string }[] };
    const table = t.tables[0].name;
    const r = await preview(
      new Request("http://tm.test/api/lake/preview", {
        method: "POST",
        body: JSON.stringify({ query: `SELECT * FROM ${table}`, max_rows: 5 }),
      }),
    );
    const body = (await r.json()) as { columns: string[]; rows: Record<string, unknown>[]; shape: number[]; error: null };
    expect(body.error).toBeNull();
    expect(body.rows.length).toBeLessThanOrEqual(5);
    expect(body.shape).toEqual([body.rows.length, body.columns.length]);
    // The mock answers aggregates per signal; its numeric columns read as numbers.
    const numeric = body.columns.find((c) => typeof body.rows[0]?.[c] === "number");
    expect(numeric).toBeDefined();
    const bad = (await (await preview(new Request("http://tm.test/api/lake/preview", { method: "POST", body: JSON.stringify({ query: "DROP TABLE x" }) }))).json()) as { error: string };
    expect(bad.error).toMatch(/read-only|DROP/i);
  });
  it("refuses a bad table before anything else", async () => {
    expect((await schema(get("/api/lake/schema?table=x;drop"))).status).toBe(422);
    expect((await partitionValues(get("/api/lake/partition-values?table=t"))).status).toBe(422);
  });
});

describe("the Explorer's lake answers for real", () => {
  it("refuses an anonymous viewer in the provider's shape", async () => {
    delete process.env.TM_USE_MOCK_API;
    delete process.env.TM_TEST_HOOKS;
    const r = await tables(get("/api/lake/tables"));
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ tables: [], error: expect.stringContaining("signed-in") });
  });
});

describe("rows as records", () => {
  it("reads numbers as numbers, blanks as null, and the rest as text", () => {
    expect(cellValue("1.5e3")).toBe(1500);
    expect(cellValue("")).toBeNull();
    expect(cellValue("INS1")).toBe("INS1");
    expect(cellValue("007")).toBe(7);
    const rows = parseCsv('a,b\n1,"x, y"\n,\n');
    expect(toRecords(rows[0], rows.slice(1))).toEqual({
      columns: ["a", "b"],
      rows: [
        { a: 1, b: "x, y" },
        { a: null, b: null },
      ],
    });
  });
});
