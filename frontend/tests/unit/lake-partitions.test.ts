/**
 * The two variables that split the lake's partition tree between the pickers:
 * which folders ADDRESS a session, and which lie INSIDE one.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DATA_PARTITIONS,
  DEFAULT_SESSION_PARTITIONS,
  dataColumns,
  parsePartitionColumns,
  sessionColumn,
  sessionColumns,
  sessionColumnsOf,
  sessionTreeColumns,
  setLakePartitions,
} from "@/lib/explore/lake-partitions";

beforeEach(() => {
  setLakePartitions("", "");
});

describe("reading a variable", () => {
  it("takes a comma or a slash, and strips the sink's virtual marker", () => {
    expect(parsePartitionColumns("platform,work_order,run_id")).toEqual([
      "platform",
      "work_order",
      "run_id",
    ]);
    expect(parsePartitionColumns(" protocol , ~bus ,~stream, ~fcc ,~signal ")).toEqual([
      "protocol",
      "bus",
      "stream",
      "fcc",
      "signal",
    ]);
    // A pasted path is a path: the folder spelling reads as its column.
    expect(parsePartitionColumns("site/rig/session=")).toEqual(["site", "rig", "session"]);
  });
  it("drops what could never be a partition column", () => {
    expect(parsePartitionColumns("")).toEqual([]);
    expect(parsePartitionColumns(null)).toEqual([]);
    expect(parsePartitionColumns("ok,,2bad,drop table,fine_1")).toEqual(["ok", "fine_1"]);
  });
});

describe("the split the two pickers read", () => {
  it("falls back to this estate's own shape when neither is set", () => {
    expect(sessionColumns()).toEqual(DEFAULT_SESSION_PARTITIONS);
    expect(dataColumns()).toEqual(DEFAULT_DATA_PARTITIONS);
    expect(sessionColumn()).toBe("run_id");
    expect(sessionTreeColumns()).toEqual(["platform", "work_order", "test_definition"]);
  });
  it("takes another estate's shape, the last session level being the session", () => {
    setLakePartitions("site,rig,session", "channel,~signal");
    expect(sessionColumn()).toBe("session");
    expect(sessionTreeColumns()).toEqual(["site", "rig"]);
    expect(dataColumns()).toEqual(["channel", "signal"]);
  });
  it("leaves the tree with no levels when the session IS the first folder", () => {
    setLakePartitions("run_id", "signal");
    expect(sessionColumn()).toBe("run_id");
    expect(sessionTreeColumns()).toEqual([]);
  });
  it("ignores an unusable value rather than picking sessions out of nothing", () => {
    setLakePartitions("   ", ",,");
    expect(sessionColumns()).toEqual(DEFAULT_SESSION_PARTITIONS);
    expect(dataColumns()).toEqual(DEFAULT_DATA_PARTITIONS);
  });
  it("lets the server fall back without the provider's module state", () => {
    expect(sessionColumnsOf([])).toEqual(DEFAULT_SESSION_PARTITIONS);
    expect(sessionColumnsOf(["a", "b"])).toEqual(["a", "b"]);
  });
});
