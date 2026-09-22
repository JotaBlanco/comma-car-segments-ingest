import { create } from 'zustand';
import { ApiError } from '../api/client';
import { openEvents, type EventsHandle, type LinkState } from '../api/events';
import {
  fetchCatalog,
  fetchConfig,
  fetchFlightState,
  fetchResolve,
  fetchScopes,
  fetchSignals,
  fetchSnippets,
} from '../api/fts';
import { suggestAgent } from '../api/suggestAgent';
import {
  clearStoredPat,
  getToken,
  initParentRelay,
  initPluginSdk,
  isEmbedded,
  loadStoredPat,
  onPortalToken,
  onToken,
  setToken,
  storePat,
} from '../api/token';
import type {
  AppConfig,
  Catalog,
  FlightStateDto,
  ShowTracesPlan,
  SnippetDto,
  TableKind,
} from '../api/types';
import { type HashState, readHash, writeHash } from '../app/hash';
import { findRecording, readEntryParams, type EntryParams } from '../app/params';
import { resetChartTheme } from '../components/charts/colors';
import type { ViewRange } from '../components/charts/viewRange';
import { type DragMode, loadDragMode, storeDragMode } from '../selection/drag';
import { type FlightEvent, pickedEvents } from '../selection/events';
import { log } from '../log';
import { clock } from '../playback/clock';
import { collapsedFrom, collapsedIds, type Collapsed } from '../layout/panels';
import type { WorkbookHandle } from '../api/workbook';
import {
  addWidget,
  clearStoredDashboard,
  findView,
  isPreset,
  loadActiveView,
  loadLayout,
  loadViews,
  moveItem,
  newViewId,
  normalizeLayout,
  removeWidget,
  resizeItem,
  setWidgetParams,
  STANDARD_LAYOUT,
  storeActiveView,
  storeLayout,
  storeViews,
  type Layout,
  type SavedView,
  type WidgetId,
  type WidgetKind,
} from '../layout/dashboard';
import {
  clampStripHeight,
  clearStoredStripHeight,
  loadStripHeight,
  storeStripHeight,
  STRIP_HEIGHT_DEFAULT,
} from '../layout/panelSizes';
import {
  clampTreeWidth,
  loadTreeOpen,
  loadTreeWidth,
  storeTreeOpen,
  storeTreeWidth,
  TREE_WIDTH_DEFAULT,
} from '../layout/sidebar';
import { applyTheme, loadTheme, nextTheme, type Theme } from '../theme/theme';

export interface PickedSignal {
  key: string;
  table: TableKind;
  scope: string;
  signal: string;
}

export function pickKey(table: TableKind, scope: string, signal: string): string {
  return `${table}:${scope}:${signal}`;
}

/** Token origin; only a user-supplied one the modal replaces. */
export type TokenSource = 'portal' | 'pat' | null;

export function parsePick(key: string): PickedSignal | null {
  const [table, scope, signal] = key.split(':');
  if (!table || !scope || !signal) return null;
  return { key, table: table as TableKind, scope, signal };
}

