/**
 * Per-run Explore query history (lib/explore/history-store.ts).
 * Node env — the store persists through the in-memory localStorage shim.
 *
 *  - recording prepends newest-first; runs are isolated per run id
 *  - a consecutive re-run of the same SQL replaces the entry (timestamp,
 *    status and counts update) and keeps its id, star and label
 *  - the unsaved cap evicts oldest-first; saved entries never evict
 *  - corrupt or mismatched storage reads as empty, never throws
 *  - mutations are read-merge-write, so a concurrent write from another
 *    context is not clobbered by a stale in-memory copy
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  HISTORY_VERSION,
  MAX_UNSAVED_ENTRIES,
  historyStorageKey,
  recordExploreHistory,
  removeHistoryEntry,
  resetHistoryCache,
  toggleSaved,
} from "@/lib/explore/history-store";
import { installLocalStorage } from "./support/local-storage";

installLocalStorage();

const RUN = "TAS-88214";

function entries(runId = RUN) {
  const raw = localStorage.getItem(historyStorageKey(runId));
  return raw === null ? [] : (JSON.parse(raw).entries as Array<Record<string, unknown>>);
}

beforeEach(() => {
  localStorage.clear();
  resetHistoryCache();
});

describe("recordExploreHistory", () => {
  it("prepends newest-first and isolates runs", () => {
    recordExploreHistory(RUN, { sql: "SELECT 1", at: 1, status: "ok", rowCount: 1 });
    recordExploreHistory(RUN, { sql: "SELECT 2", at: 2, status: "ok", rowCount: 2 });
    recordExploreHistory("TAS-00001", { sql: "SELECT 9", at: 3, status: "ok" });
    expect(entries().map((entry) => entry.sql)).toEqual(["SELECT 2", "SELECT 1"]);
    expect(entries("TAS-00001")).toHaveLength(1);
  });

  it("replaces a consecutive same-SQL re-run, preserving id, star and label", () => {
    recordExploreHistory(RUN, { sql: "SELECT 1", at: 1, status: "ok", rowCount: 5 });
    const first = entries()[0];
    toggleSaved(RUN, first.id as string, "baseline");

    recordExploreHistory(RUN, { sql: "SELECT 1", at: 2, status: "error", detail: "no" });
    const after = entries();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(first.id);
    expect(after[0].at).toBe(2);
    expect(after[0].status).toBe("error");
    expect(after[0].saved).toBe(true);
    expect(after[0].label).toBe("baseline");
  });

  it("does not collapse non-consecutive duplicates", () => {
    recordExploreHistory(RUN, { sql: "SELECT 1", at: 1, status: "ok" });
    recordExploreHistory(RUN, { sql: "SELECT 2", at: 2, status: "ok" });
    recordExploreHistory(RUN, { sql: "SELECT 1", at: 3, status: "ok" });
    expect(entries()).toHaveLength(3);
  });

  it("evicts oldest unsaved entries past the cap, never saved ones", () => {
    recordExploreHistory(RUN, { sql: "SELECT keep", at: 0, status: "ok" });
    toggleSaved(RUN, entries()[0].id as string);
    for (let index = 1; index <= MAX_UNSAVED_ENTRIES + 5; index += 1) {
      recordExploreHistory(RUN, { sql: `SELECT ${index}`, at: index, status: "ok" });
    }
    const all = entries();
    expect(all.filter((entry) => !entry.saved)).toHaveLength(MAX_UNSAVED_ENTRIES);
    expect(all.some((entry) => entry.sql === "SELECT keep")).toBe(true);
    expect(all.some((entry) => entry.sql === "SELECT 1")).toBe(false);
  });

  it("merges over storage written elsewhere instead of clobbering", () => {
    recordExploreHistory(RUN, { sql: "SELECT mine", at: 1, status: "ok" });
    // Simulate another browser tab writing directly.
    const foreign = {
      v: HISTORY_VERSION,
      entries: [
        { id: "other", sql: "SELECT theirs", at: 2, status: "ok", saved: false },
        ...entries(),
      ],
    };
    localStorage.setItem(historyStorageKey(RUN), JSON.stringify(foreign));
    recordExploreHistory(RUN, { sql: "SELECT after", at: 3, status: "ok" });
    expect(entries().map((entry) => entry.sql)).toEqual([
      "SELECT after",
      "SELECT theirs",
      "SELECT mine",
    ]);
  });
});

describe("toggleSaved / removeHistoryEntry", () => {
  it("stars, unstars and removes", () => {
    recordExploreHistory(RUN, { sql: "SELECT 1", at: 1, status: "ok" });
    const id = entries()[0].id as string;
    toggleSaved(RUN, id, "mine");
    expect(entries()[0].saved).toBe(true);
    toggleSaved(RUN, id);
    expect(entries()[0].saved).toBe(false);
    expect(entries()[0].label).toBe("mine");
    removeHistoryEntry(RUN, id);
    expect(entries()).toHaveLength(0);
  });
});

describe("corrupt storage", () => {
  it("reads as empty on bad JSON or a version mismatch", () => {
    localStorage.setItem(historyStorageKey(RUN), "{nope");
    recordExploreHistory(RUN, { sql: "SELECT 1", at: 1, status: "ok" });
    expect(entries()).toHaveLength(1);

    localStorage.setItem(
      historyStorageKey(RUN),
      JSON.stringify({ v: HISTORY_VERSION + 1, entries: [{ bogus: true }] }),
    );
    recordExploreHistory(RUN, { sql: "SELECT 2", at: 2, status: "ok" });
    expect(entries()).toHaveLength(1);
  });
});
