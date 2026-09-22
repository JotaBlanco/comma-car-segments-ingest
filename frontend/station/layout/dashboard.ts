/**
 * The dashboard's model: widgets placed on a column grid, moved and resized in cells, and the
 * whole arrangement saved as a named view. Pure: the grid component turns pointer pixels into
 * cells and calls in here; the store keeps the result and persists it.
 *
 * The grid has COLS columns and rows of ROW_PX pixels; an item is a rectangle of cells. Two
 * items never overlap: a move or a resize pushes what it lands on downwards, and everything
 * then floats up to fill the gaps (vertical compaction), so the dashboard reads top-down with
 * no holes.
 */
import { isPanelId, PANEL_IDS, type Collapsed, type PanelId } from './panels';

/** A waveform widget shows the parameters chosen on it; several can sit on one dashboard. */
export const WAVEFORM = 'waveform';
export type WidgetKind = PanelId | typeof WAVEFORM;
/** A widget instance id: a singleton's kind, or `waveform:<n>`. */
export type WidgetId = string;
export const WIDGET_KINDS: readonly WidgetKind[] = [...PANEL_IDS, WAVEFORM];

export function isWidgetKind(v: string): v is WidgetKind {
  return isPanelId(v) || v === WAVEFORM;
}

/** The kind an instance id names, or null for an id that names none. */
export function kindOf(id: string): WidgetKind | null {
  if (isPanelId(id)) return id;
  return /^waveform:\d+$/.test(id) ? WAVEFORM : null;
}
export const COLS = 12;
/** One grid row, in pixels. A collapsed widget takes one row: its title bar. */
export const ROW_PX = 40;

export interface LayoutItem {
  id: WidgetId;
  kind: WidgetKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** A waveform's parameters, as pick keys (`table:scope:signal`), in order. */
  params?: string[];
}

export type Layout = LayoutItem[];

export interface WidgetSpec {
  id: WidgetKind;
  title: string;
  description: string;
  w: number;
  h: number;
  minW: number;
  minH: number;
  /** True for a widget the dashboard may hold several of. */
  multi?: boolean;
}

export const WIDGETS: Record<WidgetKind, WidgetSpec> = {
  map: {
    id: 'map',
    title: 'Map',
    description: 'The ground track on a map, with the aircraft at the playhead.',
    w: 6,
    h: 9,
    minW: 3,
    minH: 4,
  },
  altitude: {
    id: 'altitude',
    title: 'Altitude',
    description: 'Altitude against time, with the zoom, the marked period and the events.',
    w: 6,
    h: 9,
    minW: 3,
    minH: 4,
  },
  instruments: {
    id: 'instruments',
    title: 'Instruments',
    description: 'Attitude indicator, speed and altitude tapes and the heading tape.',
    w: 8,
    h: 8,
    minW: 4,
    minH: 5,
  },
  annunciator: {
    id: 'annunciator',
    title: 'Annunciator',
    description: 'The flight control lamps: modes, states and warnings at the playhead.',
    w: 4,
    h: 8,
    minW: 2,
    minH: 3,
  },
  strips: {
    id: 'strips',
    title: 'Picked parameters',
    description:
      'The ad hoc place: one strip chart per parameter ticked in the tree, in pick order.',
    w: 12,
    h: 8,
    minW: 4,
    minH: 3,
  },
  waveform: {
    id: 'waveform',
    title: 'Waveform',
    description:
      'Its own parameters, chosen on the widget and saved with the view. Add as many as you like.',
    w: 6,
    h: 8,
    minW: 3,
    minH: 3,
    multi: true,
  },
};

/** The arrangement the station always had: map and altitude, instruments and lamps, strips. */
export const STANDARD_LAYOUT: Layout = [
  { id: 'map', kind: 'map', x: 0, y: 0, w: 6, h: 9 },
  { id: 'altitude', kind: 'altitude', x: 6, y: 0, w: 6, h: 9 },
  { id: 'instruments', kind: 'instruments', x: 0, y: 9, w: 8, h: 8 },
  { id: 'annunciator', kind: 'annunciator', x: 8, y: 9, w: 4, h: 8 },
  { id: 'strips', kind: 'strips', x: 0, y: 17, w: 12, h: 8 },
];

