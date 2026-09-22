// ── Measurement strip renderer ─────────────────────────────
// Canvas drawing + the bucket-aggregation maths behind it. Deliberately free
// of DOM ownership and app state: hand it a canvas, a list of signal frames
// and a cursor, get back the geometry it drew with. The view layer
// (measure-view.js) owns everything else.
//
// A "frame" is one signal reduced to the plot's pixel width:
//   { min: [], max: [], mean: [], count: [] }   // one entry per bucket
// The real series endpoint will return exactly this shape, so the renderer
// never sees raw samples and never has to care where they came from.
//
// WHY min/max AND mean: averaging a bucket hides transients, and hunting
// transients is most of what measurement work is. A strip asked for the band
// (``opts.envelope: true``) draws the min–max range as a shaded area with the
// mean as a line inside it, so a spike that lives in a single sample still
// shows up as a tall band. The band is OPT-IN: without it a strip draws mean
// lines alone, which is the readable default once several signals overlap.

// ── aggregation ───────────────────────────────────────────

/** Reduce a raw sample array to ``buckets`` min/max/mean/count entries. */
// A plot inside a canvas node is read and drawn as if its node filled this much of the view.
const QM_VIEW_SHARE = 0.7;
const QM_BITMAP_MAX = 8192;  // The widest bitmap a node plot is given, whatever the view.

/** The width, in screen pixels, a node plot would have with its node zoomed to fill 70% of the view. */
function qmReferenceWidth() {
  const vw = (typeof window !== "undefined" && window.innerWidth) || 1600;
  return Math.max(300, Math.round(vw * QM_VIEW_SHARE));
}

/** The box a node plot is drawn in: its layout size, and a bitmap scale that holds the reference resolution. */
function qmBoxFor(el, refW) {
  const w = Math.max(1, el.clientWidth || (el.parentElement && el.parentElement.clientWidth) || 1);
  const h = Math.max(1, el.clientHeight || (el.parentElement && el.parentElement.clientHeight) || 1);
  const dpr = Math.max(1, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
  const scale = Math.min(QM_BITMAP_MAX / w, Math.max(1, refW / w) * dpr);
  return { w, h, scale };
}

function qmBucketize(values, buckets) {
  const n = values.length;
  const out = { min: [], max: [], mean: [], count: [] };
  if (!n || buckets < 1) return out;
  const per = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * per);
    const e = Math.min(n, Math.max(s + 1, Math.floor((b + 1) * per)));
    let lo = Infinity, hi = -Infinity, sum = 0, cnt = 0;
    for (let i = s; i < e; i++) {
      const v = values[i];
      if (v == null || !isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v;
      cnt++;
    }
    out.min.push(cnt ? lo : NaN);
    out.max.push(cnt ? hi : NaN);
    out.mean.push(cnt ? sum / cnt : NaN);
    out.count.push(cnt);
  }
  return out;
}

/** Exact min/max/mean over a whole frame.
 *
 * The mean is COUNT-WEIGHTED, which is what makes it exact rather than an
 * average of averages: buckets at the edges of a range routinely hold fewer
 * samples than the ones in the middle. This is also why ``count`` is not
 * optional in the frame contract — without it the readout would quietly lie.
 */
function qmRangeStats(frame) {
  let lo = Infinity, hi = -Infinity, num = 0, den = 0;
  const n = frame && frame.mean ? frame.mean.length : 0;
  for (let i = 0; i < n; i++) {
    const c = frame.count[i] || 0;
    if (!c) continue;
    if (frame.min[i] < lo) lo = frame.min[i];
    if (frame.max[i] > hi) hi = frame.max[i];
    num += frame.mean[i] * c;
    den += c;
  }
  if (!den) return { min: NaN, max: NaN, mean: NaN, count: 0 };
  return { min: lo, max: hi, mean: num / den, count: den };
}

/** Exact min/max/mean over a SLICE of a frame, between two fractions.
 *
 *  Same count-weighted maths as qmRangeStats, restricted to the buckets between
 *  the two cursors — so "what did this signal do between A and B" costs nothing
 *  beyond the frame already on screen. Fractions may arrive in either order.
 */
function qmSpanStats(frame, fracA, fracB) {
  const n = frame && frame.mean ? frame.mean.length : 0;
  if (!n) return { min: NaN, max: NaN, mean: NaN, count: 0 };
  const lo = Math.max(0, Math.min(n - 1, Math.round(Math.min(fracA, fracB) * (n - 1))));
  const hi = Math.max(0, Math.min(n - 1, Math.round(Math.max(fracA, fracB) * (n - 1))));
  let mn = Infinity, mx = -Infinity, num = 0, den = 0;
  for (let i = lo; i <= hi; i++) {
    const c = frame.count[i] || 0;
    if (!c) continue;
    if (frame.min[i] < mn) mn = frame.min[i];
    if (frame.max[i] > mx) mx = frame.max[i];
    num += frame.mean[i] * c;
    den += c;
  }
  if (!den) return { min: NaN, max: NaN, mean: NaN, count: 0 };
  return { min: mn, max: mx, mean: num / den, count: den };
}

/** Bucket index for a fraction (0..1) across the frame. */
function qmBucketAt(frame, frac) {
  const n = frame && frame.mean ? frame.mean.length : 0;
  if (!n) return 0;
  return Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
}

// ── drawing ───────────────────────────────────────────────

/** Resolve a CSS custom property off the measurement root.
 *
 * Every colour the canvas paints comes through here, which is what lets the
 * light/dark toggle re-theme the plots: flipping ``data-theme`` on the root
 * changes what these return, and the next draw picks it up. A hardcoded
 * literal anywhere below would survive the flip and break one theme.
 */
function qmToken(root, name) {
  return getComputedStyle(root).getPropertyValue(name).trim();
}

function qmFmtNum(v, dec) {
  if (v == null || !isFinite(v)) return "—";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: dec == null ? 2 : dec,
    maximumFractionDigits: dec == null ? 2 : dec,
  });
}

