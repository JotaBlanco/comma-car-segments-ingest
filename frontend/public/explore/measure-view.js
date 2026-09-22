// ── Measurement view (signal explorer) ────────
// Owns the shell: signal tree, stacked strips, cursor readout, theme and mode.
// Drawing lives in measure-render.js; data comes from an injected provider, so
// this file has no knowledge of the lake, of endpoints, or of node kinds.
//
// PROVIDER CONTRACT — anything satisfying this can drive the view:
//   provider.children(path)  -> Promise<[{ key, value, leaf, count }]>
//        One level of the partition tree. ``path`` is "" at the root.
//        ``leaf: true`` marks a selectable signal, which is always a whole
//        partition — the deepest level's value, or the whole table when it has
//        no partition columns (the ``~all`` segment, window.QM.WHOLE_TABLE).
//        Value columns are never tree nodes: they are ticked in the columns
//        panel and fanned out per signal by tracesOf.
//   provider.frames(ids, q)  -> Promise<{ [id]: {min,max,mean,count} }>
//        q = { t0, t1, buckets, cols }. ``ids`` are TRACE keys, not signal ids
//        — one per (signal, value column), and q.cols[key] names the single
//        column that trace aggregates. See tracesOf. A key may instead carry
//        its column as a bare last segment: that is what the fan-out appends,
//        and what a layout saved by an older build already holds. Frames are
//        already reduced to ``buckets`` entries — see measure-render.js for the
//        contract and why ``count`` is mandatory.
//   provider.meta(id)        -> { name, unit, dec }   (optional, sync)
//
// STATE — one object, three renderers. Standard / AI / Explore are views over
// ``state``, never separate copies of it: that is what makes an AI-produced
// layout show up in explore with no import step.

