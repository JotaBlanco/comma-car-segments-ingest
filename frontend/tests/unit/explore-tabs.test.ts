/**
 * Explore workbench tab state machine (lib/explore/tabs.ts).
 * Node env — persistence runs against the in-memory localStorage shim.
 *
 *  - creation numbers titles per kind; only the bootstrap tab carries the
 *    seed query — explicitly created SQL tabs start empty
 *  - the last tab never closes; closing the active tab activates the left
 *    neighbour; a closed tab's SQL entry is dropped
 *  - the 8-tab cap makes creation a no-op
 *  - persistence round-trips, discards version mismatches, and repairs
 *    referentially broken payloads instead of bricking
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_EXPLORE_TABS,
  MAX_TAB_TITLE,
  TABS_VERSION,
  exploreTabsReducer,
  loadTabsState,
  nextTitle,
  saveTabsState,
  seedTabsState,
  tabsStorageKey,
  type ExploreTabsState,
} from "@/lib/explore/tabs";
import { buildSeedSql } from "@/lib/explore/viz-sql";
import { installLocalStorage } from "./support/local-storage";

installLocalStorage();

const RUN = "TAS-88214";

beforeEach(() => {
  localStorage.clear();
});

describe("seedTabsState", () => {
  it("starts with one SQL tab carrying the seed query", () => {
    const state = seedTabsState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].kind).toBe("sql");
    expect(state.tabs[0].title).toBe("SQL query 1");
    expect(state.activeId).toBe(state.tabs[0].id);
    expect(state.sqlByTab[state.tabs[0].id]).toBe(buildSeedSql());
  });
});

describe("create", () => {
  it("numbers titles max+1 per kind and activates the new tab", () => {
    let state = seedTabsState();
    state = exploreTabsReducer(state, { type: "create", kind: "sql" });
    expect(state.tabs[1].title).toBe("SQL query 2");
    expect(state.activeId).toBe(state.tabs[1].id);

    state = exploreTabsReducer(state, { type: "create", kind: "viz" });
    expect(state.tabs[2].title).toBe("Visualisation 1");
  });

  it("does not reuse a closed tab's number", () => {
    let state = seedTabsState();
    state = exploreTabsReducer(state, { type: "create", kind: "sql" }); // SQL query 2
    state = exploreTabsReducer(state, { type: "close", id: state.tabs[0].id });
    state = exploreTabsReducer(state, { type: "create", kind: "sql" });
    expect(state.tabs[1].title).toBe("SQL query 3");
  });

  it("seeds a new SQL tab with the provided SQL, else starts it empty", () => {
    let state = seedTabsState();
    state = exploreTabsReducer(state, { type: "create", kind: "sql", sql: "SELECT 1" });
    expect(state.sqlByTab[state.activeId]).toBe("SELECT 1");
    // Only the bootstrap tab carries the seed query — an explicit "+" create
    // starts empty (the editor shows its placeholder).
    state = exploreTabsReducer(state, { type: "create", kind: "sql" });
    expect(state.sqlByTab[state.activeId]).toBe("");
  });

  it("is a no-op at the cap", () => {
    let state = seedTabsState();
    for (let index = 0; index < MAX_EXPLORE_TABS + 2; index += 1) {
      state = exploreTabsReducer(state, { type: "create", kind: "sql" });
    }
    expect(state.tabs).toHaveLength(MAX_EXPLORE_TABS);
  });

  it("gives ai and viz tabs no sqlByTab entry", () => {
    let state = seedTabsState();
    state = exploreTabsReducer(state, { type: "create", kind: "ai" });
    state = exploreTabsReducer(state, { type: "create", kind: "viz" });
    expect(Object.keys(state.sqlByTab)).toHaveLength(1);
  });
});

describe("close", () => {
  it("refuses to close the last tab", () => {
    const state = seedTabsState();
    expect(exploreTabsReducer(state, { type: "close", id: state.tabs[0].id })).toBe(state);
  });

  it("activates the left neighbour when the active tab closes", () => {
    let state = seedTabsState();
    state = exploreTabsReducer(state, { type: "create", kind: "sql" });
    state = exploreTabsReducer(state, { type: "create", kind: "sql" });
    const middle = state.tabs[1];
    state = exploreTabsReducer(state, { type: "activate", id: middle.id });
    state = exploreTabsReducer(state, { type: "close", id: middle.id });
    expect(state.activeId).toBe(state.tabs[0].id);
    expect(state.sqlByTab[middle.id]).toBeUndefined();
  });

  it("keeps the active tab when a background tab closes", () => {
    let state = seedTabsState();
    state = exploreTabsReducer(state, { type: "create", kind: "sql" });
    const active = state.activeId;
    state = exploreTabsReducer(state, { type: "close", id: state.tabs[0].id });
    expect(state.activeId).toBe(active);
  });
});

describe("rename", () => {
  it("renames a tab, trimming whitespace", () => {
    let state = seedTabsState();
    const id = state.tabs[0].id;
    state = exploreTabsReducer(state, { type: "rename", id, title: "  traction study  " });
    expect(state.tabs[0].title).toBe("traction study");
  });

  it("ignores empty and whitespace-only titles", () => {
    const state = seedTabsState();
    const id = state.tabs[0].id;
    expect(exploreTabsReducer(state, { type: "rename", id, title: "" })).toBe(state);
    expect(exploreTabsReducer(state, { type: "rename", id, title: "   " })).toBe(state);
  });

  it("caps the title length", () => {
    let state = seedTabsState();
    const id = state.tabs[0].id;
    state = exploreTabsReducer(state, { type: "rename", id, title: "x".repeat(100) });
    expect(state.tabs[0].title).toHaveLength(MAX_TAB_TITLE);
  });

  it("ignores an unknown tab id", () => {
    const state = seedTabsState();
    expect(exploreTabsReducer(state, { type: "rename", id: "gone", title: "x" })).toBe(state);
  });

  it("persists a custom title through the localStorage round-trip untouched", () => {
    let state = seedTabsState();
    const id = state.tabs[0].id;
    state = exploreTabsReducer(state, { type: "rename", id, title: "traction study" });
    saveTabsState(RUN, state);
    expect(loadTabsState(RUN).tabs[0].title).toBe("traction study");
  });

  it("keeps default numbering sane after a rename", () => {
    let state = seedTabsState(); // SQL query 1
    state = exploreTabsReducer(state, { type: "create", kind: "sql" }); // SQL query 2
    state = exploreTabsReducer(state, {
      type: "rename",
      id: state.tabs[1].id,
      title: "traction study",
    });
    // The renamed tab drops out of the pattern scan — max+1 over the rest.
    state = exploreTabsReducer(state, { type: "create", kind: "sql" });
    expect(state.tabs[2].title).toBe("SQL query 2");
  });
});

describe("reorder", () => {
  /** Three tabs: SQL query 1 / SQL query 2 / Visualisation 1. */
  function threeTabs(): ExploreTabsState {
    let state = seedTabsState();
    state = exploreTabsReducer(state, { type: "create", kind: "sql" });
    state = exploreTabsReducer(state, { type: "create", kind: "viz" });
    return state;
  }

  it("moves a tab to the target index without touching activeId", () => {
    let state = threeTabs();
    const active = state.activeId;
    const first = state.tabs[0].id;
    state = exploreTabsReducer(state, { type: "reorder", id: first, index: 2 });
    expect(state.tabs.map((tab) => tab.title)).toEqual([
      "SQL query 2",
      "Visualisation 1",
      "SQL query 1",
    ]);
    expect(state.activeId).toBe(active);
  });

  it("clamps out-of-range indices to the ends", () => {
    let state = threeTabs();
    const last = state.tabs[2].id;
    state = exploreTabsReducer(state, { type: "reorder", id: last, index: -5 });
    expect(state.tabs[0].id).toBe(last);
    state = exploreTabsReducer(state, { type: "reorder", id: last, index: 99 });
    expect(state.tabs[2].id).toBe(last);
  });

  it("is a no-op for an unknown id and for a same-slot move", () => {
    const state = threeTabs();
    expect(exploreTabsReducer(state, { type: "reorder", id: "gone", index: 0 })).toBe(state);
    expect(
      exploreTabsReducer(state, { type: "reorder", id: state.tabs[1].id, index: 1 }),
    ).toBe(state);
  });

  it("persists the new order through the localStorage round-trip", () => {
    let state = threeTabs();
    state = exploreTabsReducer(state, { type: "reorder", id: state.tabs[0].id, index: 2 });
    saveTabsState(RUN, state);
    expect(loadTabsState(RUN).tabs.map((tab) => tab.id)).toEqual(
      state.tabs.map((tab) => tab.id),
    );
  });

  it("repair keeps a stored non-creation order — it never resorts", () => {
    // A payload that NEEDS repair (dangling activeId) with viz first: the
    // load must fix the reference and leave the order exactly as stored.
    localStorage.setItem(
      tabsStorageKey(RUN),
      JSON.stringify({
        v: TABS_VERSION,
        tabs: [
          { id: "c", kind: "viz", title: "Visualisation 1" },
          { id: "a", kind: "sql", title: "SQL query 1" },
          { id: "b", kind: "sql", title: "SQL query 2" },
        ],
        activeId: "gone",
        sqlByTab: { a: "SELECT 1", b: "SELECT 2" },
      }),
    );
    const state = loadTabsState(RUN);
    expect(state.tabs.map((tab) => tab.id)).toEqual(["c", "a", "b"]);
    expect(state.activeId).toBe("c");
  });
});