// ── which clock are we on? ─────────────────────────────────
// X is whatever column the user picked, and it is not always an absolute
// timestamp: a relative column (t_rel_ms, a per-file offset, a trigger-relative
// recording) starts at zero. Formatting one of those as a wall clock is not just
// unhelpful, it INVENTS data — new Date(-420) is 1969-12-31T23:59:59.580Z, so a
// value 420ms before zero printed as "59:58" and read like a real timestamp near
// the end of a minute. Reported exactly that way.
//
// Decide from the magnitude, not from the column name, so it holds for any column
// the user picks and any provider. An absolute epoch-ms instant in a real
// measurement is at least ~1e11 (1973-03-03); a relative offset within a
// recording is at most days (~1e8); and anything negative cannot be an absolute
// timestamp of a measurement at all.
const QM_ABS_EPOCH_FLOOR = 1e11;

/** "abs" or "rel" for the range being displayed. */
function qmTimeKind(t0, t1) {
  const lo = Math.min(Number(t0), Number(t1));
  if (!isFinite(lo)) return "abs";
  return lo < QM_ABS_EPOCH_FLOOR ? "rel" : "abs";
}

/** mm:ss for an epoch-ms instant — the compact reading, for sub-minute steps. */
function qmFmtClock(ms) {
  const d = new Date(ms);
  return String(d.getUTCMinutes()).padStart(2, "0") + ":" +
         String(d.getUTCSeconds()).padStart(2, "0");
}

/** Full timestamp with milliseconds, for the cursor readout. */
function qmFmtStamp(ms) {
  const d = new Date(ms);
  return String(d.getUTCHours()).padStart(2, "0") + ":" +
         String(d.getUTCMinutes()).padStart(2, "0") + ":" +
         String(d.getUTCSeconds()).padStart(2, "0") + "." +
         String(d.getUTCMilliseconds()).padStart(3, "0");
}

// Every clock above reads UTC, so every tick POSITION below is aligned to UTC
// too. Aligning to the viewer's zone instead would put an "hour" tick at :30
// across half of Asia while the label above it still printed the hour.
const QM_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                   "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Whole days since the epoch — two instants match iff they share a UTC date. */
function qmUtcDay(ms) {
  return Math.floor(Number(ms) / 86400000);
}

/** "12 Feb" — the short date a time of day needs once the day is in doubt. */
function qmFmtDate(ms) {
  const d = new Date(ms);
  return String(d.getUTCDate()).padStart(2, "0") + " " + QM_MONTHS[d.getUTCMonth()];
}

/** Does this range leave a bare time of day ambiguous?
 *
 *  True once it crosses a UTC midnight, or is long enough to come back round to
 *  the same clock reading. Either way "12:13" has two answers inside the range,
 *  and a readout that has to say WHEN cannot leave the choice to the reader.
 */
function qmSpansDay(t0, t1) {
  const a = Number(t0), b = Number(t1);
  if (!isFinite(a) || !isFinite(b)) return false;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return hi - lo >= 86400000 || qmUtcDay(lo) !== qmUtcDay(hi);
}

/** An offset from zero, as a duration. Precision follows the span on screen, so
 *  a 2-second window does not print every tick as "0 s". */
function qmFmtRel(ms, span) {
  if (ms == null || !isFinite(ms)) return "—";
  const secs = ms / 1000;
  const sp = Math.abs(Number(span) || 0) / 1000;
  const dec = sp === 0 ? 3 : (sp < 2 ? 3 : (sp < 20 ? 2 : (sp < 200 ? 1 : 0)));
  const a = Math.abs(secs);
  const sign = secs < 0 ? "-" : "";
  // Past a minute, seconds alone stop being readable.
  if (a >= 60) {
    const m = Math.floor(a / 60);
    const r = a - m * 60;
    return sign + m + ":" + (r < 10 ? "0" : "") + r.toFixed(Math.min(dec, 2));
  }
  return sign + a.toFixed(dec) + " s";
}

/** Format an X value for display, on whichever clock the range is on.
 *
 *  A negative relative time prints as a signed offset. It used to return "",
 *  on the reasoning that there is no instant before zero — but a run-relative
 *  column legitimately holds pre-trigger data, and blanking it meant panning
 *  left of the run start erased the ruler tick by tick and left a range wholly
 *  before zero with no time axis at all. Absolute (epoch) times are untouched:
 *  a negative epoch really is not an instant in a measurement.
 *
 *  A precise absolute stamp gains the short date exactly when the range makes
 *  the clock alone ambiguous, so a window spanning midnight stops reporting two
 *  different days as "17:01:20.722" and "12:13:58.544".
 */
function qmFmtX(ms, t0, t1, opts) {
  const kind = (opts && opts.kind) || qmTimeKind(t0, t1);
  if (kind === "abs") {
    if (!(opts && opts.precise)) return qmFmtClock(ms);
    return qmSpansDay(t0, t1) ? qmFmtDate(ms) + " " + qmFmtStamp(ms) : qmFmtStamp(ms);
  }
  const span = (opts && opts.precise) ? 0 : (t1 - t0);
  // Typographic minus, so the sign reads as a sign next to a digit.
  if (ms < 0) return "−" + qmFmtRel(-ms, span);
  return qmFmtRel(ms, span);
}

/** Draw one strip.
 *
 * opts = {
 *   root,                 // the .qm element the theme tokens live on
 *   height,               // CSS px
 *   t0, t1,               // visible range, epoch ms
 *   cursorT, markT,       // cursor A (required), Δ marker B (optional)
 *   signals: [ { frame, colorVar, dec, axis } ],
 * }
 * Returns { padL, padR, w, h, buckets } so the caller can map pointer x
 * back to a time without duplicating the padding maths.
 */
/** The zoom step for one wheel notch, from the app's own sensitivity setting.
 *
 *  Deliberately identical to the node canvas (canvas-render.js): step =
 *  1.1 ** zoomAccel, where zoomAccel is the "Zoom wheel sensitivity" slider in
 *  Settings — 0.2 to 2.0, described there as "Lower = slower zoom (better for
 *  trackpads)". The measurement view used a hard-coded 1.3 per notch, which
 *  ignored that slider and was far coarser than the rest of the app.
 */
function qmWheelZoomStep(accel) {
  const a = Number(accel);
  return Math.pow(1.1, isFinite(a) && a > 0 ? a : 1);
}

