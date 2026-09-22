/**
 * The Explorer's provider over several sessions: every path is asked under each picked run,
 * levels merge by folder, and a signal's frames merge bucket by bucket.
 */
import { describe, expect, it } from "vitest";
import { mergeFrames, mergeLevels, mergedProvider, under, type Frame, type LakeProvider } from "@/lib/explore/merged-provider";

const R1 = "platform=sn002/run_id=r1";
const R2 = "platform=sn002/run_id=r2";

function fake(): { calls: string[]; provider: LakeProvider } {
  const calls: string[] = [];
  const provider: LakeProvider = {
    async children(path) {
      calls.push(`children ${path}`);
      if (path === R1) return [{ value: "a429", seg: "protocol=a429", leaf: false, count: 2 }, { value: "fto", seg: "protocol=fto", leaf: false, count: 1 }];
      if (path === R2) return [{ value: "a429", seg: "protocol=a429", leaf: false, count: 3 }, { value: "analog", seg: "protocol=analog", leaf: false, count: 1 }];
      if (path.endsWith("run_id=r1/protocol=a429/bus=INS1")) return [{ value: "alt", seg: "signal=alt", leaf: true }];
      if (path.endsWith("run_id=r2/protocol=a429/bus=INS1")) return [{ value: "alt", seg: "signal=alt", leaf: true }, { value: "spd", seg: "signal=spd", leaf: true }];
      throw new Error(`no ${path}`);
    },
    async frames(ids, q) {
      calls.push(`frames ${ids.join(",")} ${JSON.stringify(q.cols)}`);
      const out: Record<string, Frame> = {};
      for (const id of ids) {
        if (id.includes("run_id=r1")) out[id] = { min: [1, NaN], max: [3, NaN], mean: [2, NaN], count: [2, 0] };
        if (id.includes("run_id=r2")) out[id] = { min: [NaN, 10], max: [NaN, 30], mean: [NaN, 20], count: [0, 4] };
      }
      return out;
    },
    async extent(ids) {
      return ids[0].includes("r1") ? { t0: 100, t1: 200 } : { t0: 500, t1: 600 };
    },
    async units(ids) {
      return ids.map((id) => ({ id, unit: id.includes("r1") ? "ft" : "" }));
    },
    meta(id) {
      return { name: id };
    },
  };
  return { calls, provider };
}

describe("merged provider", () => {
  it("joins paths under a root", () => {
    expect(under(R1, "")).toBe(R1);
    expect(under(R1, "/protocol=a429")).toBe(`${R1}/protocol=a429`);
  });
  it("merges a level by folder, summing counts, and answers nothing without a session", async () => {
    const { provider } = fake();
    const merged = mergedProvider(provider, () => [R1, R2]);
    expect(await merged.children("")).toEqual([
      { value: "a429", seg: "protocol=a429", leaf: false, count: 5 },
      { value: "analog", seg: "protocol=analog", leaf: false, count: 1 },
      { value: "fto", seg: "protocol=fto", leaf: false, count: 1 },
    ]);
    expect((await merged.children("protocol=a429/bus=INS1")).map((n) => n.value)).toEqual(["alt", "spd"]);
    expect(await mergedProvider(provider, () => []).children("")).toEqual([]);
  });
  it("merges one signal's frames across the runs, bucket by bucket", async () => {
    const { provider, calls } = fake();
    const merged = mergedProvider(provider, () => [R1, R2]);
    const id = "protocol=a429/bus=INS1/signal=alt";
    const out = await merged.frames([id], { t0: 0, t1: 1000, buckets: 2, cols: { [id]: "value" } });
    expect(out[id]).toEqual({ min: [1, 10], max: [3, 30], mean: [2, 20], count: [2, 4] });
    expect(calls.filter((c) => c.startsWith("frames"))).toHaveLength(2);
    expect(calls.find((c) => c.includes("run_id=r1/protocol=a429/bus=INS1/signal=alt"))).toContain('"value"');
    expect(await merged.extent!([id])).toEqual({ t0: 100, t1: 600 });
    expect(await merged.units!([id], { unit: "unit" })).toEqual({ [id]: "ft" });
    expect(merged.meta!(id)).toEqual({ name: `${R1}/${id}` });
  });
  it("keeps the first frame's empty values where no run has samples", () => {
    expect(mergeFrames([{ min: [NaN], max: [NaN], mean: [NaN], count: [0] }])).toEqual({ min: [NaN], max: [NaN], mean: [NaN], count: [0] });
    expect(mergeFrames([])).toBeNull();
    expect(mergeLevels([[{ value: "b", leaf: false }], [{ value: "a", leaf: false }]]).map((n) => n.value)).toEqual(["a", "b"]);
  });
});
