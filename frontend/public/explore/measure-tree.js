// ── Measurement view: table, columns and signal tree ────────────
// Attaches to the same prototype as measure-view.js, which must load first and
// which exposes the constructor on window.QM. Split out of that file to keep
// each module readable; this half is all about BROWSING what is available —
// picking a table, resolving X/Y columns, and walking the partition tree.
(function () {
  "use strict";

  const Measure = window.QM.Measure;
  const esc = window.QM.esc;
  const el = window.QM.el;
  const toColumnList = window.QM.toColumnList;
  const autoSignalName = window.QM.autoSignalName;
  const columnRank = window.QM.columnRank;

  // Empty is not a state to render: the user's model is "one entity has 1..N
  // value columns", so the picker refuses to clear the last one.
  const LAST_COLUMN = "At least one value column must be selected.";

  // icons.js defines the global ``icon`` in the app; a host that mounts the tree
  // alone (unit tests) may not load it, so fall back to no glyph rather than
  // throwing — same guard pattern as kb-manager.js.
  const drawIcon = (name) => (typeof icon === "function" ? icon(name) : "");

  /** A node's PATH segment, which is not always its label.
   *
   *  A lake partition displays as key=value and must address as "key=value" —
   *  the catalog resolves "platform=FORD", not "FORD". Providers that address
   *  by bare value omit ``seg``. Every path composition in this file goes
   *  through here; using ``value`` directly is the bug this replaced. */
  const segOf = (n) => (n && n.seg != null ? n.seg : (n ? n.value : ""));

  // How many nodes of one partition level get rendered before a "show more"
  // control takes over, and how many signals one branch tick may select. Both
  // exist because the sizes here come from the lake, not from a person: a level
  // can hold six values or six hundred thousand, and the unbounded version of
  // either turned one click into gigabytes of DOM.
  const LEVEL_PAGE = 200;
  const MAX_BRANCH_SELECT = window.QM.MAX_SIGNALS;

  // A lake error can quote a whole upstream trace, which a 260px column cannot hold.
  const MSG_MAX = 160;
  const clip = (t) => (t.length > MSG_MAX ? t.slice(0, MSG_MAX - 1) + "…" : t);

  // ── table selection ─────────────────────────────────────
  // The entry point of the flow: choose a table, confirm, then its partition
  // tree appears. Until a table is chosen there is nothing to select signals
  // from, so the picker takes over the sidebar rather than hiding in a menu.

  Measure.prototype.pickTable = function () {
    const self = this;
    const box = this.$(".qm-tables");
    const tree = this.$(".qm-tree");
    if (!box.hidden) { box.hidden = true; tree.hidden = false; return; }

    box.hidden = false;
    tree.hidden = true;
    box.innerHTML = `<div class="qm-tree-msg">Loading tables…</div>`;
    if (!this.provider.tables) {
      box.innerHTML = `<div class="qm-tree-msg">This provider has no table list.</div>`;
      return;
    }
    Promise.resolve(this.provider.tables()).then((list) => {
      box.innerHTML = "";
      if (!list || !list.length) {
        box.innerHTML = `<div class="qm-tree-msg">No tables reported by the lake.</div>`;
        return;
      }
      (list || []).forEach((t) => {
        const row = el(`
          <div class="qm-row qm-tablerow${t.name === self.state.table ? " qm-cur" : ""}">
            <span class="qm-fico" aria-hidden="true">${drawIcon("folder")}</span>
            <span class="qm-pval">${esc(t.name)}</span>
            <span class="qm-count">${esc(t.rows || "")}</span>
          </div>`);
        // reset: picking a table means "start at its top level", even if it is
        // the table already loaded.
        row.addEventListener("click", () => self.setTable(t.name, { reset: true }));
        box.appendChild(row);
      });
    }).catch((e) => {
      // The lake being unreachable is a normal operational state, not a
      // programming error, so say what happened and offer the retry rather
      // than leaving "Loading tables…" on screen for the timeout's duration.
      const msg = String((e && e.message) || e);
      const refused = /refused|Max retries|not set|timed? ?out|unreachable/i.test(msg);
      box.innerHTML = "";
      box.appendChild(el(`
        <div class="qm-tree-msg">
          <div>${refused ? "The lake did not answer." : esc(msg)}</div>
          ${refused ? `<div class="qm-msg-detail">${esc(msg)}</div>` : ""}
          <button class="qm-tbtn qm-retry" type="button">
            <span class="qm-tico" aria-hidden="true">⟳</span>retry</button>
        </div>`));
      box.querySelector(".qm-retry").addEventListener("click", () => {
        // Drop the cached rejection so the next call really re-requests.
        box.hidden = true;
        self.pickTable();
      });
    });
  };

  /** Switching table invalidates every signal id — they are table-scoped.
   *
   *  ``opts.reset`` forces the clean start even when the name is unchanged.
   *  Choosing a table from the picker means "show me this table's partitions",
   *  and without it a still-selected deep signal made revealSelected re-expand
   *  its whole ancestry — six chained level fetches on a deeply partitioned
   *  table, which read as the tree going far too deep for what was asked.
   */
  Measure.prototype.setTable = function (name, opts) {
    const s = this.state;
    const changed = s.table !== name || !!(opts && opts.reset);
    s.table = name;
    this.$(".qm-title").textContent = name || "pick a table";
    this.$(".qm-tables").hidden = true;
    this.$(".qm-tree").hidden = false;
    if (changed) {
      s.signals = [];
      s.windows.forEach((w) => { w.signalIds = []; });
      // A table picked by hand is browsed from its top; roots come from a dataset.
      s.roots = (opts && Array.isArray(opts.roots)) ? opts.roots.filter(Boolean) : [];
      this._treeOpen = {};   // a new table is a new tree — drop the old expansion
      s.columns = { x: null, y: [] };
      this._treeRoot = null;
      this.frames = {};
      this._cols = null;
      this._yOpen = false;
      this._yFilter = "";
      // A new table's data sits somewhere else in time, so the next signal
      // selected must reposition the range again.
      this._positioned = false;
      // A stale "not found" or Fit failure read as though the NEW table were broken.
      this.showFetchError(null);
    }
    this.persist();
    this.renderTree();
    this.renderWindows();
    // An OPEN columns panel keeps showing the previous table's columns
    // otherwise — the cache is cleared above but nothing redraws it, so the
    // panel offered columns that do not exist on the table now selected.
    if (changed && !this.$(".qm-colspanel").hidden) this._loadColumns();
    this._scheduleFetch(0);
  };

  // ── X / Y columns ───────────────────────────────────────
  // A table-level DEFAULT pair plus per-signal overrides: set the default once
  // and every signal follows, so an unchanged table structure needs no
  // per-signal work. `columnsFor` is the single place inheritance is resolved.

  Measure.prototype.columnsFor = function (sig) {
    const d = this.state.columns || {};
    const defaults = toColumnList(d.y);
    // A per-signal override is ONE column by definition; everything else takes
    // the table's list. Deduped again here, cheaply, because state.columns.y is
    // reachable from an applied AI layout and from tests.
    const ys = (sig && sig.y) ? [sig.y] : defaults;
    return {
      x: (sig && sig.x) || d.x || null,
      ys: ys,
      y: ys[0] || null,
      xOverridden: !!(sig && sig.x && sig.x !== d.x),
      yOverridden: !!(sig && sig.y && defaults.indexOf(sig.y) < 0),
    };
  };

  /** Fetch the active table's columns and redraw the panel.
   *
   *  ``state.columns.y`` is the sole owner of the value-column selection: the
   *  tree selects whole partitions, so no part of this panel is derived from
   *  what is selected there.
   */
  Measure.prototype._loadColumns = function () {
    const self = this;
    const panel = this.$(".qm-colspanel");
    panel.innerHTML = `<div class="qm-tree-msg">Loading columns…</div>`;
    const load = this.provider.columns
      ? Promise.resolve(this.provider.columns(this.state.table))
      : Promise.resolve([]);
    return load.then((cols) => {
      self._cols = cols || [];
      self.renderColumns();
    }).catch(() => {
      self._cols = [];
      self.renderColumns();
    });
  };

  Measure.prototype.toggleColumns = function () {
    const panel = this.$(".qm-colspanel");
    // The picker is a sibling of this panel, so hiding one no longer hides the other.
    if (!panel.hidden) { panel.hidden = true; this._closeYPanel(); return; }
    panel.hidden = false;
    this._loadColumns();
  };

  /** Everything the columns panel says about the selection, as one string.
   *
   *  Only the parts a re-render would change: which signals are registered,
   *  their labels and overrides, and the table-level column choice.
   */
  Measure.prototype._colsSignature = function () {
    const c = this.state.columns || {};
    return JSON.stringify([
      c.x || null, toColumnList(c.y), c.unit || null,
      this.state.signals.map(
        (x) => [x.id, x.name, x.x || null, x.y || null, x.unit || null]),
    ]);
  };

  /** The panel mirrors the selection, so it follows every change to it.
   *
   *  Driven from renderWindows, which every selection change already ends in
   *  and which also runs for things this panel does not show -- so the gate is
   *  the signature, compared against the one the last render drew. Coalesced to
   *  one render per frame, because ticking a branch toggles one signal per leaf.
   */
  Measure.prototype._refreshColumnsPanel = function () {
    const self = this;
    if (this._dead || this._colsRaf) return;
    if (this._colsSignature() === this._colsKey) return;
    const raf = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    this._colsRaf = raf(() => {
      self._colsRaf = null;
      const panel = self.$(".qm-colspanel");
      if (self._dead || !panel || panel.hidden || !self._cols) return;
      // A render of its own in the meantime already showed this selection.
      if (self._colsSignature() === self._colsKey) return;
      // A redraw drops the caret, so focus in the panel or its picker defers it.
      const act = document.activeElement;
      const ypanel = self.$(".qm-ypanel");
      if (act && (panel.contains(act) || (ypanel && ypanel.contains(act)))) return;
      self.renderColumns();
    });
  };

  /** Place the value-column picker under its trigger, in its host's coordinates.
   *
   *  The panel lives beside .qm-colspanel instead of inside it because that
   *  panel is a 34vh scroll box that clipped every row of the list away. Its
   *  host (.qm-work) is the containing block, so the offsets are trigger-rect
   *  minus host-rect; ``position: fixed`` is not an option, because the inline
   *  plot host sits inside the canvas's transformed layer where fixed offsets
   *  resolve against the transform instead of the viewport.
   */
  Measure.prototype._placeYPanel = function () {
    const panel = this.$(".qm-ypanel");
    const btn = this.$(".qm-ycols");
    if (!panel || !btn || panel.hidden) return;
    const host = panel.parentNode;
    if (!host || !host.getBoundingClientRect) return;
    const hr = host.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    panel.style.top = `${br.bottom - hr.top + 4}px`;
    // Clamped so the right edge stays inside the host on a narrow work column.
    const room = hr.width - panel.offsetWidth - 6;
    panel.style.left = `${Math.max(0, Math.min(br.left - hr.left, room))}px`;
  };

  Measure.prototype.renderColumns = function () {
    const self = this;
    const panel = this.$(".qm-colspanel");
    const cols = this._cols || [];
    // This is the panel's only writer, so a render here answers a pending refresh.
    this._colsKey = this._colsSignature();
    if (!cols.length) {
      panel.innerHTML = `<div class="qm-tree-msg">No column list available.</div>`;
      // The picker outlives the panel's body, so an empty list has to close it.
      this._closeYPanel();
      return;
    }
    // X is restricted to time-like columns for now. A non-time X turns the strip
    // into an XY plot, where per-time-bucket aggregation, the range bar and the
    // cursor all stop meaning anything — that is a different plot type, not a
    // column choice. See backlog.md §4 item 9.
    // X candidates: anything that COULD be a clock, time-named ones first.
    // Restricting this to /time|date|ts/ names made the panel useless on the
    // tables that need it most — a column called `booked_at` holding epoch
    // millis was not offered, so "pick a time column as X" had no answer.
    // Any numeric column can be an epoch, and a timestamp type always can.
    const looksTime = (c) =>
      window.QM.COL_TIME_NAME.test(String(c.name)) || c.type === "timestamp";
    // Ordered by the SAME preference the provider uses to detect a time column,
    // because the panel falls back to its first option — and on a table with
    // both `Timestamp` (a raw counter) and `ts_ms` the first option won and
    // disagreed with the column the query was actually using.
    const X_RANK = ["t_abs_ms", "ts_ms", "timestamp", "ts", "time"];
    // RELATIVE time is not a clock. t_rel_ms counts from the start of a file, so
    // its values are small offsets while every range in this view is absolute
    // epoch ms — filtering one against the other matches nothing at all, and the
    // plot goes silently empty. Still offered (someone may want it deliberately)
    // but ranked last so it can never become the default.
    const isRelative = (c) => window.QM.COL_REL_NAME.test(String(c.name));
    const xRank = (c) => {
      if (isRelative(c)) return 40;               // last: offsets, not a clock
      const i = X_RANK.indexOf(String(c.name).toLowerCase());
      if (i >= 0) return i;                       // best: a known clock name
      if (c.type === "timestamp") return 10;      // a real timestamp type
      if (looksTime(c)) return 20;                // time-ish name
      return 30;                                  // any other numeric column
    };
    // Every column is offered for X too, clocks first. Same reasoning as Y: the
    // order decides the default, the list decides what is possible.
    const timeish = cols.slice().sort((a, b) => xRank(a) - xRank(b));

    // EVERY column is offered for Y, measurements first. Filtering the list down
    // to measurements stopped the Y default landing on a clock, but it also hid
    // columns someone may legitimately want to plot — the fix belongs in the
    // ORDER (which decides the default), not in what is available.
    // ONE heuristic, shared with the provider's own value-column fallback
    // (measure-view.js columnRank) — so the panel's first row is exactly the
    // column a fresh node seeds.
    const yRank = (c) => columnRank(c.name, c.type);
    const numeric = cols.slice().sort((a, b) => yRank(a) - yRank(b));
    const d = this.state.columns;

    // A select with nothing matching ``cur`` silently displays its FIRST option,
    // so an unset default read as "t_rel_ms is my Y" while the query actually
    // ran with none — the panel disagreed with the plot. Resolve the effective
    // value here and write it back, so what is shown is what is used.
    const effective = (list, cur, key) => {
      if (cur && list.some((c) => c.name === cur)) return cur;
      const first = list.length ? list[0].name : null;
      if (first && this.state.columns[key] !== first) {
        this.state.columns[key] = first;
        this._colsSeeded = true;
      }
      return first;
    };

    // Y is a LIST, so the same job runs over one: drop names the table no
    // longer has (self-healing on the next open), seed the ranked first when
    // that empties it, and write back — never render an empty plot silently.
    const effectiveYs = (list) => {
      const names = list.map((c) => c.name);
      const cur = toColumnList(this.state.columns.y);
      const keep = cur.filter((name) => names.indexOf(name) >= 0);
      // Seed the way the provider's own fallback seeds (pickValueColumn in
      // measure-lake.js): an exact `value` column first, then the ranked first.
      // Seeding the ranked first alone put the panel on the schema's first
      // numeric column, and the plot that had drawn `value` went flat.
      if (!keep.length && names.length) {
        const exact = names.find((name) => /^value$/i.test(name));
        keep.push(exact || names[0]);
      }
      if (keep.length !== cur.length || keep.some((name, i) => name !== cur[i])) {
        this.state.columns.y = keep;
        this._colsSeeded = true;
      }
      return keep;
    };

    const opts = (list, cur) => list.map((c) =>
      `<option value="${esc(c.name)}"${c.name === cur ? " selected" : ""}>${esc(c.name)}</option>`).join("");

    this._colsSeeded = false;
    const effX = effective(timeish, d.x, "x");
    const picked = effectiveYs(numeric);

    // Unit column. The catalog exposes no per-column units (its /schema returns
    // name/type/nullable only), so the unit has to come from the DATA: on a
    // long/narrow table it is normally a column sitting beside the value.
    // Text columns and partition columns are the candidates.
    const unitCands = cols.filter((c) =>
      c.type !== "numeric" && c.type !== "timestamp" && !/^(__|_)/.test(c.name));
    const unitOpts = `<option value="">(none)</option>` +
      unitCands.map((c) =>
        `<option value="${esc(c.name)}"${c.name === d.unit ? " selected" : ""}>${esc(c.name)}</option>`
      ).join("");

    // Why a column is not a measurement, for the rows ranked below them. The
    // list still offers everything — the order decides the default, the label
    // just says why something is unlikely to be what you want.
    const dimReason = (c) => {
      const rank = yRank(c);
      if (rank >= 40) return "internal bookkeeping column";
      if (rank === 30) return "not numeric";
      if (rank === 25) return "bookkeeping column, not a measurement";
      if (rank === 20) return "a clock, not a measurement";
      return null;
    };
    const yFilter = String(this._yFilter || "").trim().toLowerCase();
    const yRows = numeric.map((c) => {
      const on = picked.indexOf(c.name) >= 0;
      const why = dimReason(c);
      const off = yFilter && String(c.name).toLowerCase().indexOf(yFilter) < 0;
      return `<div class="qm-cprow${why ? " qm-dim" : ""}" data-col="${esc(c.name)}"${
        off ? " hidden" : ""}${why ? ` title="${esc(why)}"` : ""}${
        on && picked.length === 1 ? ` aria-disabled="true"` : ""}>
          <span class="qm-axbox" role="checkbox" tabindex="0"
                aria-checked="${on ? "true" : "false"}"
                data-on="${on ? "1" : "0"}">${on ? "✓" : ""}</span>
          <span class="qm-cpname">${esc(c.name)}</span>
        </div>`;
    }).join("");
    const yLabel = picked.length === 1
      ? picked[0]
      : (picked.length ? picked.length + " columns" : "no columns");
    // What the list changes, said once: it has a single owner now.
    const yNote = "applies to every signal without its own override; " +
      "an overridden signal keeps its single column";

    // View-level, not per column and not per window: one band per layout.
    const envOn = this.state.envelope === true;

    panel.innerHTML = `
      <div class="qm-colrow">
        <span class="qm-collbl">Default X</span>
        <select class="qm-selx">${opts(timeish, effX)}</select>
        <span class="qm-collbl">Value columns</span>
        <button class="qm-ycols" type="button" aria-expanded="${this._yOpen ? "true" : "false"}"
                title="Columns plotted for every signal without its own override">
          <span class="qm-ycount">${esc(yLabel)}</span>
          <span class="qm-caret" aria-hidden="true">▾</span>
        </button>
        <span class="qm-collbl" title="Column holding each signal's engineering unit — read once per signal, not per point">Unit</span>
        <select class="qm-selu">${unitOpts}</select>
        <span class="qm-collbl">Band</span>
        <span class="qm-axbox qm-envelope" role="checkbox" tabindex="0"
              aria-checked="${envOn ? "true" : "false"}"
              data-on="${envOn ? "1" : "0"}"
              title="Shade each pixel's min–max range around the mean line; off shows the mean line only">${envOn ? "✓" : ""}</span>
        <span class="qm-colnote">${esc(yNote)}</span>
      </div>
      <div class="qm-perlist"></div>`;

    panel.querySelector(".qm-selx").addEventListener("change", (ev) => {
      self.state.columns.x = ev.target.value;
      self.persist(); self.renderColumns(); self._scheduleFetch(0);
    });
    // The picker's own slot, OUTSIDE the columns panel: .qm-colspanel is a 34vh
    // scroll box, and a floating list inside it was clipped to its header.
    const ypanel = this.$(".qm-ypanel");
    const ybtn = panel.querySelector(".qm-ycols");
    ypanel.innerHTML = `
      <div class="qm-cphead">
        <span>Value columns</span>
        <button class="qm-cpclose" type="button" title="Close (Esc)">✕</button>
      </div>
      <label class="qm-search">
        <span aria-hidden="true">⌕</span>
        <input type="text" placeholder="Filter columns…" value="${esc(this._yFilter || "")}" />
      </label>
      ${yRows}`;
    const setOpen = (open) => {
      self._yOpen = open;
      ypanel.hidden = !open;
      ybtn.setAttribute("aria-expanded", String(open));
      if (open) self._placeYPanel();
    };
    setOpen(!!this._yOpen);
    ybtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setOpen(ypanel.hidden);
    });
    ypanel.querySelector(".qm-cpclose").addEventListener("click", (ev) => {
      ev.stopPropagation();
      setOpen(false);
    });
    // Filtering is local to the open panel — no persist, no refetch. Kept on the
    // view so the list survives the re-render every tick triggers.
    ypanel.querySelector(".qm-search input").addEventListener("input", (ev) => {
      const q = ev.target.value.trim().toLowerCase();
      self._yFilter = ev.target.value;
      ypanel.querySelectorAll(".qm-cprow").forEach((row) => {
        row.hidden = !!q && String(row.dataset.col).toLowerCase().indexOf(q) < 0;
      });
    });
    ypanel.querySelectorAll(".qm-cprow").forEach((row) => {
      const flip = (ev) => {
        ev.stopPropagation();
        self._toggleValueColumn(row.dataset.col);
      };
      row.addEventListener("click", flip);
      row.querySelector(".qm-axbox").addEventListener("keydown", (ev) => {
        if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); flip(ev); }
      });
    });
    panel.querySelector(".qm-selu").addEventListener("change", (ev) => {
      self.state.columns.unit = ev.target.value || null;
      // Units are per signal and constant, so they are resolved once rather
      // than travelling with every frame. Clear what we cached and re-ask.
      self.state.signals.forEach((s) => { delete s.unit; });
      self.persist();
      self.resolveUnits();
      self.renderColumns();
    });
    // Frames already carry min/max, so flipping the band only needs a redraw.
    const envbox = panel.querySelector(".qm-envelope");
    const flipEnv = (ev) => {
      ev.stopPropagation();
      self.state.envelope = self.state.envelope !== true;
      self.persist(); self.renderColumns(); self.draw();
    };
    envbox.addEventListener("click", flipEnv);
    envbox.addEventListener("keydown", (ev) => {
      if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); flipEnv(ev); }
    });

    // Seeding changed what the query will use, so persist it and refetch —
    // otherwise the panel shows a Y the plot is not actually using.
    if (this._colsSeeded) {
      this._colsSeeded = false;
      this.persist();
      this._scheduleFetch(0);
    }

    const list = panel.querySelector(".qm-perlist");
    if (!this.state.signals.length) {
      list.innerHTML = `<div class="qm-tree-msg">Select signals to override individually.</div>`;
      return;
    }
    // A unit typed per value column belongs to the TABLE, so every channel's
    // sub-row for that column reads the same entry.
    const unitFor = (col) => (self.state.columns.units || {})[col];
    this.state.signals.forEach((sig) => {
      const c = self.columnsFor(sig);
      // The badge promises "reset would change something", and reset restores
      // the automatic name too, so a hand-typed label counts as an override.
      const renamed = String(sig.name || "") !== autoSignalName(sig.id, self.state.table);
      const over = renamed || c.xOverridden || c.yOverridden;
      // The dropdown is a SINGLE-column override, so it only earns its place
      // when there is one column to override or an override already set (to
      // change or undo); with several the sub-rows own the column choice.
      const showY = !!sig.y || picked.length <= 1;
      const ycell = showY ? `<select class="qm-sy">${opts(numeric, c.y)}</select>` : "";
      const row = el(`
        <div class="qm-colrow">
          <span class="qm-swatch" style="background:var(${esc(sig.colorVar)})"></span>
          <input class="qm-collbl qm-signame qm-sname" type="text" value="${esc(sig.name)}"
                 maxlength="40"
                 title="Label for this signal; empty restores the automatic name">
          <select class="qm-sx">${opts(timeish, c.x)}</select>
          ${ycell}
          <span class="qm-ovr" data-ovr="${over ? "yes" : "no"}">${
            over ? "overridden" : "default"}</span>
          <button class="qm-reset" type="button"
                  title="Back to the table default X/Y and the automatic name">reset</button>
        </div>`);
      row.querySelector(".qm-sx").addEventListener("change", (ev) => {
        sig.x = ev.target.value; self.persist(); self.renderColumns(); self._scheduleFetch(0);
      });
      const ysel = row.querySelector(".qm-sy");
      if (ysel) {
        ysel.addEventListener("change", (ev) => {
          sig.y = ev.target.value; self.persist(); self.renderColumns(); self._scheduleFetch(0);
        });
      }
      const namebox = row.querySelector(".qm-sname");
      // A name labels the chip, axis, readout and fan-out traces — never the query.
      namebox.addEventListener("change", (ev) => {
        const typed = String(ev.target.value || "").trim();
        sig.name = typed || autoSignalName(sig.id, self.state.table);
        self.persist();
        self.renderWindows(); self.renderReadout(); self.draw();
        self.renderColumns();
      });
      // Space and Escape are view shortcuts, and a press in the row dismisses open pickers.
      namebox.addEventListener("keydown", (ev) => ev.stopPropagation());
      namebox.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      row.querySelector(".qm-reset").addEventListener("click", () => {
        // Only X/Y feed the query; the name is a label, so restoring it alone
        // relabels the chip, axis and readout without asking for frames again.
        const requery = sig.x != null || sig.y != null;
        delete sig.x; delete sig.y;
        sig.name = autoSignalName(sig.id, self.state.table);
        self.persist();
        self.renderWindows(); self.renderReadout(); self.draw();
        self.renderColumns();
        if (requery) self._scheduleFetch(0);
      });
      list.appendChild(row);

      // One settings sub-row per column this channel resolves to — the same
      // fan-out tracesOf performs, so what the panel shows is what is drawn.
      const subCols = c.ys.length ? c.ys : [null];
      // A unit typed on a channel drawing SEVERAL columns cannot mean the
      // signal: it belongs to the column, on every channel. With one column
      // there is nothing to distinguish, so it stays the signal's own.
      const perColumn = subCols.length > 1;
      subCols.forEach((col) => {
        const eff = (col && unitFor(col)) || sig.unit || "";
        const sub = el(`
          <div class="qm-colrow qm-colsub">
            <span class="qm-colname">${esc(col || "value")}</span>
            <span class="qm-collbl">unit</span>
            <input class="qm-sunit" data-col="${esc(col || "")}" type="text"
                   maxlength="16" value="${esc(eff)}"
                   title="${esc(perColumn
                     ? "Unit for this column on every channel"
                     : "Unit for this signal; empty falls back to the unit column")}">
          </div>`);
        const unitbox = sub.querySelector(".qm-sunit");
        // A unit labels the trace, it is not part of the query: relabel, never refetch.
        unitbox.addEventListener("change", (ev) => {
          const typed = String(ev.target.value || "").trim();
          if (perColumn) {
            const map = self.state.columns.units || (self.state.columns.units = {});
            if (typed) map[col] = typed;
            else delete map[col];
          } else {
            // null, not "": resolveUnits only refills a signal whose unit is unset.
            sig.unit = typed || null;
          }
          self.persist();
          self.renderWindows(); self.renderReadout(); self.draw();
          self.renderColumns();
          // Cleared means "use the unit column", so ask now rather than at the next reload.
          if (!typed && !perColumn) self.resolveUnits();
        });
        // Space and Escape are view shortcuts, and a press in the row dismisses open pickers.
        unitbox.addEventListener("keydown", (ev) => ev.stopPropagation());
        unitbox.addEventListener("pointerdown", (ev) => ev.stopPropagation());
        list.appendChild(sub);
      });
    });
  };

  /** Tick or untick one value column in the table-level selection. */
  Measure.prototype._toggleValueColumn = function (name) {
    if (!name) return;
    const cur = toColumnList(this.state.columns.y);
    const at = cur.indexOf(name);
    if (at < 0) cur.push(name);
    else if (cur.length > 1) cur.splice(at, 1);
    else { this.showFetchError(LAST_COLUMN); return; }
    this.state.columns.y = cur;
    this._clearRefusal();
    // The window heads redraw too: one chip per trace, and traces fan out over these columns.
    this.persist();
    this.renderColumns();
    this.renderWindows();
    this._scheduleFetch(0);
  };

  /** Drop the picker's own refusal message, and only that one — a fetch error
   *  or a cap notice is somebody else's and must survive a tick. */
  Measure.prototype._clearRefusal = function () {
    const bar = this.$(".qm-err");
    if (bar && !bar.hidden && bar.textContent === LAST_COLUMN) {
      this.showFetchError(null);
    }
  };

  // ── tree ────────────────────────────────────────────────

  const showValue = (v) => (v === "__None__" ? "(none)" : v);
  const segsOf = (path) => String(path || "").split("/").filter(Boolean);

  /** The leading segments every root shares — shown once, not repeated per root row. */
  function sharedPrefix(roots) {
    if (roots.length < 2) return [];
    const first = segsOf(roots[0]);
    let n = 0;
    while (n < first.length - 1 && roots.every((r) => segsOf(r)[n] === first[n])) n++;
    return first.slice(0, n);
  }

  /** Root rows for a dataset's folders: label = the values past the shared prefix, seg = the whole path. */
  function rootNodes(roots) {
    const shared = sharedPrefix(roots).length;
    return roots.map((path) => {
      const segs = segsOf(path);
      const last = segs[segs.length - 1] || "";
      const eq = last.indexOf("=");
      return {
        key: eq > 0 ? last.slice(0, eq) : null,
        value: segs.slice(shared).map((seg) => showValue(seg.slice(seg.indexOf("=") + 1))).join(" / ") || path,
        seg: path,
        leaf: false,
        kind: "root",
      };
    });
  }

  Measure.prototype.renderTree = function () {
    const self = this;
    const tree = this.$(".qm-tree");
    this._bsCache = {};        // per-render only — see _branchState. Reset BEFORE
                               // the early return below, or a state cached from a
                               // previous pass outlives the selection it described.
    if (!this._treeRoot) {
      tree.innerHTML = `<div class="qm-tree-msg">Loading partitions…</div>`;
      // Rooted on a dataset's folders: those are the top level, each one a branch
      // whose path is the whole partition path, so children and ids stay lake paths.
      const roots = this.state.roots || [];
      // A root at the deepest partition level has nothing beneath it: it IS the signal, so it
      // draws as a leaf and can be ticked; the rest are branches to unfold.
      const depthP = roots.length && typeof this.provider.partitionColumns === "function"
        ? Promise.resolve(this.provider.partitionColumns()).then((cols) => (cols || []).length).catch(() => 0)
        : Promise.resolve(0);
      const load = roots.length
        ? depthP.then((depth) => rootNodes(roots).map((n) => (depth && segsOf(n.seg).length >= depth
            ? Object.assign(n, { leaf: true, kind: "physical", meta: { name: n.value, unit: "", dec: 3 } })
            : n)))
        : this.provider.children("");
      load.then((kids) => {
        self._treeRoot = kids || [];
        // Opened on leaves with nothing picked yet: plot them, as the dataset meant them.
        const win = self.activeWin();
        const leaves = (kids || []).filter((n) => n.leaf);
        if (roots.length && leaves.length && !(win && win.signalIds.length) && !self.state.signals.length) {
          leaves.forEach((n) => self.toggleSignal(segOf(n), n.meta));
          return;
        }
        self.renderTree();
        // Cold start: revealSelected bails while _treeRoot is null, so a layout
        // applied before the root arrived would sit collapsed. Reveal now that
        // there is a tree to expand.
        self.revealSelected(self.activeWin());
      }).catch((e) => {
        // A refused catalog leaves the structure unknown, which is not an empty tree.
        const msg = String((e && e.message) || e);
        const row = el(`<div class="qm-tree-msg"></div>`);
        row.textContent = "Partition listing failed: " + clip(msg);
        row.title = msg;                 // the untruncated reason, on hover
        tree.innerHTML = "";
        tree.appendChild(row);
        // _treeRoot stays null, so the next render really re-requests the level.
      });
      return;
    }
    // Preserve scroll across re-renders; expansion is preserved by the shared
    // _openMap. Together they mean switching the active window never yanks the
    // tree back to the top or collapses the branches you opened.
    const _scrollTop = tree.scrollTop;
    tree.innerHTML = "";
    const shared = sharedPrefix(this.state.roots || []);
    if (shared.length) {
      // What every root has in common, said once above the tree, values only.
      const cap = el(`<div class="qm-tree-msg qm-roots" title="${esc(shared.join(" / "))}"></div>`);
      cap.textContent = "under " + shared.map((seg) => showValue(seg.slice(seg.indexOf("=") + 1))).join(" / ");
      tree.appendChild(cap);
    }
    tree.appendChild(this._branch(this._treeRoot, ""));
    tree.scrollTop = _scrollTop;
    // The tree selects into ONE window, so say which — otherwise a checkbox
    // that appears to do nothing (because a different window is targeted) is
    // indistinguishable from a bug.
    const win = this.activeWin();
    const box = this.$(".qm-search input");
    const want = (win ? win._filter : this._filter) || "";
    if (box.value !== want) box.value = want;
    this.$(".qm-sb-target").textContent = win ? win.label : "partitions";
    this.$(".qm-count-sig").textContent = win
      ? win.signalIds.length + " in " + win.label
      : "0 selected";
    this.$(".qm-count-win").textContent = this.state.windows.length +
      (this.state.windows.length === 1 ? " window" : " windows");
    this._syncClearBtn();
  };

  /** Expansion state for the partition tree.
   *
   *  SHARED across windows (view-level), not per window: the tree is one view of
   *  the table's partitions, so switching the active window must NOT collapse the
   *  branches you opened — only the checkboxes change to reflect the newly
   *  targeted window's selection. (Fetched children `n._kids` are shared too.)
   */
  Measure.prototype._openMap = function () {
    if (!this._treeOpen) this._treeOpen = {};
    return this._treeOpen;
  };

  Measure.prototype._branch = function (nodes, path) {
    const self = this;
    const open = this._openMap();
    const frag = document.createDocumentFragment();

    // PAGED, because a partition level is not a list a person wrote — it is
    // whatever the lake has, and on a real table that runs to tens or hundreds of
    // thousands of values. Rendering a row each meant one click on such a level
    // built that many DOM subtrees, listeners and closures in one synchronous
    // pass: reported as 15GB of RAM and a locked-up machine, with no way to click
    // anything (including "clear") to get back out. Nothing about that page is
    // usable anyway — the filter box is how you find a signal in 100k of them.
    const active = this.activeWin();
    const filter = (active ? active._filter : this._filter) || "";
    const visible = (nodes || []).filter((n) => !(
      filter && n.leaf &&
      String(n.value).toLowerCase().indexOf(filter) < 0
    ));
    const shownMap = (this._shown = this._shown || {});
    const cap = Math.max(LEVEL_PAGE, shownMap[path] || 0);
    const page = visible.slice(0, cap);

    page.forEach((n) => {
      // ``seg`` is the node's PATH segment, which is not always its label. A
      // lake partition displays as key=value and must also address as
      // "key=value", or the catalog cannot resolve the path and answers with
      // the level above — which renders as a level nested inside itself, and
      // leaves the signal id with no partition filter in it. Providers that
      // address by bare value (the synthetic one) just omit ``seg``.
      const seg = segOf(n);
      const id = path ? path + "/" + seg : seg;

      const isOpen = !!open[id];
      const wrap = document.createElement("div");
      const sel = n.leaf ? (this.isSelected(id) ? "on" : "off") : this._branchState(n, id);
      const mark = sel === "some" ? "–" : sel === "mirror" ? "≡" : "✓";
      const sig = this.state.signals.find((x) => x.id === id);
      // Folder/file icon per kind, Lakehouse-style: a virtual partition (a
      // per-file value index, not a directory) gets the purple folder-star, a
      // physical branch the amber folder, and a leaf the dim file.
      const isVirtual = n.kind === "virtual";
      const fico = isVirtual ? "folder-star" : (n.leaf ? "file" : "folder");
      const ficoCls = isVirtual ? "qm-fico-virtual" : (n.leaf ? "qm-fico-file" : "");
      const row = el(`
        <div class="qm-row${n.leaf ? " qm-leaf" : ""}"${n.leaf ? ' draggable="true"' : ""}>
          <span class="qm-chev">${n.leaf ? "" : (isOpen ? "▾" : "▸")}</span>
          <span class="qm-cb" data-state="${sel}" title="${sel === "mirror" ? "Picked beneath it what its siblings have — tick again for everything under it" : ""}">${mark}</span>
          <span class="qm-fico ${ficoCls}"${isVirtual ? ' title="Virtual partition: a per-file value index, not a directory. Files hold many values, so column statistics cannot be read per value."' : ""} aria-hidden="true">${drawIcon(fico)}</span>
          ${sig ? `<span class="qm-swatch" style="background:var(${esc(sig.colorVar)})"></span>` : ""}
          <span class="qm-pval">${esc(n.value)}</span>
          ${(n.key != null && (isOpen || self._showKeys))
            ? `<span class="qm-pkey-badge${isVirtual ? " qm-virtual" : ""}" title="Partition key">${esc(n.key)}</span>`
            : ""}
          ${n.count != null ? `<span class="qm-count">${esc(n.count)}</span>` : ""}
        </div>`);

      row.querySelector(".qm-cb").addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (n.leaf) self.toggleSignal(id, n.meta);
        else self._toggleBranch(n, id);
      });

      if (n.leaf) {
        row.addEventListener("click", () => self.toggleSignal(id, n.meta));
        // Drag straight onto a window, so a signal can be placed somewhere
        // other than the tree's current target without retargeting first.
        row.addEventListener("dragstart", (ev) => {
          ev.dataTransfer.setData("text/qm-signal", id);
          ev.dataTransfer.effectAllowed = "copy";
          self._dragMeta = n.meta;
        });
      } else {
        row.addEventListener("click", () => {
          if (open[id]) delete open[id];
          else open[id] = true;
          if (open[id] && !n._kids) {
            n._kids = "loading";
            self.provider.children(id).then((kids) => {
              n._kids = kids || [];
              self.renderTree();
            }).catch(() => { n._kids = []; self.renderTree(); });
          }
          self.renderTree();
        });
      }

      wrap.appendChild(row);
      if (!n.leaf && isOpen) {
        const kids = document.createElement("div");
        kids.className = "qm-kids";
        if (n._kids === "loading" || n._kids == null) {
          kids.innerHTML = `<div class="qm-tree-msg">Loading…</div>`;
        } else if (!n._kids.length) {
          kids.innerHTML = `<div class="qm-tree-msg">(empty)</div>`;
        } else {
          kids.appendChild(this._branch(n._kids, id));
        }
        wrap.appendChild(kids);
      }
      frag.appendChild(wrap);
    });

    // What was left out, and the way to see it. Silently truncating would be
    // worse than the freeze: a missing signal reads as missing DATA.
    if (visible.length > page.length) {
      const rest = visible.length - page.length;
      const step = Math.min(LEVEL_PAGE, rest);
      const more = el(`<div class="qm-more" role="button" tabindex="0"
           title="${esc(String(visible.length))} values at this level">
        show ${esc(String(step))} more · ${esc(String(rest))} of ${esc(String(visible.length))} hidden
      </div>`);
      const reveal = () => {
        shownMap[path] = page.length + step;
        self.renderTree();
      };
      more.addEventListener("click", reveal);
      more.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); reveal(); }
      });
      frag.appendChild(more);
    }
    return frag;
  };

  /** Tri-state for a branch, from whatever of its subtree we have loaded.
   *
   *  Cached for the render pass. It walks the ENTIRE loaded subtree and is asked
   *  once per rendered row, so on a deep tree the uncached version was quadratic
   *  — which is CPU, not memory, but it froze the same page just as effectively.
   */
  Measure.prototype._branchState = function (n, path) {
    const cache = (this._bsCache = this._bsCache || {});
    if (cache[path] !== undefined) return cache[path];
    const val = this._branchStateNow(n, path);
    cache[path] = val;
    return val;
  };

  Measure.prototype._branchStateNow = function (n, path) {
    if (!Array.isArray(n._kids) || !n._kids.length) return "off";
    let on = 0, total = 0;
    const walk = (nodes, p) => {
      nodes.forEach((k) => {
        const kid = p + "/" + segOf(k);
        if (k.leaf) { total++; if (this.isSelected(kid)) on++; }
        else if (Array.isArray(k._kids)) walk(k._kids, kid);
      });
    };
    walk(n._kids, path);
    if (!total || !on) return "off";
    if (on === total) return "on";
    // Exactly what the siblings picked beneath themselves: the copy a first tick makes.
    const mirror = this._mirrorIds(path);
    const under = this._selectedUnder(path);
    if (mirror.length && under.length === mirror.length && mirror.every((id) => under.indexOf(id) >= 0)) return "mirror";
    return "some";
  };

  /** The active window's signals beneath ``path``. */
  Measure.prototype._selectedUnder = function (path) {
    const win = this.activeWin();
    return win ? win.signalIds.filter((id) => id.indexOf(path + "/") === 0) : [];
  };

  /** What the siblings of ``path`` (same parent, same key, another value) have selected beneath
   *  themselves, carried over to ``path``: the ids a first tick copies. */
  Measure.prototype._mirrorIds = function (path) {
    const win = this.activeWin();
    if (!win) return [];
    const cut = path.lastIndexOf("/");
    const parent = cut < 0 ? "" : path.slice(0, cut);
    const own = cut < 0 ? path : path.slice(cut + 1);
    const key = own.slice(0, own.indexOf("=") + 1);
    if (!key) return [];
    const prefix = parent ? parent + "/" : "";
    const out = [];
    win.signalIds.forEach((id) => {
      if (id.indexOf(prefix) !== 0) return;
      const rest = id.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) return;
      const seg = rest.slice(0, slash);
      if (seg === own || seg.indexOf(key) !== 0) return;
      const mirrored = path + "/" + rest.slice(slash + 1);
      if (out.indexOf(mirrored) < 0) out.push(mirrored);
    });
    return out;
  };

  /** The loaded node at ``path``, or null; walks root rows whose seg is a whole path. */
  Measure.prototype._findNode = function (path) {
    const parts = segsOf(path);
    let nodes = this._treeRoot;
    let i = 0;
    let found = null;
    while (nodes && i < parts.length) {
      const here = parts.slice(i);
      let hit = null, used = 0;
      for (const n of nodes) {
        const k = segsOf(segOf(n)).length;
        if (k && k <= here.length && here.slice(0, k).join("/") === segOf(n)) { hit = n; used = k; break; }
      }
      if (!hit) return null;
      found = hit;
      i += used;
      nodes = Array.isArray(hit._kids) ? hit._kids : null;
    }
    return i === parts.length ? found : null;
  };

  /** One tick on a branch. A branch with nothing picked whose siblings have picks beneath
   *  themselves takes a copy of those first (the "mirror" mark); the next tick, or the first
   *  when there is nothing to copy, selects everything under it; anything else clears it. */
  Measure.prototype._toggleBranch = function (n, path) {
    if (!Array.isArray(n._kids)) return;
    const self = this;
    const state = this._branchStateNow(n, path);
    if (state === "off") {
      const mirror = this._mirrorIds(path);
      if (mirror.length) {
        // The copied leaves may sit levels down and not be loaded yet.
        const parents = [];
        mirror.forEach((id) => { const p = id.slice(0, id.lastIndexOf("/")); if (parents.indexOf(p) < 0) parents.push(p); });
        return Promise.all(parents.map((p) => self._ensureLoaded(p))).then(() => {
          mirror.forEach((id) => {
            const leaf = self._findNode(id);
            if (leaf && leaf.leaf && !self.isSelected(id)) self.toggleSignal(id, leaf.meta);
          });
          const open = self._openMap();
          open[path] = true;
          self.renderTree();
        });
      }
    }
    // Only an UNSELECTED branch (or one holding just the copy) selects; anything else
    // deselects. It used to be `!== "on"`, so a partially selected branch tried to fill
    // itself in — and with the cap below a big branch can never reach "on", which made the
    // tick permanently one-way: click to select 48, click again to select 48 more, never
    // able to clear it. Escape beats symmetry.
    const turnOn = state === "off" || state === "mirror";
    const leaves = [];
    const walk = (nodes, p) => {
      nodes.forEach((k) => {
        const kid = p + "/" + segOf(k);
        if (k.leaf) leaves.push({ id: kid, meta: k.meta });
        else if (Array.isArray(k._kids)) walk(k._kids, kid);
      });
    };
    walk(n._kids, path);

    // CAPPED on the way in. Every selected signal costs a chip in the window
    // head, a row in the readout, four aggregates in the SQL and a frame of
    // min/max/mean/count arrays — so ticking a branch holding thousands of leaves
    // wedged the page just as hard as rendering them. Deselecting is never
    // capped: getting OUT of a bad state must always work.
    let take = leaves;
    if (turnOn) {
      const room = Math.max(0, MAX_BRANCH_SELECT - this.state.signals.length);
      take = leaves.slice(0, room);
      if (take.length < leaves.length) {
        this.showFetchError("Selected " + take.length + " of " + leaves.length +
          " signals — " + MAX_BRANCH_SELECT + " is the limit for one plot. " +
          "Use the filter box to pick the ones you want.");
      }
    }
    take.forEach((lf) => {
      if (this.isSelected(lf.id) !== turnOn) this.toggleSignal(lf.id, lf.meta);
    });
  };

  Measure.prototype._ensureLoaded = function (path) {
    const self = this;
    const parts = segsOf(path);
    let nodes = this._treeRoot;

    // A root row's seg is a whole path, so a step may consume several parts.
    const step = (i) => {
      if (!nodes || i >= parts.length) return Promise.resolve();
      const here = parts.slice(i);
      let n = null, used = 0;
      for (const x of nodes) {
        const k = segsOf(segOf(x)).length;
        if (k && k <= here.length && here.slice(0, k).join("/") === segOf(x)) { n = x; used = k; break; }
      }
      if (!n || n.leaf) return Promise.resolve();
      const prefix = parts.slice(0, i + used).join("/");
      if (Array.isArray(n._kids)) { nodes = n._kids; return step(i + used); }
      return Promise.resolve(self.provider.children(prefix)).then((kids) => {
        n._kids = kids || [];
        nodes = n._kids;
        return step(i + used);
      }).catch(() => { n._kids = []; });
    };
    return step(0);
  };

  /** Open the branches holding this window's signals, so clicking a subwindow
   *  shows WHAT IS IN IT rather than a collapsed tree you have to re-navigate.
   *  Only ancestors are expanded — the leaves are what we are revealing. */
  Measure.prototype.revealSelected = function (win) {
    const self = this;
    if (!win || !this._treeRoot || !win.signalIds.length) return;
    const open = this._openMap();

    const parents = [];
    win.signalIds.forEach((id) => {
      const parts = String(id).split("/");
      let pre = "";
      for (let i = 0; i < parts.length - 1; i++) {
        pre = pre ? pre + "/" + parts[i] : parts[i];
        if (parents.indexOf(pre) < 0) parents.push(pre);
        open[pre] = true;
      }
    });
    if (!parents.length) return;

    // Re-render once, after every level has arrived — not per fetch.
    Promise.all(parents.map((x) => self._ensureLoaded(x)))
      .then(() => self.renderTree());
  };

})();