describe("setSql", () => {
  it("updates the tab's SQL", () => {
    let state = seedTabsState();
    const id = state.tabs[0].id;
    state = exploreTabsReducer(state, { type: "setSql", id, sql: "SELECT 2" });
    expect(state.sqlByTab[id]).toBe("SELECT 2");
  });

  it("never resurrects a closed tab", () => {
    let state = seedTabsState();
    state = exploreTabsReducer(state, { type: "create", kind: "sql" });
    const closed = state.tabs[0].id;
    state = exploreTabsReducer(state, { type: "close", id: closed });
    const after = exploreTabsReducer(state, { type: "setSql", id: closed, sql: "SELECT 3" });
    expect(after).toBe(state);
  });

  it("ignores writes to non-sql tabs", () => {
    let state = seedTabsState();
    state = exploreTabsReducer(state, { type: "create", kind: "viz" });
    const viz = state.activeId;
    const after = exploreTabsReducer(state, { type: "setSql", id: viz, sql: "SELECT 4" });
    expect(after).toBe(state);
  });
});

describe("persistence", () => {
  it("round-trips through localStorage", () => {
    let state = seedTabsState();
    state = exploreTabsReducer(state, { type: "create", kind: "viz" });
    state = exploreTabsReducer(state, { type: "setSql", id: state.tabs[0].id, sql: "SELECT 9" });
    saveTabsState(RUN, state);
    expect(loadTabsState(RUN)).toEqual(state);
  });

  it("keeps runs isolated", () => {
    const state = seedTabsState();
    saveTabsState(RUN, state);
    expect(loadTabsState("TAS-00001").tabs[0].id).not.toBe(state.tabs[0].id);
  });

  it("discards a version mismatch", () => {
    const state = seedTabsState();
    saveTabsState(RUN, state);
    const raw = JSON.parse(localStorage.getItem(tabsStorageKey(RUN)) ?? "{}");
    raw.v = TABS_VERSION + 1;
    localStorage.setItem(tabsStorageKey(RUN), JSON.stringify(raw));
    expect(loadTabsState(RUN).tabs[0].id).not.toBe(state.tabs[0].id);
  });

  it("reseeds on corrupt JSON", () => {
    localStorage.setItem(tabsStorageKey(RUN), "{not json");
    const state = loadTabsState(RUN);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].kind).toBe("sql");
  });

  it("repairs an activeId that points at no tab", () => {
    const state = seedTabsState();
    saveTabsState(RUN, state);
    const raw = JSON.parse(localStorage.getItem(tabsStorageKey(RUN)) ?? "{}");
    raw.activeId = "gone";
    localStorage.setItem(tabsStorageKey(RUN), JSON.stringify(raw));
    expect(loadTabsState(RUN).activeId).toBe(state.tabs[0].id);
  });

  it("reseeds an empty tab list and clamps an over-cap one", () => {
    localStorage.setItem(
      tabsStorageKey(RUN),
      JSON.stringify({ v: TABS_VERSION, tabs: [], activeId: "x", sqlByTab: {} }),
    );
    expect(loadTabsState(RUN).tabs).toHaveLength(1);

    const many = Array.from({ length: 12 }, (_, index) => ({
      id: `t${index}`,
      kind: "sql",
      title: `SQL query ${index + 1}`,
    }));
    localStorage.setItem(
      tabsStorageKey(RUN),
      JSON.stringify({ v: TABS_VERSION, tabs: many, activeId: "t0", sqlByTab: {} }),
    );
    expect(loadTabsState(RUN).tabs).toHaveLength(MAX_EXPLORE_TABS);
  });

  it("drops sqlByTab orphans and backfills missing SQL — seed for the first tab, empty after", () => {
    localStorage.setItem(
      tabsStorageKey(RUN),
      JSON.stringify({
        v: TABS_VERSION,
        tabs: [
          { id: "a", kind: "sql", title: "SQL query 1" },
          { id: "b", kind: "sql", title: "SQL query 2" },
        ],
        activeId: "a",
        sqlByTab: { gone: "SELECT 1" },
      }),
    );
    const state = loadTabsState(RUN);
    expect(state.sqlByTab).toEqual({ a: buildSeedSql(), b: "" });
  });
});

describe("nextTitle", () => {
  it("counts only its own kind and ignores renamed-style titles", () => {
    const tabs = [
      { id: "a", kind: "sql", title: "SQL query 4" },
      { id: "b", kind: "viz", title: "Visualisation 9" },
      { id: "c", kind: "sql", title: "my special tab" },
    ] as const;
    expect(nextTitle(tabs as unknown as ExploreTabsState["tabs"], "sql")).toBe("SQL query 5");
    expect(nextTitle(tabs as unknown as ExploreTabsState["tabs"], "ai")).toBe("Ask AI 1");
  });
});