interface SessionState {
  config: AppConfig | null;
  catalog: Catalog | null;
  aircraft: string | null;
  recording: string | null;
  /** Tree levels already opened this session, by `aircraft/recording/kind[/scope]`. */
  scopesByNode: Record<string, string[]>;
  signalsByNode: Record<string, string[]>;
  /** Nodes with a lookup in flight. */
  treeLoading: Record<string, boolean>;
  flight: FlightStateDto | null;
  picked: PickedSignal[];
  /** Shared drag zoom; mirrored to the hash as v. */
  view: ViewRange | null;
  /** The marked period, shown on every panel; mirrored to the hash as sel. */
  selection: ViewRange | null;
  /** The lake's data snippets for the open recording; null until looked up. */
  snippets: SnippetDto[] | null;
  snippetsLoading: boolean;
  /** Snippets shown as events on every panel, by id; mirrored to the hash as an. */
  pickedSnippets: number[];
  /** The picked snippets as drawable bands, derived once per change. */
  events: FlightEvent[];
  /** What a chart drag does. */
  dragMode: DragMode;
  follow: boolean;
  collapsed: Collapsed;
  theme: Theme;
  treeOpen: boolean;
  treeWidth: number;
  /** The widgets on the dashboard and where they sit, in grid cells. */
  layout: Layout;
  /** Edit mode: widgets move by their title bar, resize by their corner, and can be removed. */
  editing: boolean;
  /** The views a person saved; the presets live in `PRESET_VIEWS`. */
  views: SavedView[];
  /** The preset or saved view the layout came from, until the layout changes hands. */
  activeViewId: string | null;
  /** An issue a link asked to tick, until the run's snippets arrive and it can be. */
  pendingIssue: number | null;
  /** The workbook's signals-and-anomalies dialog. */
  picksOpen: boolean;
  setPicksOpen(open: boolean): void;
  /** The Test Manager workbook this station draws, when it draws one. Its owner keeps it. */
  workbook: { name: string; onLayout: (layout: Layout) => void } | null;
  stripHeight: number;
  hasToken: boolean;
  needsPat: boolean;
  tokenSource: TokenSource;
  booted: boolean;
  /** Shell stays covered until the boot token attempt settles. */
  authResolved: boolean;
  authBusy: boolean;
  /** Whether the agent push stream is open. */
  aiLink: LinkState;
  loading: boolean;
  error: string | null;
  lastStatus: number | null;
  initToken(): Promise<void>;
  loadCatalog(): Promise<void>;
  boot(): Promise<void>;
  submitPat(token: string): Promise<void>;
  selectRecording(a: string, r: string, t?: number): Promise<void>;
  openEntry(a: string, r: string, entry: EntryParams): Promise<void>;
  loadScopes(kind: TableKind): Promise<void>;
  loadSignals(kind: TableKind, scope: string): Promise<void>;
  togglePick(p: PickedSignal): void;
  togglePanel(id: WidgetId): void;
  setFollow(b: boolean): void;
  setView(v: ViewRange): void;
  resetZoom(): void;
  setSelection(r: ViewRange): void;
  clearSelection(): void;
  loadSnippets(): Promise<void>;
  toggleSnippet(id: number): void;
  pickAllSnippets(on: boolean): void;
  setDragMode(m: DragMode): void;
  toggleTheme(): void;
  toggleTree(): void;
  resetView(): void;
  setTreeWidth(px: number): void;
  moveWidget(id: WidgetId, x: number, y: number): void;
  resizeWidget(id: WidgetId, w: number, h: number): void;
  addWidget(kind: WidgetKind): void;
  removeWidget(id: WidgetId): void;
  /** The parameters one waveform shows, as pick keys. */
  setWidgetParams(id: WidgetId, keys: readonly string[]): void;
  /** An empty dashboard, to build one from the gallery. */
  clearDashboard(): void;
  setEditing(on: boolean): void;
  /** Load a preset or a saved view onto the dashboard. */
  applyView(id: string): void;
  /** Draw a Test Manager workbook: its layout now, its owner told of every change. */
  openWorkbook(handle: WorkbookHandle): void;
  /** Back to the station's own dashboard. */
  closeWorkbook(): void;
  /** Save the dashboard under a name; a saved view of that name is overwritten. Returns its id. */
  saveView(name: string): string;
  deleteView(id: string): void;
  setStripHeight(px: number): void;
  resetLayout(): void;
  syncHash(): void;
  applyPlan(plan: ShowTracesPlan): Promise<void>;
  startEvents(): void;
}

const TOKEN_WAIT_MS = 10_000;
const NO_PORTAL_TOKEN = 'Portal token unavailable — enter a PAT to continue';
const PAT_REFUSED = 'The Quix Portal refused that token. Check it and try again.';

// StrictMode mounts twice; the in-flight promise stops a race.
let initPending: Promise<void> | null = null;
let eventsHandle: EventsHandle | null = null;
// Plans apply in arrival order; the newest one lands last.
let planChain: Promise<void> = Promise.resolve();

function findRun(catalog: Catalog | null, runId: string): { a: string; r: string } | null {
  return catalog ? findRecording(catalog, runId) : null;
}