export interface SavedView {
  id: string;
  name: string;
  layout: Layout;
}

/** The views that ship with the station; a person cannot delete them. */
export const PRESET_VIEWS: readonly SavedView[] = [
  { id: 'preset:standard', name: 'Standard', layout: STANDARD_LAYOUT },
  {
    id: 'preset:charts',
    name: 'Charts',
    layout: [
      { id: 'altitude', kind: 'altitude', x: 0, y: 0, w: 12, h: 8 },
      { id: 'strips', kind: 'strips', x: 0, y: 8, w: 12, h: 14 },
    ],
  },
  {
    id: 'preset:cockpit',
    name: 'Cockpit',
    layout: [
      { id: 'instruments', kind: 'instruments', x: 0, y: 0, w: 8, h: 11 },
      { id: 'annunciator', kind: 'annunciator', x: 8, y: 0, w: 4, h: 11 },
      { id: 'map', kind: 'map', x: 0, y: 11, w: 12, h: 9 },
    ],
  },
];

export function isPreset(viewId: string | null): boolean {
  return viewId !== null && PRESET_VIEWS.some((v) => v.id === viewId);
}

/* ─────────────────────────── geometry ─────────────────────────── */

function collides(a: LayoutItem, b: LayoutItem): boolean {
  if (a.id === b.id) return false;
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function byPosition(a: LayoutItem, b: LayoutItem): number {
  return a.y - b.y || a.x - b.x;
}

/**
 * Float every item up until it rests on another or on the top. `pinned` stays where it is,
 * so the item a person is dragging does not jump out from under the pointer.
 */
export function compact(layout: Layout, pinned?: WidgetId): Layout {
  const sorted = [...layout].sort(byPosition);
  const placed: LayoutItem[] = [];
  for (const item of sorted) {
    const next = { ...item };
    if (next.id !== pinned) {
      while (next.y > 0 && !placed.some((p) => collides({ ...next, y: next.y - 1 }, p)))
        next.y -= 1;
    }
    placed.push(next);
  }
  return placed.sort(byPosition);
}

/** Push every item `moving` lands on below it, cascading, then compact around it. */
function resolve(layout: Layout, moving: LayoutItem): Layout {
  const items = layout.map((it) => (it.id === moving.id ? { ...moving } : { ...it }));
  const queue = [moving];
  while (queue.length > 0) {
    const cause = queue.shift()!;
    for (const it of items) {
      if (it.id === cause.id || !collides(cause, it)) continue;
      if (it.id === moving.id) continue;
      it.y = cause.y + cause.h;
      queue.push(it);
    }
  }
  return compact(items, moving.id);
}

function clampW(kind: WidgetKind, x: number, w: number): number {
  return Math.max(WIDGETS[kind].minW, Math.min(COLS - x, Math.round(w)));
}

function clampH(kind: WidgetKind, h: number): number {
  return Math.max(WIDGETS[kind].minH, Math.round(h));
}

export function moveItem(layout: Layout, id: WidgetId, x: number, y: number): Layout {
  const item = layout.find((it) => it.id === id);
  if (!item) return layout;
  const nx = Math.max(0, Math.min(COLS - item.w, Math.round(x)));
  const ny = Math.max(0, Math.round(y));
  if (nx === item.x && ny === item.y) return layout;
  return resolve(layout, { ...item, x: nx, y: ny });
}

export function resizeItem(layout: Layout, id: WidgetId, w: number, h: number): Layout {
  const item = layout.find((it) => it.id === id);
  if (!item) return layout;
  const nw = clampW(item.kind, item.x, w);
  const nh = clampH(item.kind, h);
  if (nw === item.w && nh === item.h) return layout;
  return resolve(layout, { ...item, w: nw, h: nh });
}

/** The next free `waveform:<n>`: the smallest n no instance uses. */
export function nextWaveformId(layout: Layout): WidgetId {
  let n = 1;
  while (layout.some((it) => it.id === `${WAVEFORM}:${n}`)) n += 1;
  return `${WAVEFORM}:${n}`;
}

/**
 * A widget of that kind in its default size at the bottom of the dashboard. A singleton already
 * placed stays; a waveform gets a fresh instance every time.
 */
export function addWidget(layout: Layout, kind: WidgetKind): Layout {
  const spec = WIDGETS[kind];
  const id = spec.multi ? nextWaveformId(layout) : kind;
  if (layout.some((it) => it.id === id)) return layout;
  const item: LayoutItem = {
    id,
    kind,
    x: 0,
    y: layoutHeight(layout),
    w: Math.min(spec.w, COLS),
    h: spec.h,
  };
  if (spec.multi) item.params = [];
  return compact([...layout, item]);
}

/** The parameters a waveform shows; another widget ignores the call. */
export function setWidgetParams(layout: Layout, id: WidgetId, params: readonly string[]): Layout {
  const item = layout.find((it) => it.id === id);
  if (!item || !WIDGETS[item.kind].multi) return layout;
  const next = [...new Set(params.filter(isPickKey))];
  if (item.params && sameList(item.params, next)) return layout;
  return layout.map((it) => (it.id === id ? { ...it, params: next } : it));
}

function isPickKey(v: unknown): v is string {
  return typeof v === 'string' && v.split(':').length === 3 && !v.split(':').includes('');
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function removeWidget(layout: Layout, id: WidgetId): Layout {
  if (!layout.some((it) => it.id === id)) return layout;
  return compact(layout.filter((it) => it.id !== id));
}

/** Rows the layout spans. */
export function layoutHeight(layout: Layout): number {
  return layout.reduce((m, it) => Math.max(m, it.y + it.h), 0);
}

/** What the grid draws: a collapsed widget shrinks to its title bar and the rest floats up. */
export function effectiveLayout(layout: Layout, collapsed: Collapsed): Layout {
  return compact(layout.map((it) => (collapsed[it.id] ? { ...it, h: 1 } : it)));
}

export function sameLayout(a: Layout, b: Layout): boolean {
  const sa = [...a].sort(byPosition);
  const sb = [...b].sort(byPosition);
  if (sa.length !== sb.length) return false;
  return sa.every((it, i) => {
    const o = sb[i];
    const cells = it.id === o.id && it.x === o.x && it.y === o.y && it.w === o.w && it.h === o.h;
    return cells && sameList(it.params ?? [], o.params ?? []);
  });
}

/**
 * A layout from anything: unknown widgets and duplicates dropped, cells clamped, gaps closed.
 * What a saved view or the storage holds is read this way, so an old or edited value cannot
 * break the grid.
 */
/** One item from anything, or null for a value that names no widget. */
function normalizeItem(v: unknown): LayoutItem | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  const kind = kindOf(id);
  if (kind === null) return null;
  const num = (k: string, d: number) => (Number.isFinite(Number(r[k])) ? Number(r[k]) : d);
  const spec = WIDGETS[kind];
  const w = Math.max(spec.minW, Math.min(COLS, Math.round(num('w', spec.w))));
  const x = Math.max(0, Math.min(COLS - w, Math.round(num('x', 0))));
  const y = Math.max(0, Math.round(num('y', 0)));
  const h = Math.max(spec.minH, Math.round(num('h', spec.h)));
  const item: LayoutItem = { id, kind, x, y, w, h };
  if (spec.multi) {
    const raw = Array.isArray(r.params) ? (r.params as unknown[]) : [];
    item.params = [...new Set(raw.filter(isPickKey))];
  }
  return item;
}

export function normalizeLayout(raw: unknown): Layout {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Layout = [];
  for (const v of raw) {
    const item = normalizeItem(v);
    if (item === null || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  // Overlaps in a hand-edited value: place them one by one, each pushing what it lands on.
  let placed: Layout = [];
  for (const it of out.sort(byPosition)) placed = resolve([...placed, it], it);
  return compact(placed);
}

/* ─────────────────────────── persistence ─────────────────────────── */

const LAYOUT_KEY = 'fts.dashboard.layout';
const VIEWS_KEY = 'fts.dashboard.views';
const ACTIVE_KEY = 'fts.dashboard.view';

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked: the dashboard lasts for this page only */
  }
}

/** The stored arrangement, else the standard one. Null storage means the standard. */
export function loadLayout(): Layout {
  const raw = readJson(LAYOUT_KEY);
  return raw === null ? STANDARD_LAYOUT : normalizeLayout(raw);
}

export function storeLayout(layout: Layout): void {
  writeJson(LAYOUT_KEY, layout);
}

export function loadViews(): SavedView[] {
  const raw = readJson(VIEWS_KEY);
  if (!Array.isArray(raw)) return [];
  const out: SavedView[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.name !== 'string') continue;
    if (r.id.startsWith('preset:') || out.some((o) => o.id === r.id)) continue;
    out.push({ id: r.id, name: r.name.trim() || 'Untitled', layout: normalizeLayout(r.layout) });
  }
  return out;
}

