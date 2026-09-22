/**
 * Workbooks: saved station dashboards kept in this browser. The store never throws on a
 * blocked storage, never interprets a layout, and links a workbook to a run and a period.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkbook,
  deleteWorkbook,
  listWorkbooks,
  renameWorkbook,
  resetWorkbooksForTests,
  setWorkbookLayout,
  setWorkbookSessions,
  workbookHref,
  WORKBOOKS_KEY,
} from "@/lib/workbooks";

function stubStorage(): Record<string, string> {
  const store: Record<string, string> = {};
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
  });
  return store;
}

beforeEach(() => resetWorkbooksForTests());
afterEach(() => vi.unstubAllGlobals());

describe("workbooks", () => {
  it("creates, renames, keeps the station's layout, and deletes", () => {
    const store = stubStorage();
    const w = createWorkbook("  Approach checks ");
    expect(w).not.toBeNull();
    expect(listWorkbooks().map((x) => x.name)).toEqual(["Approach checks"]);
    const layout = [{ id: "map", kind: "map", x: 0, y: 0, w: 6, h: 9 }];
    setWorkbookLayout(w!.id, layout);
    setWorkbookLayout(w!.id, "not a list");
    expect(listWorkbooks()[0].layout).toEqual(layout);
    renameWorkbook(w!.id, "");
    expect(listWorkbooks()[0].name).toBe("Untitled workbook");
    setWorkbookSessions(w!.id, ["r1", "r1", "", "r2"]);
    expect(listWorkbooks()[0].sessions).toEqual(["r1", "r2"]);
    expect(JSON.parse(store[WORKBOOKS_KEY]).workbooks).toHaveLength(1);
    deleteWorkbook(w!.id);
    expect(listWorkbooks()).toEqual([]);
  });
  it("reads what a previous session stored and drops what is not a workbook", () => {
    const store = stubStorage();
    store[WORKBOOKS_KEY] = JSON.stringify({
      v: 1,
      workbooks: [
        { id: "a", name: "A", layout: [], created_at: 1, updated_at: 2 },
        { id: "b", name: "B", layout: "x", created_at: 1, updated_at: 2 },
        null,
      ],
    });
    expect(listWorkbooks().map((w) => w.id)).toEqual(["a"]);
    // A row saved before sessions existed reads as having none.
    expect(listWorkbooks()[0].sessions).toEqual([]);
  });
  it("survives a blocked storage", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {},
      },
    });
    const w = createWorkbook("Mine");
    expect(w).not.toBeNull();
    expect(listWorkbooks()).toHaveLength(1);
  });
  it("links a workbook to a run, its signals and a period", () => {
    expect(workbookHref("w1")).toBe("/workbooks/w1");
    expect(
      workbookHref("w 1", { run: "r1", signals: ["alt", "spd"], frame: { t0_ms: 10, t1_ms: 10 }, issue: 7 }),
    ).toBe("/workbooks/w%201?run=r1&signal=alt&signal=spd&t=10&sel=10%2C11&issue=7");
  });
});
