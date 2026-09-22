// ── Measurement view: range navigation, cursors and pointer input ────────────
// Attaches to the same prototype as measure-view.js, which must load first and
// which exposes the constructor on window.QM. Split out of that file to keep
// each module readable; this half is all about MOVING through the data —
// zoom, scroll, fit, the range strip, the cursors, and every pointer gesture.
(function () {
  "use strict";

  const Measure = window.QM.Measure;
  const esc = window.QM.esc;
  const el = window.QM.el;

  // Below this a range is meaningless for any lake. Declared up here because
  // _writeRange clamps with it, and that runs before the old declaration site.
  const MIN_SPAN_MS = 10;

  // ── per-window X range ──────────────────────────────────
  // A window either follows the shared range (win.range absent — the default, so
  // stacked strips stay comparable) or owns its own. Fitting, zooming or
  // scrolling inside an UNLINKED window touches only that window; the same
  // gestures on a linked window move the shared range as before.

  /** The range a window actually draws — its own, or the shared one. */
  Measure.prototype.rangeOf = function (win) {
    if (win && win.range) return win.range;
    return { t0: this.state.t0, t1: this.state.t1 };
  };

  Measure.prototype.isXLinked = function (win) { return !(win && win.range); };

  /** Give a window its own range, seeded from what it currently shows so
   *  unlinking never makes the view jump. */
  Measure.prototype.unlinkX = function (win) {
    if (!win || win.range) return;
    const r = this.rangeOf(win);
    win.range = { t0: r.t0, t1: r.t1 };
  };

  Measure.prototype.relinkX = function (win) {
    if (win) delete win.range;
  };

  /** Write a range to the right owner: the window if it is unlinked, the shared
   *  state otherwise. Every navigation path goes through here. */
  Measure.prototype._writeRange = function (win, t0, t1) {
    // Normalise here, because this is the ONE place every range write goes
    // through. A range whose end preceded its start rendered as an axis running
    // backwards (observed: "18:45:51 → 17:10:30" at 56,698,266 ms/px) and every
    // query built from it asked for an empty interval. Reject non-finite values
    // for the same reason: they come from an extent computed over the wrong
    // column, and NaN spreads silently through every later calculation.
    let a = Number(t0), b = Number(t1);
    if (!isFinite(a) || !isFinite(b)) return;
    if (b < a) { const t = a; a = b; b = t; }
    if (b - a < MIN_SPAN_MS) b = a + MIN_SPAN_MS;
    if (win && win.range) { win.range.t0 = a; win.range.t1 = b; }
    else { this.state.t0 = a; this.state.t1 = b; }
  };

  /** Cache key for a range + resolution, so two windows showing the same range
   *  share one fetch instead of querying the lake twice. */
  Measure.prototype.rangeKey = function (win) {
    const r = this.rangeOf(win);
    return Math.round(r.t0) + "|" + Math.round(r.t1) + "|" + this.bucketsFor();
  };

  /** Frames are stored PER WINDOW, not per range key. Keying by range meant a
   *  zoom orphaned them the instant the range moved, so the plot blanked until
   *  the refetch landed — the opposite of repainting from what we already hold.
   *  The fetch groups by range to avoid duplicate queries, then fans the result
   *  out to every window in the group. */
  Measure.prototype.framesFor = function (win) {
    return (win && this.frames[win.id]) || {};
  };

  /** The range a window's frames actually cover.
   *
   *  Falls back to the visible range, which is the right answer whenever the two
   *  agree — that is, whenever no re-query is in flight — and keeps providers that
   *  never report a span (the synthetic one) behaving exactly as before.
   */
  Measure.prototype.frameSpanFor = function (win) {
    const got = win && this.frameSpan && this.frameSpan[win.id];
    return got && got.t1 !== got.t0 ? got : this.rangeOf(win);
  };

  Measure.prototype.zoom = function (kind, win) {
    const r = this.rangeOf(win);
    if (kind === "out") this.zoomAt(r.t0 + (r.t1 - r.t0) / 2, 2, win);
    else if (kind === "fit") this.fit(win);
  };

  /** Fit to all data. Without a window this is the GLOBAL fit, which also
    *  re-links every window so the whole page shares one range again. */
  Measure.prototype.fit = function (win) {
    // No metadata bounds (the usual case on a lake — see measure-lake.js
    // loadBounds) so derive the range from the SELECTION instead. That query is
    // filtered to the chosen partitions, so it prunes to a few files rather
    // than scanning the table, which is what makes fit affordable at all.
    if (!this.cfg.bounds) return this._fitToExtent(win);
    const relinked = !win;
    if (relinked) this.state.windows.forEach((w) => this.relinkX(w));
    this._writeRange(win, this.cfg.bounds[0], this.cfg.bounds[1]);
    this.clampCursors();
    // Re-linking changes the per-window x badges, so the headers have to be
    // re-rendered — otherwise a window reads "x own" while following the shared
    // range, which is worse than no badge at all.
    if (relinked) this.renderWindows();
    this.draw();
    this._scheduleFetch(0);
  };

  /** Fit from the data's own extent rather than table bounds.
   *
   *  ``win`` omitted means every selected signal across every window, and the
   *  windows re-link so they stay comparable — the same contract as fit().
   *  Never calls back into autoFit: autoFit falls back to fit on failure, and
   *  the pair would bounce.
   */
  Measure.prototype._fitToExtent = function (win) {
    const self = this;
    if (!this.provider.extent) return;
    const ids = win
      ? (win.signalIds || [])
      : this.state.windows.reduce((acc, w) => {
        (w.signalIds || []).forEach((id) => { if (acc.indexOf(id) < 0) acc.push(id); });
        return acc;
      }, []);
    if (!ids.length) return;

    const relinked = !win;
    this.root.classList.add("qm-busy");
    Promise.resolve(this.provider.extent(ids, { cols: this.colsFor(ids) }))
      .then((ex) => {
        if (!ex || ex.t1 <= ex.t0) {
          // Reaching here means the query SUCCEEDED and returned no rows — a
          // failure throws and is reported below with its real cause. Saying
          // both at once ("found no data — the lake did not answer") named two
          // opposite diagnoses and told the user nothing.
          self.showFetchError(
            "Fit: the lake reports no rows for the selected signals. " +
            "Check the X column is the right time column for this table.");
          return;
        }
        self.showFetchError(null);
        const pad = (ex.t1 - ex.t0) * 0.02;
        if (relinked) self.state.windows.forEach((w) => self.relinkX(w));
        self._writeRange(win, ex.t0 - pad, ex.t1 + pad);
        self.clampCursors();
        if (relinked) self.renderWindows();
        self.draw();
        self._scheduleFetch(0);
      })
      .catch((e) => {
        self.showFetchError("Fit failed: " + String((e && e.message) || e));
      })
      .then(() => self.root.classList.remove("qm-busy"));
  };


  /** Scale the range by ``k`` about ``anchor``, keeping the anchored instant
   *  under the same pixel. k > 1 zooms out, k < 1 zooms in.
   *
   *  This is the interaction the whole feature exists for: changing the range
   *  changes the QUERY, not just the view, so it always ends in a refetch.
   */
  Measure.prototype.zoomAt = function (anchor, k, win) {
    const r = this.rangeOf(win);
    const span = r.t1 - r.t0;
    const frac = span ? (anchor - r.t0) / span : 0.5;
    let next = Math.max(MIN_SPAN_MS, span * k);

    const b = this.cfg.bounds;
    if (b) next = Math.min(next, b[1] - b[0]);

    let t0 = anchor - frac * next;
    let t1 = t0 + next;
    if (b) {
      if (t0 < b[0]) { t0 = b[0]; t1 = t0 + next; }
      if (t1 > b[1]) { t1 = b[1]; t0 = t1 - next; }
    }
    this._writeRange(win, t0, t1);
    this.clampCursors();
    // Repaint from the frames already in hand on the next frame, then refine at
    // the new resolution when the debounce settles. Without this, a drag looked
    // frozen until the fetch landed — the motion has to track the pointer.
    this.scheduleDraw();
    this._scheduleFetch();
  };

  /** Set the visible range outright, clamped to the data bounds. */
  Measure.prototype.setRange = function (t0, t1, win) {
    let a = Math.min(t0, t1), b = Math.max(t0, t1);
    if (b - a < MIN_SPAN_MS) b = a + MIN_SPAN_MS;
    const bd = this.cfg.bounds;
    if (bd) {
      a = Math.max(bd[0], a);
      b = Math.min(bd[1], b);
      if (b - a < MIN_SPAN_MS) return;
    }
    this._writeRange(win, a, b);
    this.clampCursors();
    this.draw();
    this._scheduleFetch(0);
  };

  /** Shift the range by a whole number of milliseconds, clamped to bounds. */
  Measure.prototype.panBy = function (dt, win) {
    const r = this.rangeOf(win);
    const span = r.t1 - r.t0;
    let t0 = r.t0 + dt;
    const b = this.cfg.bounds;
    if (b) t0 = Math.max(b[0], Math.min(b[1] - span, t0));
    this._writeRange(win, t0, t0 + span);
    this.clampCursors();
    this.scheduleDraw();         // same reason as zoomAt: track the pointer
    this._scheduleFetch();
  };

  /** Drag the lit block to scroll. The strip is the only thing that shows
   *  WHERE you are in the measurement — zoom alone hides that entirely. */
  /** Wire a scroll strip to a window's range.
   *
   *  ``winOf()`` says whose range it moves: the strip under the workspace follows
   *  the ACTIVE window, while a per-subwindow strip is fixed to its own. Both go
   *  through _writeRange, so scrolling a window that shares the X axis moves its
   *  partners with it and scrolling an unlinked one leaves them alone — the same
   *  rule as every other navigation.
   */
  Measure.prototype._bindStripTo = function (strip, blockSel, winOf) {
    const self = this;
    let dragging = false, grabDx = 0;

    const bounds = () => this.cfg.bounds || [this.state.t0, this.state.t1];

    const scrollTo = (clientX, useGrab) => {
      const b = bounds();
      const full = b[1] - b[0];
      const r = strip.getBoundingClientRect();
      if (!r.width || full <= 0) return;
      const win = winOf();
      const rg = self.rangeOf(win);
      const span = rg.t1 - rg.t0;
      // Position the window's LEFT edge, preserving where inside the block the
      // pointer grabbed it, so the block doesn't jump under the cursor.
      const frac = (clientX - r.left -
        (useGrab ? grabDx : (span / full) * r.width / 2)) / r.width;
      const t0 = Math.max(b[0], Math.min(b[1] - span, b[0] + frac * full));
      self._writeRange(win, t0, t0 + span);
      self.clampCursors();
      // Repaint from the frames in hand — they now know which range they cover,
      // so held data slides instead of stretching — then refine when the
      // debounce settles.
      self.scheduleDraw();
      self._scheduleFetch();
    };

    strip.addEventListener("pointerdown", (ev) => {
      const block = strip.querySelector(blockSel).getBoundingClientRect();
      const inside = ev.clientX >= block.left && ev.clientX <= block.right;
      grabDx = inside ? ev.clientX - block.left : 0;
      dragging = true;
      try { strip.setPointerCapture(ev.pointerId); } catch (e) { /* no capture */ }
      scrollTo(ev.clientX, inside);
      ev.preventDefault();
      ev.stopPropagation();
    });
    strip.addEventListener("pointermove", (ev) => {
      if (dragging) scrollTo(ev.clientX, true);
    });
    const stop = () => { dragging = false; };
    strip.addEventListener("pointerup", stop);
    strip.addEventListener("pointercancel", stop);
  };

  Measure.prototype._bindRangeStrip = function () {
    const self = this;
    this._bindStripTo(this.$(".qm-rangestrip"), ".qm-rangewin",
      () => self.activeWin());
  };

  /** Per-subwindow scroll strip: same control, its own window. Stacked strips
   *  can hold different ranges, so "where am I in the measurement" is a
   *  per-window question and the answer belongs under each plot. */
  Measure.prototype._bindWinStrip = function (win, strip) {
    this._bindStripTo(strip, ".qm-winwin", () => win);
  };

  /** Position one strip's lit block: the visible range inside the whole
   *  measurement. Shared by both kinds of strip. */
  Measure.prototype._syncStripBlock = function (block, rg) {
    const b = this.cfg.bounds;
    if (!block) return;
    if (!b || b[1] <= b[0]) { block.style.left = "0%"; block.style.width = "100%"; return; }
    const full = b[1] - b[0];
    const left = Math.max(0, Math.min(100, ((rg.t0 - b[0]) / full) * 100));
    const width = Math.max(1.2, Math.min(100 - left, ((rg.t1 - rg.t0) / full) * 100));
    block.style.left = left + "%";
    block.style.width = width + "%";
  };

  /** Is there anywhere for this window to scroll to?
   *
   *  At full extent the lit block fills the whole strip and dragging it cannot
   *  move anything. A control that cannot do anything is not a control, it is a
   *  bar sitting between two plots — which is exactly how it was reported.
   */
  Measure.prototype._canScroll = function (win) {
    const b = this.cfg.bounds;
    if (!b || b[1] <= b[0]) return false;
    const rg = this.rangeOf(win);
    return (rg.t1 - rg.t0) < (b[1] - b[0]) * 0.999;
  };

  Measure.prototype._syncRangeStrip = function () {
    // The workspace strip shows the ACTIVE window's range — with windows unlinked
    // there is no single "the" range to display, which is exactly why each window
    // now carries its own strip too.
    const active = this.activeWin();
    this._syncStripBlock(this.$(".qm-rangewin"), this.rangeOf(active));
    // Same rule as the per-window strips: while the whole measurement is on
    // screen this cannot scroll anywhere, so it is 16px of full-width bar that
    // does nothing. Both strips were reported as exactly that.
    const ws = this.$(".qm-rangestrip");
    if (ws) ws.hidden = !this._canScroll(active);
    this.state.windows.forEach((w) => {
      if (!w._node) return;
      const strip = w._node.querySelector(".qm-winstrip");
      if (!strip) return;
      this._syncStripBlock(strip.querySelector(".qm-winwin"), this.rangeOf(w));
      // Only there while it has a job: it appears when you zoom in and gives the
      // height back when you are looking at everything.
      strip.hidden = !this._canScroll(w);
    });
  };

  /** Find where a window's signals actually have data, then fit to it.
   *
   *  The range is global to the node (one measurement time base), so this moves
   *  every window — the button is labelled to say so. Giving each window its own
   *  X range would break the shared axis that makes stacked strips comparable.
   */
  Measure.prototype.autoFit = function (win) {
    const self = this;
    if (!win || !win.signalIds.length) return;
    if (!this.provider.extent) return this.fit(win);
    Promise.resolve(this.provider.extent(win.signalIds,
      { cols: this.colsFor(win.signalIds) })).then((ex) => {
      if (!ex || ex.t1 <= ex.t0) return;
      const pad = (ex.t1 - ex.t0) * 0.02;
      // Fitting ONE window gives that window its own range — otherwise every
      // other strip jumps to a range chosen for signals it does not show.
      self.unlinkX(win);
      self._writeRange(win, ex.t0 - pad, ex.t1 + pad);
      self.clampCursors();
      self.renderWindows();
      self.draw();
      self._scheduleFetch(0);
    }).catch(() => self.fit(win));
  };

  Measure.prototype.clampCursors = function () {
    const s = this.state;
    // Clamp to the widest range on screen: a cursor legitimately sits outside an
    // individual window's range once windows are unlinked.
    let lo = s.t0, hi = s.t1;
    s.windows.forEach((w) => {
      const r = this.rangeOf(w);
      if (r.t0 < lo) lo = r.t0;
      if (r.t1 > hi) hi = r.t1;
    });
    const fix = (t) => t == null ? null : Math.max(lo, Math.min(hi, t));
    // Skip anything that is not a pair rather than throwing on it: clamping runs
    // on every zoom and drag, so one malformed entry would break navigation
    // outright instead of degrading.
    const pair = (p) => {
      if (!p || typeof p !== "object") return;
      p.a = fix(p.a);
      p.b = fix(p.b);
    };
    pair(s.cursor.shared);
    Object.keys(s.cursor.own).forEach((k) => pair(s.cursor.own[k]));
  };

  Measure.prototype._bindPlot = function (win, canvas, geomKey) {
    const self = this;
    const gk = geomKey || win.id;   // standard mode draws the same window at a
                                    // different width, so geometry is keyed
                                    // separately from the window identity
    let mode = null;          // "pan" | "sweep" | "band" | "moveA" | "moveB"
    let panFrom = 0;
    let downX = 0;            // press point — tells a click (place cursor) from a drag (pan)
    let moved = false;

    const timeAt = (ev) => {
      const g = self.geom[gk];
      const rg = self.rangeOf(win);
      const r = canvas.getBoundingClientRect();
      if (!g || !g.w) return rg.t0;
      const frac = (ev.clientX - r.left - g.padL) / g.w;
      return rg.t0 + Math.max(0, Math.min(1, frac)) * (rg.t1 - rg.t0);
    };

    const msPerPx = () => {
      const g = self.geom[gk];
      const rg = self.rangeOf(win);
      return g && g.w ? (rg.t1 - rg.t0) / g.w : 0;
    };

    canvas.addEventListener("pointerdown", (ev) => {
      self.focus(win.id);
      // Gesture map, checked in this order — navigation modifiers win over the
      // cursor so a drag never means two things at once:
      //   shift + drag        -> scroll (pan) the time range
      //   ctrl/⌘ + drag       -> rubber-band: pick a range, applied on release
      //   alt/⌥ + drag        -> MEASURE: cursor A at the press, B follows
      //   middle drag         -> scroll (pan) the time range
      //   press ON a cursor   -> drag THAT cursor alone, leaving the other put
      //   plain drag elsewhere-> PAN the time range (like the node canvas) —
      //                          UNLESS the diff cursor is on, when it MEASURES
      //                          an interval (A at the press, B follows)
      //   plain click (no drag)-> drop cursor A where you clicked
      // Grabbing a cursor matters: without it, every press collapsed both onto
      // the pointer, so a measured interval could never be nudged — only
      // re-measured from scratch.
      // shift+drag SCROLLS. It used to zoom continuously about the press point,
      // which is a scale, and reaching for shift to travel along the recording
      // instead changed the magnification: "shift+drag ... is scaling, not
      // scrolling". Dragging to zoom is still there as ctrl/⌘+drag, which picks a
      // range explicitly and applies it on release, and ctrl/⌘+wheel zooms about
      // the pointer.
      //
      // The diff sweep has its OWN modifier now. It used to be a plain drag while
      // diff mode was on, which collided with the range-zoom in the worst way:
      // both are "press, drag sideways, release", they look identical while you
      // are doing them, and on a Mac ⌘ is the modifier your hand reaches for — so
      // an attempt to measure an interval zoomed the plot instead. Two gestures
      // that produce a horizontal band must not differ only by which modifier you
      // happened to be holding, so measuring is alt/⌥+drag and is explicit.
      //
      // A plain drag now PANS and never disturbs the cursors; a plain click (a
      // press with no drag) drops cursor A, so an interval you just measured
      // survives until you deliberately click.
      const grabbed = self._cursorAt(win, ev, gk);
      mode = ev.button === 1 ? "pan"
           : ev.shiftKey ? "pan"
           : (ev.ctrlKey || ev.metaKey) ? "band"
           : ev.altKey ? "sweep"
           : grabbed ? ("move" + grabbed)
           : self.state.diff ? "sweep"    // diff cursor on = MEASURE: drag draws A→B
           : "pan";                       // otherwise a plain drag PANS; a click places the cursor
      panFrom = ev.clientX;
      downX = ev.clientX;
      moved = false;
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* no capture */ }
      canvas.style.cursor = mode === "pan" ? "grabbing" : "crosshair";
      if (mode === "band") {
        const t = timeAt(ev);
        self.state.band = { t0: t, t1: t, win: win.id };
        self.draw();
      }
      if (mode === "moveA" || mode === "moveB") {
        // Nothing to reset — the grabbed cursor simply follows from here.
      } else if (mode === "sweep") {
        // Asking for an interval is asking for the Δ, so the sweep turns the diff
        // cursor on rather than making you find the toolbar button first.
        if (!self.state.diff) self.setDiff(true);
        const t = timeAt(ev);
        self.setCursor(win, t);    // A anchors here...
        self.setCursorB(win, t);   // ...and B starts collapsed onto it
        self.draw();
      }
      ev.preventDefault();
    });

    canvas.addEventListener("pointermove", (ev) => {
      if (!mode) {
        // Not dragging: track the pointer for the hover readout and show when a
        // cursor is grabbable.
        self.state.hover = timeAt(ev);
        canvas.style.cursor = self._cursorAt(win, ev, gk) ? "ew-resize" : "crosshair";
        // Coalesced, not immediate: pointermove fires per frame or faster, and a
        // synchronous repaint here re-ran the whole renderer — and reallocated
        // every strip's bitmap — for each event. See scheduleDraw.
        self.scheduleDraw();
        return;
      }
      if (mode === "moveA") {
        self.setCursor(win, timeAt(ev));
        self.scheduleDraw();
      } else if (mode === "sweep" || mode === "moveB") {
        self.setCursorB(win, timeAt(ev));   // A stays put
        self.scheduleDraw();
      } else if (mode === "band") {
        if (self.state.band) {
          self.state.band.t1 = timeAt(ev);
          self.trackHover(self.state.band.t1);
        }
      } else {
        const dx = ev.clientX - panFrom;
        panFrom = ev.clientX;
        if (Math.abs(ev.clientX - downX) > 3) moved = true;
        if (dx) self.panBy(-dx * msPerPx(), win);
        self.trackHover(timeAt(ev));
      }
    });

    const end = (ev) => {
      if (!mode) return;
      if (mode === "pan" && ev.type === "pointerup" && !moved) {
        // A click, not a drag: drop cursor A where you clicked. A drag pans
        // now, so this keeps the measurement cursor a single click away.
        self.setCursor(win, timeAt(ev));
        self.draw();
      }
      if (mode === "sweep" && ev.type === "pointerup") {
        self.setCursorB(win, timeAt(ev));
        self.draw();
      }
      if (mode === "band") {
        const b = self.state.band;
        self.state.band = null;
        // Ignore a stray click or a band thinner than the floor span, which
        // would otherwise zoom to nothing.
        if (b && ev.type === "pointerup" && Math.abs(b.t1 - b.t0) > MIN_SPAN_MS) {
          self.setRange(Math.min(b.t0, b.t1), Math.max(b.t0, b.t1), win);
        } else {
          self.draw();
        }
      }
      mode = null;
      canvas.style.cursor = "crosshair";
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);

    canvas.addEventListener("pointerleave", () => {
      if (mode) return;                 // keep it while a drag is in flight
      self.state.hover = null;
      self.draw();
    });

    // Wheel gesture map — the node canvas's own split (canvas-render.js:1540):
    //   ctrl/⌘ + wheel      -> ZOOM about the pointer
    //   plain wheel         -> PAN along time
    //   shift + wheel       -> PAN (Chrome reports it as deltaX, Firefox keeps
    //                          deltaY, and a plain wheel pans, so no branch)
    //   horizontal deltaX   -> PAN (trackpad two-finger swipe)
    // A bare wheel used to zoom, contradicting both the canvas and this file's
    // own gesture map, and leaving a Windows mouse — no deltaX, no horizontal
    // wheel — no way to travel along the recording at all. Zoom step is
    // 1.1 ** zoomAccel from the "Zoom wheel sensitivity" slider, the same source
    // and value canvas-render.js uses; a macOS trackpad pinch arrives as
    // ⌘/ctrl+wheel with a vertical delta, so pinch-to-zoom needs nothing extra.
    // Deltas are normalised to pixels first (qmWheelDeltaPx): a line-mode device
    // reports ~3 per notch, and both branches read the raw number.
    canvas.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      self.focus(win.id);
      const accel = (typeof getSetting === "function")
        ? getSetting("zoomAccel", 1.0) : 1.0;
      const g = self.geom[gk];
      const wpx = (g && g.w) || canvas.clientWidth || 1;
      const d = qmWheelDeltaPx(ev, wpx, canvas.clientHeight || wpx);
      if (ev.ctrlKey || ev.metaKey) {
        if (!d.y) return;
        const step = qmWheelZoomStep(accel);
        // zoomAt multiplies the SPAN, so step > 1 zooms out: scrolling down zooms
        // out and up zooms in — the same direction as the canvas.
        // The window under the pointer, like the pan branch — it may draw its own range.
        self.zoomAt(timeAt(ev), d.y > 0 ? step : 1 / step, win);
        return;
      }
      // Whichever axis the device is actually reporting on: a mouse only ever
      // moves deltaY, a trackpad swipe moves deltaX.
      const px = Math.abs(d.x) > Math.abs(d.y) ? d.x : d.y;
      if (!px) return;
      const r = self.rangeOf(win);
      const dt = qmWheelPan(px, (r.t1 - r.t0) / wpx, accel);
      if (dt) self.panBy(dt, win);
    }, { passive: false });

    canvas.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      self.fit(win);          // double-click fits the window you clicked
    });
  };

  /** The {a, b} pair this window reads — shared, or its own. */
  /** A window accepts a signal dragged from the tree. */
  Measure.prototype._bindDrop = function (win, node) {
    const self = this;
    const has = (ev) => Array.prototype.indexOf.call(
      ev.dataTransfer.types || [], "text/qm-signal") >= 0;

    node.addEventListener("dragover", (ev) => {
      if (!has(ev)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
      node.classList.add("qm-dropok");
    });
    node.addEventListener("dragleave", () => node.classList.remove("qm-dropok"));
    node.addEventListener("drop", (ev) => {
      node.classList.remove("qm-dropok");
      const id = ev.dataTransfer.getData("text/qm-signal");
      if (!id) return;
      ev.preventDefault();
      // Add to THIS window regardless of which one the tree is targeting, and
      // leave the target alone — dropping is a placement, not a mode change.
      if (win.signalIds.indexOf(id) < 0) {
        self._register(id, self._dragMeta);
        win.signalIds.push(id);
        self.persist();
        self.renderTree();
        self.renderWindows();
        self._scheduleFetch(0);
      }
    });
  };

  Measure.prototype._cursorAt = function (win, ev, geomKey) {
    const g = this.geom[geomKey || win.id];
    if (!g || !g.w) return null;
    const s = this.state;
    const rg = this.rangeOf(win);
    const span = (rg.t1 - rg.t0) || 1;
    const r = (win._canvas || {}).getBoundingClientRect
      ? win._canvas.getBoundingClientRect() : { left: 0 };
    const px = ev.clientX - r.left;
    const xOf = (t) => g.padL + ((t - rg.t0) / span) * g.w;
    const cur = this.cursorsOf(win);
    const TOL = 6;

    // B first: when the two coincide, grabbing B is the useful default — A is
    // where you started measuring from.
    if (s.diff && cur.b != null && Math.abs(px - xOf(cur.b)) <= TOL) return "B";
    if (cur.a != null && Math.abs(px - xOf(cur.a)) <= TOL) return "A";
    return null;
  };

  Measure.prototype.cursorsOf = function (win) {
    const s = this.state;
    if (!win || win.scope !== "own") return s.cursor.shared;
    // Must be an OBJECT, not merely truthy: a stray number here (or a payload
    // from an older build) passed a plain falsy check and was handed back, so
    // the next `.a = …` threw and took zoom and the cursor drag with it.
    const cur = s.cursor.own[win.id];
    if (!cur || typeof cur !== "object") {
      s.cursor.own[win.id] = typeof cur === "number"
        ? { a: cur, b: s.cursor.shared.b }        // salvage the one time we have
        : { a: s.cursor.shared.a, b: s.cursor.shared.b };
    }
    return s.cursor.own[win.id];
  };

  /** Cursor A only — kept as its own name because it is the one being dragged. */
  Measure.prototype.cursorOf = function (win) {
    return this.cursorsOf(win).a;
  };

  Measure.prototype.setCursor = function (win, t) {
    this.cursorsOf(win).a = t;
  };

  Measure.prototype.setCursorB = function (win, t) {
    this.cursorsOf(win).b = t;
  };

  /** Link or unlink every window's cursor at once. */
  Measure.prototype.setAllScope = function (scope) {
    const s = this.state;
    s.windows.forEach((w) => {
      if (scope === "own" && w.scope !== "own") {
        // Seed the private pair from the shared one so unlinking doesn't jump
        // the cursor to a different instant.
        s.cursor.own[w.id] = { a: s.cursor.shared.a, b: s.cursor.shared.b };
      }
      w.scope = scope;
    });
    this.persist();
    this.renderWindows();
    this.draw();
  };

  /** Reflect cursor-link state: all / none / mixed. */
  Measure.prototype._syncToolbar = function () {
    const wins = this.state.windows;
    const shared = wins.filter((w) => w.scope === "shared").length;
    const state = !wins.length ? "none"
      : shared === wins.length ? "all"
      : shared === 0 ? "none" : "mixed";
    const btn = this.$(".qm-linktog");
    btn.dataset.state = state;
    this.$(".qm-linklbl").textContent =
      state === "all" ? "shared cursor"
      : state === "none" ? "cursors unlinked"
      : "cursors mixed";
    btn.title = state === "all"
      ? "Shared cursor — click to unlink every window"
      : "Click to link every window to one time base";
  };

  /** Keep the hover indicator under the physical pointer, then redraw.
   *
   *  During a zoom or pan the RANGE moves, so a hover time left frozen maps to a
   *  drifting pixel — the line and its value flags slide across the plot as if
   *  something were dragging them. Re-deriving the time from the pointer after
   *  the range update pins the indicator to the mouse, where it belongs, and
   *  keeps the values live while navigating.
   *
   *  Note the measurement cursors do NOT do this on purpose: they are anchored
   *  to an instant, so their pixel position moving under a zoom is correct.
   */
  Measure.prototype.trackHover = function (t) {
    this.state.hover = t;
    this.scheduleDraw();          // called from pointermove — see scheduleDraw
  };

})();