/** Where a plan wants the clock: cursor, else window start. */
function planTime(plan: ShowTracesPlan): number | undefined {
  return plan.t_ms ?? plan.t0_ms ?? undefined;
}

export const useSession = create<SessionState>((set, get) => {
  async function runInitToken(): Promise<void> {
    try {
      const config = await fetchConfig();
      set({ config });
      const embedded = isEmbedded();
      suggestAgent(config.agentId, embedded);
      const attempt = await acquireToken(embedded, config.authActive);
      const hasToken = getToken() !== null;
      if (!embedded && hasToken) set({ tokenSource: 'pat' });
      const needsPat = config.authActive && !hasToken;
      set({ hasToken, needsPat });
      if (needsPat && embedded) {
        set({ error: NO_PORTAL_TOKEN });
        log.error('boot', 'no token from the portal', { embedded: true, ...attempt });
        return;
      }
      log.info('boot', 'token ready', { embedded, authActive: config.authActive, hasToken });
    } catch (e) {
      const error = message(e);
      set({ error });
      log.error('boot', 'token init failed', { error });
    } finally {
      set({ authResolved: true });
    }
  }

  /** Reopen what the hash saved: the recording, its zoom and its marked period. */
  async function openSaved(h: HashState): Promise<void> {
    if (!h.a || !h.r) return;
    await get().selectRecording(h.a, h.r, h.t);
    if (h.v && get().flight) get().setView({ t0_ms: h.v[0], t1_ms: h.v[1] });
    if (h.sel && get().flight) get().setSelection({ t0_ms: h.sel[0], t1_ms: h.sel[1] });
    if (h.an && get().flight) set({ pickedSnippets: h.an });
  }

  /** Only a user token is recoverable, never the portal's. */
  function rejectToken(status: number | null): void {
    if (status !== 401 || !get().config?.authActive) return;
    if (get().tokenSource === 'portal') return;
    clearStoredPat();
    setToken(null);
    set({
      needsPat: true,
      hasToken: false,
      authBusy: false,
      tokenSource: null,
      error: PAT_REFUSED,
    });
    log.warn('auth', 'pat rejected', { status });
  }

  /**
   * The dashboard changed by hand: keep it, and it no longer equals any view. Inside a
   * workbook its owner keeps it instead, and hears every change.
   */
  function placeLayout(layout: Layout): void {
    const workbook = get().workbook;
    if (workbook === null) storeLayout(layout);
    else workbook.onLayout(layout);
    set({ layout });
  }

  return {
    config: null,
    catalog: null,
    aircraft: null,
    recording: null,
    scopesByNode: {},
    signalsByNode: {},
    treeLoading: {},
    flight: null,
    picked: [],
    view: null,
    selection: null,
    snippets: null,
    snippetsLoading: false,
    pickedSnippets: [],
    events: [],
    dragMode: loadDragMode(),
    follow: true,
    collapsed: collapsedFrom([]),
    theme: loadTheme(),
    treeOpen: loadTreeOpen(),
    treeWidth: loadTreeWidth(),
    layout: loadLayout(),
    editing: false,
    views: loadViews(),
    activeViewId: loadActiveView(),
    workbook: null,
    pendingIssue: null,
    picksOpen: false,
    stripHeight: loadStripHeight(),
    hasToken: false,
    needsPat: false,
    tokenSource: null,
    booted: false,
    authResolved: false,
    authBusy: false,
    aiLink: 'off',
    loading: false,
    error: null,
    lastStatus: null,

    async initToken() {
      if (get().booted) {
        await initPending;
        return;
      }
      set({ booted: true });
      onToken((t) => set({ hasToken: !!t }));
      onPortalToken(() => set({ tokenSource: 'portal' }));
      initPending = runInitToken();
      await initPending;
    },

    async loadCatalog() {
      set({ loading: true, error: null });
      try {
        const catalog = await fetchCatalog();
        const entry = readEntryParams(window.location.search);
        const h = readHash();
        const picked = h.s.map(parsePick).filter((p): p is PickedSignal => p !== null);
        const collapsed = collapsedFrom(h.c);
        set({ catalog, picked, collapsed, loading: false, lastStatus: null });
        log.info('boot', 'catalog loaded', { aircraft: catalog.aircraft.length });
        get().startEvents();
        const opened = entry ? findRecording(catalog, entry.run) : null;
        if (entry && opened) await get().openEntry(opened.a, opened.r, entry);
        // A workbook's run is the URL's; the hash's last recording is not it.
        else if (get().workbook === null) await openSaved(h);
      } catch (e) {
        const error = message(e);
        const status = e instanceof ApiError ? e.status : null;
        set({ error, loading: false, lastStatus: status });
        log.error('boot', 'catalog load failed', { error, status });
        rejectToken(status);
      }
    },

    async boot() {
      await get().initToken();
      if (get().hasToken || !get().config?.authActive) await get().loadCatalog();
    },

    // The modal stays up until the catalog proves the token.
    async submitPat(token) {
      log.info('auth', 'pat submitted', { tokenLen: token.length });
      storePat(token);
      set({ error: null, authBusy: true, tokenSource: 'pat' });
      await get().loadCatalog();
      // rejectToken already set the refused state; do not undo it.
      if (get().lastStatus === 401) return;
      // The catalog is the verdict; a later error rides the banner.
      if (get().catalog !== null) {
        set({ needsPat: false, hasToken: true, authBusy: false });
        return;
      }
      set({ authBusy: false });
    },

    async openEntry(a, r, entry) {
      set({ pendingIssue: entry.issue ?? null });
      await get().selectRecording(a, r, entry.t);
      if (get().error) return;
      // The link names the picks, so a pick the hash held belongs to another run.
      const { picks } = entry.signals.length
        ? await fetchResolve(a, r, entry.signals)
        : { picks: [] };
      const picked = picks.map((p) => ({
        key: pickKey(p.table, p.scope, p.name),
        table: p.table,
        scope: p.scope,
        signal: p.name,
      }));
      set({ picked });
      log.info('entry', 'signals placed', { asked: entry.signals.length, found: picked.length });
      if (entry.sel && get().flight) {
        get().setSelection({ t0_ms: entry.sel[0], t1_ms: entry.sel[1] });
      }
      get().syncHash();
    },

    async selectRecording(a, r, t) {
      const cur = get();
      if (cur.aircraft === a && cur.recording === r && cur.flight && !cur.error) return;
      set({
        aircraft: a,
        recording: r,
        loading: true,
        error: null,
        flight: null,
        view: null,
        selection: null,
        snippets: null,
        pickedSnippets: [],
        events: [],
      });
      try {
        const flight = await fetchFlightState(a, r);
        clock.load(
          flight.segments.map((s) => ({ t0: s.t0_ms, t1: s.t1_ms })),
          t,
        );
        set({ flight, loading: false });
        void get().loadSnippets();
        log.info('recording', 'flight state loaded', {
          aircraft: a,
          recording: r,
          frames: flight.n,
          segments: flight.segments.length,
        });
        get().syncHash();
      } catch (e) {
        const error = message(e);
        set({ loading: false, error });
        log.error('recording', 'flight state failed', { aircraft: a, recording: r, error });
      }
    },

    async loadScopes(kind) {
      const { aircraft, recording, scopesByNode } = get();
      if (!aircraft || !recording) return;
      const node = `${aircraft}/${recording}/${kind}`;
      if (scopesByNode[node] || get().treeLoading[node]) return;
      set({ treeLoading: { ...get().treeLoading, [node]: true } });
      try {
        const { scopes } = await fetchScopes(aircraft, recording, kind);
        set({ scopesByNode: { ...get().scopesByNode, [node]: scopes }, error: null });
        log.info('tree', 'scopes loaded', { node, scopes: scopes.length });
      } catch (e) {
        const error = message(e);
        set({ error });
        log.error('tree', 'scopes failed', { node, error });
      } finally {
        set({ treeLoading: { ...get().treeLoading, [node]: false } });
      }
    },

    async loadSignals(kind, scope) {
      const { aircraft, recording, signalsByNode } = get();
      if (!aircraft || !recording) return;
      const node = `${aircraft}/${recording}/${kind}/${scope}`;
      if (signalsByNode[node] || get().treeLoading[node]) return;
      set({ treeLoading: { ...get().treeLoading, [node]: true } });
      try {
        const { signals } = await fetchSignals(aircraft, recording, kind, scope);
        set({ signalsByNode: { ...get().signalsByNode, [node]: signals }, error: null });
        log.info('tree', 'signals loaded', { node, signals: signals.length });
      } catch (e) {
        const error = message(e);
        set({ error });
        log.error('tree', 'signals failed', { node, error });
      } finally {
        set({ treeLoading: { ...get().treeLoading, [node]: false } });
      }
    },

    togglePick(p) {
      const picked = get().picked;
      const next = picked.some((x) => x.key === p.key)
        ? picked.filter((x) => x.key !== p.key)
        : [...picked, p];
      set({ picked: next });
      get().syncHash();
    },

    togglePanel(id) {
      const collapsed = { ...get().collapsed, [id]: !(get().collapsed[id] ?? false) };
      set({ collapsed });
      get().syncHash();
      log.debug('layout', 'panel toggled', { id, collapsed: collapsed[id] });
    },

    setFollow(follow) {
      set({ follow });
    },

    setView(view) {
      set({ view });
      get().syncHash();
      log.debug('charts', 'zoom set', { ...view, span: view.t1_ms - view.t0_ms });
    },

    resetZoom() {
      if (get().view === null) return;
      set({ view: null });
      get().syncHash();
      log.debug('charts', 'zoom reset');
    },

    setSelection(selection) {
      set({ selection });
      get().syncHash();
      log.debug('charts', 'period selected', {
        ...selection,
        span: selection.t1_ms - selection.t0_ms,
      });
    },

    clearSelection() {
      if (get().selection === null) return;
      set({ selection: null });
      get().syncHash();
      log.debug('charts', 'selection cleared');
    },

    async loadSnippets() {
      const { aircraft, recording } = get();
      if (!aircraft || !recording || get().snippetsLoading) return;
      set({ snippetsLoading: true });
      try {
        const { snippets } = await fetchSnippets(aircraft, recording);
        if (get().aircraft !== aircraft || get().recording !== recording) return;
        let picked = get().pickedSnippets.filter((id) => snippets.some((s) => s.id === id));
        // The issue a link named is ticked as soon as the run's snippets name it.
        const wanted = get().pendingIssue;
        if (wanted !== null && snippets.some((s) => s.id === wanted) && !picked.includes(wanted)) {
          picked = [...picked, wanted];
        }
        set({ snippets, pickedSnippets: picked, events: pickedEvents(snippets, picked), pendingIssue: null });
        log.info('tree', 'snippets loaded', { count: snippets.length, picked: picked.length });
      } catch (e) {
        const error = message(e);
        set({ snippets: [] });
        log.error('tree', 'snippets failed', { error });
      } finally {
        set({ snippetsLoading: false });
      }
    },

    toggleSnippet(id) {
      const { pickedSnippets, snippets } = get();
      const next = pickedSnippets.includes(id)
        ? pickedSnippets.filter((x) => x !== id)
        : [...pickedSnippets, id];
      set({ pickedSnippets: next, events: pickedEvents(snippets ?? [], next) });
      get().syncHash();
      log.debug('tree', 'snippet toggled', { id, picked: next.length });
    },

    pickAllSnippets(on) {
      const snippets = get().snippets ?? [];
      // Only a dated snippet can be drawn; an undated note stays unpicked.
      const next = on
        ? snippets.filter((s) => s.t0_ms !== null && s.t1_ms !== null).map((s) => s.id)
        : [];
      set({ pickedSnippets: next, events: pickedEvents(snippets, next) });
      get().syncHash();
      log.debug('tree', on ? 'all snippets picked' : 'snippets cleared', { picked: next.length });
    },

    setDragMode(dragMode) {
      storeDragMode(dragMode);
      set({ dragMode });
      log.debug('charts', 'drag mode', { dragMode });
    },

    resetView() {
      clock.stop();
      set({
        aircraft: null,
        recording: null,
        flight: null,
        picked: [],
        view: null,
        selection: null,
        snippets: null,
        pickedSnippets: [],
        events: [],
        error: null,
      });
      get().syncHash();
      log.info('session', 'view reset');
    },

    toggleTree() {
      const treeOpen = !get().treeOpen;
      storeTreeOpen(treeOpen);
      set({ treeOpen });
    },

    setTreeWidth(px) {
      const treeWidth = clampTreeWidth(px);
      storeTreeWidth(treeWidth);
      set({ treeWidth });
    },

    moveWidget(id, x, y) {
      const layout = moveItem(get().layout, id, x, y);
      if (layout !== get().layout) placeLayout(layout);
    },

    resizeWidget(id, w, h) {
      const layout = resizeItem(get().layout, id, w, h);
      if (layout !== get().layout) placeLayout(layout);
    },

    addWidget(kind) {
      const layout = addWidget(get().layout, kind);
      if (layout === get().layout) return;
      placeLayout(layout);
      log.debug('layout', 'widget added', { kind });
    },

    setWidgetParams(id, keys) {
      const layout = setWidgetParams(get().layout, id, keys);
      if (layout === get().layout) return;
      placeLayout(layout);
      log.debug('layout', 'widget parameters set', { id, count: keys.length });
    },

    removeWidget(id) {
      const layout = removeWidget(get().layout, id);
      if (layout === get().layout) return;
      placeLayout(layout);
      log.debug('layout', 'widget removed', { id });
    },

    clearDashboard() {
      placeLayout([]);
      set({ editing: true });
      log.info('layout', 'dashboard cleared');
    },

    setEditing(editing) {
      set({ editing });
      log.debug('layout', editing ? 'editing' : 'locked');
    },

    applyView(id) {
      const view = findView(get().views, id);
      if (!view) return;
      if (get().workbook !== null) {
        placeLayout(view.layout);
        log.info('layout', 'preset placed in the workbook', { id, name: view.name });
        return;
      }
      storeLayout(view.layout);
      storeActiveView(view.id);
      set({ layout: view.layout, activeViewId: view.id });
      log.info('layout', 'view applied', { id, name: view.name });
    },

    saveView(name) {
      const label = name.trim() || 'Untitled';
      const existing = get().views.find((v) => v.name.toLowerCase() === label.toLowerCase());
      const id = existing?.id ?? newViewId();
      const view: SavedView = { id, name: label, layout: get().layout };
      const views = existing
        ? get().views.map((v) => (v.id === id ? view : v))
        : [...get().views, view];
      storeViews(views);
      storeActiveView(id);
      set({ views, activeViewId: id });
      log.info('layout', existing ? 'view overwritten' : 'view saved', { id, name: label });
      return id;
    },

    setPicksOpen(picksOpen) {
      set({ picksOpen });
    },

    openWorkbook(handle) {
      const layout = handle.layout.length === 0 ? STANDARD_LAYOUT : normalizeLayout(handle.layout);
      set({
        workbook: { name: handle.name, onLayout: handle.onLayout },
        layout,
        activeViewId: null,
        editing: false,
      });
      log.info('workbook', 'workbook opened', { name: handle.name, widgets: layout.length });
    },

    closeWorkbook() {
      if (get().workbook === null) return;
      set({ workbook: null, layout: loadLayout(), activeViewId: loadActiveView(), editing: false });
      log.info('workbook', 'workbook closed');
    },

    deleteView(id) {
      if (isPreset(id) || !get().views.some((v) => v.id === id)) return;
      const views = get().views.filter((v) => v.id !== id);
      storeViews(views);
      const activeViewId = get().activeViewId === id ? null : get().activeViewId;
      storeActiveView(activeViewId);
      set({ views, activeViewId });
      log.info('layout', 'view deleted', { id });
    },

    setStripHeight(px) {
      const stripHeight = clampStripHeight(px);
      storeStripHeight(stripHeight);
      set({ stripHeight });
    },

    resetLayout() {
      if (get().workbook === null) clearStoredDashboard();
      else get().workbook?.onLayout(STANDARD_LAYOUT);
      clearStoredStripHeight();
      storeTreeWidth(TREE_WIDTH_DEFAULT);
      set({
        layout: STANDARD_LAYOUT,
        activeViewId: null,
        editing: false,
        stripHeight: STRIP_HEIGHT_DEFAULT,
        treeWidth: TREE_WIDTH_DEFAULT,
        collapsed: collapsedFrom([]),
      });
      get().syncHash();
      log.info('layout', 'layout reset');
    },

    toggleTheme() {
      const theme = nextTheme(get().theme);
      applyTheme(theme);
      resetChartTheme();
      set({ theme });
    },

    startEvents() {
      if (eventsHandle) return;
      eventsHandle = openEvents(
        (f) => {
          if (f.event !== 'show_traces') return;
          let plan: ShowTracesPlan;
          try {
            plan = JSON.parse(f.data) as ShowTracesPlan;
          } catch (e) {
            log.warn('ai', 'unreadable plan ignored', { error: String(e) });
            return;
          }
          planChain = planChain.then(async () => {
            try {
              await get().applyPlan(plan);
            } catch (e) {
              log.warn('ai', 'plan failed', { error: String(e) });
            }
          });
        },
        (aiLink) => set({ aiLink }),
      );
      log.info('ai', 'event stream started');
    },

    async applyPlan(plan) {
      const hit = findRun(get().catalog, plan.run_id);
      if (!hit) {
        log.warn('ai', 'plan for an unknown run ignored', { run_id: plan.run_id });
        return;
      }
      const t = planTime(plan);
      log.info('ai', 'plan received', { run_id: plan.run_id, traces: plan.traces.length, t });
      const cur = get();
      if (cur.aircraft === hit.a && cur.recording === hit.r && cur.flight) {
        if (t !== undefined) clock.seek(t);
      } else {
        await get().selectRecording(hit.a, hit.r, t);
        if (get().error) return;
      }
      set({
        picked: plan.traces.map((tr) => ({
          key: pickKey(tr.protocol, tr.scope, tr.signal),
          table: tr.protocol,
          scope: tr.scope,
          signal: tr.signal,
        })),
      });
      if (plan.t0_ms !== null && plan.t1_ms !== null) {
        get().setView({ t0_ms: plan.t0_ms, t1_ms: plan.t1_ms });
      } else {
        get().resetZoom();
      }
      get().syncHash();
    },

    syncHash() {
      const { aircraft, recording, picked, collapsed, view, selection, pickedSnippets } = get();
      writeHash({
        a: aircraft ?? undefined,
        r: recording ?? undefined,
        t: recording ? clock.t : undefined,
        s: picked.map((p) => p.key),
        c: collapsedIds(collapsed),
        v: view ? [view.t0_ms, view.t1_ms] : undefined,
        sel: selection ? [selection.t0_ms, selection.t1_ms] : undefined,
        an: pickedSnippets.length > 0 ? pickedSnippets : undefined,
      });
    },
  };
});

interface TokenAttempt {
  sdkLoaded: boolean;
  relayed: boolean;
  waitedMs: number;
}

async function acquireToken(embedded: boolean, authActive: boolean): Promise<TokenAttempt> {
  if (!embedded) {
    const pat = loadStoredPat();
    if (pat) setToken(pat);
    return { sdkLoaded: false, relayed: false, waitedMs: 0 };
  }
  // Both paths start together; nested, only the relay can answer.
  const relay = initParentRelay();
  const sdkLoaded = await initPluginSdk();
  if (!authActive || getToken()) return { sdkLoaded, relayed: false, waitedMs: 0 };
  const relayed = await relay;
  if (relayed || !sdkLoaded) return { sdkLoaded, relayed, waitedMs: 0 };
  return { sdkLoaded, relayed, waitedMs: await waitForToken(TOKEN_WAIT_MS) };
}

/** The first portal token is async; give up, do not hang boot. */
function waitForToken(timeoutMs: number): Promise<number> {
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(Date.now() - started);
    }, timeoutMs);
    const off = onToken((t) => {
      if (!t) return;
      clearTimeout(timer);
      off();
      resolve(Date.now() - started);
    });
  });
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