/** How far a wheel event should scroll the range, in ms.
 *
 *  Proportional to the event's own delta rather than a fixed fraction of the
 *  window. That is the difference between a device-agnostic feel and a fixed
 *  step: a mouse notch reports ~100 delta units, a trackpad reports a stream of
 *  small ones, so a fixed "a fifth of the window per event" flew across the
 *  recording on a trackpad. Pixels of delta become pixels of plot.
 */
function qmWheelPan(delta, msPerPx, accel) {
  const a = Number(accel);
  const scale = isFinite(a) && a > 0 ? a : 1;
  return delta * (msPerPx || 0) * scale;
}

/** A wheel event's delta in PIXELS, whatever unit the device reported it in.
 *
 *  ``deltaMode`` is 0 for pixels, 1 for LINES and 2 for PAGES, and everything
 *  downstream (qmWheelPan above, "pixels of delta become pixels of plot")
 *  assumes pixels. A line-mode device — a plain Windows mouse under Firefox
 *  reports 3 lines per notch, not ~100 px — therefore moved the plot by a
 *  hundredth of the intended distance. 16 px per line is the browsers' own
 *  default line height; a page is one plot's worth, so the caller passes the
 *  plot's width and height. Takes the event rather than two numbers so the
 *  mode and both axes stay together.
 */
function qmWheelDeltaPx(ev, wpx, hpx) {
  const mode = ev ? ev.deltaMode : 0;
  const dx = Number(ev && ev.deltaX) || 0;
  const dy = Number(ev && ev.deltaY) || 0;
  const unit = (page) => (mode === 2 ? (Number(page) || 0) : mode === 1 ? 16 : 1);
  return { x: dx * unit(wpx), y: dy * unit(hpx) };
}

/** Is this a Mac? Only ever used to LABEL a modifier.
 *
 *  The gestures themselves already accept either modifier (ctrlKey || metaKey),
 *  so nothing behaves differently — but printing "ctrl" to a Mac user is wrong,
 *  and on macOS ctrl+click is the context menu, so ⌘ is the one to reach for.
 */
function qmIsMac(nav) {
  const n = nav || (typeof navigator !== "undefined" ? navigator : null);
  if (!n) return false;
  const p = (n.userAgentData && n.userAgentData.platform) || n.platform ||
    n.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(String(p));
}

/** The modifier's name, spelled the way this platform spells it. */
function qmModLabel(isMac) { return isMac ? "⌘" : "ctrl"; }

/** Every control, in one list, so the help panel and the plot tooltip cannot
 *  drift apart — they are two presentations of this.
 *
 *  ``diff`` changes what a click MEANS (it plants cursor A), so it is an input
 *  rather than a footnote. ``mod`` is qmModLabel's answer.
 */
function qmControls(diff, mod) {
  const m = mod || "ctrl";
  return [
    ["wheel", "pan through time"],
    [m + " + wheel", "zoom about the pointer — same speed as the canvas (Zoom wheel sensitivity in Settings)"
      + (m === "⌘" ? " · pinch too" : "")],
    ["drag", diff
      ? "measure an interval — cursor A at the press, B follows"
      : "pan through time"],
    ["click", diff ? "reset both cursors to the point" : "place the cursor"],
    ["drag a cursor", "move that one cursor, leaving the other put"],
    [(mod === "⌘" ? "⌥" : "alt") + " + drag",
      "measure an interval (turns the diff cursor on)"],
    ["shift + drag · middle-drag", "pan through time"],
    ["shift + wheel · horizontal swipe", "pan through time"],
    [m + " + drag", "pick a range, applied when you let go"],
    ["double-click", "fit this window to all its data"],
    ["◀ ▶ buttons", "scroll a quarter-window at a time"],
    ["⊕ ⊖ buttons", "zoom about the middle"],
  ];
}

/** How many of `widths` fit in `avail` px, allowing `gap` between them and
 *  keeping `reserve` px back for the "+N" button.
 *
 *  Pure so the decision is testable: jsdom reports every width as 0, so the
 *  measuring half can only ever be exercised in a real browser.
 *
 *  Always returns at least 1 when there is anything at all. A strip showing only
 *  "+11 more" tells you nothing about what is on screen — one legend entry plus
 *  the overflow is the floor worth having.
 */
function qmChipsThatFit(widths, avail, gap, reserve) {
  const list = widths || [];
  if (!list.length) return 0;
  const g = gap || 0;

  // Do they ALL fit? Then there is no button, so none of its width is reserved.
  // Checking this first matters: reserving unconditionally dropped the last chip
  // to make room for a "+N" that would then have had nothing to count.
  const total = list.reduce((a, w) => a + w, 0) + g * (list.length - 1);
  if (total <= avail) return list.length;

  const room = avail - (reserve || 0);
  let used = 0;
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const w = list[i] + (i ? g : 0);
    if (used + w > room && n > 0) break;
    used += w;
    n += 1;
  }
  return Math.max(1, n);
}

/** Which buckets are a single real measurement, and worth a dot.
 *
 *  A bucket holding exactly ONE reading IS that reading — its mean is the sample
 *  value — so a dot there says "measured here". A bucket holding several is an
 *  aggregate and must NOT get one: a point where the line is the mean of five
 *  readings is the same lie the min/max envelope exists to prevent.
 *
 *  Returns [] when the dots would not be distinguishable. Zoomed out, buckets sit
 *  a pixel apart and a thousand dots merge into the line they are annotating; they
 *  appear as you zoom in, which is when "measured or interpolated?" is the actual
 *  question. Also [] for a single dot, which cannot show spacing and just looks
 *  like a blemish.
 */
function qmSampleDots(frame, wpx, minGap) {
  if (!frame || !frame.count || !frame.mean) return [];
  const out = [];
  for (let i = 0; i < frame.mean.length; i++) {
    if (frame.count[i] === 1 && isFinite(frame.mean[i])) out.push(i);
  }
  if (out.length < 2) return [];
  return (wpx / out.length) >= (minGap || 4) ? out : [];
}

/** How many axis gutters fall on each side for ``n`` drawn axes.
 *
 *  They alternate left / right / left / right, so the left side takes the odd
 *  ones. Exported so a caller laying out several strips can compute the shared
 *  gutter count without restating this rule and drifting out of step with it.
 */
function qmAxisSides(n) {
  const k = Math.max(0, n | 0);
  return { left: Math.ceil(k / 2), right: Math.floor(k / 2) };
}

