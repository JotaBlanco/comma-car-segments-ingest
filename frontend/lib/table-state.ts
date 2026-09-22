"use client";

/**
 * URL-backed table filter/sort/pagination state.
 *
 * Design goals (see plans/design/TABLE-FILTERS-FE-draft.md §2.8 & §3):
 * - All state lives in the URL (`searchParams`) so it is shareable & back-button friendly.
 * - Multi-value filters use *repeated keys* (`?status=a&status=b`) — read with `getAll`,
 *   written with `append`. Semantics: OR within a key, AND across keys.
 * - Quick views are *derived presets*: no `view=` param. Active view is computed by
 *   strict set-equality on the params it writes.
 * - `router.push` for user-intent changes (filter/sort/page/quick-view) so back-button walks
 *   the history; `router.replace` for debounced search keystrokes (no history spam).
 * - Every setter that changes the row set (all but `setQ` and `setPage`) resets `page` to 1.
 * - Canonical URL ordering + default stripping keep two identical states → one URL string
 *   (stable sharing, stable TanStack Query cache keys once callers normalize).
 *
 * Pure functions (`parseTableState`, `buildTableQuery`, `resolveQuickView`, `normalizeState`)
 * are React-free and unit-testable directly.
 */

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/** How the URL parameter for one quick view is expressed. */
export interface QuickViewPreset {
  /** Stable id used for `activeId` comparisons. */
  readonly id: string;
  /**
   * Params this preset writes. Absence of a key means "must be absent for the preset to
   * match" (that is what makes `All` express "no filters set"). Empty array means the same
   * as absent.
   */
  readonly params: Readonly<Record<string, readonly string[]>>;
}

export interface TableStateConfig {
  /** Keys that use multi-value repeated params. Read with `getAll`. */
  readonly multiKeys: readonly string[];
  /** Keys that stay single-value pass-throughs (e.g. `signal`, `unlinked`). */
  readonly singleKeys: readonly string[];
  /** Sort keys accepted by the endpoint. Non-listed `sort` in the URL is ignored. */
  readonly sortKeys: readonly string[];
  /** Default sort (matches the server default; omitted from the URL when active). */
  readonly defaultSort: { key: string; order: "asc" | "desc" } | null;
  /** Default page size (omitted from the URL when active). */
  readonly defaultPageSize: number;
  /** Allowed page-size values (used for validation only; UI ships its own select). */
  readonly pageSizeOptions: readonly number[];
  /** Quick view presets in canonical display order. */
  readonly quickViews: readonly QuickViewPreset[];
  /**
   * Keys a quick view neither reads nor writes. Each one must also appear in
   * `multiKeys` or `singleKeys`; this list only exempts it from the presets.
   *
   * A quick view is exclusive: `applyPreset` rewrites every configured key and
   * `presetMatches` demands set-equality on every configured key. That is right
   * for a key one preset owns — picking `Archived` must drop `Deleted`. It is
   * wrong for a filter that stands beside the views instead of among them, like
   * the files screen's "Hide invalid". Without this list such a key would fight
   * the segment in both directions: picking a view would silently switch the
   * filter off, and switching the filter on would un-highlight the view.
   *
   * `clearAll` still clears these keys, because "Clear all" means all.
   */
  readonly independentKeys?: readonly string[];
}

