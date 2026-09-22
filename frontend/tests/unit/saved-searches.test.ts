/**
 * Saved searches store (lib/saved-searches.ts) — FR-DM-017 saved half.
 * Node env — the store persists through the in-memory localStorage shim.
 *
 *  - a saved search is a name plus the canonical query string
 *  - the description is optional, and an older row that carries none loads
 *  - each screen owns its own storage key, so the lists never mix
 *  - rename and delete both work, and both survive a re-read
 *  - a second save under one name overwrites, never duplicates
 *  - corrupt or mismatched storage reads as empty, never throws
 *  - a refused localStorage keeps the list in memory and reports it
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SAVED_SEARCHES,
  SAVED_SEARCH_VERSION,
  removeSavedSearch,
  renameSavedSearch,
  resetSavedSearchCache,
  saveSearch,
  savedSearchStorageKey,
  savedSearchesPersist,
  type SavedSearch,
  type SavedSearchScope,
} from "@/lib/saved-searches";
import { installLocalStorage } from "./support/local-storage";

installLocalStorage();

function stored(scope: SavedSearchScope): SavedSearch[] {
  const raw = localStorage.getItem(savedSearchStorageKey(scope));
  return raw === null ? [] : (JSON.parse(raw).searches as SavedSearch[]);
}

beforeEach(() => {
  localStorage.clear();
  resetSavedSearchCache();
});

describe("saveSearch", () => {
  it("keeps the name and the whole query string", () => {
    saveSearch("runs", "Cold soak, rig 1", "?rig=RIG-01&status=complete");

    const searches = stored("runs");
    expect(searches).toHaveLength(1);
    expect(searches[0].name).toBe("Cold soak, rig 1");
    expect(searches[0].query).toBe("?rig=RIG-01&status=complete");
    expect(typeof searches[0].at).toBe("number");
  });

  it("stores under a versioned envelope", () => {
    saveSearch("runs", "All", "");
    const raw = JSON.parse(localStorage.getItem(savedSearchStorageKey("runs")) as string);
    expect(raw.v).toBe(SAVED_SEARCH_VERSION);
  });

  it("saves an empty query, because 'no filter' is a view worth keeping", () => {
    expect(saveSearch("runs", "Everything", "")).not.toBeNull();
    expect(stored("runs")[0].query).toBe("");
  });

  it("refuses an empty or blank name and writes nothing", () => {
    expect(saveSearch("runs", "   ", "?q=a")).toBeNull();
    expect(stored("runs")).toHaveLength(0);
  });

  it("trims the name and caps its length", () => {
    saveSearch("runs", `  ${"x".repeat(MAX_NAME_LENGTH + 20)}  `, "?q=a");
    expect(stored("runs")[0].name).toHaveLength(MAX_NAME_LENGTH);
  });

  it("prepends newest-first", () => {
    saveSearch("runs", "First", "?q=1");
    saveSearch("runs", "Second", "?q=2");
    expect(stored("runs").map((entry) => entry.name)).toEqual(["Second", "First"]);
  });

  it("overwrites when the same name saves again, keeping one row and one id", () => {
    const first = saveSearch("runs", "Cold soak", "?q=1");
    const again = saveSearch("runs", "cold SOAK", "?q=2");

    const searches = stored("runs");
    expect(searches).toHaveLength(1);
    expect(searches[0].id).toBe(first?.id);
    expect(again?.id).toBe(first?.id);
    expect(searches[0].query).toBe("?q=2");
  });

  it("caps the list, dropping the oldest", () => {
    for (let index = 0; index < MAX_SAVED_SEARCHES + 5; index += 1) {
      saveSearch("runs", `search ${index}`, `?page=${index + 1}`);
    }
    const searches = stored("runs");
    expect(searches).toHaveLength(MAX_SAVED_SEARCHES);
    expect(searches[0].name).toBe(`search ${MAX_SAVED_SEARCHES + 4}`);
    expect(searches.some((entry) => entry.name === "search 0")).toBe(false);
  });
});

describe("per-screen scoping", () => {
  it("writes one key per screen", () => {
    expect(savedSearchStorageKey("runs")).toBe("tm-saved-searches:runs");
    expect(savedSearchStorageKey("files")).toBe("tm-saved-searches:files");
    expect(savedSearchStorageKey("signals")).toBe("tm-saved-searches:signals");
  });

  it("never leaks a runs search into the files or the signals list", () => {
    saveSearch("runs", "Cold soak", "?rig=RIG-01");
    saveSearch("files", "Quarantined", "?status=quarantined");

    expect(stored("runs").map((entry) => entry.name)).toEqual(["Cold soak"]);
    expect(stored("files").map((entry) => entry.name)).toEqual(["Quarantined"]);
    expect(stored("signals")).toHaveLength(0);
  });

  it("deletes only inside the screen that owns the row", () => {
    const runs = saveSearch("runs", "Same name", "?rig=RIG-01");
    saveSearch("files", "Same name", "?source=TAS");

    removeSavedSearch("runs", runs?.id as string);

    expect(stored("runs")).toHaveLength(0);
    expect(stored("files")).toHaveLength(1);
  });
});

describe("renameSavedSearch", () => {
  it("changes the name and keeps the query", () => {
    const saved = saveSearch("signals", "Old name", "?unit=degC");
    renameSavedSearch("signals", saved?.id as string, "  New name  ");

    const searches = stored("signals");
    expect(searches[0].name).toBe("New name");
    expect(searches[0].query).toBe("?unit=degC");
    expect(searches[0].id).toBe(saved?.id);
  });

  it("ignores an empty name", () => {
    const saved = saveSearch("signals", "Old name", "?unit=degC");
    renameSavedSearch("signals", saved?.id as string, "   ");
    expect(stored("signals")[0].name).toBe("Old name");
  });

  it("ignores an unknown id", () => {
    saveSearch("signals", "Old name", "?unit=degC");
    renameSavedSearch("signals", "no-such-id", "New name");
    expect(stored("signals")[0].name).toBe("Old name");
  });
});

describe("removeSavedSearch", () => {
  it("removes one row and leaves the rest", () => {
    saveSearch("files", "Keep", "?q=1");
    const drop = saveSearch("files", "Drop", "?q=2");

    removeSavedSearch("files", drop?.id as string);

    expect(stored("files").map((entry) => entry.name)).toEqual(["Keep"]);
  });
});

describe("bad storage", () => {
  it("reads corrupt JSON as empty and still saves after it", () => {
    localStorage.setItem(savedSearchStorageKey("runs"), "{not json");
    resetSavedSearchCache();

    expect(saveSearch("runs", "After", "?q=1")).not.toBeNull();
    expect(stored("runs").map((entry) => entry.name)).toEqual(["After"]);
  });

  it("reads another version as empty", () => {
    localStorage.setItem(
      savedSearchStorageKey("runs"),
      JSON.stringify({ v: SAVED_SEARCH_VERSION + 1, searches: [{ id: "a", name: "x", query: "", at: 1 }] }),
    );
    resetSavedSearchCache();

    saveSearch("runs", "After", "?q=1");
    expect(stored("runs")).toHaveLength(1);
  });

  it("drops a row that is not a saved search", () => {
    localStorage.setItem(
      savedSearchStorageKey("runs"),
      JSON.stringify({
        v: SAVED_SEARCH_VERSION,
        searches: [{ id: "a", name: "Good", query: "?q=1", at: 1 }, { nope: true }, 7],
      }),
    );
    resetSavedSearchCache();

    saveSearch("runs", "After", "?q=2");
    expect(stored("runs").map((entry) => entry.name)).toEqual(["After", "Good"]);
  });

  it("keeps working when localStorage refuses the write", () => {
    const setItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new DOMException("QuotaExceededError");
    };

    try {
      expect(savedSearchesPersist("runs")).toBe(true);
      // No throw reaches the caller, and the row is still there to read back.
      const saved = saveSearch("runs", "Full disk", "?q=1");
      expect(saved).not.toBeNull();
      expect(savedSearchesPersist("runs")).toBe(false);

      renameSavedSearch("runs", saved?.id as string, "Renamed anyway");
      removeSavedSearch("runs", "no-such-id");
      // Nothing landed in storage, and the screen never saw an error.
      expect(localStorage.getItem(savedSearchStorageKey("runs"))).toBeNull();
    } finally {
      localStorage.setItem = setItem;
    }
  });
});

describe("the optional description", () => {
  it("keeps the description a person wrote", () => {
    saveSearch("runs", "Cold soak", "?rig=RIG-01", "Every complete run on rig 1.");

    expect(stored("runs")[0].description).toBe("Every complete run on rig 1.");
  });

  it("writes no description key when a caller passes none", () => {
    saveSearch("runs", "Cold soak", "?rig=RIG-01");

    expect("description" in stored("runs")[0]).toBe(false);
  });

  it("reads a blank description as no description", () => {
    saveSearch("runs", "Cold soak", "?rig=RIG-01", "   ");

    expect("description" in stored("runs")[0]).toBe(false);
  });

  it("trims the description and caps its length", () => {
    saveSearch("runs", "Cold soak", "?rig=RIG-01", `  ${"d".repeat(MAX_DESCRIPTION_LENGTH + 20)}  `);

    expect(stored("runs")[0].description).toHaveLength(MAX_DESCRIPTION_LENGTH);
  });

  it("loads a row this store wrote before the description existed", () => {
    // The exact shape the store wrote until 24 Aug 2026: no description key.
    localStorage.setItem(
      savedSearchStorageKey("runs"),
      JSON.stringify({
        v: SAVED_SEARCH_VERSION,
        searches: [{ id: "old-1", name: "Older row", query: "?rig=RIG-09", at: 1 }],
      }),
    );
    resetSavedSearchCache();

    saveSearch("runs", "New row", "?rig=RIG-01", "With a description.");

    const searches = stored("runs");
    expect(searches.map((entry) => entry.name)).toEqual(["New row", "Older row"]);
    expect(searches[1].description).toBeUndefined();
  });

  it("drops the description when the same name saves again with none", () => {
    saveSearch("runs", "Cold soak", "?q=1", "The first reason.");
    saveSearch("runs", "cold SOAK", "?q=2");

    expect(stored("runs")).toHaveLength(1);
    expect("description" in stored("runs")[0]).toBe(false);
  });
});