/** Axes that actually print for a window: on one shared scale, only the first. */
function qmDrawnAxes(nAxes, sharedMode) {
  return sharedMode ? Math.min(1, Math.max(0, nAxes | 0)) : Math.max(0, nAxes | 0);
}

// ── axis ticks ────────────────────────────────────────────
// An axis labelled max / midpoint / min prints whatever the data happens to
// end at — "17,487.44", "16,592.50", "15,697.56" — which reads as three
// unrelated numbers and makes the plot impossible to eyeball a value off.
// Round steps give the axis a unit you can count in, and the grid draws at the
// same values so a line IS a labelled number rather than a fifth of the box.

/** The coarsest-but-finest round step for a span: {1, 2, 2.5, 5} × 10^k.
 *
 *  Chosen against ``floor(span / step) + 1``, an upper bound on the ticks any
 *  offset of that step can put inside the range, rather than against the count
 *  for this exact range. That is deliberate: the bound does not depend on where
 *  the range starts, so panning does not make the tick spacing flicker between
 *  two densities while the data slides underneath it.
 */
function qmNiceStep(span, target) {
  const s = Number(span);
  const want = Math.max(2, Math.floor(Number(target) || 5));
  if (!isFinite(s) || s <= 0) return 0;
  const mant = [1, 2, 2.5, 5];
  // Start a decade below the span/target estimate so the walk can only climb,
  // and the first step that fits is the finest one on the ladder that fits.
  let k = Math.floor(Math.log10(s / want)) - 1;
  for (let guard = 0; guard < 24; guard++, k++) {
    const pow = Math.pow(10, k);
    for (let i = 0; i < mant.length; i++) {
      const step = mant[i] * pow;
      if (Math.floor(s / step + 1e-9) + 1 <= want) return step;
    }
  }
  return s / (want - 1);
}

/** Decimal places a label needs to state a ``step`` exactly. */
function qmTickDecimals(step) {
  const s = Math.abs(Number(step));
  if (!isFinite(s) || s <= 0) return 0;
  const d = Math.max(0, Math.min(6, -Math.floor(Math.log10(s))));
  // A 2.5-style step needs one digit more than its magnitude implies, or two
  // neighbouring ticks round to the same printed number.
  const scaled = s * Math.pow(10, d);
  return Math.abs(scaled - Math.round(scaled)) > 1e-9 ? Math.min(6, d + 1) : d;
}

/** Every multiple of ``step`` inside [lo, hi], ascending. */
function qmTicksAt(lo, hi, step) {
  const a = Number(lo), b = Number(hi), s = Number(step);
  if (!isFinite(a) || !isFinite(b) || !isFinite(s) || s <= 0 || b <= a) return [];
  // Multiplying an index by a fractional step leaves float dust (0.30000000000000004),
  // so every value is snapped back to the step's own precision.
  const rp = Math.pow(10, Math.max(0, Math.min(15, 1 - Math.floor(Math.log10(s)))));
  const first = Math.ceil(a / s - 1e-9);
  const last = Math.floor(b / s + 1e-9);
  const out = [];
  // Bounded: the step is picked to yield a handful of ticks, so a runaway count
  // is a caller bug and must not turn into a hung frame.
  for (let i = first; i <= last && out.length < 200; i++) {
    const v = Math.round(i * s * rp) / rp;
    out.push(v === 0 ? 0 : v);          // never print a negative zero
  }
  return out;
}

/** Round tick values inside [lo, hi], at most ``target`` of them. */
function qmNiceTicks(lo, hi, target) {
  return qmTicksAt(lo, hi, qmNiceStep(Number(hi) - Number(lo), target));
}

// ── time ticks ────────────────────────────────────────────
// Same argument as the numeric axis, one dimension over. Eight even divisions
// of the range printed mm:ss of eight arbitrary instants, so a 19-hour window
// read "01:20 25:25 49:30 13:34" — not a time axis, just four numbers. Ticks
// land on round times instead, and the LABEL follows the step: a two-hour step
// has nothing to say about seconds, and a one-day step nothing about hours.

// Round time steps in ms. Not {1, 2, 2.5, 5} × 10^k, because time is not
// decimal: 15 min, 6 h and 1 day are steps a reader counts in, and 2.5 h is
// not. Below a second it goes back to decimal — sub-second time has no units
// of its own.
const QM_TIME_STEPS = [
  100, 200, 500,
  1000, 2000, 5000, 10000, 15000, 30000,
  60000, 120000, 300000, 600000, 900000, 1800000,
  3600000, 7200000, 10800000, 21600000, 43200000,
  86400000, 172800000, 259200000, 604800000,
];

const QM_DAY_MS = 86400000;

/** The finest round time step whose ticks still fit in ``target`` labels.
 *
 *  Judged by ``floor(span / step) + 1``, an upper bound across every offset of
 *  that step, for the reason qmNiceStep gives: a bound that does not depend on
 *  where the range starts cannot make the spacing flicker while the user pans.
 */
function qmNiceTimeStep(span, target) {
  const s = Math.abs(Number(span));
  const want = Math.max(2, Math.floor(Number(target) || 5));
  if (!isFinite(s) || s <= 0) return 0;
  for (let i = 0; i < QM_TIME_STEPS.length; i++) {
    const step = QM_TIME_STEPS[i];
    if (Math.floor(s / step + 1e-9) + 1 <= want) return step;
  }
  // Past a week the calendar stops offering units, so whole days go decimal.
  return Math.max(QM_DAY_MS, qmNiceStep(s / QM_DAY_MS, want) * QM_DAY_MS);
}

/** Round times inside [t0, t1], with the step that produced them.
 *
 *  Multiples of the step counted from the epoch, which for every step from a
 *  millisecond to a day is also a UTC boundary — so an hour tick falls on the
 *  hour and a day tick on midnight, agreeing with the UTC labels. A relative
 *  clock gets the same treatment for free: its zero IS the epoch here, so the
 *  ticks come out as round offsets from the trigger.
 */