export function storeViews(views: readonly SavedView[]): void {
  writeJson(VIEWS_KEY, views);
}

export function loadActiveView(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY) || null;
  } catch {
    return null;
  }
}

export function storeActiveView(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* storage blocked */
  }
}

export function clearStoredDashboard(): void {
  try {
    localStorage.removeItem(LAYOUT_KEY);
    localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* storage blocked: nothing was stored to clear */
  }
}

export function newViewId(): string {
  return `view:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The preset or saved view with that id. */
export function findView(views: readonly SavedView[], id: string | null): SavedView | null {
  if (id === null) return null;
  return PRESET_VIEWS.find((v) => v.id === id) ?? views.find((v) => v.id === id) ?? null;
}

/** Singletons not on the dashboard, in gallery order. A waveform is never missing. */
export function missingWidgets(layout: Layout): PanelId[] {
  return PANEL_IDS.filter((id) => !layout.some((it) => it.id === id));
}

/** The title a widget's bar shows: the kind's name, numbered for a waveform. */
export function widgetTitle(item: Pick<LayoutItem, 'id' | 'kind'>): string {
  const title = WIDGETS[item.kind].title;
  if (!WIDGETS[item.kind].multi) return title;
  const n = item.id.split(':')[1];
  return n ? `${title} ${n}` : title;
}

/* ─────────────────────────── pixels ─────────────────────────── */

/** One column's width for a container of `width` px with `gap` px between columns. */
export function colWidth(width: number, gap: number): number {
  return Math.max(0, (width - gap * (COLS - 1)) / COLS);
}

export interface PxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function itemRect(item: LayoutItem, colW: number, gap: number): PxRect {
  return {
    left: item.x * (colW + gap),
    top: item.y * (ROW_PX + gap),
    width: item.w * colW + (item.w - 1) * gap,
    height: item.h * ROW_PX + (item.h - 1) * gap,
  };
}

/** The cell a pixel offset lands on: the nearest column and row. */
export function cellAt(
  px: number,
  py: number,
  colW: number,
  gap: number,
): { x: number; y: number } {
  return { x: Math.round(px / (colW + gap)), y: Math.round(py / (ROW_PX + gap)) };
}

/** The cell size a pixel size rounds to. */
export function cellsFor(
  pw: number,
  ph: number,
  colW: number,
  gap: number,
): { w: number; h: number } {
  return { w: Math.round((pw + gap) / (colW + gap)), h: Math.round((ph + gap) / (ROW_PX + gap)) };
}
