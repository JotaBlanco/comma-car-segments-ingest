/**
 * Explore workbench tabs (plan §4 follow-on) — pure state machine + storage.
 *
 * React-free on purpose, like table-state.ts: the reducer and the persistence
 * round-trip are plain functions so they unit-test without a DOM. The React
 * side is a single useReducer in explore-tab.tsx.
 *
 * Persistence rules (ported from the QuixLake console's tab store):
 *  - inputs only — tab list, active id and each SQL tab's text. Results,
 *    timings, transcripts and errors are never written.
 *  - versioned payload: a TABS_VERSION mismatch discards the stored state
 *    instead of guessing, so a breaking shape change resets cleanly.
 *  - every read repairs: a payload that parses but is referentially broken
 *    (activeId pointing nowhere, sqlByTab orphans, an over-cap tab list)
 *    must never brick the Explore tab — clamp what can be clamped, reseed
 *    when nothing can.
 */

import { buildSeedSql } from "./viz-sql";

export type ExploreTabKind = "sql" | "ai" | "viz";

export interface ExploreTabItem {
  id: string;
  kind: ExploreTabKind;
  title: string;
}

export interface ExploreTabsState {
  tabs: ExploreTabItem[];
  activeId: string;
  /** SQL text per sql-tab id. Other kinds never appear here. */
  sqlByTab: Record<string, string>;
}

export type ExploreTabsAction =
  /** `id` lets the caller know the new tab's id up front (lazy-mount set). */
  | { type: "create"; kind: ExploreTabKind; sql?: string; id?: string }
  | { type: "close"; id: string }
  | { type: "activate"; id: string }
  | { type: "rename"; id: string; title: string }
  | { type: "setSql"; id: string; sql: string }
  /** Move a tab to `index` (clamped). Order IS the array order, so the
      existing persistence payload carries it with no schema change. */
  | { type: "reorder"; id: string; index: number };

/** Hard ceiling — panes stay mounted once activated, so tab count is memory. */
export const MAX_EXPLORE_TABS = 8;

/** Rename cap — the strip truncates around 220px anyway. */
export const MAX_TAB_TITLE = 40;

export const TABS_VERSION = 1;

const TITLE_PREFIX: Record<ExploreTabKind, string> = {
  sql: "SQL query",
  ai: "Ask AI",
  viz: "Visualisation",
};

const KINDS: readonly ExploreTabKind[] = ["sql", "ai", "viz"];

export function newTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // jsdom fallback — uniqueness within one session is all we need.
  return `tab-${Math.random().toString(36).slice(2, 10)}`;
}

/** "SQL query 3" for the third SQL tab — max+1 over existing numbers, never gap-filling. */
export function nextTitle(tabs: readonly ExploreTabItem[], kind: ExploreTabKind): string {
  const prefix = TITLE_PREFIX[kind];
  const pattern = new RegExp(`^${prefix} (\\d+)$`);
  let max = 0;
  for (const tab of tabs) {
    if (tab.kind !== kind) continue;
    const match = pattern.exec(tab.title);
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  return `${prefix} ${max + 1}`;
}

function createTab(
  state: ExploreTabsState,
  kind: ExploreTabKind,
  sql?: string,
  id?: string,
): ExploreTabsState {
  if (state.tabs.length >= MAX_EXPLORE_TABS) return state;
  const tab: ExploreTabItem = { id: id ?? newTabId(), kind, title: nextTitle(state.tabs, kind) };
  // Only the workbench's bootstrap tab (seedTabsState) carries the seed query.
  // An explicitly created tab starts EMPTY — the editor shows a placeholder —
  // unless the caller hands it SQL ("Open in tab" flows).
  const sqlByTab = kind === "sql" ? { ...state.sqlByTab, [tab.id]: sql ?? "" } : state.sqlByTab;
  return { tabs: [...state.tabs, tab], activeId: tab.id, sqlByTab };
}

/**
 * Rename a tab. Whitespace is trimmed and an empty result keeps the old
 * title; anything past MAX_TAB_TITLE is cut. A renamed tab simply drops out
 * of nextTitle's default-pattern scan, so default numbering stays max+1 over
 * the tabs still carrying pattern titles.
 */
function renameTab(state: ExploreTabsState, id: string, title: string): ExploreTabsState {
  const trimmed = title.trim().slice(0, MAX_TAB_TITLE);
  if (trimmed.length === 0) return state;
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1 || state.tabs[index].title === trimmed) return state;
  const tabs = state.tabs.slice();
  tabs[index] = { ...tabs[index], title: trimmed };
  return { ...state, tabs };
}

