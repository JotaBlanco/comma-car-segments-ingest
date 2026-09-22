/**
 * The run page's anomalies are the lake's data snippets narrowed to the run, each read
 * for the period, source and note it carries. These pin the pure reading in
 * `lib/snippets/anomalies.ts` against the shape QuixLab writes.
 */
import { describe, expect, it } from "vitest";
import {
  formatFrame,
  filterSnippets,
  formatSpan,
  partitionRunIds,
  searchSnippets,
  snippetFrame,
  snippetNote,
  snippetRuns,
  snippetFacets,
  snippetSource,
  snippetTags,
  withState,
  snippetsForRun,
  sortSnippets,
} from "@/lib/snippets/anomalies";
import type { DataSnippet } from "@/types";

const RUN = "sn002_20250125T150942051Z";
const FOLDER = `platform=sn002/work_order=WO-2025-0110/test_definition=TD-ANALOG-DAQ/run_id=${RUN}/protocol=a429`;
const MD = `# INS1 · inertial_altitude

**1 anomalous reading(s)** for \`inertial_altitude\` on bus INS1 between timestamps 1737821514758 and 1737821514758.
**Partitions:** bus=INS1 · signal=inertial_altitude
**Time:** 1737821514758 - 1737821514900
**Found by:** ai_3 in QuixLab
`;

function snip(over: Partial<DataSnippet> = {}): DataSnippet {
  return {
    id: 7,
    name: "INS1 · inertial_altitude · 1737821514758 - 173",
    sql: `SELECT * FROM pcap_data_v1 WHERE bus = 'INS1' AND signal = 'inertial_altitude' AND timestamp BETWEEN 1737821476758 AND 1737821516759`,
    partitions: [FOLDER],
    markdown: MD,
    tags: ["anomaly"],
    updated_at: "2026-09-15T16:00:37Z",
    ...over,
  };
}

describe("snippetsForRun", () => {
  it("keeps the snippets whose partitions name the run, and SQL-only ones naming it", () => {
    const list = [
      snip({ id: 1 }),
      snip({ id: 2, partitions: [FOLDER.replace(RUN, "sn002_other")] }),
      snip({ id: 3, partitions: [], sql: `SELECT * FROM t WHERE run_id = '${RUN}'` }),
      snip({ id: 4, partitions: [], sql: "SELECT * FROM t" }),
    ];
    expect(snippetsForRun(list, RUN).map((s) => s.id)).toEqual([1, 3]);
    expect(partitionRunIds([FOLDER, "platform=sn002"])).toEqual([RUN]);
  });
});

describe("snippetFrame", () => {
  it("reads the Time line before the padded SQL window", () => {
    expect(snippetFrame(snip())).toEqual({ t0_ms: 1737821514758, t1_ms: 1737821514900 });
  });
  it("falls back to the sentence, then the SQL, and scales other epoch units", () => {
    expect(snippetFrame(snip({ markdown: "Readings between timestamps 1737821514000 and 1737821514500." }))).toEqual({
      t0_ms: 1737821514000,
      t1_ms: 1737821514500,
    });
    expect(snippetFrame(snip({ markdown: "a note" }))).toEqual({ t0_ms: 1737821476758, t1_ms: 1737821516759 });
    expect(snippetFrame(snip({ markdown: "**Time:** 1737821514 - 1737821515" }))).toEqual({
      t0_ms: 1737821514000,
      t1_ms: 1737821515000,
    });
    expect(snippetFrame(snip({ markdown: "", sql: "SELECT 1" }))).toBeNull();
  });
});

describe("snippetSource and snippetNote", () => {
  it("reads the Partitions line, else the SQL, else the name", () => {
    expect(snippetSource(snip())).toEqual({ scope: "bus=INS1", signal: "inertial_altitude" });
    expect(snippetSource(snip({ markdown: "", sql: "SELECT * FROM t WHERE fcc = 2 AND signal = 'x'" }))).toEqual({
      scope: "fcc=2",
      signal: "x",
    });
    expect(snippetSource(snip({ markdown: "", sql: "SELECT 1", name: "INS2 · ground_speed · 1" }))).toEqual({
      scope: "bus=INS2",
      signal: "ground_speed",
    });
  });
  it("takes the first plain sentence, without the heading or the labelled lines", () => {
    expect(snippetNote(MD)).toBe(
      "1 anomalous reading(s) for inertial_altitude on bus INS1 between timestamps 1737821514758 and 1737821514758.",
    );
    expect(snippetNote("")).toBe("");
  });
});

describe("list helpers", () => {
  it("searches every field and sorts by the chosen key", () => {
    const list = [snip({ id: 1, name: "b", updated_at: "2026-01-02" }), snip({ id: 2, name: "a", updated_at: "2026-01-03", partitions: [] })];
    expect(searchSnippets(list, "ground").map((s) => s.id)).toEqual([]);
    expect(searchSnippets(list, "inertial INS1").map((s) => s.id)).toEqual([1, 2]);
    expect(sortSnippets(list, "name", "asc").map((s) => s.id)).toEqual([2, 1]);
    expect(sortSnippets(list, "updated", "desc").map((s) => s.id)).toEqual([2, 1]);
    expect(sortSnippets(list, "partitions", "desc").map((s) => s.id)).toEqual([1, 2]);
  });
  it("formats a period and its span", () => {
    expect(formatFrame({ t0_ms: 1737821514758, t1_ms: 1737821514900 })).toBe("16:11:54.758 → 16:11:54.900 Z");
    expect(formatFrame({ t0_ms: 1737821514758, t1_ms: 1737821514758 })).toBe("16:11:54.758 Z");
    expect(formatSpan({ t0_ms: 0, t1_ms: 142 })).toBe("142 ms");
    expect(formatSpan({ t0_ms: 0, t1_ms: 60_000 * 2 + 5000 })).toBe("2m 05s");
    expect(formatSpan({ t0_ms: 5, t1_ms: 5 })).toBe("instant");
  });
});