function qmNiceTimeTicks(t0, t1, target) {
  const a = Number(t0), b = Number(t1);
  const step = qmNiceTimeStep(b - a, target);
  if (!step || !isFinite(a) || !isFinite(b) || b <= a) return { ticks: [], step: step };
  const first = Math.ceil(a / step - 1e-9);
  const last = Math.floor(b / step + 1e-9);
  const ticks = [];
  // Bounded: the step is chosen to yield a handful, so a runaway count is a
  // caller bug and must not turn into a hung frame.
  for (let i = first; i <= last && ticks.length < 200; i++) ticks.push(i * step);
  return { ticks: ticks, step: step };
}

/** An absolute tick label, at the precision its own step earns.
 *
 *  ``withDate`` prefixes the short date, and is for the ticks that OPEN a day —
 *  the first on the ruler and the first after each midnight. Dating every tick
 *  would repeat one date eight times and spend the width that keeps the labels
 *  from touching.
 */
function qmFmtAbsTick(ms, step, withDate) {
  const s = Math.abs(Number(step)) || 0;
  if (s >= QM_DAY_MS) return qmFmtDate(ms);
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  if (withDate) {
    // The date is worth its width only next to the hour it belongs to, so a
    // dated tick is never on the bare mm:ss reading.
    const hms = s >= 60000
      ? hh + ":" + mm
      : hh + ":" + mm + ":" + String(d.getUTCSeconds()).padStart(2, "0");
    return qmFmtDate(ms) + " " + hms;
  }
  if (s >= 60000) return hh + ":" + mm;
  // Sub-minute the hour is redundant: mm:ss is what a second-scale window is
  // read in, and what the strip has always printed there.
  if (s >= 1000) return qmFmtClock(ms);
  const dec = s >= 100 ? 1 : (s >= 10 ? 2 : 3);
  return qmFmtClock(ms) + "." +
         String(d.getUTCMilliseconds()).padStart(3, "0").slice(0, dec);
}