function closeTab(state: ExploreTabsState, id: string): ExploreTabsState {
  if (state.tabs.length <= 1) return state;
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const sqlByTab = { ...state.sqlByTab };
  delete sqlByTab[id];
  const activeId =
    state.activeId === id ? tabs[Math.max(0, index - 1)].id : state.activeId;
  return { tabs, activeId, sqlByTab };
}

/**
 * Move a tab to `index`, clamped into [0, tabs.length - 1]. Unknown ids and
 * same-slot moves are no-ops (same reference), so callers can dispatch freely
 * from drag handlers without churning state. activeId never changes — a
 * reorder moves a tab, it does not select one.
 */
function reorderTab(state: ExploreTabsState, id: string, index: number): ExploreTabsState {
  const from = state.tabs.findIndex((tab) => tab.id === id);
  if (from === -1) return state;
  const to = Math.max(0, Math.min(index, state.tabs.length - 1));
  if (to === from) return state;
  const tabs = state.tabs.slice();
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved);
  return { ...state, tabs };
}

export function exploreTabsReducer(
  state: ExploreTabsState,
  action: ExploreTabsAction,
): ExploreTabsState {
  switch (action.type) {
    case "create":
      return createTab(state, action.kind, action.sql, action.id);
    case "close":
      return closeTab(state, action.id);
    case "activate":
      return state.tabs.some((tab) => tab.id === action.id)
        ? { ...state, activeId: action.id }
        : state;
    case "rename":
      return renameTab(state, action.id, action.title);
    case "setSql": {
      // A reactive write can land after its tab closed — never resurrect it.
      const tab = state.tabs.find((entry) => entry.id === action.id);
      if (tab === undefined || tab.kind !== "sql") return state;
      return { ...state, sqlByTab: { ...state.sqlByTab, [action.id]: action.sql } };
    }
    case "reorder":
      return reorderTab(state, action.id, action.index);
  }
}

export function seedTabsState(): ExploreTabsState {
  const tab: ExploreTabItem = { id: newTabId(), kind: "sql", title: "SQL query 1" };
  return { tabs: [tab], activeId: tab.id, sqlByTab: { [tab.id]: buildSeedSql() } };
}

export function tabsStorageKey(runId: string): string {
  return `tm-explore-tabs:${runId}`;
}

interface StoredTabs {
  v: number;
  tabs: unknown;
  activeId: unknown;
  sqlByTab: unknown;
}

function isTabItem(value: unknown): value is ExploreTabItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.title === "string" &&
    KINDS.includes(item.kind as ExploreTabKind)
  );
}

/** Parse + repair stored state; anything unrecoverable falls back to a fresh seed. */
export function loadTabsState(runId: string): ExploreTabsState {
  if (typeof window === "undefined") return seedTabsState();
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(tabsStorageKey(runId));
  } catch {
    return seedTabsState();
  }
  if (raw === null) return seedTabsState();

  try {
    const stored = JSON.parse(raw) as StoredTabs;
    if (stored.v !== TABS_VERSION || !Array.isArray(stored.tabs)) return seedTabsState();

    const seen = new Set<string>();
    const tabs = stored.tabs
      .filter(isTabItem)
      .filter((tab) => (seen.has(tab.id) ? false : (seen.add(tab.id), true)))
      .slice(0, MAX_EXPLORE_TABS);
    if (tabs.length === 0) return seedTabsState();

    const activeId = tabs.some((tab) => tab.id === stored.activeId)
      ? (stored.activeId as string)
      : tabs[0].id;

    const storedSql =
      typeof stored.sqlByTab === "object" && stored.sqlByTab !== null
        ? (stored.sqlByTab as Record<string, unknown>)
        : {};
    const sqlByTab: Record<string, string> = {};
    let firstSql = true;
    for (const tab of tabs) {
      if (tab.kind !== "sql") continue;
      const sql = storedSql[tab.id];
      // Backfill a missing entry: the run's first SQL tab gets the seed query
      // (it is the bootstrap tab of a fresh workbench), later tabs start
      // empty — mirroring createTab.
      sqlByTab[tab.id] = typeof sql === "string" ? sql : firstSql ? buildSeedSql() : "";
      firstSql = false;
    }

    return { tabs, activeId, sqlByTab };
  } catch {
    return seedTabsState();
  }
}

export function saveTabsState(runId: string, state: ExploreTabsState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      tabsStorageKey(runId),
      JSON.stringify({
        v: TABS_VERSION,
        tabs: state.tabs,
        activeId: state.activeId,
        sqlByTab: state.sqlByTab,
      }),
    );
  } catch {
    // Quota or privacy mode — persistence is a convenience, never a failure.
  }
}