describe("QuixLab's tags", () => {
  const QL = ["quixlab-store", "ai_3_store", "ai_3", "anomaly", "open"];
  it("reads the store, the analysis, the kind and the state by position", () => {
    expect(snippetTags(snip({ tags: QL }))).toEqual({
      quixLab: true,
      store: "ai_3_store",
      analysis: "ai_3",
      kind: "anomaly",
      state: "open",
      reference: false,
      other: [],
    });
    expect(snippetTags(snip({ tags: ["quixlab-store", "ai_3_store", "ai_3", "gap", "resolved", "reference"] }))).toMatchObject({
      kind: "gap",
      state: "resolved",
      reference: true,
    });
  });
  it("holds without the analysis id, and falls back to the note's lines", () => {
    expect(snippetTags(snip({ tags: ["quixlab-store", "s1", "drift", "closed"] }))).toMatchObject({
      store: "s1",
      analysis: null,
      kind: "drift",
      state: "closed",
    });
    expect(
      snippetTags(snip({ tags: ["quixlab-store", "s1"], markdown: "**Kind:** outlier\n**State:** resolved\n" })),
    ).toMatchObject({ store: "s1", kind: "outlier", state: "resolved", other: [] });
    expect(snippetTags(snip({ tags: [] }))).toEqual({
      quixLab: false,
      store: null,
      analysis: null,
      kind: "anomaly",
      state: null,
      reference: false,
      other: [],
    });
    expect(snippetTags(snip({ tags: ["anomaly", "mine"] }))).toMatchObject({ quixLab: false, other: ["anomaly", "mine"] });
  });
  it("filters by state, kind and store, and counts the facets", () => {
    const list = [
      snip({ id: 1, tags: QL }),
      snip({ id: 2, tags: ["quixlab-store", "ai_3_store", "ai_3", "gap", "resolved"] }),
      snip({ id: 3, tags: ["quixlab-store", "other_store", "ai_1", "gap", "open"] }),
      snip({ id: 4, tags: [] }),
    ];
    expect(filterSnippets(list, {}).map((s) => s.id)).toEqual([1, 2, 3, 4]);
    expect(filterSnippets(list, { state: "open" }).map((s) => s.id)).toEqual([1, 3]);
    expect(filterSnippets(list, { kind: "gap", store: "ai_3_store" }).map((s) => s.id)).toEqual([2]);
    expect(snippetFacets(list)).toEqual({
      kinds: ["anomaly", "gap"],
      stores: ["ai_3_store", "other_store"],
      states: { open: 2, resolved: 1, closed: 0, none: 1 },
    });
  });
});

describe("snippetRuns and the issue sorts", () => {
  it("takes the run the SQL pins, else the partition folders", () => {
    expect(snippetRuns(snip())).toEqual([RUN]);
    expect(snippetRuns(snip({ sql: "SELECT * FROM t WHERE run_id = 'other' AND run_id = 'other'" }))).toEqual(["other"]);
    expect(snippetRuns(snip({ partitions: [] }))).toEqual([]);
  });
  it("sorts by kind and by state, open first", () => {
    const list = [
      snip({ id: 1, tags: ["quixlab-store", "s", "gap", "closed"] }),
      snip({ id: 2, tags: ["quixlab-store", "s", "anomaly", "open"] }),
      snip({ id: 3, tags: [] }),
      snip({ id: 4, tags: ["quixlab-store", "s", "drift", "resolved"] }),
    ];
    expect(sortSnippets(list, "state", "asc").map((s) => s.id)).toEqual([2, 4, 1, 3]);
    expect(sortSnippets(list, "kind", "asc").map((s) => s.id)).toEqual([2, 3, 4, 1]);
  });
});

describe("moving an issue to another state", () => {
  it("replaces the state tag in place and rewrites the note's line", () => {
    const open = snip({
      tags: ["quixlab-store", "ai_3_store", "ai_3", "gap", "open"],
      markdown: "# One\n\nA finding.\n**Kind:** gap\n**State:** open\n",
    });
    expect(withState(open, "resolved")).toEqual({
      tags: ["quixlab-store", "ai_3_store", "ai_3", "gap", "resolved"],
      markdown: "# One\n\nA finding.\n**Kind:** gap\n**State:** resolved\n",
    });
  });
  it("keeps the reference tag last and adds a line the note never had", () => {
    const ref = snip({ tags: ["quixlab-store", "s1", "gap", "open", "reference"], markdown: "A note." });
    expect(withState(ref, "closed")).toEqual({
      tags: ["quixlab-store", "s1", "gap", "closed", "reference"],
      markdown: "A note.\n**State:** closed\n",
    });
  });
  it("gives a hand-written snippet its first state", () => {
    expect(withState(snip({ tags: [], markdown: "" }), "open")).toEqual({
      tags: ["open"],
      markdown: "\n**State:** open\n",
    });
  });
});
