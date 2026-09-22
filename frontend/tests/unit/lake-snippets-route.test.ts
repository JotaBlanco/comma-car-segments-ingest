/**
 * The /api/lake/snippets handlers: the mock lake answers the demo rig, and a real call
 * without a viewer token is refused before any credential is read.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as listSnippets, lakeSnippets } from "@/app/api/lake/snippets/route";
import { GET as snippetData, normaliseData } from "@/app/api/lake/snippets/[id]/data/route";
import { PUT as writeSnippet } from "@/app/api/lake/snippets/[id]/route";

const env = process.env;

beforeEach(() => {
  process.env = { ...env };
});

afterEach(() => {
  process.env = env;
});

describe("GET /api/lake/snippets", () => {
  it("answers the mock rig with three findings for the run", async () => {
    process.env.TM_USE_MOCK_API = "1";
    const r = await listSnippets(new Request("http://tm.test/api/lake/snippets?table=pcap_data_v1&run=TAS-1"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { run: string; snippets: { partitions: string[] }[] };
    expect(body.run).toBe("TAS-1");
    expect(body.snippets).toHaveLength(3);
    expect(body.snippets[0].partitions[0]).toContain("run_id=TAS-1");
  });
  it("fills the lake's snippets to the tab's shape: no tags field becomes an empty list", () => {
    const lake = {
      snippets: [
        {
          created_at: "2026-09-15T15:54:06.541046",
          id: 37,
          markdown: "# ai_2_store\n\nNo significant anomalies detected.",
          name: "ai_2_store · 05f0ce19ba9d",
          partitions: ["platform=sn002/run_id=sn002_20260723T131303942Z/protocol=a429"],
          sql: "SELECT * FROM pcap_data_v1",
          updated_at: "2026-09-15T15:54:06.541046",
        },
        { id: "38", name: "bare" },
        { name: "no id" },
        null,
      ],
    };
    const out = lakeSnippets(lake);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 37, tags: [], partitions: ["platform=sn002/run_id=sn002_20260723T131303942Z/protocol=a429"] });
    expect(out[1]).toEqual({
      id: 38,
      name: "bare",
      sql: "",
      partitions: [],
      markdown: "",
      tags: [],
      created_at: undefined,
      updated_at: undefined,
    });
    expect(lakeSnippets({})).toEqual([]);
    expect(lakeSnippets(null)).toEqual([]);
  });
  it("answers every run's findings when no run is named", async () => {
    process.env.TM_USE_MOCK_API = "1";
    const r = await listSnippets(new Request("http://tm.test/api/lake/snippets?table=pcap_data_v1"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { run: string; snippets: { id: number; partitions: string[] }[] };
    expect(body.run).toBe("");
    expect(body.snippets).toHaveLength(6);
    expect(new Set(body.snippets.map((s) => s.id)).size).toBe(6);
    expect(body.snippets.some((s) => s.partitions[0].includes("run_id=sn002_20250125T150942051Z"))).toBe(true);
  });
  it("refuses a bad table and an anonymous real call", async () => {
    delete process.env.TM_USE_MOCK_API;
    delete process.env.TM_TEST_HOOKS;
    expect((await listSnippets(new Request("http://tm.test/api/lake/snippets?table=x;drop&run=r"))).status).toBe(422);
    expect((await listSnippets(new Request("http://tm.test/api/lake/snippets?table=t&run=r"))).status).toBe(401);
    expect((await listSnippets(new Request("http://tm.test/api/lake/snippets?table=t"))).status).toBe(401);
  });
});

describe("GET /api/lake/snippets/{id}/data", () => {
  it("serves mock rows and normalises the lake's column and row shapes", async () => {
    process.env.TM_USE_MOCK_API = "1";
    const r = await snippetData(new Request("http://tm.test/api/lake/snippets/3/data?table=t&limit=5"), {
      params: Promise.resolve({ id: "3" }),
    });
    const body = (await r.json()) as { columns: string[]; rows: string[][]; row_count: number };
    expect(body.columns[0]).toBe("timestamp");
    expect(body.row_count).toBe(5);
    expect(normaliseData({ columns: [{ name: "a" }, "b"], rows: [{ a: 1, b: null }, [2, "x"]] }, 9)).toEqual({
      columns: ["a", "b"],
      rows: [
        ["1", ""],
        ["2", "x"],
      ],
      row_count: 2,
      limit: 9,
    });
  });
});

describe("PUT /api/lake/snippets/{id}", () => {
  const body = (payload: unknown) =>
    new Request("http://tm.test/api/lake/snippets/7", { method: "PUT", body: JSON.stringify(payload) });

  it("answers the mock rig with what it was asked to write", async () => {
    process.env.TM_USE_MOCK_API = "1";
    const r = await writeSnippet(body({ table: "t", tags: ["quixlab-store", "resolved"], markdown: "x" }), {
      params: Promise.resolve({ id: "7" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: 7, tags: ["quixlab-store", "resolved"], markdown: "x" });
  });

  it("refuses a body without the table, the tags or the note, and an anonymous real call", async () => {
    process.env.TM_USE_MOCK_API = "1";
    const params = { params: Promise.resolve({ id: "7" }) };
    expect((await writeSnippet(body({ table: "t", tags: ["a"] }), params)).status).toBe(422);
    expect((await writeSnippet(body({ table: "x;drop", tags: [], markdown: "" }), params)).status).toBe(422);
    delete process.env.TM_USE_MOCK_API;
    delete process.env.TM_TEST_HOOKS;
    expect((await writeSnippet(body({ table: "t", tags: [], markdown: "" }), params)).status).toBe(401);
  });
});
