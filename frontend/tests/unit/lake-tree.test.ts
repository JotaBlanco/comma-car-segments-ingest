/** The lake's hive path as text, and what a folder's column means to the registry. */
import { describe, expect, it } from "vitest";
import {
  displayValue,
  entityKind,
  filtersOf,
  parsePath,
  parseSegment,
  pathOf,
  segmentName,
} from "@/lib/lake/tree";

describe("a folder name", () => {
  it("splits at the first = , so a value may hold one", () => {
    expect(parseSegment("work_order=WO-2026-0915")).toEqual({ column: "work_order", value: "WO-2026-0915" });
    expect(parseSegment("bench_sw=v1=2")).toEqual({ column: "bench_sw", value: "v1=2" });
    expect(parseSegment("run_id=")).toEqual({ column: "run_id", value: "" });
    expect(parseSegment("nothing")).toBeNull();
    expect(parseSegment("=orphan")).toBeNull();
  });
  it("round-trips a path, dropping what is not a folder", () => {
    const path = "platform=AC3/work_order=WO-1";
    expect(pathOf(parsePath(path))).toBe(path);
    expect(parsePath("")).toEqual([]);
    expect(parsePath("platform=AC3//stray/work_order=WO-1")).toEqual([
      { column: "platform", value: "AC3" },
      { column: "work_order", value: "WO-1" },
    ]);
    expect(segmentName({ column: "a", value: "b" })).toBe("a=b");
  });
  it("pins its ancestors as equality filters", () => {
    expect(filtersOf(parsePath("platform=AC3/work_order=WO-1"))).toEqual({
      platform: "AC3",
      work_order: "WO-1",
    });
    expect(filtersOf([])).toEqual({});
  });
  it("reads the lake's two nothing-here spellings as one word", () => {
    expect(displayValue("__None__")).toBe("(none)");
    expect(displayValue("unknown")).toBe("(none)");
    expect(displayValue("")).toBe("(none)");
    expect(displayValue("AC3")).toBe("AC3");
  });
});

describe("what a level means to the registry", () => {
  it("joins by name, whatever the operator spelled it", () => {
    expect(entityKind("work_order")).toBe("work_order");
    expect(entityKind("workOrderId")).toBe("work_order");
    expect(entityKind("test_definition")).toBe("test_definition");
    expect(entityKind("definition")).toBe("test_definition");
    expect(entityKind("platform")).toBe("project");
    expect(entityKind("project")).toBe("project");
  });
  it("knows nothing about a level of its own, so it is shown by its value", () => {
    expect(entityKind("protocol")).toBeNull();
    expect(entityKind("rig")).toBeNull();
    expect(entityKind("run_id")).toBeNull();
  });
});