(function () {
  "use strict";

  // Trace colours come from tokens (measure.css) so both themes work; signals
  // take them in selection order and keep them until deselected.
  const SIG_VARS = [
    "--qm-sig-1", "--qm-sig-2", "--qm-sig-3", "--qm-sig-4",
    "--qm-sig-5", "--qm-sig-6", "--qm-sig-7", "--qm-sig-8",
  ];

  /** Pan/zoom debounce — see _scheduleFetch.
   *
   *  Trailing, so a continuous drag still issues ONE query when it settles, never
   *  one per frame; the interval only decides how soon after the last event that
   *  query goes out. 200ms buys back a fifth of a second of felt lag on every
   *  gesture, and costs an extra partition scan only for a burst whose gaps fall
   *  between 200 and 400ms — a superseded query is aborted on our side, but the
   *  lake keeps working on it, so the saving there is our slot, not its load.
   */
  const REFETCH_MS = 200;
  // The most signals one plot may carry, wherever they come from: a branch tick
  // in the tree, or a restored viz.measure layout. Every signal costs a chip in
  // the window head, a row in the readout, four aggregates in the SQL and a frame
  // of four arrays — and a CAN frame_name branch holds enough of them to turn one
  // click into gigabytes. Shared with measure-tree.js via window.QM.
  const MAX_SIGNALS = 48;

  // The step is what stops a 1px resize from becoming a new query — see bucketsFor.
  const BUCKET_STEP = 100;
  // One bucket per CSS pixel up to a 4K plot; the ceiling guards memory, not the lake.
  const BUCKET_MAX = 4096;

  /** The reserved path segment for the whole-table channel.
   *
   *  A table with no partition columns has no partition value to name a channel
   *  after, so the provider offers ONE synthetic leaf at the root and the table
   *  itself is the channel. The segment has to be one no partition can produce
   *  — a real one reads "key=value", and a bare segment already means a value
   *  column — so the grammar (parseId, namedColumn) reads this exact string as
   *  "no partition filter, no column". Shared via window.QM: measure-lake.js
   *  speaks the same grammar.
   */
  const WHOLE_TABLE = "~all";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  /** The canonical shape of a value-column selection: a deduped list of names.
   *
   *  A layout saved before multi-select holds a scalar, so ONE place coerces it
   *  (load) and everything downstream may assume a list. Same normalisation
   *  viz-plotly.js does for the dataset node's chart ``y``.
   */
  function toColumnList(v) {
    const list = Array.isArray(v) ? v : (v ? [v] : []);
    const out = [];
    list.forEach((name) => {
      if (name && out.indexOf(name) < 0) out.push(name);
    });
    return out;
  }

  /** A per-value-column unit map from a payload: non-empty strings only.
   *
   *  Written by hand in the columns panel, so a malformed one (array, string,
   *  null) must restore as empty rather than shadow the unit column.
   */
  function unitMap(v) {
    const out = {};
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    Object.keys(v).forEach((name) => {
      const u = String(v[name] == null ? "" : v[name]).trim();
      if (name && u) out[name] = u;
    });
    return out;
  }

  /** The ``columns`` slice of a payload.
   *
   *  ``unit`` (the table's unit COLUMN) and ``units`` (a unit typed per value
   *  column) are written only when set, so a layout that uses neither
   *  serializes exactly as it did before either existed.
   */
  function columnsPayload(c) {
    const out = { x: c.x, y: toColumnList(c.y) };
    if (c.unit) out.unit = c.unit;
    const units = unitMap(c.units);
    if (Object.keys(units).length) out.units = units;
    return out;
  }

  /** The value column a signal id already NAMES, or null.
   *
   *  The same grammar parseId speaks (measure-lake.js): a trailing segment with
   *  no "=" is a column. load folds such an id out of a saved layout, so what
   *  is left is an id pushed straight into state; it is ONE trace whatever the
   *  default list says — appending a second name would aggregate the wrong column.
   */
  function namedColumn(id) {
    const segs = String(id).split("/").filter(Boolean);
    const last = segs.length ? segs[segs.length - 1] : "";
    // The whole-table channel is bare but names no column, so it fans out.
    if (last === WHOLE_TABLE) return null;
    return last.indexOf("=") > 0 ? null : (last || null);
  }

  /** The automatic label for a signal id: the deepest segment's value.
   *
   *  Same derivation the tree's leaf metadata uses ("day=13" -> "13", a bare
   *  "GS" -> "GS"), so clearing the columns panel's name field restores exactly
   *  the name a fresh selection would have carried. The whole-table channel has
   *  no value of its own, so it is labelled with ``table`` when the caller
   *  knows it.
   */
  function autoSignalName(id, table) {
    const segs = String(id).split("/").filter(Boolean);
    const last = segs.length ? segs[segs.length - 1] : "";
    if (last === WHOLE_TABLE) return String(table || id);
    const at = last.indexOf("=");
    return (at > 0 ? last.slice(at + 1) : last) || String(id);
  }

  /** Fold ids that END in their value column into channel + column list.
   *
   *  A build where columns were tree leaves saved one signal PER column
   *  ("…/day=13/GS"), and such an id stays pinned to that one column: the
   *  columns panel's list is ignored, so one channel drew one row and one
   *  trace. Folding on the way in restores the channel ("…/day=13") and moves
   *  the column into the table-level list, where fan-out picks it up again.
   *
   *  Only an id whose remaining channel is still a partition path folds — for
   *  anything else the split would be a guess. Window keys mostly need no
   *  work: the fan-out key "channel/col" is byte-identical to the legacy id,
   *  so hidden/axes survive as they are unless the fold leaves exactly ONE
   *  column, whose trace key is the bare channel.
   *
   *  Nothing folds -> the same objects come back, so a layout without such an
   *  id serializes exactly as it did before.
   */
  function foldNamedColumns(payload, columns) {
    const signals = Array.isArray(payload.signals) ? payload.signals : [];
    const channelOf = {};
    const cols = [];
    signals.forEach((x) => {
      const id = String((x && x.id) || "");
      const col = namedColumn(id);
      if (!col) return;
      const segs = id.split("/").filter(Boolean);
      const channel = segs.slice(0, -1).join("/");
      if (!channel || namedColumn(channel)) return;
      channelOf[id] = channel;
      if (cols.indexOf(col) < 0) cols.push(col);
    });
    if (!cols.length) return { payload: payload, columns: columns, folded: false };

    // The saved list keeps its order and its picks; a folded column joins it.
    const y = toColumnList(columns.y);
    cols.forEach((col) => { if (y.indexOf(col) < 0) y.push(col); });
    const units = unitMap(columns.units);
    const foldedCols = {};
    const byId = {};
    const out = [];
    signals.forEach((x) => {
      const id = String((x && x.id) || "");
      const channel = channelOf[id];
      const key = channel || id;
      if (!byId[key]) {
        // First appearance wins the registry entry: its colour, decimals and X.
        byId[key] = Object.assign({}, x, { id: key });
        if (channel) { delete byId[key].y; delete byId[key].unit; }
        out.push(byId[key]);
      }
      if (!channel) return;
      const col = namedColumn(id);
      // A unit saved on a per-column signal describes the COLUMN, on every channel.
      const unit = String((x && x.unit) || "").trim();
      if (unit && !units[col]) units[col] = unit;
      (foldedCols[key] || (foldedCols[key] = [])).push(col);
    });
    // A hand-typed label survives the collapse; a legacy name that is only its
    // own column name labelled a row that no longer exists.
    out.forEach((entry) => {
      const names = foldedCols[entry.id];
      if (names && (!entry.name || names.indexOf(String(entry.name)) >= 0)) {
        entry.name = autoSignalName(entry.id);
      }
    });

    // One column left means the trace key is the bare channel, so a key that
    // named a column must follow it; with several they already match fan-out.
    const one = y.length === 1;
    const toChannel = (k) => channelOf[k] || k;
    const asIs = (k) => k;
    const dedupe = (arr, map) => {
      const seen = [];
      (arr || []).forEach((k) => {
        const next = map(k);
        if (seen.indexOf(next) < 0) seen.push(next);
      });
      return seen;
    };
    const toTraceKey = one ? toChannel : asIs;
    const windows = Array.isArray(payload.windows) ? payload.windows.map((w) => {
      const next = Object.assign({}, w, { signals: dedupe(w.signals, toChannel) });
      if (Array.isArray(w.hidden)) next.hidden = dedupe(w.hidden, toTraceKey);
      if (Array.isArray(w.axes)) next.axes = dedupe(w.axes, toTraceKey);
      return next;
    }) : payload.windows;

    return {
      payload: Object.assign({}, payload, { signals: out, windows: windows }),
      columns: Object.assign({}, columns, { y: y, units: units }),
      folded: true,
    };
  }

  // Names that plausibly carry time — the same alternation the lake provider
  // uses to detect a table's time column, so panel and query agree.
  const COL_TIME_NAME =
    /(^|_)(t|ts|time|timestamp|date|datetime|day|hour|epoch|millis?|ms|us|ns)(_|$)/i;
  // Relative time counts from a file's start, so it is an offset, not a clock.
  const COL_REL_NAME = /(^|_)rel(_|$)|_rel_?ms$/i;
  // Names that identify, count or size a row rather than measure anything.
  const COL_BOOKKEEPING =
    /(^|_)(size|bytes|index|idx|count|seq|sequence|id|offset|anchor|version|flag)(_|$)|(size|bytes|index|count)$|_id$/i;
  // A name that is ONLY a unit abbreviation labels a reading in that unit.
  const COL_UNIT_ONLY = /^(ms|us|ns|millis?)$/i;

  /** How likely a column is to hold a reading: 0 best, 40 worst.
   *
   *  THE one heuristic behind both value defaults — the columns panel's row
   *  order (measure-tree.js) and the provider's schema fallback
   *  (measure-lake.js pickValueColumn). Ranking separately let them disagree
   *  on the same table: the panel seeded `file_timestamp_epoch_ms` while the
   *  query ran on `fileSizeBytes`, and neither is a measurement.
   *
   *  Nothing is ever excluded, only demoted — the order decides the default,
   *  the list decides what is possible. ``type`` is optional because the
   *  provider only asks about columns it already knows are numeric.
   */
  function columnRank(name, type) {
    const n = String(name || "");
    if (/^(__|_)/.test(n)) return 40;            // Sink/pandas bookkeeping.
    if (type === "timestamp") return 20;         // A clock by type.
    if (type && type !== "numeric") return 30;   // Plottable only if castable.
    if (COL_BOOKKEEPING.test(n)) return 25;      // Row metadata, not a reading.
    if (COL_UNIT_ONLY.test(n)) return 0;         // A unit label, not a clock.
    if (COL_REL_NAME.test(n) || COL_TIME_NAME.test(n)) return 20;
    return 0;                                    // A measurement.
  }

  /** Median samples per bucket in a frame, over the buckets that hold data.
   *
   *  How much the mean line is hiding: a bucket standing for 100 readings is a
   *  different plot from one standing for 1, and ms/px alone cannot tell them
   *  apart — the same pixel width over the same range reads identically on a
   *  10 Hz table and a 100 kHz one. Median, not mean: the first and last
   *  buckets of a range are partial and would drag an average down.
   *  Null when no bucket holds a reading.
   */
  function medianBucketCount(frame) {
    const cs = ((frame && frame.count) || []).filter((n) => n > 0);
    if (!cs.length) return null;
    cs.sort((a, b) => a - b);
    const mid = cs.length >> 1;
    return cs.length % 2 ? cs[mid] : (cs[mid - 1] + cs[mid]) / 2;
  }

  // ── controller ──────────────────────────────────────────

  function Measure(host, cfg) {
    const self = this;
    this.cfg = cfg || {};
    this.provider = this.cfg.provider;
    this.host = host;
    Measure._all.add(this);   // so an app theme toggle can retheme open views

    const now = this.cfg.t1 || Date.now();
    this.state = {
      title: this.cfg.title || "measurement",
      t0: this.cfg.t0 || now - 120000,
      t1: now,
      // REGISTRY, not selection: id -> display metadata. Membership lives on
      // the windows, because the same signal can sit in several of them and
      // each window owns its own selection.
      signals: [],            // [{ id, name, unit, dec, colorVar }]
      windows: [],            // [{ id, label, signalIds, scope, height }]
      // Cursor A and the diff cursor B, per scope. Shared windows share a
      // pair; a window on "own" scope keeps its own.
      cursor: { shared: { a: null, b: null }, own: {} },
      diff: false,            // diff cursor visible + Δ columns in the readout
      hover: null,            // time under the pointer, shared across windows
      band: null,             // { t0, t1, win } while a rubber-band zoom is drawn
      table: this.cfg.table || null,   // chosen lake table (null = pick one)
      // Partition paths the tree is rooted on instead of the table's top level:
      // what a partition dataset picked. Empty means the whole table.
      roots: Array.isArray(this.cfg.roots) ? this.cfg.roots.filter(Boolean) : [],
      // Table-level default X column and Y column LIST. Per-signal overrides
      // live on the signal; anything unset inherits from here, so identical
      // table structures need no per-signal work. Each resolved y column is one
      // trace — see tracesOf. ``units`` is per value column and table-wide: a
      // column means the same quantity on every channel, so the unit is typed
      // once, and a signal's own unit stays the fallback.
      columns: { x: null, y: [], units: {} },
      // Min-max band behind the mean line; opt-in, off until Band asks for it.
      envelope: false,
      active: null,           // window the sidebar tree targets
      mode: this.cfg.mode || "explore",
      theme: this.cfg.theme || "dark",
    };
    if (this.state.cursor.shared.a == null) {
      const mid = this.state.t0 + (this.state.t1 - this.state.t0) / 2;
      this.state.cursor.shared.a = mid;
      this.state.cursor.shared.b = mid + (this.state.t1 - this.state.t0) * 0.1;
    }

    this.frames = {};         // windowId -> traceKey -> frame
    this.frameSpan = {};      // windowId -> the range those frames cover
    this.geom = {};           // windowId -> geometry from qmDrawStrip
    this._fetchGen = 0;
    this._fetchTimer = null;
    this._traceCap = null;    // the "too many traces" notice currently on screen

    this.root = el(`
      <div class="qm" data-theme="${esc(this.state.theme)}" data-mode="${esc(this.state.mode)}">
        <header class="qm-topbar">
          <div class="qm-id">
            <span class="qm-tag">measure</span>
            <button class="qm-tablebtn" type="button" title="Change table">
              <b class="qm-title"></b><span class="qm-caret" aria-hidden="true">▾</span>
            </button>
          </div>
          <div class="qm-modewrap">
          <div class="qm-modes" role="group" aria-label="View mode">
            <button type="button" data-set-mode="standard" aria-pressed="false">Standard</button>
            <button type="button" data-set-mode="ai" aria-pressed="false">AI</button>
            <button type="button" data-set-mode="explore" aria-pressed="false">Explore</button>
          </div>
          <div class="qm-modenote"></div>
          </div>
          <div class="qm-spacer"></div>
          <div class="qm-range">
            <span class="qm-field qm-t0"></span>
            <span>→</span>
            <span class="qm-field qm-t1"></span>
            <button class="qm-ibtn" type="button" data-zoom="out" title="Zoom out">−</button>
            <button class="qm-ibtn" type="button" data-zoom="fit" title="Fit all data">⤢</button>
            <button class="qm-ibtn qm-help" type="button" title="Controls (press ?)">?</button>
            <button class="qm-ibtn qm-theme" type="button" title="Switch plot theme" aria-pressed="false">◐</button>
            <button class="qm-ibtn qm-close" type="button" title="Close">✕</button>
          </div>
        </header>

        <div class="qm-pane qm-body">
          <aside class="qm-sidebar">
            <div class="qm-sb-head">
              <div class="qm-sbmodes" role="tablist" aria-label="Sidebar view">
                <button class="qm-sbmode" type="button" data-sb="tree"
                        role="tab" aria-selected="true"
                        title="Browse partitions and pick signals">tree</button>
                <button class="qm-sbmode" type="button" data-sb="values"
                        role="tab" aria-selected="false"
                        title="Signal values at the cursor">values</button>
              </div>
              <button class="qm-keytog" type="button" aria-pressed="false"
                      title="Show the partition key on every folder — not just the ones you've opened">
                <span aria-hidden="true">⌗</span> keys</button>
              <button class="qm-clearsig" type="button" disabled
                      title="Unselect every signal in every window">
                <span aria-hidden="true">⊘</span> clear all</button>
              <button class="qm-sbfold" type="button"
                      title="Collapse the sidebar (gives the width to the plots)">‹</button>
            </div>
            <label class="qm-search">
              <span aria-hidden="true">⌕</span>
              <input type="text" placeholder="Filter signals…" />
            </label>
            <div class="qm-tables" hidden></div>
            <div class="qm-tree"></div>
            <div class="qm-sb-values" hidden>
              <div class="qm-valbar" role="radiogroup" aria-label="Cursor sampling">
                <span class="qm-valbar-lbl">at cursor</span>
                <button class="qm-fill" type="button" data-fill="nearest" role="radio"
                        aria-checked="true"
                        title="Show the nearest measured point, and how far away it is">points</button>
                <button class="qm-fill" type="button" data-fill="interp" role="radio"
                        aria-checked="false"
                        title="Interpolate between the measured points either side">interpolate</button>
              </div>
              <table>
                <thead></thead>
                <tbody></tbody>
              </table>
            </div>
            <div class="qm-sb-foot">
              <div class="qm-times"></div>
              <div class="qm-sb-counts">
                <span class="qm-count-sig">0 selected</span>
                <span class="qm-sb-target">partitions</span>
                <span class="qm-count-win">0 windows</span>
              </div>
            </div>
            <div class="qm-sb-resizer" title="Drag to resize the sidebar (double-click to reset)"
                 role="separator" aria-orientation="vertical"></div>
          </aside>
          <div class="qm-work">
            <div class="qm-toolbar" role="toolbar" aria-label="Measurement controls">
              <button class="qm-tbtn qm-sbunfold" type="button" hidden
                      title="Show the sidebar tree">
                <span class="qm-tico" aria-hidden="true">☰</span>show tree</button>
              <button class="qm-tbtn qm-difftog" type="button" aria-pressed="false"
                      title="Diff cursor — adds cursor B and the Δ columns">
                <span class="qm-tico" aria-hidden="true">⇹</span>diff cursor</button>
              <button class="qm-tbtn qm-linktog" type="button" data-state="all"
                      title="Shared cursor — link every window to one time base">
                <span class="qm-tico" aria-hidden="true">⛓</span><span class="qm-linklbl">shared cursor</span></button>
              <span class="qm-tsep"></span>
              <button class="qm-tbtn qm-nav" type="button" data-nav="zin" title="Zoom in">
                <span class="qm-tico" aria-hidden="true">⊕</span></button>
              <button class="qm-tbtn qm-nav" type="button" data-nav="zout" title="Zoom out">
                <span class="qm-tico" aria-hidden="true">⊖</span></button>
              <button class="qm-tbtn qm-nav" type="button" data-nav="left" title="Scroll back">
                <span class="qm-tico" aria-hidden="true">◀</span></button>
              <button class="qm-tbtn qm-nav" type="button" data-nav="right" title="Scroll forward">
                <span class="qm-tico" aria-hidden="true">▶</span></button>
              <button class="qm-tbtn qm-nav" type="button" data-nav="fit" title="Fit all data">
                <span class="qm-tico" aria-hidden="true">⤢</span>fit</button>
              <span class="qm-tsep"></span>
              <button class="qm-tbtn qm-cols" type="button" title="Default X / Y columns for every signal">
                <span class="qm-tico" aria-hidden="true">▦</span>columns</button>
              <span class="qm-tsep"></span>
              <button class="qm-tbtn qm-addwin" type="button" title="Add a window">
                <span class="qm-tico" aria-hidden="true">＋</span>window</button>
            </div>
            <div class="qm-colspanel" hidden></div>
            <!-- Floats free of .qm-colspanel's scroll box; placed from its trigger. -->
            <div class="qm-ypanel" hidden></div>
            <div class="qm-err" role="status" hidden></div>
            <div class="qm-workspace"></div>
            <div class="qm-rangestrip" title="Visible window inside the whole measurement — drag to scroll">
              <div class="qm-rangewin"></div>
            </div>
          </div>

        </div>

        <div class="qm-helpbox" hidden role="dialog" aria-label="Controls">
          <div class="qm-helphead">
            <span>Controls</span>
            <button class="qm-helpclose" type="button" title="Close (Esc)">✕</button>
          </div>
          <dl class="qm-helplist"></dl>
        </div>

        <div class="qm-pane qm-standard">
          <div class="qm-standard-msg">
            <b>Standard</b> is the dataset node exactly as it works today — SQL
            editor, result table and the existing chart types. Measurement mode
            adds nothing here; the strips, cursor and readout live in
            <b>Explore</b>.
          </div>
        </div>

        <div class="qm-pane qm-ai">
          <div class="qm-ai-wrap">
            <div class="qm-box">
              <div class="qm-who">Prompt</div>
              <textarea class="qm-prompt" rows="3"
                placeholder="e.g. show engine speed and vehicle speed together, throttle and brake below"></textarea>
              <div class="qm-ai-actions">
                <span class="qm-ai-status">Agent wiring pending — the layout path below is live.</span>
                <button class="qm-go" type="button" disabled>Ask agent</button>
              </div>
            </div>

            <div class="qm-box">
              <div class="qm-who">Preview</div>
              <div class="qm-mini-wrap"></div>
            </div>

            <div class="qm-box">
              <div class="qm-who">Current layout · viz.measure</div>
              <pre class="qm-patch qm-json"></pre>
            </div>

            <div class="qm-box">
              <div class="qm-who">Apply a layout</div>
              <textarea class="qm-apply-json" rows="5"
                placeholder='{"windows":[{"id":"w1","signals":["FORD/EngineSpeed"],"cursor":{"scope":"shared"}}]}'></textarea>
              <div class="qm-ai-actions">
                <span class="qm-ai-status">Writes through the same door the agent will use — Explore inherits it immediately.</span>
                <button class="qm-go qm-apply" type="button">Apply</button>
              </div>
            </div>
          </div>
        </div>
      </div>`);

    this.$ = (sel) => this.root.querySelector(sel);
    this.$.all = (sel) => Array.prototype.slice.call(this.root.querySelectorAll(sel));

    this.$(".qm-title").textContent = this.state.title;
    host.appendChild(this.root);

    // ── chrome wiring ─────────────────────────────────────
    this.$.all("[data-set-mode]").forEach((b) => {
      b.addEventListener("click", () => self.setMode(b.dataset.setMode));
    });
    // Standard / AI are dataset-node concepts (the SQL result and the AI layout);
    // opened from anywhere else — e.g. a standalone Explore node — there is no
    // dataset behind the view, so the whole Standard/AI/Explore switcher is noise.
    if (this.cfg.exploreOnly) {
      this.state.mode = "explore";
      this.root.dataset.mode = "explore";
      const mw = this.$(".qm-modewrap");
      if (mw) mw.style.display = "none";
    }
    // Compact chrome: inline in a canvas node, the view is just the waveforms.
    if (this.cfg.compact) this.root.dataset.compact = "1";

    this.$(".qm-theme").addEventListener("click", () => {
      self.setTheme(self.state.theme === "light" ? "dark" : "light");
    });

    const closeBtn = this.$(".qm-close");
    if (this.cfg.onClose) closeBtn.addEventListener("click", () => self.cfg.onClose());
    else closeBtn.remove();

    this.$.all("[data-zoom]").forEach((b) => {
      // Zoom out moves the window the readout beside it shows; fit stays global.
      b.addEventListener("click", () => self.zoom(b.dataset.zoom,
        b.dataset.zoom === "fit" ? null : self.activeWin()));
    });

    // The filter belongs to the window whose tree is showing — switching
    // windows should not carry a stale search across.
    this.$(".qm-search input").addEventListener("input", (ev) => {
      const win = self.activeWin();
      const v = ev.target.value.trim().toLowerCase();
      if (win) win._filter = v; else self._filter = v;
      self.renderTree();
    });

    // Apply a layout payload by hand. This is the same entry point the agent
    // will use, so exercising it here proves the AI → explore inheritance path
    // before any agent exists.
    this.$(".qm-difftog").addEventListener("click", () => {
      const turningOn = !self.state.diff;
      self.setDiff(turningOn);
      // Tell the user how to actually take a measurement — with diff on, a plain
      // drag draws the interval (A at the press, B follows).
      if (turningOn) {
        try { window.qlToast && window.qlToast("Diff cursor on — drag across the plot to measure an interval"); } catch (e) { /* no toast */ }
      }
    });

    // Global cursor link. Individual windows keep their own scope button, so
    // this is a bulk action, not a lock: unlink one window afterwards and the
    // toolbar just reports "mixed".
    this.$(".qm-linktog").addEventListener("click", () => {
      const allShared = self.state.windows.length &&
        self.state.windows.every((w) => w.scope === "shared");
      self.setAllScope(allShared ? "own" : "shared");
    });

    this.$.all("[data-nav]").forEach((b) => {
      b.addEventListener("click", () => {
        // The active window, whose range the readout and the strip already show.
        const win = self.activeWin();
        const r = self.rangeOf(win);
        const mid = r.t0 + (r.t1 - r.t0) / 2;
        const step = (r.t1 - r.t0) * 0.25;   // quarter-window
        switch (b.dataset.nav) {
          case "zin": self.zoomAt(mid, 1 / 1.6, win); break;
          case "zout": self.zoomAt(mid, 1.6, win); break;
          case "left": self.panBy(-step, win); break;
          case "right": self.panBy(step, win); break;
          case "fit": self.fit(); break;   // global on purpose: re-links every window
        }
      });
    });

    this._bindRangeStrip();
    this._bindSidebar();
    this._bindSidebarResize();
    this._bindChipPanelDismiss();

    // The header "?" opens the platform-aware controls list; the key does too.
    this.$(".qm-help").addEventListener("click", () => self.toggleHelp());
    this.$(".qm-helpclose").addEventListener("click", () => self.toggleHelp(false));
    this._syncControlHints();

    // Partition-key badges: on the drill path by default, everywhere when toggled.
    this._showKeys = false;
    try { this._showKeys = sessionStorage.getItem("qm.showKeys") === "1"; } catch (e) { /* private */ }
    const keytog = this.$(".qm-keytog");
    if (keytog) {
      keytog.setAttribute("aria-pressed", String(this._showKeys));
      keytog.addEventListener("click", () => self.setShowKeys(!self._showKeys));
    }

    this.$(".qm-clearsig").addEventListener("click", () => self.clearSignals());
    this.$(".qm-tablebtn").addEventListener("click", () => self.pickTable());
    this.$(".qm-cols").addEventListener("click", () => self.toggleColumns());

    this.$(".qm-addwin").addEventListener("click", () => {
      self.addWindow();
      self.persist();
      self.renderWindows();
      self.draw();
    });

    this.$(".qm-apply").addEventListener("click", () => {
      const box = self.$(".qm-apply-json");
      const status = box.parentNode.querySelector(".qm-ai-status");
      try {
        const payload = JSON.parse(box.value);
        self.load(payload);
        self.persist();
        status.textContent = "Applied — switch to Explore to inspect it.";
      } catch (e) {
        status.textContent = "That isn't valid JSON: " + (e && e.message || e);
      }
    });

    // A resize changes the pixel width, which changes the bucket count, which
    // means the frames on screen are the wrong resolution — refetch, debounced.
    // Inline in a node the resolution follows the view, so a resize only redraws.
    this._ro = new ResizeObserver(() => (self._inNode() ? self.scheduleDraw() : self._scheduleFetch()));
    this._ro.observe(this.root);

    // Separately, observe each PLOT box. Adding or removing a window
    // redistributes the heights without the root changing size at all, so the
    // root observer never fires — and the canvases stay sized for a box that no
    // longer exists. The bitmap then gets squashed into the shorter box and the
    // axis labels and units visibly collide. Redraw (no refetch) on any plot
    // geometry change; the backing store is set on an absolutely-positioned
    // canvas, so resizing it cannot feed back into the observed box.
    this._plotRo = new ResizeObserver(() => {
      if (self._plotRaf) return;
      self._plotRaf = requestAnimationFrame(() => {
        self._plotRaf = null;
        // A narrower window fits fewer chips, so the strip is re-measured with
        // the same coalescing as the repaint.
        self.state.windows.forEach((w) => self._layoutChips(w));
        self.draw();
      });
    });

    this.setMode(this.state.mode);
    this.renderTree();
    this.renderWindows();
  }

  // ── mode / theme / range ────────────────────────────────

  Measure.prototype.setMode = function (mode) {
    this.state.mode = mode;
    this.root.dataset.mode = mode;
    this.$.all("[data-set-mode]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.setMode === mode));
    });
    // One node, two query paths: Standard runs the cell's SQL, Explore runs the
    // measurement descriptor. Say which one is live, or the switcher is the only
    // (silent) clue and a user reasonably assumes their SQL is what they see.
    const note = {
      standard: "showing the node's SQL result",
      ai: "editing the layout · not querying",
      explore: "showing the measurement descriptor · SQL not used",
    }[mode] || "";
    this.$(".qm-modenote").textContent = note;
    // Mode is a view, not a document: nothing migrates, we just redraw.
    if (this.cfg.onModeChange) this.cfg.onModeChange(mode);
    this._scheduleFetch(0);
  };

  Measure.prototype.setTheme = function (theme) {
    this.state.theme = theme;
    this.root.dataset.theme = theme;
    const btn = this.$(".qm-theme");
    btn.textContent = theme === "light" ? "◑" : "◐";
    btn.setAttribute("aria-pressed", String(theme === "light"));
    btn.title = theme === "light" ? "Switch to dark plots" : "Switch to light plots";
    // Session-scoped on purpose: a committed notebook must not impose one
    // person's plot theme on the team.
    try { sessionStorage.setItem("qm.theme", theme); } catch (e) { /* private mode */ }
    this.draw();
  };

  // ── selection ───────────────────────────────────────────

  /** The window the sidebar tree is currently selecting into. */
  Measure.prototype.activeWin = function () {
    const s = this.state;
    return s.windows.find((w) => w.id === s.active) || s.windows[0] || null;
  };

  /** Membership is PER WINDOW: the same signal can be selected in several
   *  windows at once, and unchecking it in one leaves the others alone. */
  Measure.prototype.isSelected = function (id, win) {
    const w = win || this.activeWin();
    return !!w && w.signalIds.indexOf(id) >= 0;
  };

  /** Metadata + colour for a signal, creating the registry entry on demand.
   *  Colour is registry-level so one signal looks the same in every window. */
  Measure.prototype._register = function (id, meta) {
    const s = this.state;
    let entry = s.signals.find((x) => x.id === id);
    if (entry) return entry;
    const used = s.signals.map((x) => x.colorVar);
    const m = meta || (this.provider.meta ? this.provider.meta(id) : null) || {};
    entry = {
      id: id,
      name: m.name || autoSignalName(id, s.table),
      unit: m.unit || "",
      dec: m.dec == null ? 2 : m.dec,
      colorVar: SIG_VARS.find((v) => used.indexOf(v) < 0) ||
                SIG_VARS[s.signals.length % SIG_VARS.length],
    };
    s.signals.push(entry);
    return entry;
  };

  /** Drop registry entries no window references any more. */
  Measure.prototype._pruneRegistry = function () {
    const s = this.state;
    const live = {};
    s.windows.forEach((w) => w.signalIds.forEach((id) => { live[id] = true; }));
    s.signals = s.signals.filter((x) => live[x.id]);
  };

  /** Unselect every signal, in every window.
   *
   *  Windows themselves stay: they carry the cursor scope, the Y mode and the X
   *  range the user set up, and clearing a selection is not the same act as
   *  tearing the page down. Same reason toggleSignal never auto-removes one.
   */
  Measure.prototype.clearSignals = function () {
    if (!this.state.signals.length) return;
    this.state.windows.forEach((w) => {
      w.signalIds = [];
      // The per-window trace and axis flags are keyed by signal id. Left behind,
      // they would silently re-apply — a signal selected again half an hour later
      // would come back hidden, with no visible reason why.
      w.hidden = {};
      w.axes = {};
      w._axSeen = {};
    });
    this._pruneRegistry();
    this.showFetchError(null);  // any "capped the selection" notice is now moot
    this.frames = {};          // nothing to draw, and what we hold is now orphaned
    this._fetchKey = null;     // so re-selecting the same signal does re-query
    this.persist();
    this.renderTree();
    this.renderWindows();
    this.draw();
  };

  // ── the legend strip ────────────────────────────────────
  // One row, whatever the signal count. On a CAN frame the chips ran to five
  // wrapped rows and took more height than the plot they were labelling — and the
  // cost grew with every signal selected, which is the wrong direction: the plot
  // is what the window is for. So the strip fills exactly one row and everything
  // past that collapses into "+N", which opens a panel carrying the same two
  // controls each chip has (show/hide, and the Y axis).
  //
  // The sidebar's values pane already lists every signal with its swatch and
  // window, so nothing is only reachable through here.

  const CHIP_GAP = 6;            // matches .qm-chips gap in measure.css
  const MORE_RESERVE = 52;       // room the "+N" button needs

  Measure.prototype._layoutChips = function (win) {
    const node = win && win._node;
    if (!node) return;
    const strip = node.querySelector(".qm-chips");
    const more = node.querySelector(".qm-chipmore");
    if (!strip || !more) return;
    const chips = Array.prototype.slice.call(strip.querySelectorAll(".qm-chip"));
    if (!chips.length) { more.hidden = true; return; }

    // Measure with everything shown, or a chip hidden by the LAST pass would
    // measure zero and never come back when the window is widened again.
    chips.forEach((c) => { c.hidden = false; });
    const widths = chips.map((c) => c.getBoundingClientRect().width || c.offsetWidth || 0);
    const avail = strip.clientWidth || strip.getBoundingClientRect().width || 0;
    // No layout yet (or a hidden pane): leave every chip visible rather than
    // guessing, and try again on the next draw.
    if (!avail || !widths.some((w) => w > 0)) { more.hidden = true; return; }

    const fits = qmChipsThatFit(widths, avail, CHIP_GAP, MORE_RESERVE);
    chips.forEach((c, i) => { c.hidden = i >= fits; });
    const hiddenCount = chips.length - fits;
    more.hidden = hiddenCount <= 0;
    more.textContent = "+" + hiddenCount + " ▾";
    more.setAttribute("aria-expanded",
      String(!node.querySelector(".qm-chippanel").hidden));
  };

  /** The full signal list for one window: the overflow's way in, and the only
   *  place every signal's controls are guaranteed to be reachable. */
  Measure.prototype._renderChipPanel = function (win) {
    const self = this;
    const node = win && win._node;
    if (!node) return;
    const panel = node.querySelector(".qm-chippanel");
    if (!panel) return;
    panel.innerHTML = "";
    // A way out that is VISIBLE. The panel used to be closable only by pressing
    // "+N" again, which is not where anyone looks once a list is covering the
    // plot — reported as having no close button at all. Now: a titled header with
    // an ✕, plus Escape and a click outside (bound once, in _bindSidebar's
    // sibling below).
    const traces = this.tracesOf(win);
    const head = el(`
      <div class="qm-cphead">
        <span>${esc(String(traces.length))} traces · ${esc(win.label)}</span>
        <button class="qm-cpclose" type="button" title="Close (Esc)">✕</button>
      </div>`);
    head.querySelector(".qm-cpclose").addEventListener("click", (ev) => {
      ev.stopPropagation();
      self._toggleChipPanel(win, false);
    });
    panel.appendChild(head);

    traces.forEach((t) => {
      const row = el(`
        <div class="qm-cprow${self.isHidden(win, t.key) ? " qm-off" : ""}">
          <button class="qm-cpname" type="button" title="Show or hide this trace">
            <span class="qm-swatch" style="background:var(${esc(t.colorVar)})"></span>
            ${esc(t.name)}
          </button>
          <span class="qm-axbox" role="checkbox" tabindex="0"
                aria-checked="${self.hasAxis(win, t.key) ? "true" : "false"}"
                data-on="${self.hasAxis(win, t.key) ? "1" : "0"}"
                title="Show this trace's Y axis in the plot">${
                  self.hasAxis(win, t.key) ? "✓" : ""}</span>
        </div>`);
      row.querySelector(".qm-cpname").addEventListener("click", (ev) => {
        ev.stopPropagation();
        self.toggleHidden(win, t.key);
      });
      const box = row.querySelector(".qm-axbox");
      const flip = (ev) => { ev.stopPropagation(); self.toggleAxis(win, t.key); };
      box.addEventListener("click", flip);
      box.addEventListener("keydown", (ev) => {
        if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); flip(ev); }
      });
      panel.appendChild(row);
    });
  };

  /** Hide the value-column picker and put its trigger back in the closed state.
   *
   *  The panel is placed from the trigger's rect, so everything that MOVES the
   *  trigger — closing the columns panel, scrolling it — closes the picker
   *  instead of re-placing it. */
  Measure.prototype._closeYPanel = function () {
    const yp = this.$(".qm-ypanel");
    if (yp) yp.hidden = true;
    this._yOpen = false;
    const yb = this.$(".qm-ycols");
    if (yb) yb.setAttribute("aria-expanded", "false");
  };

  /** Escape closes the open panel; so does a click anywhere outside one. Bound
   *  once for the view rather than per panel, since the panels are rebuilt on
   *  every render and per-panel listeners would accumulate.
   *
   *  Escape is scoped to the innermost thing that is open: the key is consumed
   *  only when one of this view's panels is actually up, so the panel closes
   *  and the node modal behind it stays; with nothing open the key is left
   *  alone and the modal closes as before. That needs the CAPTURE phase —
   *  node-modal.js binds its handler on document first, so a bubble listener
   *  here would run too late to stop it (same pattern as canvas-render.js's
   *  node-menu Escape).
   */
  Measure.prototype._bindChipPanelDismiss = function () {
    const self = this;
    const closeAll = () => {
      self.state.windows.forEach((w) => {
        if (w._node) {
          const p = w._node.querySelector(".qm-chippanel");
          if (p && !p.hidden) self._toggleChipPanel(w, false);
        }
      });
      // The value-column picker is the same kind of overlay list, so it shares
      // this dismissal rather than growing a second mechanism of its own.
      self._closeYPanel();
    };
    // Scrolling the columns panel slides the picker's trigger away underneath it.
    const colspanel = this.$(".qm-colspanel");
    if (colspanel) colspanel.addEventListener("scroll", () => self._closeYPanel());
    // What Escape has to close before the modal behind this view gets the key.
    const anyOpen = () => {
      const yp = self.$(".qm-ypanel");
      if (yp && !yp.hidden) return true;
      const help = self.$(".qm-helpbox");
      if (help && !help.hidden) return true;
      return self.state.windows.some((w) => {
        const p = w._node && w._node.querySelector(".qm-chippanel");
        return !!(p && !p.hidden);
      });
    };
    this._onChipKey = (ev) => {
      if (ev.key === "Escape") {
        // A text field outside the panels stops the key itself; leave it that way.
        const t = ev.target;
        const typing = !!(t && t.closest && t.closest("input, textarea, select") &&
          !t.closest(".qm-ypanel, .qm-chippanel"));
        if (typing || !anyOpen()) return;
        ev.stopPropagation();
        ev.preventDefault();     // modal-esc.js stands down on defaultPrevented
        closeAll();
        self.toggleHelp(false);
        return;
      }
      // "?" anywhere but a text field: the header button is the discoverable
      // route, this is the fast one.
      const tag = (ev.target && ev.target.tagName) || "";
      if (ev.key === "?" && tag !== "INPUT" && tag !== "TEXTAREA") {
        self.toggleHelp();
      }
    };
    document.addEventListener("keydown", this._onChipKey, true);
    this.root.addEventListener("pointerdown", (ev) => {
      // A press inside a panel, or on the button that opened it, is not a dismiss.
      if (ev.target.closest && (ev.target.closest(".qm-chippanel") ||
          ev.target.closest(".qm-chipmore") || ev.target.closest(".qm-ypanel") ||
          ev.target.closest(".qm-ycols"))) return;
      closeAll();
    });
  };

  Measure.prototype._toggleChipPanel = function (win, show) {
    const node = win && win._node;
    if (!node) return;
    const panel = node.querySelector(".qm-chippanel");
    const more = node.querySelector(".qm-chipmore");
    const open = show == null ? panel.hidden : !!show;
    // One panel at a time: two open lists over two plots is just clutter.
    this.state.windows.forEach((w) => {
      if (w._node && w !== win) w._node.querySelector(".qm-chippanel").hidden = true;
    });
    if (open) this._renderChipPanel(win);
    panel.hidden = !open;
    if (more) more.setAttribute("aria-expanded", String(open));
  };

  /** Whether there is more than one window, for the compact values table: with
   *  one window its "Window" column says 1 on every row and is paying for itself
   *  in width. */
  Measure.prototype._syncWindowCount = function () {
    if (this.state.windows.length > 1) delete this.root.dataset.oneWindow;
    else this.root.dataset.oneWindow = "1";
  };

  /** Enable "clear" only when there is a selection to clear.
   *
   *  The counts next to it are renderTree's — they name the ACTIVE window
   *  ("3 in window 2"), which this button deliberately does not: it clears every
   *  window, so it is gated on the whole selection, not the active one — which
   *  is why closing a window has to prune the registry, or it stays enabled.
   */
  Measure.prototype._syncClearBtn = function () {
    const clear = this.$(".qm-clearsig");
    if (clear) clear.disabled = !this.state.signals.length;
  };

  Measure.prototype.toggleSignal = function (id, meta) {
    let win = this.activeWin();
    if (!win) win = this.addWindow();

    // Was anything selected anywhere before this click?
    const wasEmpty = !this.state.signals.length;

    const at = win.signalIds.indexOf(id);
    if (at >= 0) {
      win.signalIds.splice(at, 1);
      this._pruneRegistry();
    } else {
      this._register(id, meta);
      win.signalIds.push(id);
    }
    // Windows are NOT auto-removed when emptied: the window is the selection
    // target, so deleting it out from under the tree would move the user's
    // checkboxes to a different window mid-click. Removal stays explicit (✕).
    this.state.active = win.id;
    this.persist();
    this.renderTree();
    this.renderWindows();

    // The FIRST signal has to bring the range to the data. Without metadata
    // bounds the view opens on the last two minutes of WALL-CLOCK time, which
    // for recorded measurements is nowhere near anything: the query is correct,
    // the plot is empty, and the only clue is that raw SQL without a time
    // filter returns rows fine. So position once, on the first selection, using
    // the same extent query fit uses.
    //
    // Only on the first: after that the range is the user's, and moving it
    // under them as they add signals would undo their navigation.
    if (at < 0 && wasEmpty && !this._positioned) {
      this._positioned = true;
      this.fit();                 // global: keeps the windows sharing one range
      return;                     // fit ends in its own fetch
    }
    this._scheduleFetch(0);
  };

  Measure.prototype.addWindow = function () {
    const s = this.state;
    const n = s.windows.length + 1;
    const win = { id: "w" + n + "_" + n, label: "window " + n, signalIds: [], scope: "shared", height: 176 };
    s.windows.push(win);
    if (!s.active) s.active = win.id;
    return win;
  };

  Measure.prototype.persist = function () {
    if (this.cfg.onChange) this.cfg.onChange(this.serialize());
  };

  /** The slice that belongs in ``viz.measure`` — layout and selection only.
   *  Cursor, mode and theme stay out: they are session state, not document. */
  Measure.prototype.serialize = function () {
    const s = this.state;
    const out = {
      range: { mode: "absolute", from: s.t0, to: s.t1 },
      table: s.table,
      columns: columnsPayload(s.columns),
      signals: s.signals.map((x) => {
        const o = { id: x.id, name: x.name, unit: x.unit, dec: x.dec, color: x.colorVar };
        if (x.x) o.x = x.x;      // only overrides are written; the rest inherit
        if (x.y) o.y = x.y;
        return o;
      }),
      windows: s.windows.map((w) => ({
        id: w.id, signals: w.signalIds.slice(),
        cursor: { scope: w.scope }, height: w.height, yMode: w.yMode || "auto",
        range: w.range ? { from: w.range.t0, to: w.range.t1 } : undefined,
        hidden: Object.keys(w.hidden || {}),
        axes: Object.keys(this._syncAxes(w, this.tracesOf(w))),
      })),
    };
    // Written only when ON, so every layout without the flag reads as off.
    if (s.envelope === true) out.envelope = true;
    if (Array.isArray(s.roots) && s.roots.length) out.roots = s.roots.slice();
    return out;
  };

  /** Apply a ``viz.measure`` payload — the same door the AI writes through. */
  Measure.prototype.load = function (payload) {
    if (!payload) return;
    const s = this.state;
    if (payload.range && payload.range.from != null) {
      s.t0 = payload.range.from;
      s.t1 = payload.range.to;
    }
    if (payload.table) { s.table = payload.table; this.$(".qm-title").textContent = payload.table; }
    if (Array.isArray(payload.roots)) {
      // A different set of roots is a different tree.
      const next = payload.roots.filter(Boolean);
      if (next.join("\n") !== (s.roots || []).join("\n")) { s.roots = next; this._treeRoot = null; }
    }
    if (payload.columns) {
      s.columns = {
        x: payload.columns.x || null,
        // A layout saved before multi-select holds a scalar. This is the one
        // door every layout comes through, so it is the one place that coerces;
        // everything downstream may assume a list.
        y: toColumnList(payload.columns.y),
        unit: payload.columns.unit || null,
        units: unitMap(payload.columns.units),
      };
    }
    // Before the trim, because a legacy layout counts its signals PER column:
    // 3 channels x 20 columns arrive as 60 ids and fold back to 3.
    const fold = foldNamedColumns(payload, s.columns);
    payload = fold.payload;
    s.columns = fold.columns;
    // Absent means off: the band is opt-in, and only an explicit true asks.
    s.envelope = payload.envelope === true;
    // Restored layouts are capped like any other selection. A layout holding
    // hundreds of signals is not a layout worth honouring: it re-wedged the page
    // on EVERY open, which is what made it impossible to click "clear all" and
    // get back out — the state kept reloading itself faster than it could be
    // cleared. Trimming on the way in makes the bad state self-healing, because
    // the next persist() writes the trimmed version back.
    let trimmed = 0;
    if (Array.isArray(payload.signals) && payload.signals.length > MAX_SIGNALS) {
      trimmed = payload.signals.length;
      payload = Object.assign({}, payload, {
        signals: payload.signals.slice(0, MAX_SIGNALS),
      });
    }
    if (Array.isArray(payload.signals)) {
      s.signals = payload.signals.map((x, i) => ({
        id: x.id,
        x: x.x, y: x.y,
        name: x.name || autoSignalName(x.id, s.table),
        unit: x.unit || "",
        dec: x.dec == null ? 2 : x.dec,
        colorVar: x.color || SIG_VARS[i % SIG_VARS.length],
      }));
    }
    if (Array.isArray(payload.windows)) {
      s.windows = payload.windows.map((w, i) => ({
        id: w.id || "w" + (i + 1),
        label: "window " + (i + 1),
        signalIds: (w.signals || []).filter((id) => s.signals.some((x) => x.id === id)),
        scope: (w.cursor && w.cursor.scope) || "shared",
        height: w.height || 176,
        yMode: w.yMode || "auto",
        range: (w.range && w.range.from != null)
          ? { t0: w.range.from, t1: w.range.to } : undefined,
        hidden: (w.hidden || []).reduce((o, k) => { o[k] = true; return o; }, {}),
        axes: Array.isArray(w.axes)
          ? w.axes.reduce((o, k) => { o[k] = true; return o; }, {})
          : undefined,
      }));
      s.active = s.windows.length ? s.windows[0].id : null;
    }
    this.clampCursors();
    if (trimmed) {
      // Say it, and write the trimmed layout back so the next open is clean.
      this.showFetchError("This layout had " + trimmed + " signals selected — " +
        "kept the first " + MAX_SIGNALS + ". Use “clear all” and pick the ones " +
        "you want.");
      this.persist();
    } else if (fold.folded) {
      // Silent housekeeping: the fold is a no-op for the user, and leaving it
      // unsaved would re-run on every open.
      this.persist();
    }
    this.renderTree();
    this.renderWindows();
    // Open the branches holding the loaded layout's signals, so an applied
    // layout arrives with its selection visible rather than collapsed.
    this.revealSelected(this.activeWin());
    this._scheduleFetch(0);
  };

  // ── windows ─────────────────────────────────────────────

  Measure.prototype.renderWindows = function () {
    const self = this;
    const ws = this.$(".qm-workspace");
    ws.innerHTML = "";

    if (!this.state.windows.length) {
      ws.appendChild(el(`<div class="qm-empty">Pick signals on the left to plot them.</div>`));
      return;
    }

    this.state.windows.forEach((win, wi) => {
      win.label = "window " + (wi + 1);
      const traces = self.tracesOf(win);
      // Every signal-set change ends in a render, so this is where axes catch up.
      self._syncAxes(win, traces);

      const node = el(`
        <section class="qm-win${self.state.active === win.id ? " qm-active" : ""}"
                 style="flex: ${win.height || WIN_H_DEFAULT} 1 0">
          <div class="qm-win-head">
            <span class="qm-win-title">${esc(win.label)}</span>
            <span class="qm-chips">${traces.map((t) => `
              <span class="qm-chip${self.isHidden(win, t.key) ? " qm-off" : ""}" data-sig="${esc(t.key)}">
                <button class="qm-chipname" type="button" title="Show or hide this trace">
                  <span class="qm-swatch" style="background:var(${esc(t.colorVar)})"></span>${esc(t.name)}
                </button>
                <span class="qm-axbox" role="checkbox" tabindex="0"
                      aria-checked="${self.hasAxis(win, t.key) ? "true" : "false"}"
                      data-on="${self.hasAxis(win, t.key) ? "1" : "0"}"
                      title="Show this trace's Y axis in the plot">${
                        self.hasAxis(win, t.key) ? "✓" : ""}</span>
              </span>`).join("")}</span>
            <button class="qm-chipmore" type="button" hidden
                    title="The signals that do not fit — show, hide or give one a Y axis"></button>
            <span class="qm-win-tools">
              <span class="qm-badge qm-agg">—</span>
              <button class="qm-ymode" type="button" data-y="${esc(win.yMode || "auto")}"
                      title="Y axis: per-signal autoscale, or one shared scale">Y ${esc(win.yMode || "auto")}</button>
              <button class="qm-scope" type="button" data-scope="${esc(win.scope)}"
                      title="Cursor scope">cursor ${esc(win.scope)}</button>
              <button class="qm-xlink" type="button" data-x="${self.isXLinked(win) ? "linked" : "own"}"
                      title="X axis: shared with the other windows, or this window's own">x ${self.isXLinked(win) ? "shared" : "own"}</button>
              <button class="qm-winfit" type="button"
                      title="Fit the range to THIS window's data. Gives the window its own X range so the others stay put.">⤿ fit</button>
              <button class="qm-ibtn qm-drop" type="button" title="Remove window">✕</button>
            </span>
          </div>
          <div class="qm-chippanel" hidden></div>
          <div class="qm-plot"><canvas></canvas></div>
          <div class="qm-winstrip" title="Where this window sits in the whole measurement — drag to scroll">
            <div class="qm-winwin"></div>
          </div>
        </section>`);

      // Clicking the NAME toggles the trace; the small box toggles its Y axis.
      node.querySelectorAll(".qm-chip").forEach((chip) => {
        const id = chip.dataset.sig;
        chip.querySelector(".qm-chipname").addEventListener("click", (ev) => {
          ev.stopPropagation();
          self.toggleHidden(win, id);
        });
        const box = chip.querySelector(".qm-axbox");
        const flip = (ev) => { ev.stopPropagation(); self.toggleAxis(win, id); };
        box.addEventListener("click", flip);
        box.addEventListener("keydown", (ev) => {
          if (ev.key === " " || ev.key === "Enter") flip(ev);
        });
      });

      const canvas = node.querySelector("canvas");
      win._node = node;
      win._canvas = canvas;

      // Clicking anywhere on the header targets this window for selection, so
      // the tree's checkboxes follow where you are working.
      node.querySelector(".qm-win-head").addEventListener("click", (ev) => {
        if (ev.target.closest("button")) return;   // let the tools do their job
        if (self.state.active !== win.id) {
          self.state.active = win.id;
          self.revealSelected(win);
          self.renderWindows();
          self.renderTree();
          self.draw();
        }
      });

      node.querySelector(".qm-scope").addEventListener("click", () => {
        win.scope = win.scope === "shared" ? "own" : "shared";
        // cursor.own[id] holds a PAIR {a, b}. This used to assign cursorOf(),
        // which is cursor A alone — a number — so every later `pair.a = …`
        // threw "Cannot create property 'a' on number", taking out zoom, the
        // cursor drag and clampCursors. cursorsOf() creates the pair, seeded
        // from the shared one, which is the seeding this line was reaching for.
        if (win.scope === "own") self.cursorsOf(win);
        const b = node.querySelector(".qm-scope");
        b.dataset.scope = win.scope;
        b.textContent = "cursor " + win.scope;
        self.persist();
        self.draw();
      });

      node.querySelector(".qm-ymode").addEventListener("click", () => {
        win.yMode = (win.yMode === "shared") ? "auto" : "shared";
        const b = node.querySelector(".qm-ymode");
        b.dataset.y = win.yMode;
        b.textContent = "Y " + win.yMode;
        self.persist();
        self.draw();
      });

      node.querySelector(".qm-xlink").addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (self.isXLinked(win)) self.unlinkX(win); else self.relinkX(win);
        self.persist();
        self.renderWindows();
        self.draw();
        self._scheduleFetch(0);
      });

      node.querySelector(".qm-winfit").addEventListener("click", (ev) => {
        ev.stopPropagation();
        self.autoFit(win);
      });

      node.querySelector(".qm-drop").addEventListener("click", () => {
        self.state.windows = self.state.windows.filter((w) => w.id !== win.id);
        if (self.state.active === win.id) {
          self.state.active = self.state.windows.length ? self.state.windows[0].id : null;
        }
        // A registry entry no other window references has nowhere left to draw.
        self._pruneRegistry();
        // Window ids come from the window COUNT, so the next one can take this id.
        delete self.frames[win.id];
        self.persist();
        // The tree paints the ACTIVE window's ticks and swatches, which just moved.
        self.renderTree();
        self.renderWindows();
        self.draw();
      });

      node.querySelector(".qm-chipmore").addEventListener("click", (ev) => {
        ev.stopPropagation();
        self._toggleChipPanel(win);
      });
      self._bindPlot(win, canvas);
      self._bindWinStrip(win, node.querySelector(".qm-winstrip"));
      self._bindDrop(win, node);
      ws.appendChild(node);

      // A grip BETWEEN windows, not on one of them: the boundary belongs to the
      // pair, and a drag has to move both sides at once or the leftover space
      // just goes dead at the bottom.
      if (wi < self.state.windows.length - 1) {
        const grip = el(`<div class="qm-win-grip" role="separator"
             aria-orientation="horizontal"
             title="Drag to resize these windows (double-click to even them out)"></div>`);
        ws.appendChild(grip);
        self._bindWinResize(grip, win, self.state.windows[wi + 1]);
      }
    });

    this._syncClearBtn();
    this._syncWindowCount();
    // Every selection change ends here, and the panel lists one row per signal.
    this._refreshColumnsPanel();

    // Re-attach the plot observer to the new nodes, then draw AFTER layout so
    // the first paint measures the real box rather than the pre-layout one.
    if (this._plotRo) {
      this._plotRo.disconnect();
      this.state.windows.forEach((w) => {
        const plot = w._node && w._node.querySelector(".qm-plot");
        if (plot) self._plotRo.observe(plot);
      });
    }
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        self.state.windows.forEach((w) => self._layoutChips(w));
        self.draw();
      });
    } else {
      this.state.windows.forEach((w) => self._layoutChips(w));
    }
  };

  /** Pointer + wheel bindings for one plot.
   *
   *  Gesture split: plain drag moves the cursor (the measurement-tool idiom — the cursor
   *  is the primary instrument), while navigation takes a modifier or the
   *  wheel. Drag-to-box-zoom, Grafana's default, is deliberately NOT bound: it
   *  would collide with the cursor drag, and losing the cursor costs more here
   *  than gaining a zoom gesture.
   */
  // ── per-signal visibility and Y axes ────────────────────
  // Both are per (window, signal): the same signal in two windows can be drawn
  // in one and hidden in the other, and can own an axis in one without
  // cluttering the other.

  Measure.prototype.isHidden = function (win, id) {
    return !!(win.hidden && win.hidden[id]);
  };

  Measure.prototype.toggleHidden = function (win, id) {
    win.hidden = win.hidden || {};
    if (win.hidden[id]) delete win.hidden[id];
    else win.hidden[id] = true;
    this.persist();
    this.renderWindows();
    this.draw();
  };

  /** Bring ``win.axes`` up to date with the traces the window has now.
   *
   *  The rule: a trace this window has not seen before gets an axis if fewer
   *  than two of its CURRENT traces have one. That is the old "first two
   *  traces" default for a new window, it gives the second axis to a trace
   *  added next to a single one — whose numbers and unit were otherwise
   *  invisible until the chip's axis box was ticked by hand — and it stops
   *  there, so a wide selection does not sprout a gutter per trace. Only NEW
   *  traces are topped up: an axis switched off by hand, or one that left with
   *  its trace, never comes back on its own.
   *
   *  ``_axSeen`` is session state, never serialized. Undefined means the axes
   *  came from a saved layout, so every trace present now counts as already
   *  decided and the array round-trips through serialize/load unchanged.
   *
   *  Called from the two places the trace set is consumed and may be stale —
   *  ``renderWindows`` (every selection change ends there), ``drawExplore``
   *  (a refetch-only path skips the render) — plus ``serialize``, so a layout
   *  saved without an intervening frame still writes the axes it will show.
   *  Deliberately NOT from ``tracesOf``: that is a pure derivation, called
   *  from six places and from tests, and it must stay free of side effects.
   */
  Measure.prototype._syncAxes = function (win, traces) {
    // Nothing left to key an axis by, and stale keys would re-apply themselves.
    if (!traces.length) { win.axes = {}; win._axSeen = {}; return win.axes; }
    if (!win.axes) { win.axes = {}; win._axSeen = {}; }
    if (!win._axSeen) {
      win._axSeen = {};
      traces.forEach((t) => { win._axSeen[t.key] = true; });
    }
    let on = traces.reduce((n, t) => (win.axes[t.key] ? n + 1 : n), 0);
    traces.forEach((t) => {
      if (win._axSeen[t.key]) return;
      win._axSeen[t.key] = true;
      if (on < 2) { win.axes[t.key] = true; on += 1; }
    });
    // A trace that goes away and comes back later is new again.
    Object.keys(win._axSeen).forEach((k) => {
      if (!traces.some((t) => t.key === k)) delete win._axSeen[k];
    });
    return win.axes;
  };

  /** The window's axis flags, keyed by trace key — which equals the signal id
   *  under a one-column selection, so a saved layout's axis keys keep
   *  resolving. Seeds a window that has never had any. */
  Measure.prototype._defaultAxes = function (win) {
    if (!win.axes) this._syncAxes(win, this.tracesOf(win));
    return win.axes;
  };

  Measure.prototype.hasAxis = function (win, id) {
    return !!this._defaultAxes(win)[id];
  };

  Measure.prototype.toggleAxis = function (win, id) {
    const ax = this._defaultAxes(win);
    if (ax[id]) delete ax[id];
    else ax[id] = true;
    this.persist();
    this.renderWindows();
    this.draw();
  };

  /** Which cursor, if any, the pointer is on top of. Returns "A", "B" or null.
   *
   *  Hit-testing is in PIXELS, not time: a fixed time tolerance would be
   *  unusably tight when zoomed out and absurdly wide when zoomed in.
   */
  Measure.prototype.setDiff = function (on) {
    this.state.diff = !!on;
    const btn = this.$(".qm-difftog");
    btn.setAttribute("aria-pressed", String(this.state.diff));
    // A plain drag means something else with diff on, so the help and the tooltip
    // are rebuilt from the list rather than patched with a regex.
    this._syncControlHints();
    this.draw();
  };

  /** The readout follows the last-focused window — with two windows on
   *  independent cursors, "the value" is otherwise ambiguous. */
  /** Load the children of every prefix along `path`, fetching lazily.
   *
   *  Auto-expanding is not just a flag: a branch can only render open once its
   *  children exist, so revealing a deep selection has to walk and fetch each
   *  level. Already-loaded levels cost nothing.
   */
  Measure.prototype.focus = function (id) {
    // Standard mode's preview strip is not a real window; ignore it so the
    // readout keeps pointing at something that exists.
    if (!this.state.windows.some((w) => w.id === id)) return;
    if (this.state.active === id) return;
    this.state.active = id;
    this.state.windows.forEach((w) => {
      if (w._node) w._node.classList.toggle("qm-active", w.id === id);
    });
    this.revealSelected(this.activeWin());
    this.renderTree();      // the tree selects into the active window
    this.renderReadout();
  };

  // ── data ────────────────────────────────────────────────

  Measure.prototype._scheduleFetch = function (delay) {
    const self = this;
    clearTimeout(this._fetchTimer);
    this._fetchTimer = setTimeout(() => self.fetchAndDraw(),
      delay == null ? REFETCH_MS : delay);
  };

  /** Repaint once on the next frame, however many times you ask.
   *
   *  Pointer moves arrive per-frame or faster, and each one used to call draw()
   *  synchronously — so a single sweep across a plot ran the whole renderer, for
   *  every window, dozens of times a second. Coalescing to one repaint per frame
   *  costs nothing visible (the display cannot show more) and takes the
   *  allocation rate down with it. State updates stay synchronous: only the
   *  painting is deferred, so anything reading cursors or hover right after an
   *  event still sees the new value.
   */
  Measure.prototype.scheduleDraw = function () {
    const self = this;
    if (this._drawRaf || this._dead) return;
    const raf = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    this._drawRaf = raf(() => {
      self._drawRaf = null;
      if (!self._dead) self.draw();
    });
  };

  /** Show (or clear) the reason the last fetch produced nothing.
   *
   *  "no data" is the correct label for an empty range but a lie for a failed
   *  query, and the two are indistinguishable to the person looking at an empty
   *  plot. The message goes on screen, not just to the console.
   */
  Measure.prototype.showFetchError = function (msg) {
    const bar = this.$(".qm-err");
    if (!bar) return;
    if (!msg) {
      bar.hidden = true;
      bar.textContent = "";
      return;
    }
    bar.hidden = false;
    bar.textContent = msg;
    bar.title = msg;
  };

  /** Fill in each signal's engineering unit from the chosen unit column.
   *
   *  A unit is a property of the signal, not of the window in view, so it is
   *  resolved ONCE per signal and cached on it — never fetched alongside the
   *  frames, which would repeat the same lookup on every zoom.
   */
  Measure.prototype.resolveUnits = function () {
    const self = this;
    const col = this.state.columns && this.state.columns.unit;
    if (!col || !this.provider.units) return Promise.resolve();
    const missing = this.state.signals
      .filter((s) => s.unit == null)
      .map((s) => s.id);
    if (!missing.length) return Promise.resolve();

    return Promise.resolve(this.provider.units(missing, { unit: col }))
      .then((map) => {
        let changed = false;
        Object.keys(map || {}).forEach((id) => {
          const sig = self.state.signals.find((s) => s.id === id);
          // "" is a real answer (the column exists but this signal has no
          // unit); it stops us asking again every render.
          if (sig && sig.unit !== map[id]) { sig.unit = map[id] || ""; changed = true; }
        });
        if (changed) {
          self.renderWindows();      // the Y axis carries the unit
          self.renderReadout();
          self.draw();
        }
      })
      .catch(() => { /* no units is a fine outcome */ });
  };

  /** Resolved x/y per id, for handing to a provider.
   *
   *  A signal id names its own column only when something pushed it in that
   *  way (see tracesOf), and the user may have overridden either axis — so anything that builds SQL
   *  needs this map, not just the frame fetch. extent() went without it, which
   *  meant fit could not resolve the time column on a table whose clock was
   *  chosen by hand.
   */
  Measure.prototype.colsFor = function (ids) {
    const out = {};
    (ids || []).forEach((id) => {
      const sig = this.state.signals.find((x) => x.id === id);
      out[id] = this.columnsFor(sig);
    });
    return out;
  };

  /** The traces one window draws: one per (signal, resolved value column).
   *
   *  The ONE fan-out point for a multi-column selection. ``state.signals`` and
   *  ``win.signalIds`` stay per SIGNAL, so the partition tree, drag/drop,
   *  reveal and the branch tri-state never learn about columns. Three cases:
   *
   *    0 or 1 column resolved   -> 1 trace, key === id
   *    N columns resolved       -> N traces, key = id + "/" + col
   *    id already names a column -> 1 trace, key === id
   *
   *  The last is a fallback, not a path the UI produces: load folds a saved
   *  "…/day=13/GS" back into channel + column list, and the tree selects
   *  partitions. It survives for an id pushed in directly — a hand-written AI
   *  layout, toggleSignal, a test — where fanning out would aggregate the
   *  wrong column (…/GS/MS).
   *
   *  The appended segment is bare, so parseId reads it as a column and the lake
   *  provider needs no change — and all N traces keep the same partition
   *  prefix, so they still collapse into one SQL statement.
   *
   *  A unit is resolved per TRACE: the table-wide entry for its column wins,
   *  the signal's own unit is the fallback.
   */
  Measure.prototype.tracesOf = function (win) {
    const out = [];
    if (!win) return out;
    const units = (this.state.columns && this.state.columns.units) || {};
    let wanted = 0;
    win.signalIds.forEach((id) => {
      const sig = this.state.signals.find((x) => x.id === id);
      if (!sig) return;
      const c = this.columnsFor(sig);
      const named = namedColumn(id);
      const cols = named ? [named] : (c.ys.length > 1 ? c.ys : [c.ys[0] || null]);
      const one = cols.length <= 1;
      cols.forEach((col, k) => {
        wanted++;
        if (out.length >= MAX_SIGNALS) return;
        out.push({
          key: one ? id : id + "/" + col,
          sigId: id,
          col: col,
          x: c.x,
          name: one ? sig.name : sig.name + " · " + col,
          unit: (col && units[col]) || sig.unit || "",
          dec: sig.dec,
          // Trace 0 keeps the colour the signal has today; the rest walk the
          // palette from there, so the mapping is deterministic and needs no
          // allocator state.
          colorVar: k === 0 ? sig.colorVar : SIG_VARS[
            (Math.max(0, SIG_VARS.indexOf(sig.colorVar)) + k) % SIG_VARS.length],
        });
      });
    });
    // MAX_SIGNALS guards the blast radius, and with N columns that is
    // signals × columns, not signals. Name both numbers: a silent cap looks
    // like the plot lost traces.
    const nCols = toColumnList(this.state.columns && this.state.columns.y).length || 1;
    win._traceCap = wanted > out.length
      ? "That layout wants " + wanted + " traces — " + win.signalIds.length +
        " signals × " + nCols + " value columns. Drawing the first " +
        MAX_SIGNALS + "; deselect a value column or a signal."
      : null;
    const note = this.state.windows.map((w) => w._traceCap).find(Boolean) || null;
    if (note !== this._traceCap) {
      this._traceCap = note;
      this.showFetchError(note);
    }
    return out;
  };

  /** Inline in a canvas node: read and drawn as if the node filled 70% of the view, untouched by node size or canvas zoom. */
  Measure.prototype._inNode = function () {
    return !!this.cfg.compact && typeof qmReferenceWidth === "function";
  };

  Measure.prototype.bucketsFor = function () {
    // One resolution for the whole view: every strip is the same width, so a
    // single bucket count keeps the frame cache from holding near-duplicates.
    const w = (this._inNode() ? qmReferenceWidth() : this.$(".qm-workspace").clientWidth) - 20 - 112;   // padding + gutters
    // QUANTISED, because the bucket count is part of the query key. At an exact
    // pixel width every 1px change — a resize drag, a scrollbar appearing, a
    // browser-zoom nudge, the sidebar grip — was a brand-new query for a plot
    // that looks identical, and each of those is a full partition scan in the
    // lake. Rounding to BUCKET_STEP keeps resolution proportional to the width (a
    // wider plot still gets more buckets) while collapsing that churn.
    const raw = Math.max(48, Math.round(w));
    const q = Math.round(raw / BUCKET_STEP) * BUCKET_STEP;
    return Math.min(BUCKET_MAX, Math.max(BUCKET_STEP, q));
  };

  Measure.prototype.fetchAndDraw = function () {
    const self = this;
    const gen = ++this._fetchGen;
    const buckets = this.bucketsFor();

    // Windows can now hold their own range, so group them by (range, resolution)
    // and issue ONE request per distinct group. Two windows showing the same
    // range share a fetch; an unlinked window costs one extra query, not one per
    // signal.
    const groups = {};
    this.state.windows.forEach((w) => {
      const key = this.rangeKey(w);
      const r = this.rangeOf(w);
      if (!groups[key]) {
        // ``cols`` carries the RESOLVED x/y per signal (table default plus any
        // per-signal override). A long/narrow table needs it: the signal id is
        // a partition path with no column in it, so the provider cannot know
        // what to aggregate without being told.
        groups[key] = {
          // gen travels INTO the provider so it can cancel superseded scans —
          // the same counter used below to discard their answers.
          q: { t0: r.t0, t1: r.t1, buckets: buckets, cols: {}, gen: gen },
          ids: [], wins: [],
        };
      }
      groups[key].wins.push(w.id);
      this.tracesOf(w).forEach((t) => {
        if (groups[key].ids.indexOf(t.key) < 0) groups[key].ids.push(t.key);
        // One column per trace, stated: the provider never re-derives it.
        groups[key].q.cols[t.key] = { x: t.x, y: t.col };
      });
    });
    const keys = Object.keys(groups).filter((k) => groups[k].ids.length);
    // Units are cheap, cached per signal and independent of the range — resolve
    // any that are still unknown alongside (not inside) the frame fetch.
    this.resolveUnits();
    if (!keys.length) { this.draw(); return Promise.resolve(); }

    // Every input the generated SQL depends on, plus the windows the answer has
    // to reach. Re-querying on pan and zoom is the feature and must always
    // happen — the range and the bucket count are both inside the group key, so
    // any navigation changes this. What it stops is the IDENTICAL request: the
    // resize observer, a mode switch, a window re-render and a tree re-render all
    // land here, and each repeat was another full partition scan for frames
    // already on screen. The window ids are in the key on purpose — a new window
    // sharing an existing range holds no frames yet, so it must still fetch.
    const key = JSON.stringify(keys.sort().map((k) => [
      k, groups[k].wins.slice().sort(), groups[k].ids.slice().sort(),
      groups[k].ids.slice().sort().map((id) => groups[k].q.cols[id]),
    ]));
    if (key === this._fetchKey) { this.draw(); return Promise.resolve(); }
    this._fetchKey = key;
    this.root.classList.add("qm-busy");

    const settle = () => {
      // Only the newest request clears the flag — an older one landing late
      // must not make the view look idle while a newer fetch is still out.
      if (gen === self._fetchGen) self.root.classList.remove("qm-busy");
    };

    return Promise.all(keys.map((k) =>
      Promise.resolve(self.provider.frames(groups[k].ids, groups[k].q))
        .then((frames) => ({ k: k, frames: frames || {} }))
        .catch((e) => {
          if (window.console) console.warn("[measure] frame fetch failed", e);
          // Remember WHY. Showing "no data" for a failed query sends everyone
          // hunting a data problem that is really a query problem.
          return { k: k, frames: {}, err: e };
        })
    )).then((results) => {
      if (gen !== self._fetchGen) return;   // a newer request took over
      const failed = results.filter((r) => r.err);
      // A failure must not be cached as "already fetched", or the view would sit
      // on the error until the range happened to move — pressing the same button
      // again has to actually retry.
      if (failed.length) self._fetchKey = null;
      self.showFetchError(failed.length
        ? String((failed[0].err && failed[0].err.message) || failed[0].err) : null);
      // Replace only the windows we just fetched for; a window whose group
      // failed keeps its previous frames rather than going blank.
      results.forEach((r) => {
        groups[r.k].wins.forEach((wid) => {
          self.frames[wid] = r.frames;
          // The range these buckets cover. Everything that maps a bucket to a
          // time needs it: until the next answer lands the view is drawing THESE
          // frames over a range that may already have moved.
          self.frameSpan[wid] = { t0: groups[r.k].q.t0, t1: groups[r.k].q.t1 };
        });
      });
      settle();
      self.draw();
    });
  };

  // ── draw ────────────────────────────────────────────────

  Measure.prototype.draw = function () {
    const shown = this.rangeOf(this.activeWin());
    // On whichever clock the data is on — see qmFmtX. A relative X starting at
    // zero was being printed as a wall clock, which turned anything before zero
    // into a bogus timestamp near the end of a minute.
    this.$(".qm-t0").textContent = this._fmtX(shown.t0) || "—";
    this.$(".qm-t1").textContent = this._fmtX(shown.t1) || "—";
    this._syncRangeStrip();

    // Only the visible mode is drawn — the hidden panes have zero-width
    // canvases, so drawing them would just cache a wrong bucket count.
    if (this.state.mode === "standard") this.drawStandard();
    else if (this.state.mode === "ai") this.renderAi();
    else this.drawExplore();
  };

  Measure.prototype.drawExplore = function () {
    const self = this;

    // Pass one: what each strip is going to draw. Pass two draws it. The split
    // exists because the gutter widths are a property of the PAGE, not of one
    // strip: a window with one Y axis and no unit used to reclaim that space and
    // start its plot further left and higher than its neighbour, so the same
    // instant sat at a different x in each strip — with a shared cursor, that
    // reads as the cursor not lining up between windows.
    //
    // Only windows on the SHARED cursor take part. Reserving gutters costs plot
    // width, and it only buys something when strips are making a claim about the
    // same instant: a window on its own cursor is its own time base, so it keeps
    // its space instead of paying for an alignment nobody is reading.
    const plan = [];
    let minLeftAxes = 0, minRightAxes = 0, reserveUnitLine = false;
    this.state.windows.forEach((win) => {
      if (!win._canvas) return;
      const shared = win.scope !== "own";
      const fr = self.framesFor(win);
      const traces = self.tracesOf(win);
      // Again here, so a trace arriving on a refetch-only path is drawn with its axis.
      self._syncAxes(win, traces);
      const signals = traces.map((t) => (
        fr[t.key]
          ? { frame: fr[t.key], colorVar: t.colorVar, dec: t.dec, unit: t.unit,
              hidden: self.isHidden(win, t.key), axis: self.hasAxis(win, t.key) }
          : null
      )).filter(Boolean);

      // Mirror what qmDrawStrip itself counts: visible signals only, and on a
      // shared Y scale just the one axis.
      const shown = signals.filter((sg) => !sg.hidden);
      const axes = shown.filter((sg) => sg.axis);
      const nDrawn = qmDrawnAxes(axes.length, (win.yMode || "auto") === "shared");
      const sides = qmAxisSides(nDrawn);
      if (shared) {
        minLeftAxes = Math.max(minLeftAxes, sides.left);
        minRightAxes = Math.max(minRightAxes, sides.right);
        if (axes.slice(0, nDrawn).some((sg) => sg.unit)) reserveUnitLine = true;
      }
      plan.push({ win: win, signals: signals, shared: shared });
    });

    plan.forEach((item) => {
      const win = item.win;
      const signals = item.signals;

      self.geom[win.id] = qmDrawStrip(win._canvas, {
        // In a node: layout pixels at the reference scale, so the canvas transform never resizes the bitmap.
        box: self._inNode() ? qmBoxFor(win._canvas, qmReferenceWidth()) : undefined,
        minLeftAxes: item.shared ? minLeftAxes : 0,
        minRightAxes: item.shared ? minRightAxes : 0,
        reserveUnitLine: item.shared ? reserveUnitLine : false,
        root: self.root,
        height: "auto",
        t0: self.rangeOf(win).t0,
        t1: self.rangeOf(win).t1,
        cursorT: self.cursorsOf(win).a,
        markT: self.state.diff ? self.cursorsOf(win).b : null,
        hoverT: self.state.hover,
        bandT: (self.state.band && self.state.band.win === win.id)
          ? [self.state.band.t0, self.state.band.t1] : null,
        yMode: win.yMode || "auto",
        envelope: self.state.envelope === true,
        frameT0: self.frameSpanFor(win).t0,
        frameT1: self.frameSpanFor(win).t1,
        signals: signals,
      });

      // Honesty badge: at aggregated resolution the line is a mean, not a
      // sample, and the user has to be able to see that at a glance.
      const g = self.geom[win.id];
      const wr = self.rangeOf(win);
      const msPerPx = (wr.t1 - wr.t0) / Math.max(1, g.w);
      const badge = win._node.querySelector(".qm-agg");
      // Density behind the mean, read off the first trace on screen.
      const smp = medianBucketCount((signals.find((sg) => !sg.hidden) || {}).frame);
      const smpTxt = smp == null ? ""
        : " · ~" + (smp >= 10 ? Math.round(smp) : Math.round(smp * 10) / 10) + " smp/px";
      badge.textContent = signals.length
        ? "≈ " + msPerPx.toFixed(msPerPx < 10 ? 1 : 0) + " ms/px" + smpTxt + " · aggregated"
        : "no data";
    });

    this.renderReadout();
  };

  // ── standard mode ───────────────────────────────────────
  // Nothing to render: standard mode is the existing dataset node, which this
  // module does not own. Kept as a method so draw() stays uniform.

  Measure.prototype.drawStandard = function () {};

  // ── ai mode ─────────────────────────────────────────────

  Measure.prototype.renderAi = function () {
    this.$(".qm-json").textContent = JSON.stringify(this.serialize(), null, 2);

    // The simplest honest read of the data: the numbers, no plot. Anything
    // richer belongs in Explore.
    const wrap = this.$(".qm-mini-wrap");
    const self = this;
    const win = self.activeWin();
    const traces = self.tracesOf(win);
    const shownTraces = traces.slice(0, 6);
    if (!shownTraces.length) {
      wrap.innerHTML = `<div class="qm-mini-empty">No signals selected yet.</div>`;
      return;
    }
    const fr = self.framesFor(win);
    const rows = shownTraces.map((t) => {
      const f = fr[t.key];
      const st = f ? qmRangeStats(f) : { min: NaN, max: NaN, mean: NaN };
      return `<tr>
        <td class="qm-name">
          <span class="qm-swatch" style="background:var(${esc(t.colorVar)})"></span>${esc(t.name)}
        </td>
        <td>${qmFmtNum(st.min, t.dec)}</td>
        <td>${qmFmtNum(st.max, t.dec)}</td>
        <td>${qmFmtNum(st.mean, t.dec)}</td>
        <td>${esc(t.unit || "")}</td>
      </tr>`;
    }).join("");
    const more = traces.length - shownTraces.length;
    wrap.innerHTML = `<table class="qm-mini">
      <thead><tr><th>Signal</th><th>Min</th><th>Max</th><th>Mean</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>` +
      (more > 0 ? `<div class="qm-mini-empty" style="padding-top:7px">+ ${more} more in Explore</div>` : "");
  };

  /** One row per (window, signal) pair.
   *
   *  Not per signal: with per-window selection the same signal can appear in
   *  several windows, and each window may be on its own cursor, so a per-signal
   *  row has no single correct "value". Pairing the row with its window makes
   *  every number unambiguous — and retires the old "readout follows the
   *  last-focused window" rule, which only existed to paper over that.
   */
  Measure.prototype.renderReadout = function () {
    const s = this.state;
    const diff = s.diff;

    // Fractions are per window now — a window with its own range maps a given
    // instant to a different bucket than its neighbour.
    // A cursor between two readings used to print "—", which reads as "no data
    // here" when the truth is "no data at exactly here". Fill it from the
    // measurements around it, and SAY which: an approximate value is marked and
    // carries the distance or the pair it came from, because a readout that
    // silently claims a measurement at an instant that was never sampled is worse
    // than a blank one.
    const fill = this.fillMode();
    const sampleIn = (rg) => (frame, t) => {
      const none = { v: NaN, lo: NaN, hi: NaN };
      if (!frame || t == null) return none;
      const span = (rg.t1 - rg.t0) || 1;
      const n = frame.mean.length;
      const bi = qmBucketAt(frame, (t - rg.t0) / span);
      const at = (i) => ({ v: frame.mean[i], lo: frame.min[i], hi: frame.max[i] });
      const has = (i) => i >= 0 && i < n && frame.count[i] > 0 &&
        isFinite(frame.mean[i]);
      if (has(bi)) return at(bi);

      // Nearest filled bucket either side, and how far each is in buckets.
      let lo = -1, hi = -1;
      for (let i = bi - 1; i >= 0; i--) { if (has(i)) { lo = i; break; } }
      for (let i = bi + 1; i < n; i++) { if (has(i)) { hi = i; break; } }
      if (lo < 0 && hi < 0) return none;          // genuinely nothing in view

      const tOf = (i) => rg.t0 + (n > 1 ? i / (n - 1) : 0.5) * span;
      const pick = (i) => Object.assign(at(i), {
        approx: "nearest", fromT: tOf(i), gap: Math.abs(t - tOf(i)),
      });
      if (lo < 0) return pick(hi);
      if (hi < 0) return pick(lo);
      if (fill === "nearest") {
        return pick((bi - lo) <= (hi - bi) ? lo : hi);
      }
      // Linear between the two, weighted by where the cursor falls between them.
      const w = (bi - lo) / (hi - lo);
      return {
        v: frame.mean[lo] + (frame.mean[hi] - frame.mean[lo]) * w,
        lo: NaN, hi: NaN,               // an interpolated point has no bucket
        approx: "interp", fromT: tOf(lo), toT: tOf(hi),
      };
    };

    // With the diff cursor on you are measuring an INTERVAL, so the stats
    // scope to A–B rather than the visible range. The header says which, because
    // silently changing what a number means is worse than not showing it.
    /** Cell markup for a sampled value, marked when it is not a reading AT the
     *  cursor. "~" plus the reason in the tooltip: the number is useful, and the
     *  fact that it was inferred has to travel with it. */
    const valCell = (cls, sm, sig) => {
      const txt = qmFmtNum(sm.v, sig.dec);
      const unit = sig.unit ? `<span class="qm-u">${esc(sig.unit)}</span>` : "";
      if (!sm.approx) {
        const tip = `bucket ${qmFmtNum(sm.lo, sig.dec)} – ${qmFmtNum(sm.hi, sig.dec)}`;
        return `<td class="${cls}" title="${tip}">${txt}${unit}</td>`;
      }
      const tip = sm.approx === "interp"
        ? "interpolated between the measured points either side"
        : "nearest measured point, " + (sm.gap / 1000).toFixed(3) + " s away";
      return `<td class="${cls} qm-approx" title="${esc(tip)}">` +
        `<span class="qm-approxmark" aria-hidden="true">~</span>${txt}${unit}</td>`;
    };

    const scope = diff ? "A–B" : "range";
    const head = ['<tr><th>Signal</th>'
      + '<th title="Which subwindow this signal is plotted in">Window</th>',
      '<th>Min <span class="qm-sc">(' + scope + ')</span></th>',
      '<th>Max <span class="qm-sc">(' + scope + ')</span></th>',
      '<th>Mean <span class="qm-sc">(' + scope + ')</span></th>'];
    if (diff) {
      head.push('<th>Value 1 <span class="qm-sc">@ A</span></th>',
                '<th>Value 2 <span class="qm-sc">@ B</span></th>',
                '<th>Δ value</th>', "<th>Δt</th>");
    } else {
      head.push('<th>Value <span class="qm-sc">@ cursor</span></th>');
    }
    head.push("</tr>");
    // One table, two possible homes: the bottom bar, or the sidebar. Write to
    // both — they are never both visible, and keeping them in step means
    // switching panes shows numbers immediately instead of waiting for a repaint.
    this.$(".qm-sb-values thead").innerHTML = head.join("");
    this._syncToolbar();

    const cols = diff ? 9 : 6;
    const rows = [];
    s.windows.forEach((win, wi) => {
      const cur = this.cursorsOf(win);
      // The frames' OWN range, not the visible one — see frameSpanFor. Sampling
      // by the visible range while a held frame is on screen reads the value of
      // the wrong instant, so the table and the plot would disagree mid-pan.
      const rg = this.frameSpanFor(win);
      const span = (rg.t1 - rg.t0) || 1;
      const sample = sampleIn(rg);
      const fr = this.framesFor(win);
      this.tracesOf(win).forEach((tr) => {
        const frame = fr[tr.key];
        let st = { min: NaN, max: NaN, mean: NaN };
        if (frame) {
          st = diff && cur.b != null
            ? qmSpanStats(frame, (cur.a - rg.t0) / span, (cur.b - rg.t0) / span)
            : qmRangeStats(frame);
        }
        const a = sample(frame, cur.a);

        const cells = [
          `<td class="qm-name"><span class="qm-swatch" style="background:var(${esc(tr.colorVar)})"></span>${esc(tr.name)}</td>`,
          `<td class="qm-wincell">${wi + 1}</td>`,
          `<td>${qmFmtNum(st.min, tr.dec)}</td>`,
          `<td>${qmFmtNum(st.max, tr.dec)}</td>`,
          `<td>${qmFmtNum(st.mean, tr.dec)}</td>`,
        ];

        if (diff) {
          const b = sample(frame, cur.b);
          // Difference the values AS RENDERED — parse back the very strings in
          // the two cells. Differencing the raw values lets the table
          // contradict itself (4,925 and 2,500 with Δ −2,424; two identical 0.6
          // readings with Δ −0.1), and in a measurement readout the user WILL
          // subtract the columns. Rounding with toFixed instead is not enough
          // either: it disagrees with toLocaleString at binary edges, which
          // reintroduces the same bug one decimal down (55.32 − 18.13 → 37.18).
          const shown = (x) => {
            const t = qmFmtNum(x, tr.dec);
            return t === "—" ? NaN : Number(t.replace(/,/g, ""));
          };
          let dv = (isFinite(a.v) && isFinite(b.v)) ? shown(b.v) - shown(a.v) : NaN;
          if (dv === 0) dv = 0;               // normalise -0 so it prints "0.0"
          const dt = (cur.a != null && cur.b != null)
            ? Math.abs(cur.b - cur.a) / 1000 : NaN;
          cells.push(
            valCell("qm-val", a, Object.assign({}, tr, { unit: "" })),
            valCell("qm-val2", b, Object.assign({}, tr, { unit: "" })),
            `<td class="qm-val">${dv > 0 ? "+" : ""}${qmFmtNum(dv, tr.dec)}${
              tr.unit ? `<span class="qm-u">${esc(tr.unit)}</span>` : ""}</td>`,
            `<td>${isFinite(dt) ? dt.toFixed(3) + " s" : "—"}</td>`);
        } else {
          cells.push(valCell("qm-val", a, tr));
        }
        rows.push("<tr>" + cells.join("") + "</tr>");
      });
    });

    const body = rows.join("") ||
      `<tr><td class="qm-name" colspan="${cols}">No signals selected.</td></tr>`;
    this.$(".qm-sb-values tbody").innerHTML = body;
    this._renderTimes();
    this._emitSpan();
  };

  /** Per-signal stats between the two cursors — the frame a downstream cell
   *  would consume. `node._result` only ever carries the SQL path's value, so
   *  this is the only way "analyse what I'm looking at" can work. Emitted
   *  through `cfg.onSpan` so the integration layer decides what to do with it.
   */
  Measure.prototype.spanFrame = function () {
    const s = this.state;
    const rows = [];
    s.windows.forEach((win, wi) => {
      const cur = this.cursorsOf(win);
      if (cur.a == null || cur.b == null) return;
      const rg = this.rangeOf(win);
      const span = (rg.t1 - rg.t0) || 1;
      const fr = this.framesFor(win);
      this.tracesOf(win).forEach((t) => {
        const frame = fr[t.key];
        if (!frame) return;
        const st = qmSpanStats(frame, (cur.a - rg.t0) / span, (cur.b - rg.t0) / span);
        rows.push({
          signal: t.sigId, name: t.name, unit: t.unit, column: t.col, window: wi + 1,
          from: Math.min(cur.a, cur.b), to: Math.max(cur.a, cur.b),
          min: st.min, max: st.max, mean: st.mean, samples: st.count,
        });
      });
    });
    return { from: s.t0, to: s.t1, rows: rows };   // shared range, for context
  };

  Measure.prototype._emitSpan = function () {
    if (!this.cfg.onSpan || !this.state.diff) return;
    try { this.cfg.onSpan(this.spanFrame()); } catch (e) { /* consumer's problem */ }
  };

  /** Cursor timestamps in the bottom bar.
   *
   *  Shown in BOTH modes — a value without the instant it was taken at is half a
   *  measurement. With the diff cursor on it reports Time 1, Time 2 and Δt;
   *  otherwise just the single cursor time.
   *
   *  Cursor times belong to a window (windows can be unlinked), so this reports
   *  the window the tree is targeting and names it, rather than implying there is
   *  one global cursor.
   */
  /** Format an X value the way the plot ruler does.
   *
   *  Uses the ACTIVE window's range to decide which clock we are on, so the
   *  readout and the strip can never disagree about it. Before zero on a
   *  relative clock reads as a signed offset ("−2.1 s"), not as "—".
   */
  Measure.prototype._fmtX = function (t) {
    const r = this.rangeOf(this.activeWin());
    return qmFmtX(t, r.t0, r.t1, { precise: true });
  };

  Measure.prototype._renderTimes = function () {
    const el2 = this.$(".qm-times");
    const win = this.activeWin();
    if (!win || !this.state.signals.length) { el2.innerHTML = ""; return; }

    const cur = this.cursorsOf(win);
    const parts = [`<span class="qm-tlabel">${esc(win.label)}</span>`];

    if (this.state.diff) {
      const dt = (cur.a != null && cur.b != null)
        ? (Math.abs(cur.b - cur.a) / 1000).toFixed(3) + " s" : "—";
      parts.push(
        `Time 1 <span class="qm-num">${cur.a != null ? (this._fmtX(cur.a) || "—") : "—"}</span>`,
        `Time 2 <span class="qm-num qm-t2">${cur.b != null ? (this._fmtX(cur.b) || "—") : "—"}</span>`,
        `Δt <span class="qm-num">${dt}</span>`);
    } else {
      parts.push(
        `Time <span class="qm-num">${cur.a != null ? (this._fmtX(cur.a) || "—") : "—"}</span>`);
    }

    // Where the POINTER is, and how far that is from the cursor. The cursor time
    // answers "what am I measuring"; the pointer answers "what am I about to
    // measure", and reading it off the plot meant looking away from the trace.
    // Δ to the cursor is the number you actually want when lining an event up.
    const hv = this.state.hover;
    if (hv != null) {
      // Sign the gap explicitly. toFixed carries the minus but never a plus, and
      // "15.000 s" ahead of the cursor reads identically to 15 s behind it.
      const secs = cur.a != null ? (hv - cur.a) / 1000 : null;
      const gap = secs == null
        ? null : (secs >= 0 ? "+" : "") + secs.toFixed(3) + " s";
      // The gap survives even where the absolute position does not: how far the
      // pointer is from the cursor is a difference, and a difference is valid on
      // either clock and on either side of zero.
      const at = this._fmtX(hv);
      if (at) {
        parts.push(`Pointer <span class="qm-num qm-thover">${at}</span>` +
          (gap ? ` <span class="qm-tgap">(${gap})</span>` : ""));
      } else if (gap) {
        parts.push(`Pointer <span class="qm-tgap">(${gap} from cursor)</span>`);
      }
    }
    el2.innerHTML = parts.join(" · ");
  };

  // ── sidebar width ───────────────────────────────────────
  // Partition values are long ("platform=CHEVROLET_SILVERADO_MK4"), so a fixed
  // sidebar truncates the part that distinguishes them. Width is session state,
  // not layout: it describes this screen, not the measurement, so it is kept in
  // sessionStorage alongside the theme rather than written to viz.measure.

  const SB_MIN = 170;
  const SB_MAX_FRAC = 0.6;      // never swallow the plots
  const SB_DEFAULT = 268;

  Measure.prototype._sidebarWidth = function (px) {
    // Ceiling only when the view has a measurable width — see _readoutHeight for
    // why: an unlaid-out root would otherwise clamp the stored width to SB_MIN and
    // write that back over the user's setting.
    const room = this.root.clientWidth || 0;
    const max = room > 0
      ? Math.max(SB_MIN, Math.round(room * SB_MAX_FRAC)) : Infinity;
    const w = Math.max(SB_MIN, Math.min(max, Math.round(px)));
    this.root.style.setProperty("--qm-sb-w", w + "px");
    try { sessionStorage.setItem("qm.sbWidth", String(w)); } catch (e) { /* private mode */ }
    // The plots just changed width, so their canvases must be re-sized.
    this.draw();
    return w;
  };

  // ── subwindow heights ───────────────────────────────────
  // `win.height` is a flex RATIO, not pixels (see renderWindows), which is what
  // keeps the strips filling the workspace instead of leaving dead space at the
  // bottom. A drag therefore cannot just write pixels: it converts, using the two
  // nodes' REAL heights measured at drag start. That keeps the maths exact
  // without having to know the workspace height, the gaps between strips, or
  // whether the workspace is scrolling.

  const WIN_MIN_PX = 132;       // matches .qm-win min-height in measure.css
  const WIN_H_DEFAULT = 176;    // the ratio a window starts with

  /** Move the boundary between two adjacent windows by ``dy`` pixels.
   *
   *  Their combined ratio is preserved, so the pair keeps exactly the space it
   *  had and no other window moves. Returns false when the pair has no measurable
   *  height yet (pre-layout), so a caller does not persist a garbage ratio.
   */
  Measure.prototype._resizePair = function (a, b, pxA, pxB, dy) {
    const sum = (a.height || WIN_H_DEFAULT) + (b.height || WIN_H_DEFAULT);
    const total = pxA + pxB;
    if (!(total > 0) || !(sum > 0)) return false;
    // Clamp in PIXELS against the same floor the stylesheet enforces. Clamping a
    // ratio instead would let a drag ask for 20px on a tall workspace, which CSS
    // then refuses — the strip stays 132px and the ratio silently lies about it.
    const floor = Math.min(WIN_MIN_PX, total / 2);
    const nextA = Math.max(floor, Math.min(total - floor, pxA + dy));
    a.height = Math.max(1, Math.round(sum * (nextA / total)));
    b.height = Math.max(1, sum - a.height);
    return true;
  };

  Measure.prototype._applyWinHeights = function () {
    this.state.windows.forEach((w) => {
      if (w._node) w._node.style.flexGrow = String(w.height || WIN_H_DEFAULT);
    });
  };

  Measure.prototype._bindWinResize = function (grip, a, b) {
    const self = this;
    let id = null, startY = 0, pxA = 0, pxB = 0;

    const move = (ev) => {
      if (id == null || ev.pointerId !== id) return;
      if (self._resizePair(a, b, pxA, pxB, ev.clientY - startY)) {
        self._applyWinHeights();
        // The plot boxes changed height; the ResizeObserver would catch it too,
        // but going through scheduleDraw keeps it to one repaint per frame.
        self.scheduleDraw();
      }
      ev.preventDefault();
    };
    const up = (ev) => {
      if (id == null || ev.pointerId !== id) return;
      id = null;
      grip.classList.remove("qm-dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      self.persist();            // the layout is the user's, so it survives a reopen
    };
    grip.addEventListener("pointerdown", (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      id = ev.pointerId;
      startY = ev.clientY;
      pxA = a._node ? a._node.getBoundingClientRect().height : 0;
      pxB = b._node ? b._node.getBoundingClientRect().height : 0;
      grip.classList.add("qm-dragging");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      ev.preventDefault();
      ev.stopPropagation();
    });
    grip.addEventListener("dblclick", (ev) => {
      a.height = WIN_H_DEFAULT;
      b.height = WIN_H_DEFAULT;
      self._applyWinHeights();
      self.persist();
      self.scheduleDraw();
      ev.stopPropagation();
    });
  };

  // ── sidebar: which pane, and whether it is there at all ──
  // The values table used to sit in a bottom bar, where it took height from every
  // plot at once to show numbers for one cursor. It lives here now, switched
  // against the tree — the two are never wanted at the same moment, since you
  // browse to pick signals and then read values. The bottom bar is gone entirely,
  // and folding the sidebar leaves nothing but plots. Both are session state, like
  // the theme and the widths.

  /** Toggle showing the partition key on EVERY folder (vs only the ones you've
   *  opened). Session state, like the theme and the sidebar widths. */
  Measure.prototype.setShowKeys = function (on) {
    this._showKeys = !!on;
    const b = this.$(".qm-keytog");
    if (b) b.setAttribute("aria-pressed", String(this._showKeys));
    try { sessionStorage.setItem("qm.showKeys", this._showKeys ? "1" : "0"); } catch (e) { /* private */ }
    this.renderTree();
    return this._showKeys;
  };

  Measure.prototype.setSidebarMode = function (mode) {
    const m = mode === "values" ? "values" : "tree";
    this._sbMode = m;
    this.root.dataset.sbMode = m;
    this.$.all(".qm-sbmode").forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.sb === m));
    });
    const showTree = m === "tree";
    // The filter box belongs to the tree; above a values table it would imply it
    // filters the rows.
    this.$(".qm-search").hidden = !showTree;
    this.$(".qm-tree").hidden = !showTree;
    this.$(".qm-sb-values").hidden = showTree;
    if (showTree) this.$(".qm-tables").hidden = true;
    try { sessionStorage.setItem("qm.sbMode", m); } catch (e) { /* private mode */ }
    if (m === "values") this.renderReadout();
    return m;
  };

  Measure.prototype.setSidebarFolded = function (folded) {
    const on = !!folded;
    this._sbFolded = on;
    if (on) this.root.dataset.sbFolded = "1";
    else delete this.root.dataset.sbFolded;
    const unfold = this.$(".qm-sbunfold");
    if (unfold) unfold.hidden = !on;
    try { sessionStorage.setItem("qm.sbFolded", on ? "1" : "0"); } catch (e) { /* private */ }
    // The plots just gained or lost the sidebar's width.
    this.scheduleDraw();
    return on;
  };

  // ── controls help ───────────────────────────────────────
  // The gesture list lives behind the "?" in the header. It used to ALSO feed a
  // native `title` on the whole plot, but that tooltip popped up over the data on
  // every hover and read as noise — removed. One list, one presentation (the
  // panel), so there is still nothing to keep in sync by hand.
  //
  // The modifier is labelled per platform. The gestures themselves have always
  // accepted ctrlKey OR metaKey, so nothing behaves differently on a Mac — but
  // printing "ctrl" there is wrong, and ctrl+click is the context menu on macOS,
  // so ⌘ is the one to reach for. Trackpad pinch arrives as ⌘/ctrl+wheel, which
  // means pinch-to-zoom works on the plot for free.

  Measure.prototype.controls = function () {
    return qmControls(this.state.diff, qmModLabel(qmIsMac()));
  };

  Measure.prototype._syncControlHints = function () {
    // No native `title` on the workspace: a browser tooltip covering the whole
    // plot popped up on every hover and read as noise. The "?" panel is the one
    // presentation of this list now.
    const list = this.$(".qm-helplist");
    if (list) {
      list.innerHTML = this.controls().map((c) => (
        `<div class="qm-helprow"><dt>${esc(c[0])}</dt><dd>${esc(c[1])}</dd></div>`
      )).join("");
    }
  };

  Measure.prototype.toggleHelp = function (show) {
    const box = this.$(".qm-helpbox");
    if (!box) return false;
    const open = show == null ? box.hidden : !!show;
    if (open) this._syncControlHints();      // diff mode changes what a drag means
    box.hidden = !open;
    return open;
  };

  /** How the readout fills a cursor that falls between measurements.
   *
   *  "nearest" sticks to the measured points, "interp" draws the straight line
   *  between the two either side. Neither is a default worth arguing about — which
   *  one is honest depends on the signal (a CAN frame is a sequence of discrete
   *  readings; an analogue channel is a curve you sampled), which is exactly why
   *  it is a button and not a constant. Session state, like the theme.
   */
  Measure.prototype.fillMode = function () {
    if (!this._fill) {
      let m = "nearest";
      try { m = sessionStorage.getItem("qm.fill") || "nearest"; } catch (e) { /* private */ }
      this._fill = m === "interp" ? "interp" : "nearest";
    }
    return this._fill;
  };

  Measure.prototype.setFillMode = function (mode) {
    const m = mode === "interp" ? "interp" : "nearest";
    this._fill = m;
    try { sessionStorage.setItem("qm.fill", m); } catch (e) { /* private mode */ }
    this.$.all(".qm-fill").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.fill === m));
    });
    this.renderReadout();
    return m;
  };

  Measure.prototype._bindSidebar = function () {
    const self = this;
    this.$.all(".qm-fill").forEach((b) => {
      b.addEventListener("click", () => self.setFillMode(b.dataset.fill));
    });
    this.setFillMode(this.fillMode());
    this.$.all(".qm-sbmode").forEach((b) => {
      b.addEventListener("click", () => self.setSidebarMode(b.dataset.sb));
    });
    this.$(".qm-sbfold").addEventListener("click", () => self.setSidebarFolded(true));
    // The way back out is a toolbar button OUTSIDE the sidebar, so it cannot be
    // hidden by the thing it un-hides, and it reads as a control rather than as
    // a stray arrow floating over the plot.
    this.$(".qm-sbunfold").addEventListener("click", () => self.setSidebarFolded(false));

    let mode = "tree", folded = false;
    try {
      mode = sessionStorage.getItem("qm.sbMode") || "tree";
      folded = sessionStorage.getItem("qm.sbFolded") === "1";
    } catch (e) { /* private mode */ }
    this.setSidebarMode(mode);
    this.setSidebarFolded(folded);
  };

  Measure.prototype._bindSidebarResize = function () {
    const self = this;
    const grip = this.$(".qm-sb-resizer");
    const side = this.$(".qm-sidebar");
    if (!grip || !side) return;

    const stored = (function () {
      try { return parseInt(sessionStorage.getItem("qm.sbWidth"), 10); } catch (e) { return NaN; }
    })();
    if (isFinite(stored) && stored > 0) this._sidebarWidth(stored);

    let id = null;
    const move = (ev) => {
      if (id == null || ev.pointerId !== id) return;
      // Measure from the sidebar's own left edge, so the width tracks the
      // pointer exactly however the view is positioned on the page.
      self._sidebarWidth(ev.clientX - side.getBoundingClientRect().left);
      ev.preventDefault();
    };
    const up = (ev) => {
      if (id == null || ev.pointerId !== id) return;
      id = null;
      grip.classList.remove("qm-dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    grip.addEventListener("pointerdown", (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      id = ev.pointerId;
      grip.classList.add("qm-dragging");
      // Listen on the window: the pointer routinely leaves a 7px strip.
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      ev.preventDefault();
      ev.stopPropagation();
    });
    grip.addEventListener("dblclick", (ev) => {
      self._sidebarWidth(SB_DEFAULT);
      ev.stopPropagation();
    });
    // The strip lives on the plot side of nothing, but it does sit inside the
    // sidebar — stop clicks reaching the tree behind it.
    grip.addEventListener("click", (ev) => ev.stopPropagation());
  };

  Measure.prototype.destroy = function () {
    // Set FIRST: a coalesced repaint may already be queued for the next frame,
    // and it must not run against a detached DOM after teardown.
    this._dead = true;
    Measure._all.delete(this);
    if (this._onChipKey) document.removeEventListener("keydown", this._onChipKey, true);
    clearTimeout(this._fetchTimer);
    if (this._plotRaf) cancelAnimationFrame(this._plotRaf);
    if (this._plotRo) this._plotRo.disconnect();
    if (this._ro) this._ro.disconnect();
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
  };

  // Live registry of mounted views + one window listener, so toggling the app
  // theme rethemes every open Explore/measurement surface. The per-view toggle
  // still lets a view override independently afterwards.
  Measure._all = new Set();
  if (!window.__qmThemeSync) {
    window.__qmThemeSync = true;
    window.addEventListener("quixlab:theme", function (ev) {
      const t = ev && ev.detail && ev.detail.theme;
      if (!t) return;
      Measure._all.forEach(function (v) { try { v.setTheme(t); } catch (e) { /* torn down */ } });
    });
  }

  // ── public API ──────────────────────────────────────────

  // Shared handles for the sibling modules (measure-tree/-nav/-lake.js),
  // which attach their methods to this same prototype. Split out because one
  // file had grown past 1800 lines; the seams are responsibility-based, not
  // arbitrary — tree/table/column browsing, and range navigation + input.
  window.QM = {
    Measure: Measure, esc: esc, el: el, MAX_SIGNALS: MAX_SIGNALS,
    toColumnList: toColumnList, namedColumn: namedColumn,
    autoSignalName: autoSignalName, columnRank: columnRank,
    COL_TIME_NAME: COL_TIME_NAME, COL_REL_NAME: COL_REL_NAME,
    BUCKET_MAX: BUCKET_MAX, WHOLE_TABLE: WHOLE_TABLE,
  };

  window.MeasureView = {
    /** Mount into any host element. Returns the controller. */
    mount: function (host, cfg) {
      const stored = (function () {
        try { return sessionStorage.getItem("qm.theme"); } catch (e) { return null; }
      })();
      const c = Object.assign({}, cfg);
      // A new view follows, in order: an explicit cfg.theme, this session's own
      // plot-theme choice, then the app theme — so Explore matches the app by
      // default while keeping its independent per-view toggle.
      if (!c.theme) c.theme = stored || document.documentElement.dataset.theme || "dark";
      return new Measure(host, c);
    },

    /** Fullscreen explore surface. Esc closes it. */
    openOverlay: function (cfg) {
      const overlay = el(`<div class="qm-overlay"></div>`);
      document.body.appendChild(overlay);
      let view = null;
      const close = () => {
        document.removeEventListener("keydown", onKey);
        // Save the layout — the visible TIME RANGE included — before the view is
        // torn down, so reopening the maximized window lands on the same frame
        // you left. onChange is the caller's persist hook; zoom/pan don't call it
        // themselves, so without this a zoomed range is lost on close.
        try { if (view && cfg && cfg.onChange) cfg.onChange(view.serialize()); } catch (e) { /* best effort */ }
        if (view) view.destroy();
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (cfg && cfg.onClose) cfg.onClose();
      };
      const onKey = (ev) => { if (ev.key === "Escape") close(); };
      document.addEventListener("keydown", onKey);
      view = window.MeasureView.mount(overlay,
        Object.assign({}, cfg, { onClose: close }));
      view.close = close;
      return view;
    },
  };
})();