function qmDrawStrip(canvas, opts) {
  const root = opts.root;
  // SIZING — the whole reason plots looked soft.
  //
  // Two independent mistakes were compounding:
  //   1. The backing store was `clientWidth * dpr`, an INTEGER measure against a
  //      fractional CSS box (1961 vs 1961.1), so the bitmap never mapped 1:1.
  //   2. `devicePixelRatio` can be BELOW 1 (a zoomed-out window reports 0.667
  //      here). Sizing by it then rendered 1307px of bitmap into a 1961px box —
  //      a 1.5x upscale, which resamples every line and glyph into a ghost.
  //
  // Fix: measure the real fractional rect, never render below CSS resolution,
  // and derive the transform from the exact bitmap/box ratio so one drawing unit
  // is exactly one CSS pixel with no resampling at all.
  // `hidden` signals are still selected and still measured — they just are not
  // drawn, so a busy strip can be read one trace at a time without losing the
  // selection.
  const signals = (opts.signals || []).filter(s => s && s.frame && !s.hidden);
  const dpr = window.devicePixelRatio || 1;
  const parent = canvas.parentElement;
  // A caller on a zoomed canvas gives its own box: layout pixels and the bitmap scale it wants, so the
  // canvas transform never changes what is drawn. Otherwise the real rect is measured.
  const box = opts.box || null;
  const scale = box ? Math.max(1, box.scale || 1) : Math.max(1, dpr);   // Never below CSS resolution.
  const rect = box ? { width: box.w, height: box.h } : canvas.getBoundingClientRect();

  // "auto" (the normal case) measures the container, which CSS has already
  // flexed to fill the workspace. A number is only used by callers that own
  // their own height, and it still has to be written back to the element.
  const auto = box || opts.height == null || opts.height === "auto";
  const cssW = Math.max(1, rect.width || parent.clientWidth || 1);
  const cssH = auto
    ? Math.max(60, rect.height || parent.clientHeight || 60)
    : Math.max(60, opts.height);

  // Assigning canvas.width / canvas.height DISCARDS the backing bitmap and
  // allocates a fresh one — in every browser, and even when the value written is
  // identical to the one already there. This function runs on every pointer move
  // and every repaint, so writing them unconditionally allocated a new
  // multi-megabyte bitmap per strip per event: a 1600x220 CSS strip at dpr 1.5 is
  // ~3.2MB, four windows come to ~13MB per mouse move, and a couple of seconds of
  // panning left over a gigabyte of detached bitmaps for the GC to chase. That is
  // the memory the tab was eating, and it is allocation rate, not retention.
  //
  // Write only on a real geometry change. Nothing is lost by skipping it: the
  // width assignment also cleared the canvas and reset the context, and
  // setTransform + clearRect below do both explicitly. Every alpha / dash change
  // in this renderer is save()/restore()-wrapped, so no state survives a frame.
  const bmW = Math.max(1, Math.round(cssW * scale));
  const bmH = Math.max(1, Math.round(cssH * scale));
  if (canvas.width !== bmW) canvas.width = bmW;
  if (canvas.height !== bmH) canvas.height = bmH;
  if (!auto) canvas.style.height = cssH + "px";

  const ctx = canvas.getContext("2d");
  // Exact ratio, not `scale` — rounding the backing store leaves a sub-pixel
  // difference, and using `scale` here would reintroduce the mismatch.
  const sx = canvas.width / cssW, sy = canvas.height / cssH;
  ctx.setTransform(sx, 0, 0, sy, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // Snap a coordinate so a 1px stroke covers whole device pixels instead of
  // straddling two and rendering as a 2px smear.
  const snapX = (v) => (Math.round(v * sx - 0.5) + 0.5) / sx;
  const snapY = (v) => (Math.round(v * sy - 0.5) + 0.5) / sy;
  const snapT = (v) => Math.round(v * sy) / sy;      // text baselines

  // Axis gutters are explicit per signal (`axis: true`) and alternate
  // left / right / left / right, each taking its own strip of width GUTTER. The
  // padding therefore grows with the number of visible axes rather than being
  // fixed — turning an axis off gives its width back to the plot.
  const GUTTER = 46;
  // Pixels a pair of sample dots needs before they are worth drawing — see the
  // measurement-point dots below.
  const MIN_DOT_GAP = 4;
  const axisIdx = [];
  signals.forEach((sg, i) => { if (sg.axis) axisIdx.push(i); });
  const sharedMode = opts.yMode === "shared";
  // On one shared scale every axis would print identical numbers, so only the
  // first earns a gutter.
  const drawn = sharedMode ? axisIdx.slice(0, 1) : axisIdx;
  const sideOf = {};
  let leftN = 0, rightN = 0;
  drawn.forEach((si, k) => {
    if (k % 2 === 0) sideOf[si] = { side: "left", slot: leftN++ };
    else sideOf[si] = { side: "right", slot: rightN++ };
  });
  // Stacked strips have to share their plot rectangle, or the same instant sits
  // at a different x in each one — which with a shared cursor reads as the cursor
  // being misaligned between windows. The caller passes the maximum gutter count
  // across the strips on screen, and a window using fewer axes than that reserves
  // the space anyway rather than reclaiming it and shifting its own plot.
  leftN = Math.max(leftN, opts.minLeftAxes || 0);
  rightN = Math.max(rightN, opts.minRightAxes || 0);
  const padL = 12 + GUTTER * leftN, padR = 12 + GUTTER * rightN;
  // Units sit above the topmost axis value, so reserve a line for them —
  // otherwise "km/h" prints straight over "235.4". Same alignment argument: if
  // ANY strip on screen shows a unit, every strip reserves the line, or the one
  // without a unit starts its plot 11px higher and its traces do not line up
  // with its neighbour's.
  const anyUnit = drawn.some((si) => signals[si] && signals[si].unit);
  const padT = (anyUnit || opts.reserveUnitLine) ? 19 : 8;
  const padB = 16;
  const w = Math.max(10, cssW - padL - padR);
  const h = Math.max(10, cssH - padT - padB);
  const mono = qmToken(root, "--qm-mono") || "monospace";
  const buckets = signals.length && signals[0].frame.mean
    ? signals[0].frame.mean.length
    : Math.round(w);

  const span = (opts.t1 - opts.t0) || 1;
  const tToX = (t) => padL + ((t - opts.t0) / span) * w;

  // The range the FRAMES actually cover, which is not always the range on screen.
  // Pan or zoom re-queries, and until that answer lands the view repaints the
  // frames it already holds — so those buckets have to be drawn at the times they
  // were measured at, not stretched across whatever is on screen now. Stretching
  // them made a pan look like the data was being scaled rather than moved, and a
  // zoom look like it had jumped: "scrolling does not move the data nicely, and it
  // changes zoom". With the real mapping, held data slides and scales correctly and
  // simply runs out at the edge, which is the honest picture of what we have.
  const frameT0 = opts.frameT0 == null ? opts.t0 : opts.frameT0;
  const frameT1 = opts.frameT1 == null ? opts.t1 : opts.frameT1;
  const frameSpan = (frameT1 - frameT0) || 1;
  /** Where a time falls inside the frame, 0..1 — for looking a bucket up. */
  const frameFrac = (t) => (t - frameT0) / frameSpan;

  // One tick roughly every 44px, so a short strip thins its axis out instead of
  // stacking labels. The grid and the labels share it, or the lines would stop
  // landing on the numbers.
  const tickTarget = Math.max(3, Math.min(8, Math.floor(h / 44)));

  // The time ruler needs its own target: its labels sit side by side rather than
  // stacked, and a dated one runs to ~12 characters, so the count follows the
  // WIDTH. The ruler and the vertical grid share these ticks, or a grid line
  // would stop landing on the time under it.
  const timeTarget = Math.max(4, Math.min(12, Math.floor(w / 110)));
  const timeKind = qmTimeKind(opts.t0, opts.t1);
  const timeAxis = qmNiceTimeTicks(opts.t0, opts.t1, timeTarget);
  const timeCrossesDay = timeKind === "abs" && qmSpansDay(opts.t0, opts.t1);

  // Y scaling. "auto" gives every signal its own scale, so rpm and throttle-%
  // can share a strip and both stay legible. "shared" puts them on ONE scale,
  // which is what you want when the signals are commensurable (two speeds, two
  // temperatures) and the per-signal scaling would hide the real difference
  // between them.
  const shared = sharedMode;
  let sharedLo = Infinity, sharedHi = -Infinity;
  if (shared) {
    signals.forEach((s) => {
      const st = qmRangeStats(s.frame);
      if (st.min < sharedLo) sharedLo = st.min;
      if (st.max > sharedHi) sharedHi = st.max;
    });
    const pad = (sharedHi - sharedLo) * 0.08 || 1;
    sharedLo -= pad;
    sharedHi += pad;
  }

  const scales = signals.map((s) => {
    const st = qmRangeStats(s.frame);
    let lo, hi;
    if (shared && isFinite(sharedLo) && isFinite(sharedHi)) {
      lo = sharedLo; hi = sharedHi;
    } else {
      const pad = (st.max - st.min) * 0.08 || 1;
      lo = st.min - pad; hi = st.max + pad;
    }
    return { lo, hi, st, y: (v) => padT + h - ((v - lo) / (hi - lo || 1)) * h };
  });

  // Clip the traces to the plot rectangle: a held frame legitimately extends
  // beyond the visible range while a re-query is in flight, and without this it
  // would paint straight over the axis gutters and the ruler.
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, padT, w, h);
  ctx.clip();

  signals.forEach((s, idx) => {
    const f = s.frame;
    const sc = scales[idx];
    const color = qmToken(root, s.colorVar) || qmToken(root, "--qm-text");
    const n = f.mean.length;
    // Bucket -> its own time -> x. See frameT0/frameT1 above.
    const x = (i) => tToX(frameT0 + (n > 1 ? (i / (n - 1)) : 0.5) * frameSpan);

    // min/max envelope, only for a view that asked for the band
    if (opts.envelope === true) {
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      for (let i = 0; i < n; i++) ctx.lineTo(x(i), sc.y(f.max[i]));
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(x(i), sc.y(f.min[i]));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
    }

    // mean line
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      if (!isFinite(f.mean[i])) continue;
      const px = x(i), py = sc.y(f.mean[i]);
      started ? ctx.lineTo(px, py) : (ctx.moveTo(px, py), started = true);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.stroke();

    // Real measurement points.
    //
    // A bucket holding exactly ONE reading is a real measurement: its mean IS
    // that sample, so a dot there marks measured data rather than a line drawn
    // between two distant readings. A bucket holding several is an aggregate and
    // gets NO dot — putting a point where the line is the mean of five readings
    // would be the same lie the min/max envelope exists to prevent.
    //
    // Only drawn once they would be distinguishable. Zoomed out, buckets sit a
    // pixel apart and a thousand dots merge into the very line they annotate, so
    // they appear as you zoom in — which is exactly when "is this measured or
    // interpolated?" becomes the question.
    const dots = qmSampleDots(f, w, MIN_DOT_GAP);
    if (dots.length) {
      ctx.save();
      ctx.fillStyle = color;
      dots.forEach((i) => {
        ctx.beginPath();
        ctx.arc(x(i), sc.y(f.mean[i]), 1.7, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
    }
  });

  ctx.restore();               // end of the trace clip

  // Grid AFTER the traces, on its own clip.
  //
  // WHY over rather than under: the min–max envelope is a filled area, and a
  // grid drawn beneath it vanished wherever a band was dense — exactly the busy
  // plots where a reference line earns its keep. Over the band at a low alpha it
  // stays readable through the fill without competing with the trace. The clip
  // is its own because the grid must never reach into an axis gutter.
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, padT, w, h);
  ctx.clip();
  ctx.strokeStyle = qmToken(root, "--qm-grid");
  ctx.lineWidth = 1;
  // Horizontal lines follow the FIRST printed axis, so every line is a number
  // you can read off its gutter. With no axis on screen there is nothing to
  // align to, so fall back to even divisions.
  const gridSi = drawn.length ? drawn[0] : -1;
  const gridTicks = gridSi >= 0
    ? qmNiceTicks(scales[gridSi].lo, scales[gridSi].hi, tickTarget)
    : [];
  const gridYs = gridTicks.length
    ? gridTicks.map((v) => scales[gridSi].y(v))
    : [1, 2, 3, 4].map((i) => padT + (h * i) / 5);
  gridYs.forEach((gy) => {
    const y = snapY(gy);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + w, y); ctx.stroke();
  });
  // Verticals on the ruler's own ticks, for the same reason the horizontals
  // follow the numeric axis: a line is then a round time you can read off the
  // ruler, not a fraction of the box. Ones landing on the plot edge are dropped
  // — they would only double the border.
  timeAxis.ticks.forEach((t) => {
    const x = snapX(tToX(t));
    if (x <= padL + 1 || x >= padL + w - 1) return;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + h); ctx.stroke();
  });
  ctx.restore();

  // Second pass on purpose: the gutters sit outside the clipped plot rectangle.
  signals.forEach((s, idx) => {
    // numeric gutter, only where the caller asked for one
    const pos = sideOf[idx];
    if (!pos) return;
    const sc = scales[idx];
    const color = qmToken(root, s.colorVar) || qmToken(root, "--qm-text");
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = color;
    ctx.font = "10px " + mono;
    ctx.textBaseline = "middle";
    ctx.textAlign = pos.side === "left" ? "right" : "left";
    const ax = pos.side === "left"
      ? padL - 6 - pos.slot * GUTTER
      : padL + w + 6 + pos.slot * GUTTER;
    // The edge of THIS axis's gutter, which for the innermost one is the plot
    // edge — where its tick marks bite into the gutter.
    const edge = pos.side === "left"
      ? padL - pos.slot * GUTTER
      : padL + w + pos.slot * GUTTER;
    const step = qmNiceStep(sc.hi - sc.lo, tickTarget);
    // The step's precision, not the signal's: a 0.25 step has to print "0.25"
    // even for a column that reads as whole numbers.
    const tdec = qmTickDecimals(step);
    let lastY = null;
    qmTicksAt(sc.lo, sc.hi, step).forEach((v) => {
      const y = sc.y(v);
      // Drop a label pressed against either edge — the top one would collide
      // with the unit line, the bottom one with the time ruler.
      if (y < padT + 6 || y > padT + h - 6) return;
      if (lastY != null && Math.abs(y - lastY) < 7) return;
      lastY = y;
      ctx.fillText(qmFmtNum(v, tdec), ax, snapT(y));
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      const ty = snapY(y);
      ctx.beginPath();
      ctx.moveTo(pos.side === "left" ? edge - 4 : edge, ty);
      ctx.lineTo(pos.side === "left" ? edge : edge + 4, ty);
      ctx.stroke();
      ctx.restore();
    });
    // The unit belongs to the axis, not to the legend chip — it is what the
    // numbers directly above and below it are measured in.
    if (s.unit) {
      ctx.globalAlpha = 0.75;
      ctx.fillText(s.unit, ax, snapT(padT - 11));
    }
    ctx.restore();
  });

  // time ruler
  ctx.fillStyle = qmToken(root, "--qm-text-faint");
  ctx.strokeStyle = qmToken(root, "--qm-text-faint");
  ctx.font = "10px " + mono;
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  let lastRight = -Infinity;
  let lastDay = null;
  timeAxis.ticks.forEach((t) => {
    // A date is announced once per day: on the first label drawn, then on the
    // first one of each day after it. Tracked on the labels that actually got
    // drawn, so a skipped tick does not swallow the announcement.
    const day = qmUtcDay(t);
    const withDate = timeCrossesDay && day !== lastDay;
    const txt = timeKind === "abs"
      ? qmFmtAbsTick(t, timeAxis.step, withDate)
      : qmFmtX(t, opts.t0, opts.t1);
    if (!txt) return;
    const cx = Math.round(tToX(t));
    const half = ctx.measureText(txt).width / 2;
    // Two labels touching read as one longer label, so a crowded one waits for
    // the next tick with room. Its tick mark goes with it: a mark under no
    // number is a grid line that means nothing.
    if (cx - half < lastRight + 6) return;
    lastRight = cx + half;
    lastDay = day;
    ctx.fillText(txt, cx, snapT(padT + h + 3));
    ctx.beginPath();
    ctx.moveTo(snapX(cx), padT + h);
    ctx.lineTo(snapX(cx), padT + h + 3);
    ctx.stroke();
  });

  /** A time, printed on the ruler at the x it belongs to.
   *
   *  The ruler's own round ticks are for orientation; these say WHEN the thing
   *  you are pointing at happened, to the millisecond, without having to look
   *  away from the plot. Filled background because it overprints those ticks, and
   *  clamped inside the plot so a cursor at either edge still reads.
   */
  const rulerStamp = (t, colorToken, alpha) => {
    if (t == null) return;
    const txt = qmFmtX(t, opts.t0, opts.t1, { precise: true });
    if (!txt) return;            // nothing formattable, e.g. a non-finite time
    ctx.save();
    ctx.font = "10px " + mono;
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    const tw = ctx.measureText(txt).width;
    const half = tw / 2 + 3;
    const cx = Math.max(padL + half, Math.min(padL + w - half, tToX(t)));
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.fillStyle = qmToken(root, "--qm-plot");
    ctx.fillRect(cx - half, padT + h + 2, tw + 6, 12);
    ctx.fillStyle = qmToken(root, colorToken);
    ctx.fillText(txt, cx, snapT(padT + h + 3));
    ctx.restore();
  };

  // Rubber-band zoom selection: the range that a ctrl-drag would zoom to,
  // shown over the data so you can see what you are about to get before
  // committing to it.
  if (opts.bandT && opts.bandT.length === 2 &&
      opts.bandT[0] != null && opts.bandT[1] != null) {
    const b0 = tToX(Math.min(opts.bandT[0], opts.bandT[1]));
    const b1 = tToX(Math.max(opts.bandT[0], opts.bandT[1]));
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = qmToken(root, "--qm-accent");
    ctx.fillRect(b0, padT, Math.max(1, b1 - b0), h);
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = qmToken(root, "--qm-accent");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(snapX(b0), padT); ctx.lineTo(snapX(b0), padT + h);
    ctx.moveTo(snapX(b1), padT); ctx.lineTo(snapX(b1), padT + h);
    ctx.stroke();

    // Span label, centred, so the selection is a measurement not a guess.
    const secs = Math.abs(opts.bandT[1] - opts.bandT[0]) / 1000;
    const txt = secs >= 1 ? secs.toFixed(2) + " s" : (secs * 1000).toFixed(0) + " ms";
    ctx.globalAlpha = 1;
    ctx.font = "10px " + mono;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = qmToken(root, "--qm-accent");
    ctx.fillText(txt, (b0 + b1) / 2, snapT(padT + 3));
    ctx.restore();
  }

  // Hover readout: a thin line where the pointer is, with each signal's value
  // flagged at the point the line crosses its trace. Drawn BEFORE the cursors so
  // the measurement cursors stay on top — hover is transient, cursors are the
  // instrument.
  if (opts.hoverT != null && signals.length) {
    const hx = snapX(tToX(opts.hoverT));
    ctx.save();
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = qmToken(root, "--qm-text-dim");
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + h); ctx.stroke();
    ctx.restore();

    const hfrac = frameFrac(opts.hoverT);
    // Flags go right of the line, unless that would run off the plot.
    const flip = hx > padL + w * 0.82;
    signals.forEach((sg, idx) => {
      const bi = qmBucketAt(sg.frame, hfrac);
      const v = sg.frame.mean[bi];
      if (!isFinite(v)) return;
      const py = scales[idx].y(v);
      const color = qmToken(root, sg.colorVar);
      const txt = qmFmtNum(v, sg.dec) + (sg.unit ? " " + sg.unit : "");

      ctx.save();
      ctx.font = "10px " + mono;
      const tw = ctx.measureText(txt).width;
      const bw = tw + 8, bh = 14;
      const bx = flip ? hx - 6 - bw : hx + 6;
      const by = Math.max(padT, Math.min(padT + h - bh, py - bh / 2));

      ctx.globalAlpha = 0.92;
      ctx.fillStyle = qmToken(root, "--qm-plot");
      ctx.fillRect(bx, by, bw, bh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(snapX(bx), snapY(by), bw, bh);
      ctx.fillStyle = color;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(txt, bx + 4, snapT(by + bh / 2));

      // A dot exactly where the line meets the trace.
      ctx.beginPath();
      ctx.arc(hx, py, 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
    });

    // When the pointer is. Dimmer than the cursors, because hover is transient.
    rulerStamp(opts.hoverT, "--qm-text-dim", 0.95);
  }

  // Diff interval: shade the A↔B span in the B cursor's purple so it is obvious
  // WHAT the measurement covers. Drawn before the cursor lines, which stay crisp
  // on top. Only when both cursors exist — i.e. the diff cursor is on.
  if (opts.cursorT != null && opts.markT != null) {
    const xa = tToX(opts.cursorT);
    const xb = tToX(opts.markT);
    const x0 = Math.min(xa, xb);
    const x1 = Math.max(xa, xb);
    if (x1 - x0 >= 1) {
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = qmToken(root, "--qm-cursor-b");
      ctx.fillRect(x0, padT, x1 - x0, h);
      ctx.restore();
    }
  }

  // Δ marker first, cursor A on top — A is the one being dragged, so it wins
  // the overlap.
  if (opts.markT != null) {
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = qmToken(root, "--qm-cursor-b");
    const bx = snapX(tToX(opts.markT));
    ctx.beginPath(); ctx.moveTo(bx, padT); ctx.lineTo(bx, padT + h); ctx.stroke();
    ctx.restore();
    rulerStamp(opts.markT, "--qm-cursor-b");
  }

  if (opts.cursorT != null) {
    const cx = snapX(tToX(opts.cursorT));
    ctx.strokeStyle = qmToken(root, "--qm-cursor");
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + h); ctx.stroke();

    // value dots where the cursor crosses each mean line, ringed in the plot
    // background so they stay visible on top of a dense trace
    const frac = frameFrac(opts.cursorT);
    signals.forEach((s, idx) => {
      const bi = qmBucketAt(s.frame, frac);
      const v = s.frame.mean[bi];
      if (!isFinite(v)) return;
      ctx.beginPath();
      ctx.arc(cx, scales[idx].y(v), 2.6, 0, Math.PI * 2);
      ctx.fillStyle = qmToken(root, s.colorVar);
      ctx.fill();
      ctx.strokeStyle = qmToken(root, "--qm-dot-ring");
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
    // Cursor A last, so its time wins any overlap with B's or the pointer's.
    rulerStamp(opts.cursorT, "--qm-cursor");
  }

  // padT is part of the geometry too: it is what a reserved unit line costs, and
  // a caller checking that stacked strips agree needs to see it.
  return { padL, padR, padT, w, h, buckets };
}
