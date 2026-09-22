/**
 * Opening the Explorer on a run or an issue: the link, its reading, and the layout it
 * becomes, rooted on the run's partition folder with the period as the range.
 *
 * Which levels address a session and which lie inside one is configuration
 * (`TM_LAKE_SESSION_PARTITIONS` / `TM_LAKE_DATA_PARTITIONS`), so each case
 * states the shape it is about instead of passing a column list around.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { setLakePartitions } from "@/lib/explore/lake-partitions";
import {
  exploreHref,
  exploreRange,
  readExploreEntry,
  resolveExploreLayout,
  resolveRoots,
  rootPath,
  signalPath,
} from "@/lib/explore/entry";

const SESSION = "platform,work_order,test_definition,run_id";
const DATA = "protocol,~bus,~signal";
const COMBO = { platform: "sn002", work_order: "WO-1", test_definition: "TD-1", run_id: "r1", protocol: "a429", bus: "INS1", signal: "alt" };

beforeEach(() => {
  setLakePartitions(SESSION, DATA);
});

describe("the link", () => {
  it("round-trips the run, the scope, the signal and the period", () => {
    const href = exploreHref({ run: "r1", scope: "bus=INS1", signal: "alt", frame: { t0_ms: 10, t1_ms: 20 } });
    expect(href).toBe("/explore?run=r1&scope=bus%3DINS1&signal=alt&t0=10&t1=20");
    expect(readExploreEntry(new URLSearchParams(href.slice("/explore?".length)))).toEqual({
      run: "r1",
      scope: "bus=INS1",
      signal: "alt",
      frame: { t0_ms: 10, t1_ms: 20 },
    });
    expect(readExploreEntry(new URLSearchParams("run=r1&t0=x"))).toEqual({ run: "r1", scope: null, signal: null });
    expect(readExploreEntry(new URLSearchParams(""))).toBeNull();
  });
  it("widens a short period into a window", () => {
    const r = exploreRange({ t0_ms: 100_000, t1_ms: 100_000 });
    expect(r.to - r.from).toBeGreaterThanOrEqual(10_000);
    const wide = exploreRange({ t0_ms: 0, t1_ms: 600_000 });
    expect(wide.from).toBeLessThan(0);
    expect(wide.to).toBeGreaterThan(600_000);
  });
});

describe("the root folder and the signal path", () => {
  it("reaches the session from the combination, and the signal beneath it from the issue", () => {
    expect(rootPath(COMBO, "r1")).toBe("platform=sn002/work_order=WO-1/test_definition=TD-1/run_id=r1");
    expect(rootPath({}, "r1")).toBe("platform=__None__/work_order=__None__/test_definition=__None__/run_id=r1");
    expect(signalPath({ run: "r1", scope: "bus=INS1", signal: "alt" })).toBe("protocol=a429/bus=INS1/signal=alt");
    expect(signalPath({ run: "r1" })).toBe("");
  });
  it("skips a data level the issue does not name, because the lake indexes none either", () => {
    // An FTO issue under a table whose data levels are protocol/bus/signal:
    // the file carries no `bus`, so the tree's own path for that signal has
    // none. Bailing out here used to leave every such issue un-ticked.
    expect(signalPath({ run: "r1", scope: "fcc=2", signal: "pitch" })).toBe("protocol=fto/signal=pitch");
    setLakePartitions(SESSION, "protocol,fcc,signal");
    expect(signalPath({ run: "r1", scope: "fcc=2", signal: "pitch" })).toBe("protocol=fto/fcc=2/signal=pitch");
  });
  it("follows an estate with another shape, stated in the variables", () => {
    setLakePartitions("site/rig/session", "channel,signal");
    expect(rootPath({ site: "hangar", rig: "sn9" }, "s-1")).toBe("site=hangar/rig=sn9/session=s-1");
    expect(signalPath({ run: "s-1", scope: "channel=c2", signal: "alt" })).toBe("channel=c2/signal=alt");
  });
});

describe("the layout", () => {
  it("ticks the issue's signal and takes the period, without asking the lake", async () => {
    const layout = await resolveExploreLayout(
      { run: "r1", scope: "bus=INS1", signal: "alt", frame: { t0_ms: 50_000, t1_ms: 60_000 } },
      "pcap_data_v1",
    );
    expect(layout.table).toBe("pcap_data_v1");
    expect(layout.signals).toEqual([{ id: "protocol=a429/bus=INS1/signal=alt", name: "alt" }]);
    expect(layout.range?.mode).toBe("absolute");
  });
  it("opens on the table alone when the entry names no signal", async () => {
    expect(await resolveExploreLayout({ run: "r1" }, "t")).toEqual({ table: "t" });
  });
});

describe("the roots of the sessions", () => {
  it("gives one folder per run the lake knows, asked for by the session column", async () => {
    const asked: string[] = [];
    const get = async (url: string) => {
      asked.push(url);
      if (url.includes("r2")) throw new Error("gone");
      return { combinations: [{ ...COMBO, run_id: "r1" }] };
    };
    expect(await resolveRoots(["r1", "r2"], "t", get)).toEqual([
      "platform=sn002/work_order=WO-1/test_definition=TD-1/run_id=r1",
    ]);
    expect(asked[0]).toContain(encodeURIComponent(JSON.stringify({ run_id: "r1" })));
    expect(await resolveRoots([], "t", get)).toEqual([]);
    expect(await resolveRoots(["r1"], "t", async () => ({}))).toEqual([]);
  });
});