export interface TableUrlState {
  /** Multi-value keys → sorted unique array (canonical). */
  readonly multi: Readonly<Record<string, readonly string[]>>;
  /** Single-value pass-through keys. */
  readonly single: Readonly<Record<string, string | undefined>>;
  /** Search string ("" when absent). */
  readonly q: string;
  /** Sort — null means "use the server default". */
  readonly sort: { key: string; order: "asc" | "desc" } | null;
  readonly page: number;
  readonly pageSize: number;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

function readMulti(
  sp: URLSearchParams | Readonly<URLSearchParams>,
  key: string
): readonly string[] {
  const values = sp.getAll(key).filter((value) => value.length > 0);
  if (values.length === 0) return [];
  // Sorted + deduped for canonical comparison; the URL round-trip preserves this.
  return Array.from(new Set(values)).sort();
}

function readSingle(
  sp: URLSearchParams | Readonly<URLSearchParams>,
  key: string
): string | undefined {
  const value = sp.get(key);
  return value !== null && value.length > 0 ? value : undefined;
}

function parsePage(raw: string | null): number {
  if (raw === null) return 1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

function parsePageSize(raw: string | null, config: TableStateConfig): number {
  if (raw === null) return config.defaultPageSize;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return config.defaultPageSize;
  return config.pageSizeOptions.includes(parsed) ? parsed : config.defaultPageSize;
}

function parseSort(
  sp: URLSearchParams | Readonly<URLSearchParams>,
  config: TableStateConfig
): TableUrlState["sort"] {
  const key = sp.get("sort");
  if (key === null || !config.sortKeys.includes(key)) return null;
  const orderRaw = sp.get("order");
  const order: "asc" | "desc" = orderRaw === "asc" ? "asc" : "desc";
  return { key, order };
}

export function parseTableState(
  sp: URLSearchParams | Readonly<URLSearchParams>,
  config: TableStateConfig
): TableUrlState {
  const multi: Record<string, readonly string[]> = {};
  for (const key of config.multiKeys) multi[key] = readMulti(sp, key);
  const single: Record<string, string | undefined> = {};
  for (const key of config.singleKeys) single[key] = readSingle(sp, key);
  return {
    multi,
    single,
    q: sp.get("q") ?? "",
    sort: parseSort(sp, config),
    page: parsePage(sp.get("page")),
    pageSize: parsePageSize(sp.get("page_size"), config),
  };
}

/**
 * Build a canonical query string for a state. Default sort / page 1 / default page size
 * are stripped; multi arrays are sorted; keys are emitted in a stable order.
 * The leading `?` is included when non-empty; empty state → "".
 */
export function buildTableQuery(state: TableUrlState, config: TableStateConfig): string {
  const params = new URLSearchParams();

  // Deterministic multi-key order: match the config order (already canonical).
  for (const key of config.multiKeys) {
    const values = state.multi[key] ?? [];
    // Copy + sort so callers can pass unsorted arrays and get canonical output.
    const sorted = Array.from(new Set(values)).sort();
    for (const value of sorted) params.append(key, value);
  }

  for (const key of config.singleKeys) {
    const value = state.single[key];
    if (value !== undefined && value.length > 0) params.set(key, value);
  }

  if (state.q.length > 0) params.set("q", state.q);

  const defaultSort = config.defaultSort;
  const isDefaultSort =
    state.sort === null ||
    (defaultSort !== null &&
      state.sort.key === defaultSort.key &&
      state.sort.order === defaultSort.order);
  if (!isDefaultSort && state.sort !== null) {
    params.set("sort", state.sort.key);
    params.set("order", state.sort.order);
  }

  if (state.page > 1) params.set("page", String(state.page));
  if (state.pageSize !== config.defaultPageSize) params.set("page_size", String(state.pageSize));

  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

/**
 * Resolve which quick view (if any) is active for the given state — strict set-equality.
 * Returns the preset id, or `null` when no preset matches (pills carry the visible state).
 */
export function resolveQuickView(
  state: TableUrlState,
  config: TableStateConfig
): string | null {
  for (const preset of config.quickViews) {
    if (presetMatches(state, preset, config)) return preset.id;
  }
  return null;
}

function presetMatches(
  state: TableUrlState,
  preset: QuickViewPreset,
  config: TableStateConfig
): boolean {
  const independent = config.independentKeys ?? [];
  // Every configured multi key: exactly matches preset (absent counts as []).
  for (const key of config.multiKeys) {
    if (independent.includes(key)) continue;
    const stateValues = state.multi[key] ?? [];
    const presetValues = preset.params[key] ?? [];
    if (!setsEqual(stateValues, presetValues)) return false;
  }
  // Every configured single key: exactly matches preset (undefined vs undefined).
  for (const key of config.singleKeys) {
    if (independent.includes(key)) continue;
    const stateValue = state.single[key];
    const presetArr = preset.params[key];
    const presetValue = presetArr && presetArr.length > 0 ? presetArr[0] : undefined;
    if (stateValue !== presetValue) return false;
  }
  return true;
}

function setsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (const value of a) if (!setB.has(value)) return false;
  return true;
}

/**
 * Replace every value one filter key holds — the pure half of `setFilterValues`.
 *
 * A multi-key takes the whole array. A single-key takes `values[0]`, and an
 * empty array clears it to `undefined` — that is how the filter pills remove a
 * `signal`/`definition`/`run` filter (they call `setFilterValues(key, [])`).
 * The hook used to return early for single keys, so those pills stripped
 * nothing: the ✕ clicked, the URL stood still. An unknown key returns the
 * state unchanged.
 */
export function applyFilterValues(
  state: TableUrlState,
  key: string,
  values: readonly string[],
  config: TableStateConfig
): TableUrlState {
  if (config.multiKeys.includes(key)) {
    return { ...state, multi: { ...state.multi, [key]: values.slice() } };
  }
  if (config.singleKeys.includes(key)) {
    return {
      ...state,
      single: { ...state.single, [key]: values.length > 0 ? values[0] : undefined },
    };
  }
  return state;
}

/* -------------------------------------------------------------------------- */
/* React hook                                                                  */
/* -------------------------------------------------------------------------- */

export interface UseTableStateResult {
  state: TableUrlState;
  activeQuickViewId: string | null;
  /** Apply a quick view preset (replaces every param the preset controls). */
  setQuickView: (id: string) => void;
  /** Add or remove a value from a multi-key. */
  toggleFilterValue: (key: string, value: string) => void;
  /** Replace every value for a key. Multi-keys take the whole array (Popover
      "Clear"); single-keys take `values[0]`, and `[]` clears them (the pills). */
  setFilterValues: (key: string, values: readonly string[]) => void;
  /** Search text — routes through `router.replace` (no history entry). */
  setQ: (value: string) => void;
  /** Set/toggle sort. First click on a key uses `firstOrder` (server default). */
  setSort: (key: string, firstOrder: "asc" | "desc") => void;
  setPage: (page: number) => void;
  /** Page size change resets to page 1. */
  setPageSize: (size: number) => void;
  /** Clear every filter/sort/search/page — used by the pills bar & empty state. */
  clearAll: () => void;
  /** Escape hatch: build the canonical URL for an arbitrary state (tests + deep links). */
  buildQuery: (state: TableUrlState) => string;
}

/**
 * Bind the URL state to `useSearchParams` + `useRouter`.
 *
 * `pathname` is passed in (not read from `usePathname`) so this hook works for tests that
 * mount components without an App Router context and so the caller can control the
 * navigation target explicitly.
 */
export function useTableState(config: TableStateConfig, pathname: string): UseTableStateResult {
  const searchParams = useSearchParams();
  const router = useRouter();

  const state = useMemo(
    () => parseTableState(searchParams ?? new URLSearchParams(), config),
    [searchParams, config]
  );

  const activeQuickViewId = useMemo(() => resolveQuickView(state, config), [state, config]);

  const push = useCallback(
    (next: TableUrlState) => {
      router.push(`${pathname}${buildTableQuery(next, config)}`, { scroll: false });
    },
    [router, pathname, config]
  );

  const replace = useCallback(
    (next: TableUrlState) => {
      router.replace(`${pathname}${buildTableQuery(next, config)}`, { scroll: false });
    },
    [router, pathname, config]
  );

  const setQuickView = useCallback(
    (id: string) => {
      const preset = config.quickViews.find((view) => view.id === id);
      if (preset === undefined) return;
      const next = applyPreset(state, preset, config);
      push(resetPage(next));
    },
    [state, config, push]
  );

  const toggleFilterValue = useCallback(
    (key: string, value: string) => {
      if (!config.multiKeys.includes(key)) return;
      const current = state.multi[key] ?? [];
      const has = current.includes(value);
      const nextValues = has ? current.filter((v) => v !== value) : [...current, value];
      const next: TableUrlState = {
        ...state,
        multi: { ...state.multi, [key]: nextValues },
      };
      push(resetPage(next));
    },
    [state, config, push]
  );

  const setFilterValues = useCallback(
    (key: string, values: readonly string[]) => {
      // Multi and single keys both land here — `applyFilterValues` holds the
      // shared rule. A key the config never named changes nothing, so it must
      // not push a URL either.
      const next = applyFilterValues(state, key, values, config);
      if (next === state) return;
      push(resetPage(next));
    },
    [state, config, push]
  );

  const setQ = useCallback(
    (value: string) => {
      const next: TableUrlState = { ...state, q: value };
      replace(resetPage(next));
    },
    [state, replace]
  );

  const setSort = useCallback(
    (key: string, firstOrder: "asc" | "desc") => {
      if (!config.sortKeys.includes(key)) return;
      /* `state.sort` is `null` whenever the URL is at the server default (the default is
         stripped from the URL). Treat that as the *effective* current sort so a second
         click on the default-sorted header actually toggles — otherwise the URL keeps
         re-stripping and the header never flips (real bug caught here). */
      const effective =
        state.sort ?? (config.defaultSort?.key === key ? config.defaultSort : null);
      let nextSort: TableUrlState["sort"];
      if (effective !== null && effective.key === key) {
        nextSort = { key, order: effective.order === "asc" ? "desc" : "asc" };
      } else {
        nextSort = { key, order: firstOrder };
      }
      const next: TableUrlState = { ...state, sort: nextSort };
      push(resetPage(next));
    },
    [state, config, push]
  );

  const setPage = useCallback(
    (page: number) => {
      const next: TableUrlState = { ...state, page: Math.max(1, page) };
      push(next);
    },
    [state, push]
  );

  const setPageSize = useCallback(
    (size: number) => {
      const next: TableUrlState = { ...state, pageSize: size, page: 1 };
      push(next);
    },
    [state, push]
  );

  const clearAll = useCallback(() => {
    const next: TableUrlState = {
      multi: Object.fromEntries(config.multiKeys.map((key) => [key, []])),
      single: Object.fromEntries(config.singleKeys.map((key) => [key, undefined])),
      q: "",
      sort: null,
      page: 1,
      pageSize: config.defaultPageSize,
    };
    push(next);
  }, [config, push]);

  const buildQuery = useCallback((next: TableUrlState) => buildTableQuery(next, config), [config]);

  return {
    state,
    activeQuickViewId,
    setQuickView,
    toggleFilterValue,
    setFilterValues,
    setQ,
    setSort,
    setPage,
    setPageSize,
    clearAll,
    buildQuery,
  };
}

function resetPage(state: TableUrlState): TableUrlState {
  return state.page === 1 ? state : { ...state, page: 1 };
}

function applyPreset(
  state: TableUrlState,
  preset: QuickViewPreset,
  config: TableStateConfig
): TableUrlState {
  // The preset controls every configured filter key — for a full-fidelity match, every
  // configured multi/single key resets to the preset's value (or empty/undefined).
  // An `independentKeys` key is the exception: it keeps whatever it already held.
  const independent = config.independentKeys ?? [];
  const multi: Record<string, readonly string[]> = {};
  for (const key of config.multiKeys) {
    multi[key] = independent.includes(key) ? (state.multi[key] ?? []) : (preset.params[key] ?? []);
  }
  const single: Record<string, string | undefined> = {};
  for (const key of config.singleKeys) {
    if (independent.includes(key)) {
      single[key] = state.single[key];
      continue;
    }
    const presetArr = preset.params[key];
    single[key] = presetArr && presetArr.length > 0 ? presetArr[0] : undefined;
  }
  return { ...state, multi, single };
}
