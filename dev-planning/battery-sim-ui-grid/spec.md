# Battery Sim UI — movable, resizable widget grid

**Status:** Draft
**Project:** comma-car-segments-ingest
**Created:** 2026-09-23
**Planned with:** Buddy
**Supersedes:** `dev-planning/battery-sim-ui-v2/spec.md` **§1 only** (§1.2, §1.3, §1.4 in
full; §1.1's framework decision survives — see §7.2 below). §2, §3, §4 and OQ5/OQ7 of
that spec stay in force.
**Branch / env:** `jama-ui-dev` / `testrigorg-commacarsegmentsingest-jamaui`
**Backlog:** closes BL-58 as a side effect (§2.4)

---

## 0. Summary

The Battery Sim dashboard's fixed Bootstrap `row`/`col-*` grid is replaced by a
GridStack.js grid of seven tiles that a viewer can drag and resize, the way a Quix
Portal dashboard behaves. The layout persists in that browser's `localStorage` and a
**Reset layout** button restores the shipped default. Nothing else changes: no route,
no payload, no plant parameter, no vehicle constant, no physics. This is layout only.

**Written against the END state**, i.e. after the visual pass now landing in
`battery-sim-ui/` — which turns the four small charts into one large chart behind four
tabs (SOC %, Current A, Temperature °C, Terminal Voltage V), replaces the car silhouette
with a Taycan-like one, and adds position labels to the heater/chiller knobs. Where this
spec names an element it names the one that exists after that pass.

---

## 1. The widget inventory

### 1.1 The seven tiles

The grid is **12 columns** wide with `cellHeight: 40` px and `margin: 8` (a 16 px
gutter, matching the `g-3` the page uses today). One grid unit of width at a 1440 px
viewport is ≈ 118 px; one unit of height is 40 px.

| # | Tile | `gs-id` | Contents | Default `w × h` | Minimum `w × h` | Removable |
|---|---|---|---|---|---|---|
| 1 | Car | `car` | Taycan-like SVG silhouette, wheels, brake lamps, charge cable, km/h readout, mode chip | 5 × 9 | 3 × 4 | no |
| 2 | Chart | `chart` | One `<canvas>` behind the four tabs (SOC / Current / Temperature / Voltage), the `×N` sim-scale suffix | 7 × 9 | 3 × 4 | no |
| 3 | Pack gauges | `gauges` | SOC battery graphic + thermometer, side by side | 2 × 8 | 1 × 5 | no |
| 4 | Readouts | `readouts` | Terminal voltage, battery temperature, derating factor, current achieved, current commanded (est.) | 3 × 8 | 2 × 3 | no |
| 5 | Pedals | `pedals` | Accel + Brake vertical sliders with their % readouts | 3 × 8 | 2 × 5 | no |
| 6 | Charging | `charging` | Plug switch, charge-rate slider, kW readout | 2 × 8 | 2 × 4 | no |
| 7 | Climate | `climate` | Chiller + heater knobs with their position labels, ambient-temperature slider | 2 × 8 | 2 × 4 | no |

**Where the minimums come from.** Each is the size below which the tile's content stops
being usable, not a round number:

- **Car 3 × 4** — 354 × 160 px. The SVG scales freely (§4.2), but below that the wheels
  are ~20 px across and "is it accelerating?" becomes unreadable, which is the one thing
  the car exists to answer.
- **Chart 3 × 4** — the four tab labels need ~300 px of strip; below ~120 px of canvas a
  400-point polyline over a 100-unit range is a smear.
- **Pack gauges 1 × 5** — the battery body is 70 px wide and the thermometer track 14 px,
  so one column (118 px) still holds both; 5 rows (200 px) is the shortest that leaves the
  fills readable once the `+70` / `-40` caps and the % label are on screen.
- **Readouts 2 × 3** — five `meas-value` cells two-up need ~236 px of width for the
  longest label ("battery-sign: + discharge / − charge") to wrap to two lines rather than
  three.
- **Pedals 2 × 5** — two vertical range inputs side by side; 200 px of travel is the
  shortest that gives a usable 0–100 % throw.
- **Charging 2 × 4** — the switch, its label, the slider and the kW value stack to ~150 px.
- **Climate 2 × 4** — two 44 px knobs plus their `OFF / 1 / 2` labels side by side, then
  the ambient slider.

These are declared as `gs-min-w` / `gs-min-h` attributes in the markup, so GridStack
enforces them during the resize drag and the tile simply refuses to go smaller. No
JavaScript checks a size anywhere.

### 1.2 Nothing is removable, and there is no "add widget"

Every tile is permanent. GridStack's `removable` option is not set and no tile carries a
close button. The reason is symmetry: a removable tile needs a palette to bring it back,
a palette needs an inventory UI, and the inventory UI is a second feature this dashboard
does not need — seven tiles, all of them always relevant to reading a battery sim. A
viewer who wants a tile out of the way shrinks it or pushes it below the fold.

`gs-no-move` / `gs-no-resize` / `gs-locked` are set on nothing: all seven tiles move and
resize identically.

### 1.3 What is *not* a tile

The **header** stays outside the grid as fixed chrome: the `Battery Sim` title, the
sim-speed slider and its `×N` badge, the live dot, and the two new layout controls (§5).
It is a plain `d-flex` bar, unaffected by drag or resize.

Two consequences in the markup:

- The duplicate sim-speed card in the controls row (`page_markup.py:200-205`, the
  `col-12 d-sm-none` one) is **deleted**. `page_script.py` already wires the sliders as a
  `querySelectorAll('.speed-slider')` NodeList and iterates it, so one slider instead of
  two needs no JavaScript change.
- The surviving header slider group loses `d-none d-sm-flex` and the header gains
  `flex-wrap`, so the control is present at every width.

### 1.4 The one-screen rule is now a property of the DEFAULT layout only

The default arrangement (§3.4) is 17 rows tall = 680 px of cells, plus a 48 px header and
16 px of body padding = **744 px**. At a 1440 × 900 viewport with ~90 px of Portal/browser
chrome that leaves ~66 px of headroom, so the dashboard still opens on one screen with no
scrolling.

**Once a person moves or grows a tile, the page is theirs to make as tall as they like.**
No code prevents it, no layout is rejected for being too tall, and the acceptance test in
v2 §1.4 (`document.body.scrollHeight <= window.innerHeight`) applies **only to the default
layout on a first visit or immediately after Reset**. Enforcing it against a user-authored
layout would mean fighting the drag the feature exists to provide.

---

## 2. The grid library

### 2.1 GridStack.js, pinned at **13.3.0**

GridStack is the library the reference behaviour describes: drag, resize, tile reflow,
responsive column collapse, a serialisable layout and zero framework dependency — and it
is the one such library that ships all five in one 88 KB UMD bundle with no jQuery, no
build step and no peer dependency, which is what a page assembled from module-level
Python strings can actually consume. Everything else in the space gives up one of the
five: Muuri drags and reflows but has no resize handles and no column model, Packery +
Draggabilly is two Metafizzy libraries and still no resize, interact.js is a gesture
library that leaves you hand-rolling the grid engine itself, and jQuery UI `sortable`
would drag a jQuery dependency into a page that has none.

**Version: 13.3.0, not 14.0.0.** 14.0.0 was published two days before this spec and its
headline breaking change replaces the `float` boolean with a four-valued `mode` property.
A fresh major on a demo dashboard buys nothing and costs a rewrite when the next patch
lands. 13.3.0 is the last release of the previous major and carries the API this spec is
written against: `column`, `columnOpts`, `cellHeight`, `margin`, `minRow`, `handle`,
`float`, `staticGrid`, `save()`, `load()`, `setStatic()`, and the `gs-x/gs-y/gs-w/gs-h/
gs-id/gs-min-w/gs-min-h` attribute set.

### 2.2 The two files

| File | Size | Upstream CDN URL (reference only — see §2.3) |
|---|---|---|
| `gridstack.min.css` | 5.99 KB | `https://cdn.jsdelivr.net/npm/gridstack@13.3.0/dist/gridstack.min.css` |
| `gridstack-all.js` | 87.95 KB | `https://cdn.jsdelivr.net/npm/gridstack@13.3.0/dist/gridstack-all.js` |

`gridstack-all.js` is the bundle that includes the drag-and-drop implementation
(`dd-draggable`, `dd-resizable`, `dd-touch`); the bare `gridstack.js` does not, and a grid
without it neither drags nor resizes. There is no `gridstack.min.js` in the 13.3.0 dist —
`gridstack-all.js` **is** the minified bundle.

### 2.3 Vendor both, from the start — and Bootstrap with them

**Recommendation: vendor. Do not add a second CDN dependency.**

BL-58 records that the existing jsDelivr Bootstrap `<link>` is unverified against the
Portal's CSP when the page is framed. A GridStack `<script>` from the same host inherits
exactly that risk and is strictly worse than the Bootstrap one, because the failure modes
are not comparable:

- **Bootstrap blocked** → an ugly but working dashboard. Every control still functions.
- **`gridstack-all.js` blocked** → no grid at all. The seven `.grid-stack-item` divs have
  no `position` and no size, so they collapse into a single overlapping stack at the top
  left. The dashboard is not degraded, it is destroyed.
- **`gridstack.min.css` blocked but the JS loads** → the same. GridStack writes
  `gs-*` attributes and inline `top`/`left`; the absolute positioning that turns them into
  a layout lives in the stylesheet.

So the three files go into a new **`battery-sim-ui/static/`** folder:

```
battery-sim-ui/static/gridstack.min.css     (5.99 KB, gridstack 13.3.0)
battery-sim-ui/static/gridstack-all.js      (87.95 KB, gridstack 13.3.0)
battery-sim-ui/static/bootstrap.min.css     (~230 KB, bootstrap 5.3.3)
```

and are referenced as `/static/gridstack.min.css`, `/static/gridstack-all.js`,
`/static/bootstrap.min.css`.

**No new Flask route is written.** `Flask(__name__)` (`battery-sim-ui/main.py:70`) already
serves `./static/` at `/static/<path>` by default — the folder simply does not exist yet.
The dockerfile's `COPY . .` (`battery-sim-ui/dockerfile:10`) already carries any new folder
into the image. Absolute `/static/...` paths are correct behind the Portal's
`urlPrefix: battery-sim` for the same reason the existing `fetch('/config')` and
`fetch('/battery/data')` calls are correct today.

**Cost: ~324 KB of vendored bytes in the repo.** That is the honest price and it is worth
paying once for a dashboard that cannot silently die behind a CSP.

### 2.4 This closes BL-58

Moving `BOOTSTRAP_CSS_URL` (`battery-sim-ui/page.py:20`) from jsDelivr to `/static/`
resolves BL-58 rather than deferring it, and makes the Subresource-Integrity point in that
ticket moot: there is no third-party fetch left to sign, and no wrong-hash failure mode to
guard against. `page.py`'s module docstring, which currently documents the CDN and its
vendoring fallback, is rewritten in the same edit — a docstring describing a CDN link that
no longer exists is the defect the project's comment rule names.

The three URL constants in `page.py` are **asset paths, not service constants**. Changing
them is not the "no constant changes" the brief rules out; no ceiling, no lexicon value, no
physics number and no topic name moves anywhere in this spec.

---

## 3. Persistence

### 3.1 Where, and the key

Browser **`localStorage`**, one key:

```
battery-sim-ui.layout
```

`localStorage` is the right store because the layout is a *viewer's* preference, not state
of the system under test: it needs no backend, no route, no topic, no schema migration and
no identity. One key, one writer, one reader.

### 3.2 The serialised shape

```json
{
  "version": 1,
  "items": [
    { "id": "car",      "x": 0, "y": 0, "w": 5, "h": 9 },
    { "id": "chart",    "x": 5, "y": 0, "w": 7, "h": 9 },
    { "id": "gauges",   "x": 0, "y": 9, "w": 2, "h": 8 },
    { "id": "readouts", "x": 2, "y": 9, "w": 3, "h": 8 },
    { "id": "pedals",   "x": 5, "y": 9, "w": 3, "h": 8 },
    { "id": "charging", "x": 8, "y": 9, "w": 2, "h": 8 },
    { "id": "climate",  "x": 10, "y": 9, "w": 2, "h": 8 }
  ]
}
```

`items` is `grid.save(false)` — GridStack's own serialiser with `saveContent = false`, so
it emits positions and ids and no HTML — mapped down to the five fields above. Only those
five are stored: the minimums live in the markup and must not be persisted, or a future
change to a minimum would be overridden by a stale copy.

`version` is a module-level `LAYOUT_VERSION` constant, bumped by hand in the same edit that
changes the tile set or the column count. **It is the only invalidation mechanism** — there
is no migration path and none is wanted: a bumped version means the stored layout is
ignored and the default is used, which is the correct answer for a dashboard arrangement.

### 3.3 When it is written and read

- **Written** on GridStack's `change` event, which fires once per completed drag and once
  per completed resize (not per pixel), so no debounce is needed and none is written.
- **Read** once, at init, immediately after the grid is constructed.
- **Applied** with `grid.load(stored.items, false)`. The second argument
  (`addAndRemove: false`) is load-bearing: with the default `true`, GridStack would
  *delete* any DOM tile missing from the stored list and try to *create* any id it does not
  recognise. Our tiles are static markup, not `content` strings, so the grid must only ever
  update what is already there.

### 3.4 First visit, and what the default actually is

**The default layout lives in the markup**, as the `gs-x` / `gs-y` / `gs-w` / `gs-h`
attributes on the seven `.grid-stack-item` divs. On a first visit — no key, or a `version`
mismatch, or unparseable JSON — the code does nothing at all and GridStack lays the page
out from those attributes. There is no default constant in JavaScript to keep in sync with
the markup.

For **Reset** (§5.3) the default must still be recoverable after a drag has rewritten those
attributes, so init snapshots it exactly once:

```
DEFAULT_ITEMS = grid.save(false)   // taken BEFORE the stored layout is applied
```

That keeps the markup as the single statement of the default and gives Reset something to
load.

### 3.5 The layout is per-browser and goes nowhere

Stated explicitly because it is the property that makes `localStorage` the right choice:

- The layout is **per browser profile**, not per user, not per deployment. Two people
  looking at the same dashboard see different arrangements; the same person on a second
  machine sees the default.
- **No layout value ever reaches the plant, a Kafka topic, or `/command`.** The `/command`
  body is `JSON.stringify(state)` (`page_script.py:61`) and `state` gains no layout field.
  `main.py`'s `command_route` reads seven named keys and would ignore one anyway. The
  control → field table in v2 §4.1 already carries the row `Layout changes | — | — | — |
  write nothing` and it stays true.
- Nothing is written to blob, Mongo, the lake, or the Test Manager.

### 3.6 The one `try` / `catch`, and why it is not a validation layer

`localStorage` access **throws** in a framed third-party context under some browser
configurations — a `SecurityError` on mere property access inside a `sandbox`ed iframe
without `allow-same-origin`, and a blocked write under Safari's third-party storage rules
(§6.3). That is a browser API failing, not malformed data arriving, so the project's
light-functional rule does not forbid handling it — and an unhandled throw inside the
`change` handler would take the whole drag interaction down.

**Exactly one `try`/`catch` pair** wraps the read and the write, each falling through to
"use the default / don't persist". Nothing else in this feature is guarded: no size is
range-checked, no id is validated, no stored payload is schema-checked. A stored item whose
`id` matches no tile is simply not matched by `grid.load` and disappears; that is
GridStack's behaviour, not a check we write.

---

## 4. Resize behaviour of the live content

This is the part that breaks if it is done carelessly, because four of the seven tiles
contain content whose pixel geometry is currently hard-coded or aspect-locked.

### 4.1 The chart canvas — one `ResizeObserver`, constructed once

**Today.** `sizeCanvases()` (`page_script.py:158-165`) sets `canvas.width` /
`canvas.height` from `clientWidth` / `clientHeight` and redraws; it is hooked to
`window.addEventListener('resize', sizeCanvases)` (`page_script.py:166`). A GridStack tile
resize does **not** fire `window.resize`, so as things stand a resized chart tile would
grow its CSS box while the drawing buffer stayed at its old pixel size — a blurry,
stretched chart.

**The mechanism.** One module-level `ResizeObserver`, constructed once and pointed at the
chart canvas's holder:

```
const chartResize = new ResizeObserver(sizeCanvases);
chartResize.observe(<the chart canvas's flex holder>);
```

**Why this cannot leak a listener per resize.** The observer is constructed at script scope
— not inside a handler, not inside `sizeCanvases`, not inside the GridStack `change` or
`resizestop` callback. `observe()` is called once per observed element during init and never
again. The resize path therefore contains no `addEventListener`, no `new ResizeObserver` and
no `grid.on(...)` call; it only reads `clientWidth`/`clientHeight` and redraws. The rule for
the implementer is one line: **nothing inside a resize callback may register anything.**

**`window.addEventListener('resize', sizeCanvases)` is deleted.** `ResizeObserver` fires on
a window resize too, because the canvas's box changes — so keeping both would double every
redraw for no gain.

**Rejected: `grid.on('resizestop', sizeCanvases)`.** It is one line and it works for the
drag case, but it misses three others that all change the canvas box without a GridStack
resize: a window resize, the 12 → 1 column breakpoint flip (§4.5), and GridStack's reflow of
neighbouring tiles when a *different* tile is dragged. `ResizeObserver` covers all four with
one registration; `resizestop` would need three more.

**Redraw cost during the drag.** `ResizeObserver` fires per animation frame while the corner
is being dragged. Each fire is one `canvas.width =` assignment (which clears the buffer),
one `clearRect`, up to two `fillRect` band fills and one 400-point `stroke`. That is a
single polyline on a single canvas — the visual pass has already collapsed four canvases
into one — and is comfortably inside a frame budget. No throttle is written.

**Tab switches do not resize anything.** The four tabs select which `series` entry
`drawChart` renders into the *same* canvas, so the box does not change and the observer
correctly stays silent; the tab handler calls `drawChart` directly. That is the visual
pass's code, named here only so the resize path is not wired into it twice.

### 4.2 The car SVG — the `.ratio` wrapper is deleted

**Today.** `page_markup.py:74` wraps the car in `<div class="ratio ratio-21x9">`. That
wrapper's whole job is to *impose* a height from a width. In a grid where the user chooses
the height, it is exactly wrong: a tile dragged tall would keep a 21:9 car with a band of
dead space below it.

**Replacement.** The `.ratio` div is removed. The tile's `.card-body` is already
`d-flex flex-column`; the SVG holder becomes `flex-grow-1` with the widget-internal CSS rule
`min-height: 0` (without it a flex child refuses to shrink below its content height, and the
car would pin the tile's minimum height to the SVG's intrinsic size). The `<svg>` itself
gets `width: 100%; height: 100%`, keeps `viewBox="0 0 420 180"`, and carries
`preserveAspectRatio="xMidYMid meet"` — which is the SVG default, written out so the intent
is on the page rather than implied.

**No JavaScript is involved.** SVG scaling is intrinsic to the element. And critically, the
rAF loop's only per-frame write is
`transform="rotate(angle cx cy)"` in **viewBox coordinates**
(`page_vehicle.py:72-86`), which are independent of the rendered box size. The wheels
therefore need no resize handling of any kind, and `page_vehicle.py` is not edited by this
spec.

### 4.3 The pedals — vertical range inputs replace the rotate hack

**Today.** `.pedal-track { height: 150px }` with
`input[type="range"] { width: 150px; transform: rotate(-90deg) }`
(`page_style.py:62-63`). A CSS-rotated element keeps its *unrotated* layout box, which is
why the track's height and the input's width are both the magic number 150: they have to be
equal by hand. Nothing about that arrangement can follow a tile height.

**Replacement.** Drop the rotation and use the standard vertical-range mechanism:

```
.pedal-track input[type="range"] { writing-mode: vertical-rl; direction: rtl; height: 100%; }
```

`writing-mode: vertical-rl` makes the input's genuine layout box tall, so `height: 100%`
inside a `flex-grow-1; min-height: 0` holder tracks the tile. `direction: rtl` puts the
maximum at the top, which is what a pedal reads as. This is the replacement for the
`transform: rotate(-90deg)` line and for the 150/150 pairing; both are deleted.

Browser support is Chrome 121+ (Jan 2024) and Safari 17.4+ (Mar 2024), universal for a
dashboard behind a Portal login in late 2026. The fallback, if QA finds otherwise, is OQ 6.

### 4.4 The gauges — fills already scale, tracks need one rule each

`.battery-fill` and `.thermo-fill` are already `height: <n>%` of their track
(`page_style.py:29-33, 47-51`), so they scale for free. The tracks themselves are fixed
(`.battery-body { height: 150px }`, `.thermo-track { height: 150px }`) and become
`height: 100%` inside the same `flex-grow-1; min-height: 0` holder.

**Widths stay fixed** (70 px battery, 14 px thermometer). A battery graphic that gets wider
as the tile widens reads as a bug, not a feature; the tile's `gs-min-w: 1` already
guarantees 118 px, which holds both side by side.

The knobs (44 px) and the `form-switch` stay fixed too — a 44 px knob is a 44 px knob at any
tile size, and scaling it buys nothing.

### 4.5 Responsive — GridStack owns the breakpoint, Bootstrap no longer does

```
columnOpts: { breakpointForWindow: true, breakpoints: [{ w: 768, c: 1 }] }
```

Below 768 px the grid drops to one column and every tile becomes full width, ordered by its
current `y` then `x`. Above it, twelve columns.

This **replaces** v2 §1.3's entire "shrink vs collapse" scheme: the `order-*` phone stacking,
the `d-none d-md-flex` on the thermometer and the `d-none d-sm-block` on the commanded-current
readout. Both `d-none` utilities are **deleted** — they existed to make a fixed grid fit, and
a one-column grid has no width to fight over. Every readout is now present at every width.

The phone order is derived from the grid rather than authored: with the §3.4 default, one
column reads car → chart → gauges → readouts → pedals → charging → climate. That differs from
v2 §1.3's hand-ordered phone stack (car → state → controls → charts) and the difference is
accepted: the ordering is now a consequence of the layout the user sees on a desktop, which
is the simplification the grid buys.

`breakpointForWindow: true` measures `window.innerWidth`, which inside an iframe is the
*iframe's* width — the correct number, and the one the frame gives us without touching
`window.top` (§6.2).

### 4.6 Compaction

`float: false` (GridStack's default): a tile dragged into empty space floats up to close the
gap, and tiles below a shrunk tile rise. This is the behaviour a Portal-style dashboard has
and it is what keeps a user-authored layout from accumulating holes. `minRow` is not set.

---

## 5. Controls

Three controls, all in the header, all outside the grid.

### 5.1 An explicit edit mode — the grid is static until asked

The grid is constructed with **`staticGrid: true`**. In that state nothing drags, no resize
handles are drawn, and the page behaves exactly as it does today.

This is not caution, it is a hard requirement of the content: five of the seven tiles are
made of drag targets. An accelerator slider, a brake slider, a charge-rate slider, an
ambient slider and a sim-speed slider all work by a mouse-down-and-drag gesture inside a
tile. If tiles were always draggable, every pedal push would be ambiguous.

**Control: an `Edit layout` toggle button in the header.** It calls
`grid.setStatic(false)` on, `grid.setStatic(true)` off, and toggles a `.editing` class on
`<body>` so the grips (§5.2) become visible. The poll loop, the rAF car loop and the chart
keep running throughout — freezing the sim while someone tidies their dashboard would be a
worse bug than the one it avoided.

### 5.2 The drag handle — each tile's existing title row

```
handle: '.tile-grip'
```

Even in edit mode the drag starts only from an element carrying `.tile-grip`, so a slider
inside an unfolded tile is never mistaken for a grab.

**No new DOM is added where a title already exists.** Each tile's existing heading element
takes the extra class: the `meas-label` row on Pedals, Charging and Climate, the
`chart-title` / tab-strip row on Chart, and the top label row on Gauges and Readouts. The Car
tile is the one with no heading today; it gets one 20 px bar reading `Vehicle`, which doubles
as the label the tile is currently missing.

Widget CSS: `.editing .tile-grip { cursor: move }`. That is the whole visual affordance.

### 5.3 The resize corner, and Reset

**Resize:** GridStack's default `resizable: { handles: 'se' }` — bottom-right corner only.
One corner. Handles are drawn by GridStack only while the grid is non-static, so they appear
and disappear with edit mode.

**Reset layout:** one button in the header. It removes the `localStorage` key and calls
`grid.load(DEFAULT_ITEMS, false)` with the snapshot taken at init (§3.4). No confirmation
dialog — the action is instantly reversible by dragging, and a modal here would be
ceremony.

That is the complete control surface: **one toggle, one grip per tile, one corner, one
reset.** No per-tile menu, no lock, no compact button, no layout presets, no export.

---

## 6. What the framed context forbids

The dashboard is served at `urlPrefix: battery-sim` (`quix.yaml:452-454`) and is framed
inside the Test Manager — verified working in the Portal by the user under BL-05.

### 6.1 Ruled out

- **New windows and tabs.** No `window.open` anywhere — no "pop this widget out into its own
  window". A framing page may be `sandbox`ed without `allow-popups`, in which case the call
  returns `null` silently. The feature does not need it: resizing a tile *is* the pop-out.
- **The Fullscreen API.** No `element.requestFullscreen()` on a tile. It requires
  `allow="fullscreen"` on the parent's `<iframe>`, which is the Test Manager's markup and not
  ours; without it the returned Promise rejects and the user sees nothing happen. "Maximise
  the chart" is served by dragging the chart tile wide.
- **Anything reading the top-level document.** No `window.top`, no `window.parent`, no
  `document.referrer`, no attempt to measure the Portal's chrome. Cross-origin access throws.
  Every measurement this feature makes is of its own frame.
- **Cookies as a layout store.** A third-party cookie in a frame is blocked outright in every
  current browser. This is one more reason the store is `localStorage` (§3.1).

### 6.2 Sizing is unaffected

`window.innerWidth` inside an iframe is the iframe's own width, so
`columnOpts.breakpointForWindow` (§4.5) reads the right number without any knowledge of the
frame. `ResizeObserver` (§4.1) observes elements in our own document and is likewise
frame-agnostic. Nothing in the layout path needs to know it is framed.

### 6.3 One real constraint: `localStorage` in a third-party context

The dashboard's origin and the Portal's origin differ, so from the frame's point of view its
`localStorage` is third-party storage. Chrome and Edge **partition** it — it works, keyed by
the top-level site, which in practice means "the layout you set inside the Test Manager is
the layout you get inside the Test Manager." Safari's tracking prevention **blocks** it, and a
`sandbox` attribute without `allow-same-origin` makes even reading the property throw.

The answer is §3.6's single `try`/`catch`: where storage works the layout persists, where it
does not the dashboard opens on the default every time and everything else still works. No
second store, no cookie fallback, no server-side layout.

### 6.4 Drag and resize inside an iframe are unaffected — confirmed

GridStack's drag-and-drop implementation (`dd-draggable`, `dd-resizable`, `dd-touch` in the
`gridstack-all.js` bundle) listens for mouse/pointer events on **its own document** and moves
elements by writing inline style. It does not use the HTML5 drag-and-drop API — which *is*
frame-fragile — and it does not call `document.elementFromPoint` across a frame boundary or
reach for the top document. Everything it touches is inside our own `<body>`.

One known, harmless behaviour of any in-frame drag is worth stating so it is not filed as a
bug later: if the pointer leaves the iframe mid-drag, the iframe stops receiving move events
and the tile stops following the cursor until the pointer comes back; GridStack ends the drag
on the next `mouseup`/`pointerup` it sees. The frame fills the Test Manager's content area, so
the edge is barely reachable, and nothing is lost when it happens.

---

## 7. Files touched

### 7.1 The change set

| File | One-line change | Owner |
|---|---|---|
| `battery-sim-ui/static/gridstack.min.css` | **new** — vendored, gridstack 13.3.0 | ArchDev |
| `battery-sim-ui/static/gridstack-all.js` | **new** — vendored, gridstack 13.3.0 | ArchDev |
| `battery-sim-ui/static/bootstrap.min.css` | **new** — vendored, bootstrap 5.3.3, closes BL-58 | ArchDev |
| `battery-sim-ui/page.py` | three asset URLs now `/static/…`; GridStack `<link>` + `<script>`; module docstring rewritten (the CDN paragraph it carries becomes false) | ArchDev |
| `battery-sim-ui/page_layout.py` | **new** — `LAYOUT_JS`: `GridStack.init`, the `DEFAULT_ITEMS` snapshot, load/save, edit toggle, reset. Shares the one `<script>` scope, as `page_vehicle.py` does | ArchDev |
| `battery-sim-ui/page_markup.py` | outer `row`/`col-*`/`order-*` replaced by `.grid-stack` + seven `.grid-stack-item[gs-id,gs-x,gs-y,gs-w,gs-h,gs-min-w,gs-min-h]`; `.ratio` wrappers deleted; `.tile-grip` added to each tile's title row; header gains Edit + Reset and loses the `d-sm-none` sim-speed duplicate; the two `d-none` collapses deleted | ArchDev + FrontEndEsthetic |
| `battery-sim-ui/page_style.py` | `.tile-grip`, `.fill-box { min-height: 0 }`, vertical-range `writing-mode` rules; `.pedal-track`'s rotate and the 150 px heights on `.battery-body` / `.thermo-track` / `.pedal-track` deleted. Still no `@media` rule | FrontEndEsthetic |
| `battery-sim-ui/page_script.py` | `window.addEventListener('resize', sizeCanvases)` deleted, replaced by one module-level `ResizeObserver` | ArchDev |
| `battery-sim-ui/README.md` | the grid, edit mode, reset, the `localStorage` key, the vendored assets | DocuGuy |
| `docs/architecture-battery-sim-ui.md` | replace the *Layout — Bootstrap 5.3, stylesheet only* section; add the grid, the persistence model and the framing constraints; update the file inventory | DocuGuy, after the build |
| `dev-planning/backlog.json` | new item for this feature; BL-58 → finished. **Regenerated, never hand-edited** (`battery-trace-gen/tools/gen_claude_md.py`) | ArchDev |

### 7.2 Not touched

`battery-sim-ui/main.py` (no route, no payload, no constant), `battery-sim-ui/page_vehicle.py`
(viewBox coordinates are size-independent, §4.2), `battery-sim-ui/app.yaml`,
`battery-sim-ui/dockerfile`, `battery-sim-ui/requirements.txt`, `quix.yaml`,
`battery-trace-gen/` in its entirety (plant, lexicon, parameters, traces),
`battery-trace-gen/PLANT_ORIGIN`, `frontend/`, `api/`, `CLAUDE.md`.

### 7.3 What of `battery-sim-ui-v2/spec.md` §1 survives

| v2 §1 | Status |
|---|---|
| **§1.1** Framework — Bootstrap 5.3, stylesheet only; Bootstrap owns component styling; `page_style.py` carries no `@media` rule | **In force.** Bootstrap keeps the cards, utilities, `form-range`, `form-switch`, badges and the *inner* grids (the readouts' `row g-2 / col-6`, the pedals' flex row). Only the **outer** layout layer moves to GridStack. The no-`@media` rule now also covers `page_layout.py`'s CSS: breakpoints are `columnOpts`, never a media query. |
| **§1.1** "Bootstrap owns every layout and breakpoint decision" | **Superseded.** GridStack owns the outer layout and the one breakpoint (§4.5). |
| **§1.2** The grid — `container-fluid`, the `row g-3` main row, the four-column table, the controls row table | **Superseded in full** by §1.1 and §3.2 here. |
| **§1.3** Shrink vs collapse — the `.ratio` wrappers, the `order-*` phone order, the two `d-none` collapses | **Superseded in full** by §4.2, §4.3, §4.4, §4.5. The `.ratio` wrappers and both `d-none` utilities are deleted. |
| **§1.4** The no-scroll budget at 1440×900 and its acceptance test | **Superseded** by §1.4 here: the property now attaches to the **default layout only**. |
| §2 (`TIME_SCALE`, `Q_MAX_AH`), §3 (the car), §4 (wiring), OQ5 (spoke aliasing), OQ7 (no snap-back on load) | **In force, untouched.** |
| OQ6 (CDN vs vendor) | **Answered** by §2.3 / §2.4: vendor. BL-58 closes. |

---

## 8. Open questions

**OQ 1 — GridStack 13.3.0 or 14.0.0?**
*Recommended: 13.3.0.* 14.0.0 landed two days before this spec and replaces the `float`
boolean with a four-valued `mode`. A brand-new major on a demo dashboard is risk with no
return. Revisit in a month if 14.x stabilises; the upgrade is a version string plus one
option rename.

**OQ 2 — Vendor the assets or keep the CDN?**
*Recommended: vendor all three, now.* §2.3's argument is that a blocked
`gridstack-all.js` or `gridstack.min.css` does not degrade the page, it destroys it — all
seven tiles collapse into one overlapping stack. BL-58 already flags the same CSP risk for
Bootstrap and is unresolved; adding a second unverified CDN dependency on top of an
unverified one is the wrong direction. Cost is ~324 KB in the repo and one new folder that
Flask already serves.

**OQ 3 — Seven tiles, or six as the brief listed?**
The brief named pedals, plug + charge slider, heater/chiller knobs, the readout grid, the
car and the tabbed chart. This spec splits today's single "state" card into **Pack gauges**
and **Readouts**, and folds the ambient slider into the Climate tile.
*Recommended: seven.* The gauges carry fixed-geometry graphics with a hard minimum height;
the readout grid reflows freely. Keeping them in one tile means the tile inherits the
gauges' minimum and the readouts can never be made short and wide. The ambient slider
belongs with the climate knobs because it is read with them. If the user prefers six, merge
1 and 2 back into a `state` tile at default `5 × 8`, `min 2 × 5`.

**OQ 4 — Should any tile be removable?**
*Recommended: none.* §1.2. A remove needs an add, an add needs a palette, and a palette is a
second feature. Seven tiles that are all always relevant is not a set worth curating.

**OQ 5 — Edit mode, or always draggable?**
*Recommended: an explicit `Edit layout` toggle, static by default.* §5.1. Five of the seven
tiles are built out of drag-operated sliders; an always-live grid makes every pedal push
ambiguous. The `.tile-grip` handle alone would mostly work, but "mostly" on the accelerator
is not good enough, and the toggle also gives the phone case a clean answer (nobody drags
by accident while scrolling).

**OQ 6 — `writing-mode: vertical-rl` for the pedals, or keep the 150 px rotate?**
*Recommended: `writing-mode`.* It deletes a hack (a rotated element whose layout box is its
unrotated box, forcing the magic 150/150 pairing) and is the only version where the pedal
actually grows with its tile. Support is Chrome 121+ / Safari 17.4+, both shipped in early
2024. If QA finds a browser where it fails, the fallback is one line — restore
`transform: rotate(-90deg)` with the fixed 150 px track and leave the Pedals tile's `min-h`
at 5, where the pedal stays usable but stops scaling.

**OQ 7 — `localStorage` in the Test Manager frame.**
*Recommended: use it, with §3.6's single `try`/`catch`.* Chrome and Edge partition
third-party storage, which works and arguably behaves better (the layout you set inside the
Portal is the layout you get inside the Portal). Safari blocks it and a sandboxed frame makes
it throw, in which case the dashboard opens on the default every time — an acceptable
degradation for a preference. **This needs one line of QA:** drag a tile inside the framed
dashboard, reload, confirm it stayed.

**OQ 8 — `cellHeight: 40` fixed, or `'auto'`?**
*Recommended: fixed 40 px.* `'auto'` makes cells square, which ties every tile's height to
the viewport width — so a wide monitor would make the car tile enormous and a narrow one
would squash the chart below its minimum. A fixed row height keeps the minimums in §1.1
meaningful in pixels.

**OQ 9 — Everything assumed about the reference Portal dashboard.**
The reference URL
(`https://portal.testrig.dev.quix.io/pipeline?workspace=testrigorg-quixstreamstests-dashboardtest`)
requires a Portal login and **was not opened** — neither by Buddy nor by the dispatching
thread. Every behaviour below is inferred from the words "movable, scalable, resizable" and
from what a dashboard grid conventionally does. Each is a thing to check in QA:

1. **Drag starts from a handle, not the whole tile.** Assumed; spec'd as `.tile-grip` (§5.2).
2. **Resize from the bottom-right corner.** Assumed; spec'd as `handles: 'se'` (§5.3).
3. **Tiles reflow/compact rather than free-float.** Assumed; spec'd as `float: false` (§4.6).
4. **The layout persists across a reload.** Assumed; spec'd as `localStorage` (§3).
5. **Persistence is per viewer, not shared or server-side.** Assumed; §3.5. If the Portal
   dashboard persists per *user account* on a backend, matching it would need a route and a
   store, which this spec deliberately does not add.
6. **There is an explicit edit mode rather than an always-live grid.** Assumed; §5.1. If the
   Portal's is always live, ours still should not be, for the slider reason in OQ 5.
7. **A 12-column grid.** Assumed — it is the near-universal default and GridStack's own.
8. **Widgets can be added and removed from a palette.** Assumed to exist there;
   **deliberately not built here** (OQ 4).
9. **The Portal dashboard is GridStack underneath.** Unverified and not relied on. Nothing in
   this spec depends on it being the same library.

*Recommended:* build to the above, and have the user open the reference dashboard once
during QA and report any of the nine that differ. Each is a small, local change — none of
them reshapes the grid.

---

## 9. References

- `battery-sim-ui/page.py` (the assembler, `BOOTSTRAP_CSS_URL` at :20),
  `page_markup.py` (the grid being replaced, `.ratio` at :74 and :120-138, the duplicate
  sim-speed card at :200-205), `page_style.py` (:62-63 the pedal rotate, :20-51 the fixed
  gauge heights), `page_script.py` (:158-166 `sizeCanvases` and the `window.resize` hook),
  `page_vehicle.py` (:72-86 the viewBox-coordinate render, unchanged), `main.py` (:70 the
  Flask app, unchanged), `dockerfile` (:10 `COPY . .`), `app.yaml` (unchanged).
- `dev-planning/battery-sim-ui-v2/spec.md` — §1 superseded per §7.3; §2, §3, §4, OQ5, OQ7 in
  force; OQ6 answered.
- `dev-planning/battery-sim-ui/spec.md` — v1.
- `docs/architecture-battery-sim-ui.md` — as built; the *Layout* section is replaced.
- `quix.yaml` :428-460 — the `Battery Sim UI` deployment, `urlPrefix: battery-sim`, sidebar
  item.
- `dev-planning/backlog.json` — BL-58 (jsDelivr CSP, closed by §2.4), BL-57 (v2 as built),
  BL-05 (framing verified in the Portal).
- GridStack 13.3.0 — `https://cdn.jsdelivr.net/npm/gridstack@13.3.0/dist/` (the two files in
  §2.2); `GridStackOptions` / `GridStackWidget` field names taken from that build's
  `types.d.ts`.
- The reference dashboard: `https://portal.testrig.dev.quix.io/pipeline?workspace=testrigorg-quixstreamstests-dashboardtest`
  — **login-walled, not opened.** See OQ 9.
