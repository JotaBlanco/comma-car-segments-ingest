# Battery Sim UI v2 — compact dashboard, time scaling, car visualisation

**Status:** Draft
**Project:** comma-car-segments-ingest
**Created:** 2026-09-23
**Planned with:** Buddy
**Supersedes:** `dev-planning/battery-sim-ui/spec.md` (v1, shipped at `06cda3d`)
**Branch / env:** `jama-ui-dev` / `testrigorg-commacarsegmentsingest-jamaui`

---

## 0. Summary

Three changes to the shipped Battery Sim dashboard:

1. The page is re-laid-out on Bootstrap 5.3 so the whole thing fits one 1440×900
   viewport with no scrolling and collapses to one column on a phone.
2. A **sim-speed** control (`TIME_SCALE`) compresses wall-clock time without
   touching the integration step, so the pack reaches its interesting states —
   derating band, SOC saturation, RC2 relaxation — in seconds instead of tens of
   minutes. A smaller pack (`Q_MAX_AH`) is the zero-edit secondary knob.
3. A car is drawn in the dashboard; its wheels rotate at a rate driven by the
   plant's **achieved** pack power, with visible acceleration, coasting and regen
   braking.

Nothing about the plant's physics changes. Nothing about the offline trace
generator changes. The four MF4 hashes cannot move — §2.4 is the argument.

---

## 1. Compact layout

### 1.1 Framework — Bootstrap 5.3 CSS from the jsDelivr CDN

The project rule forbids hand-rolled breakpoints. The constraint that picks the
framework is the page's shape: `battery-sim-ui/page.py` is **one module-level
HTML string served verbatim by Flask** — no npm, no bundler, no build step, no
`static/` directory (`battery-sim-ui/page.py:1-8`). That rules out anything
needing a compile.

**Chosen: Bootstrap 5.3, one `<link>` to the jsDelivr CSS bundle.** It is a plain
stylesheet — no runtime compiler in the browser — it ships a dark theme via
`<html data-bs-theme="dark">`, and its grid (`row` / `col-*` / `col-lg-*`) plus
display utilities (`d-none d-md-flex`) and `order-*` utilities are exactly the
"shrink vs collapse vs reorder" vocabulary this section needs. No Bootstrap JS
bundle is required: nothing here is a dropdown, modal or collapse.

**Rejected: Tailwind Play CDN.** It compiles classes in the browser at runtime
(~100 KB of JS, a flash of unstyled content on a cold load) and Tailwind
themselves label the Play CDN as not-for-production. The only way to use Tailwind
properly is a build step, which this service does not have and should not grow
for a dashboard.

**Rejected: keep the hand-rolled CSS.** It has zero breakpoints today (`page.py`
lines 16-181 contain no `@media` rule at all) and a fixed `max-width: 1080px`
(`page.py:32`), so it neither fills 1440 px nor survives a phone.

**Scope of the rule.** Bootstrap owns **every layout and breakpoint decision**.
A small `<style>` block survives for *widget internals only* — the pedal-slider
skin, the battery/thermometer geometry, the knob, the SVG car's fills. Those are
component styling, not responsive layout, and they must contain **no `@media`
rule**. If a rule needs a media query, it belongs in a Bootstrap class instead.

Breakpoints are Bootstrap 5.3's own, not invented: `xs <576`, `sm ≥576`,
`md ≥768`, `lg ≥992`, `xl ≥1200`, `xxl ≥1400`.

### 1.2 The grid

Container: `container-fluid px-3 py-2` — the `max-width: 1080px` wrapper is
deleted so the dashboard actually uses a 1440 px display.

**Header** — `d-flex align-items-center justify-content-between gap-3 py-2`

| Element | Classes | Note |
|---|---|---|
| `h1` "Battery Sim" | `fs-5 mb-0` | |
| Sim-speed slider + `×N` badge | `d-none d-sm-flex align-items-center gap-2` | on `xs` it moves to the controls row instead (§1.3) |
| Live dot + text | `d-flex align-items-center gap-2 small text-secondary` | unchanged behaviour |

**Main row** — `row g-3`

| Column | `xs` | `md` | `lg` | Contents |
|---|---|---|---|---|
| State | `col-12 order-2` | `col-md-4` | `col-lg-3 order-lg-1` | SOC battery bar + thermometer side by side, then the 2×2 readout grid (terminal voltage, derating factor, current achieved, current commanded) |
| Car | `col-12 order-1` | `col-md-8` | `col-lg-5 order-lg-2` | SVG car (§3), km/h readout, mode chip |
| Charts | `col-12 order-4` | `col-md-12` | `col-lg-4 order-lg-3` | inner `row g-2`, four `col-6` chart cards |

**Controls row** — `row g-3 align-items-start order-3 order-lg-4`

| Control | `xs` | `sm` | `lg` |
|---|---|---|---|
| Accel | `col-6` | `col-sm-4` | `col-lg-2` |
| Brake | `col-6` | `col-sm-4` | `col-lg-2` |
| Plug + charge rate | `col-12` | `col-sm-4` | `col-lg-2` |
| Ambient | `col-12` | `col-sm-6` | `col-lg-2` |
| Chiller | `col-6` | `col-sm-3` | `col-lg-1` |
| Heater | `col-6` | `col-sm-3` | `col-lg-1` |
| Sim speed (xs/sm only) | `col-12 d-sm-none` | — | — |

`lg` columns sum to 2+2+2+2+1+1 = 10, plus a `col-lg-2` spacer for the readouts
of `TIME_SCALE`'s effect (sim-time elapsed) — or leave the two columns empty.

### 1.3 Shrink vs collapse

**Shrink** (present at every width, sized by its column):

- **Charts.** Each canvas sits in a Bootstrap `ratio ratio-21x9` wrapper, so its
  height follows its column width with no media query. At `lg` the charts column
  is 4/12 of 1440 ≈ 460 px, each chart `col-6` ≈ 220 px wide → ~94 px tall,
  close to today's fixed 90 px (`page.py:109`).
- **Car SVG.** `ratio ratio-16x9` at `md` and up, `ratio ratio-21x9` below (two
  wrappers toggled by `d-none d-md-block` / `d-md-none`, not a media query).
- **Pedal tracks.** The rotated range input keeps a fixed 150 px length; its
  wrapper is `col-6`/`col-lg-2` so it re-flows rather than resizing.
- **Battery + thermometer.** Fixed 150 px tall (as today), side by side in a
  `d-flex gap-3` inside the state column.

**Collapse** (removed below a breakpoint by a Bootstrap display utility):

| Element | Utility | Why it is safe to drop |
|---|---|---|
| Thermometer graphic | `d-none d-md-flex` | the temperature chart and the numeric °C readout both survive |
| "Current — commanded (est.)" readout | `d-none d-sm-block` | it is a client-side estimate (`page.py:315-321`); the *achieved* current is the measured one and stays |
| Header sim-speed slider | `d-none d-sm-flex` | duplicated into the controls row as `col-12 d-sm-none` |
| Chart column | never hidden | reordered last on `xs` via `order-4` |

**Phone (`xs`, one column), top to bottom:** header → car → state (SOC, temp,
readouts) → controls → charts. Achieved entirely with `order-*` utilities.

### 1.4 The no-scroll budget at 1440×900

| Band | Height |
|---|---|
| Body padding (`py-2`, top + bottom) | 16 px |
| Header | 48 px |
| Gutter (`g-3`) | 16 px |
| Main row (tallest column: state = 150 px gauges + 8 px + 2×2 readouts ≈ 120 px + card padding 24 px) | 302 px |
| Gutter | 16 px |
| Controls row (pedal track 160 px + label 20 px + value 18 px + card padding 24 px) | 222 px |
| **Total** | **620 px** |

At 900 px viewport minus ~90 px of Quix Portal / browser chrome → 810 px usable.
620 px leaves ~190 px of headroom, which the car column absorbs (`ratio-16x9` at
a 5/12 × 1440 ≈ 590 px column gives 332 px of car — the tallest element, still
inside the main row's share).

**Acceptance test (Tester):** at a 1440×900 viewport,
`document.body.scrollHeight <= window.innerHeight` is true with every control at
its default value **and** with every control at its extreme. At 390×844
(iPhone-class), the page scrolls vertically only, and no element overflows
horizontally: `document.body.scrollWidth <= window.innerWidth`.

---

## 2. Making the sim reach interesting states faster

### 2.1 What is actually slow — the diagnosis the two knobs answer

Every figure below is computed from `plant/parameters.json` defaults and
`plant/main.py`'s own formulas; the derivation is given each time.

`ocv_lookup` (`plant/main.py:275-278`) gives OCV = 720 + 120·SOC, so **780 V at
the 50 % SOC the sim starts at** (`main.py:325`, `q_act = Q_MAX / 2`).

| State worth reaching | Governing quantity | Time at 250 kW plug charge | Time at 60 kW pedal |
|---|---|---|---|
| 10 % of SOC traversed | `Q_MAX = Q_MAX_AH × 3600` (`main.py:90`) | 112 s | 468 s (7.8 min) |
| Derating band entered (20 → 50 °C) | `dT/dt = A_THERMAL·KT2·I²` (`main.py:406-415`) | 53 s | 912 s (15.2 min) |
| RC2 settled (5·τ₂) | `TAU2 = 600 s` | 3000 s (50 min) | 3000 s (50 min) |

Working:
- 250 kW at 780 V → |I| = 250000/780 = **320.5 A** (inside `dc_current_a`'s
  declared ±400 A range in `signals.json`).
- 60 kW (`PEDAL_DISCHARGE_MAX_W`, `battery-sim-ui/main.py:32`) at 780 V →
  **76.9 A**.
- 10 % of SOC at 100 Ah = 0.10 × 360 000 C = 36 000 C. 36 000/320.5 = **112.3 s**;
  36 000/76.9 = **468 s**.
- `dT/dt = A_THERMAL × KT2 × I² = 0.0002 × 0.0278 × I²`. At 300 A that is
  **0.500 °C/s**, which reproduces `parameters.json`'s own stated derivation for
  `KT2` ("|I| = 300 A gives +1 °C per 2 s") exactly — the arithmetic is
  self-checking. At 320.5 A: 0.571 °C/s → 30 °C in 53 s. At 76.9 A: 0.0329 °C/s
  → 30 °C in 912 s.

**Conclusion.** A smaller pack shortens exactly one row of that table. `TIME_SCALE`
shortens all three, by the same factor, without altering a single published
number. **`TIME_SCALE` is the primary control; `Q_MAX_AH` is a secondary,
deployment-only default.**

### 2.2 (a) Smaller battery — `Q_MAX_AH` as a deployment variable

`Q_MAX_AH` is `tunable: false` (`parameters.json:21`) and is hoisted into the
module constant `Q_MAX` at import (`main.py:90`). Line 84 seeds every parameter
from `os.getenv(name)`, so it **is** settable per deployment and needs a restart
to change; `apply_updates` refuses a live write with
`Rejected parameter 'Q_MAX_AH': fixed at deploy time` (`main.py:181-183`). Zero
plant edit.

**Recommended value: `Q_MAX_AH = 25.0`** (lexicon range 1.0–1000.0, so legal).

| `Q_MAX_AH` | `Q_MAX` | 10 % of SOC | Seconds at 250 kW (320.5 A) | Full 0→100 % |
|---|---|---|---|---|
| 100.0 (default) | 360 000 C | 36 000 C | **112.3 s** | 1123 s (18.7 min) |
| **25.0 (recommended)** | 90 000 C | 9 000 C | **28.1 s** | 281 s (4.7 min) |

25 Ah at 780 V is a ~19.5 kWh pack. That is small for an 800 V car — 250 kW into
it is a ~12.8 C rate — and that is the honest cost of this knob: it buys SOC
speed by making the pack unphysical relative to the charge rates the UI offers.
It is recommended as the *deployment default* precisely because it is reversible
in one Portal variable edit and touches no code; it is **not** the primary answer.

Declared in two places (both **already outside the vendored plant folder**, so no
`PLANT_ORIGIN` implication):

- `battery-trace-gen/app.yaml` — new `FreeText` variable `Q_MAX_AH`,
  `defaultValue: "25"`, `required: false`, description naming the restart
  requirement.
- `quix.yaml`, the `Battery Sim` block (line 408) — `- name: Q_MAX_AH` /
  `value: "25"`.

### 2.3 (b) Time scale — `TIME_SCALE`, a new **tunable** lexicon parameter

#### The decision: (ii) tunable, not (i) env-only

Both `tunable: false` parameters carry a *stated reason* in the lexicon, and
neither reason applies here:

- `Q_MAX_AH`: "SOC = q_act / Q_max, so a mid-run change steps the SOC reading."
- `SAMPLE_TIME`: "it sets the loop rate **and** both RC filter coefficients, so a
  mid-run change breaks continuity twice over."

`TIME_SCALE` divides **only the sleep**. It appears in no state update, no filter
coefficient, no integral. Changing it mid-run breaks no continuity whatsoever —
the published series is bit-identical for any value of `TIME_SCALE`; only the
wall-clock rate at which ticks arrive changes. There is therefore no reason to
pin it at deploy time, and one strong reason not to: the demo interaction is
"race through the boring part at ×20, drop back to ×1 to watch the derating
engage." A redeploy per speed change destroys that.

It rides the path that already exists — `handle_command` → `apply_updates` →
`coerce` (`main.py:141-198`) — which already rejects a non-numeric, a bool, and
an out-of-range value. **No new validation is written anywhere.**

#### The exact `parameters.json` descriptor

Appended as the 19th entry in `plant/parameters.json`:

```json
{
  "name": "TIME_SCALE",
  "label": "Simulation Speed",
  "description": "Wall-clock compression factor. Divides the inter-tick sleep only: the integration step stays SAMPLE_TIME, so every published value is identical at any speed and only the rate at which ticks arrive changes. Tunable because it enters no state update and no filter coefficient. The minimum of 1.0 is what makes the divide safe.",
  "datatype": "float",
  "unit": null,
  "default": 1.0,
  "min": 1.0,
  "max": 50.0,
  "enum": null,
  "direction": null,
  "tunable": true
}
```

`min: 1.0` is load-bearing and is called out in the description: it is the reason
`SAMPLE_TIME / p["TIME_SCALE"]` needs no zero-check. Per the light-functional
rule, **no guard is written** — the lexicon is the guard, and a second one in
front of it is exactly the construct the rule forbids.

`max: 50.0` is a throughput decision, not a physics one: at ×50 the plant
publishes `1 / (0.1/50)` = **500 msg/s** on `battery-data` (a ~350-byte JSON
payload → ~175 KB/s on a 1-partition topic). That is comfortable; ×100 starts to
matter. See OQ 3.

#### The exact statements to change in `plant/main.py` — **ONE**

```diff
@@ plant/main.py:455  (inside run_simulation's while-loop body)
-            time.sleep(SAMPLE_TIME)
+            time.sleep(SAMPLE_TIME / p["TIME_SCALE"])
```

That is the entire Python patch. Justification that `p` is in scope: `p =
dict(params)` is taken under `state_lock` at `main.py:338`, at the top of the
same `while True:` body that line 455 closes, so line 455 reads the *same
per-tick snapshot* every other parameter read in the loop uses — no torn read,
no extra lock, no module-global read inside the loop (the invariant
`run_simulation`'s docstring states at `main.py:313-314`).

No change to `_recompute_derived` (`TIME_SCALE` enters neither ALPHA), none to
`ocv_lookup`, `solve_dc_current`, the coulomb counting, the RC updates or the
thermal integration. Every `* SAMPLE_TIME` in the body stays exactly as it is —
that is the whole point.

#### `PLANT_ORIGIN` must be updated in the same change

`battery-trace-gen/PLANT_ORIGIN` currently says "THE FOUR EDITS" and "lexicon.py
and parameters.json are byte-identical to the commit above". Both statements
become false. The same change must:

1. Rename the section **THE SIX EDITS**.
2. Add edit **(5)** — the `main.py:455` sleep divisor above, quoted as a diff,
   with the one-line rationale: "divides the sleep only; the integration step is
   unchanged, so the offline generator and the four trace hashes are untouched
   (`plant/loader.py:160` replaces `main.time` with a shim whose `sleep` discards
   its argument)."
3. Add edit **(6)** — the `TIME_SCALE` descriptor appended to `parameters.json`.
4. Delete the "parameters.json is byte-identical" claim; keep the claim for
   `lexicon.py`.
5. Refresh the recorded sha256 for `main.py` and `parameters.json`.

This is not bookkeeping. `dev-planning/battery-can-traces/test-report-round1.md`
line 17 records a Tester gate that diffs the vendored plant against `cae68bd7`
and asserts *exactly* the three statements and the byte-identical
`parameters.json`. That check is written against PLANT_ORIGIN's claims, so
updating PLANT_ORIGIN in the same commit is what keeps it green. **ArchDev must
re-run that diff check after the patch and Tester must re-confirm it.**

#### `model.version` is deliberately not bumped

`load_lexicon` compares only `model.name` between the two documents
(`plant/lexicon.py:52-59`) and takes `model` wholesale from `signals.json`
(`lexicon.py:64`). Bumping `parameters.json`'s version alone would leave the
merged view — and the `[STARTUP]` log — still reporting 1.1.0, i.e. a lie.
Bumping both would drag `signals.json` into the patch set for no functional gain.
**Recommendation: leave `model.version` at 1.1.0 in both.** PLANT_ORIGIN is this
fork's statement of record, and it is where the divergence is declared.

### 2.4 Hard constraint — the offline generator and the four trace hashes

**Verified: the change does not touch that path at all. The four hashes cannot
move as a consequence of this spec.**

The argument, from source:

1. `plant/loader.py:160` replaces the plant's `time` module outright:
   `module.time = SimpleNamespace(sleep=driver.sleep, monotonic=time.monotonic)`.
2. `_Driver.sleep(self, _seconds)` (`loader.py:92-98`) **discards its argument** —
   the parameter is named `_seconds` and is never read. It advances the tick
   counter, raises `_StopSimulation` at the tick budget, and pushes the pending
   setpoints. No wall-clock sleep happens at all; the whole offline run is
   single-threaded and deterministic, exactly as `loader.py`'s module docstring
   describes.
3. Therefore `time.sleep(SAMPLE_TIME / p["TIME_SCALE"])` evaluates to
   `driver.sleep(0.1)` instead of `driver.sleep(0.1)` — the *same call*, since
   `TIME_SCALE` defaults to 1.0 and no scenario sets it — and even if it did, the
   value is thrown away.
4. The integration step remains `SAMPLE_TIME` at every one of `main.py:390`
   (coulomb counting), `main.py:414` (heat) and `main.py:116` (ALPHA). Not one of
   those lines is edited.
5. `runner.py:45-106` reads `handle.dt_s` (= `module.SAMPLE_TIME`,
   `loader.py:120`) and three `effective_params` entries
   (`CHILLER_POWER_LOW/HIGH`, `COOLANT_TEMP`). Adding a 19th parameter adds a key
   to `effective_params` that nothing reads: `manifest.py:220` is the only other
   consumer of `run.plant` and it reads `Q_MAX_AH` alone. The dict is never
   serialised into `manifest.json`, and `generate.py:94-109` passes no plant
   parameters into `mf4.write` — the MF4 bytes derive from the frame log, the
   DBC, and the explicit identity/test arguments.
6. `plant/tests/test_polarity.py` drives the plant through the same
   `loader.drive` shim, so all four of its assertions are untouched.

**The one way the hashes could still move, and the rule that prevents it.**
`main.py:84` seeds every parameter from `os.getenv(name)` at import, and
`main.py:23` calls `load_dotenv(override=False)`. `plant/loader.load()` imports
the plant **inside the generator's own process**, and `Q_MAX` is hoisted at
import (`main.py:90`) *before* `module.params.update(scenario.plant_params)` ever
runs (`loader.py:114-116`) — so a scenario override of `Q_MAX_AH` would **not**
reach `Q_MAX`, but a `Q_MAX_AH` in the developer's shell environment or in
`battery-trace-gen/.env` **would**, and it would move all four hashes.

**Rule, to be stated in `battery-trace-gen/README.md` in the same change:**
`Q_MAX_AH` is a *deployment* variable of the `Battery Sim` service only. It must
never appear in `battery-trace-gen/.env` or in the shell that runs `generate.py`.
`TIME_SCALE` carries no such hazard (its value is discarded offline), but the
same rule is cheapest applied to both.

Related, and unaffected: `battery-trace-gen/seed/implementation_cases.py:24`
hardcodes the pack capacity at 100 Ah for the test implementations that will run
against the lake (BL-11). Those evaluate the *recorded traces*, which are
generated with the default 100 Ah. Setting `Q_MAX_AH = 25` on the live service
does not touch them. Do not "helpfully" parameterise that constant.

---

## 3. Car visualisation

### 3.1 Which signal drives the wheels

**The plant publishes no road speed.** Its `direction: "output"` signals
(`signals.json`) are `soc_percent`, `q_act_as`, `ocv_v`, `dc_voltage_v`,
`dc_current_a`, `rc1_voltage_v`, `rc2_voltage_v`, `temperature_c`, `heat_j`,
`derating_factor`, plus the `requested_power_w` / `ambient_temp_c` echoes. It is
a pack model, not a vehicle model — v1's spec §2c already recorded this ("the
model has no vehicle-speed state — it is a battery-only proxy").

Speed is therefore **derived in the browser** from the two published signals that
carry achieved electrical power:

```
P_pack_W = dc_voltage_v × dc_current_a
```

Both names are from `signals.json`. `dc_current_a` is **battery-sign** after
PLANT_ORIGIN's patch: positive = discharge. So `P_pack_W > 0` is power leaving
the pack — tractive power — and `P_pack_W < 0` is power entering it, which is
either regen or the plug.

Driving the wheels from the *achieved* current rather than from the browser's own
pedal state is deliberate and matches the architecture doc's existing
commanded-vs-achieved framing: when thermal derating engages
(`derating_factor < 1`), `dc_current_a` falls, and the car visibly stops pulling
even though the pedal has not moved. That is the mechanism the dashboard exists
to show.

### 3.2 The vehicle model — six display constants

A first-order longitudinal model, integrated in the browser:

```
P_wheel_N·m/s = P_pack_W × DRIVELINE_EFF
F_trac_N      = P_wheel_W / max(v_mps, V_FLOOR_MPS)
F_resist_N    = K_DRAG_N_PER_MPS2 × v_mps²  +  K_ROLL_N
a_mps2        = (F_trac_N − F_resist_N) / VEHICLE_MASS_KG
v_mps         = max(0, v_mps + a_mps2 × dt_sim_s)
omega_rad_s   = v_mps / WHEEL_RADIUS_M
```

**Provenance of the constants.** None of these exist anywhere in this repository —
no vehicle model does. They are **display constants**, declared exactly the way
v1 declared `PEDAL_DISCHARGE_MAX_W` / `PEDAL_CHARGE_REGEN_MAX_W` /
`DC_CHARGE_MAX_W`: named in `battery-sim-ui/main.py`, overridable per deployment
as `app.yaml` FreeText variables, echoed on `GET /config`, and carried as an open
question (OQ 4) rather than silently asserted. v1's own spec §10 set that
precedent in the same words ("reasonable EV-scale defaults, not derived from any
spec in this repo — confirm with the user").

| Constant | Value | Derivation |
|---|---|---|
| `VEHICLE_MASS_KG` | 2000 | stated; mid-size EV kerb mass |
| `K_DRAG_N_PER_MPS2` | 0.40 | ½·ρ·Cd·A with ρ = 1.20, Cd = 0.28, A = 2.4 m² → 0.403 |
| `K_ROLL_N` | 196 | Crr·m·g = 0.010 × 2000 × 9.81 |
| `DRIVELINE_EFF` | 0.90 | stated |
| `V_FLOOR_MPS` | 5.0 | the **launch floor**: below 5 m/s the tractive force is held at its 5 m/s value. This is the bound that keeps `P/v` finite at standstill *and* the only thing limiting launch acceleration — one constant doing both jobs, instead of a separate `F_MAX` clamp |
| `WHEEL_RADIUS_M` | 0.34 | 235/45R18 rolling radius |

**Sanity of the resulting behaviour**, so the numbers are checkable at review:

- Terminal speed at 60 kW pedal: 0.9 × 60000 = 54 kW; solving
  54000 = (0.403 v² + 196)·v gives v ≈ 48 m/s ≈ **173 km/h**.
- Launch acceleration: at v ≤ 5 m/s, F_trac = 54000/5 = 10 800 N, F_resist ≈ 206 N,
  a = **5.30 m/s²** → 0–100 km/h in roughly 7 s once drag is included.
- Regen braking at 30 m/s with the 20 kW regen ceiling: F_trac = −600 N,
  F_resist = 559 N → a = **−0.58 m/s²**.
- Coasting at 30 m/s: F_trac = 0 → a = **−0.28 m/s²**.

So regen decelerates about twice as hard as coasting at cruise, and much harder at
low speed (−1.9 m/s² at 5 m/s). That difference is real but subtle, which is why
§3.4 adds a discrete cue.

### 3.3 `dt_sim_s` — and why the car speeds up with `TIME_SCALE`

The integrator runs in **sim time**, not wall time:

```
dt_sim_s = dt_wall_s × TIME_SCALE
```

`TIME_SCALE` is read from the block the plant **already publishes**:
`payload.applied.parameters.TIME_SCALE` (`main.py:444-449`, emitted on the first
tick after startup — `_echo_due = True` at `main.py:102` — on every change, and
otherwise every `APPLIED_ECHO_PERIOD_S` = 5 s). No new field, no new endpoint.
The page holds the last echoed value, defaulting to 1.0 until the first echo
arrives.

This makes the whole picture coherent: at ×20 the SOC drains 20× faster **and**
the car drives 20× faster and the wheels spin 20× faster. A wall-time integrator
would show a car crawling along while the battery empties in seconds, which reads
as a bug. The cost is wheel-spoke aliasing at high scale — see OQ 5.

### 3.4 Reading acceleration, coasting and braking apart

The test is on the **wire signal**, not the local pedal state, with one exception.
`dc_current_a` is exactly `0.0` when the requested power is exactly 0 — with
`R0 = 0`, `solve_dc_current` returns `power / v_oc_eff` = 0 and the negation gives
`-0.0` — and both pedals at 0 send exactly `requested_power_w = 0`
(`battery-sim-ui/main.py:67-70`). So **exact sign tests are sufficient and no
deadband is invented.**

| Condition, evaluated per poll | Car reads |
|---|---|
| `state.charge_plug` (the browser's own, already tracked at `page.py:302`) | **Charging.** `v` forced to 0, wheels still, charge-cable graphic, inbound energy arrow scaled by \|`dc_current_a`\|, brake lamps off |
| `dc_current_a > 0` | **Drive.** F_trac positive, wheels spin up, brake lamps off |
| `dc_current_a === 0` | **Coast.** F_trac zero, wheels spin down on `F_resist` alone, brake lamps off |
| `dc_current_a < 0`, plug out | **Regen braking.** F_trac negative, wheels spin down harder, **brake lamps on**, rear glow + the regen arrow |
| `v_mps < 0.1` | **Standstill.** Rotation frozen; wheels hold their last angle (no snap to 0°) |
| Poll stalled — the existing `Date.now() - lastGoodPoll >= POLL_MS * 4` test at `page.py:510` | **Stalled.** Integrator frozen: `v` held, wheel angle stops advancing, car desaturated (`opacity-50`). The live dot already goes grey. Do **not** extrapolate — a car still driving on dead data is the one wrong answer here |

The plug case is the only one that reads the browser's own state, because
`dc_current_a < 0` alone cannot distinguish a plug from regen — the plant sees the
same positive `requested_power_w` either way (v1 spec §10 recorded exactly this
ambiguity as an open question; the browser already owns the disambiguating bit).

A **mode chip** next to the km/h readout spells the state out in words —
`Drive` / `Coast` / `Regen` / `Charging` / `Stalled` — so the state never depends
on colour alone, matching the architecture doc's colour-independence rule.

### 3.5 Rendering — inline SVG + `requestAnimationFrame`

**Inline SVG** in `PAGE_HTML`: one static `<path>` body, two `<g>` wheel groups
each holding a tyre `<circle>`, a rim `<circle>` and 5 spoke `<line>`s, plus two
brake-lamp `<rect>`s whose `fill` toggles with the mode. No external asset, no
image request, no new dependency.

**`requestAnimationFrame` advances the angle; the poll only updates ω.** This is
forced by the numbers: at 48 m/s the wheel turns at 48/0.34 = 141 rad/s ≈ 22.5
rev/s, while the poll runs at `POLL_MS = 150` ≈ 6.7 Hz (`page.py:285`). Stepping
the transform on the poll would show ~3.4 revolutions of jump per update — a
strobe, not a wheel. The rAF loop integrates
`angle_deg += omega_rad_s × 180/π × dt_frame_s` and writes one
`transform="rotate(angle, cx, cy)"` per wheel per frame. The same loop integrates
`v_mps` (§3.2), so speed and rotation never disagree.

**Rejected: CSS `@keyframes` + `animation-duration`.** Changing the duration
restarts the animation, so every speed change snaps the wheel back to 0°.
Continuously-varying rate is precisely what keyframes cannot do.

**Rejected: `<canvas>` / WebGL / a sprite sheet.** The scene is one static shape
plus two rotating groups. SVG does that in the DOM with two attribute writes per
frame; anything heavier buys nothing and adds a redraw path that has to be kept
in sync with the Bootstrap layout's resizing. (The four charts stay on `<canvas>`
— they already are, and a 400-point polyline is the case canvas is right for.)

---

## 4. Wiring

### 4.1 The complete control → field table

| Control | UI range | Field written | Envelope | Plant behaviour | Lexicon range |
|---|---|---|---|---|---|
| Accel slider | 0–100 % | (via `requested_power_w()`) | `signals.requested_power_w` | setpoint for `solve_dc_current` | −250 000…250 000 W |
| Brake slider | 0–100 % | same | `signals.requested_power_w` | same | same |
| Charge plug + rate | 0–`DC_CHARGE_MAX_W` (250 000 W) | same | `signals.requested_power_w` | same | same |
| Ambient slider | −40…60 °C | `ambient_temp_c` | `signals` | `KE·(T − T_amb)` term | −40…60 °C |
| Chiller knob | 0 / 1 / 2 | `chiller_setting` | `signals` | `power_map` + `COOLANT_TEMP` clamp | enum {0,1,2} |
| Heater knob | 0 / 1 / 2 | `heater_setting` | `signals` | `power_map` | enum {0,1,2} |
| **Sim speed slider** (new) | **1–50, step 1** | **`TIME_SCALE`** | **`parameters`** | **divides the sleep only (`main.py:455`)** | **1.0–50.0** |
| Car visualisation | — | — | — | read-only; writes nothing | — |
| Layout changes | — | — | — | write nothing | — |

**`TIME_SCALE` is the only new write this spec introduces.**

### 4.2 Range confirmation — the lexicon rejects, it does not clamp

- The sim-speed slider's `min="1" max="50"` are **exactly** the descriptor's
  `min`/`max` (§2.3). No value the slider can emit is out of range, so
  `apply_updates` never logs a rejection for it and the knob never snaps back.
- The slider emits integers. `coerce` accepts an `int` where a `float` is
  expected — "an `int` is acceptable where a `float` is expected but not the
  reverse" (`main.py:144-148`, implemented at lines 159-163). Confirmed from
  source; no cast is strictly required. `/command` casts with `float(...)`
  anyway, matching how it already handles `ambient_temp_c`
  (`battery-sim-ui/main.py:110`).
- Every existing control's UI range already sits inside its lexicon range
  (table above); v2 changes none of them.

### 4.3 The envelope and the QuixStreams primitive

`POST /command` gains one field in its request body and one object in the message
it produces:

```json
{ "signals":    { "requested_power_w": …, "ambient_temp_c": …,
                  "chiller_setting": …, "heater_setting": … },
  "parameters": { "TIME_SCALE": 10.0 } }
```

`handle_command` already reads both objects independently
(`main.py:233-247`) — `signals` and `parameters` each apply field-by-field, and
`_recompute_derived()` re-runs after the parameter write, as it does after every
parameter write. **No plant change is needed for the envelope; only the one
sleep statement.**

**No new route and no second produce.** The existing handler builds one message
and calls `output_topic.serialize(...)` + `producer.produce(...)`
(`battery-sim-ui/main.py:114-115`) — the `Application` / `app.topic()` /
`get_producer()` idiom already in place. v2 adds the `parameters` key to that same
dict. No hand-rolled Kafka client appears anywhere; the consumer side stays
`consumer_app.dataframe(input_topic).update(update_latest)` +
`consumer_app.run(sdf)` exactly as today.

The browser already POSTs its whole `state` object every time
(`page.py:328-334`, `JSON.stringify(state)`), so `time_scale` is present on every
request and `/command` reads it directly — no default, no fallback, matching the
`os.environ["input"]` reasoning already recorded in the architecture doc.

### 4.4 Two consequences worth knowing, neither a defect

- `apply_updates` returns `True` whenever a field is *taken*, not whenever it
  *differs* (`main.py:195-197`), so every `/command` POST already forces
  `_echo_due = True` and an `applied` block on the next tick. That is today's
  behaviour for the four signals; adding `TIME_SCALE` changes nothing about it.
  Do not "fix" it — the echo is cleared per tick, not per message.
- `GET /battery/data` serves the last value only (`latest`, `main.py:91-94`). At
  ×50 the plant publishes 500 msg/s and the browser samples ~6.7/s, so the charts
  decimate 75:1. That is correct and intended: the 60 s rolling window
  (`MAX_POINTS = 400` at `POLL_MS = 150`) is a **wall-clock** window that now
  spans 50× more sim time. The chart titles gain a `(×N)` suffix from the echoed
  `TIME_SCALE` so a reader knows which it is.

---

## 5. Files touched

### `battery-sim-ui/` (ArchDev + FrontEndEsthetic)

| File | Change |
|---|---|
| `page.py` | Replaced `PAGE_HTML`: Bootstrap 5.3 CDN link + `data-bs-theme="dark"`, the §1.2 grid, the inline SVG car and its rAF loop, the sim-speed slider, the mode chip, chart canvases wrapped in `.ratio`. The `<style>` block shrinks to widget internals only and must contain no `@media` rule. |
| `main.py` | `/command` reads `time_scale` and adds `"parameters": {"TIME_SCALE": …}` to the produced message. `/config` gains the six vehicle constants and `time_scale_min` / `time_scale_max`. The six constants are declared as `float(os.getenv(...))` module constants beside the three existing ceilings (lines 32-34). |
| `app.yaml` | Six new `FreeText` variables: `VEHICLE_MASS_KG`, `K_DRAG_N_PER_MPS2`, `K_ROLL_N`, `DRIVELINE_EFF`, `V_FLOOR_MPS`, `WHEEL_RADIUS_M`. |
| `README.md` | New variables, the car model's formula, the sim-speed control. |

### `battery-trace-gen/` (ArchDev)

| File | Change |
|---|---|
| `plant/main.py` | **One statement**, line 455: `time.sleep(SAMPLE_TIME / p["TIME_SCALE"])`. |
| `plant/parameters.json` | One new descriptor (§2.3), appended. `model.version` unchanged. |
| `PLANT_ORIGIN` | "FOUR EDITS" → "SIX EDITS"; add edits (5) and (6); drop the `parameters.json` byte-identical claim; refresh the `main.py` and `parameters.json` sha256 lines. |
| `app.yaml` | New `FreeText` variable `Q_MAX_AH`, `defaultValue: "25"`, description stating the restart requirement. |
| `README.md` | The rule from §2.4: `Q_MAX_AH` is a deployment variable of `Battery Sim` only and must never enter `battery-trace-gen/.env` or the shell that runs `generate.py`. |

### Root (ArchDev)

| File | Change |
|---|---|
| `quix.yaml` | `Battery Sim` block (line 408): add `Q_MAX_AH: "25"`. `Battery Sim UI` block (line 426): add the six vehicle variables. No topic changes — `battery-data` / `ui-data` are unchanged, 1 partition each. |

### Docs (DocuGuy, after the build)

| File | Change |
|---|---|
| `docs/architecture-battery-sim-ui.md` | New sections: the Bootstrap decision, the `TIME_SCALE` patch and why it cannot move the trace hashes, the vehicle model and its display constants. Update the file-inventory table. |
| `dev-planning/backlog.json` | New item for this feature; the generated table in `CLAUDE.md` follows from `tools/gen_claude_md.py`. **Neither file is edited by hand.** |

### Not touched

`frontend/`, `api/`, `mf4-decoder/`, `tm-connector/`, `mf4-to-blob/`,
`dcm-seed-dbc/`, `battery-trace-gen/{runner,generate,manifest,scenario}.py`,
`battery-trace-gen/{bus,controller,scenarios,data,specs,seed}/`,
`plant/lexicon.py`, `plant/signals.json`, `plant/loader.py`,
`plant/tests/test_polarity.py`.

---

## 6. Open questions

**OQ 1 — Is `Q_MAX_AH = 25` the right deployment default, or should the pack stay
at 100 Ah?**
*Recommended: ship `Q_MAX_AH = 25`.* It quarters the SOC traverse (112 s → 28 s
at 250 kW) for a one-line Portal edit and is reversible in one. The cost is a
~19.5 kWh pack taking a 12.8 C charge, which is unphysical; if the demo's
audience is engineers who will notice, set it back to 100 and lean on
`TIME_SCALE`, which distorts nothing.

**OQ 2 — Is the `TIME_SCALE` patch to the vendored plant acceptable at all?**
*Recommended: yes.* It is one statement, it is recorded in `PLANT_ORIGIN` the way
the polarity patch was, and it provably cannot reach the offline generator
(§2.4). The alternative — an env-only constant — costs two statements instead of
one, still patches the vendored file, and gives up the live slider that is the
whole feature. If the answer is no, the fallback is `Q_MAX_AH` alone, and the
spec should record that RC2 relaxation (50 min) then stays unreachable in a demo.

**OQ 3 — Is `max: 50.0` the right ceiling?**
*Recommended: yes.* ×50 is 500 msg/s and ~175 KB/s on a 1-partition topic —
comfortable, and 50× turns the 50-minute RC2 settle into 60 s of wall clock,
which is the slowest thing in the model. Raising the ceiling later is a one-line
lexicon edit, but it is a lexicon edit, so pick once.

**OQ 4 — The six vehicle constants have no provenance in this repo. Accept them
as display constants, or does the user have real numbers?**
*Recommended: accept them as `/config` display constants*, exactly as v1 accepted
`PEDAL_DISCHARGE_MAX_W = 60 kW` and `PEDAL_CHARGE_REGEN_MAX_W = 20 kW` under the
same open question. They are FreeText variables, so a real number replaces one
without a rebuild. The resulting behaviour is checkable against §3.2's four
sanity figures (173 km/h terminal, 5.3 m/s² launch, −0.58 vs −0.28 m/s² regen vs
coast).

**OQ 5 — Wheel-spoke aliasing.** At 48 m/s the wheel turns 22.5 rev/s; at 60 fps
that is 0.37 rev/frame, so 5 spokes will strobe and appear to rotate backwards —
and `TIME_SCALE` multiplies the problem.
*Recommended: cap the **displayed** angular rate at 2 rev/s (4π rad/s) and put the
true speed in the km/h readout beside the car.* The cap is a rendering bound, not
a model change: `v_mps` keeps integrating unclamped and the km/h number stays
truthful. State the cap in the SVG's own comment. The alternative — accepting the
strobe because real video does too — makes "is it accelerating?" unreadable at
exactly the moment the demo wants it readable.

**OQ 6 — Does the Quix Portal frame permit a third-party CDN?** The Bootstrap
stylesheet is fetched by the *user's browser*, not the container, so it works for
the public `battery-sim` URL; a Content-Security-Policy on the framing page could
still block it.
*Recommended: start with the CDN `<link>` and verify in the Portal during QA.* If
it is blocked, vendor `bootstrap.min.css` into `battery-sim-ui/` and serve it from
a Flask static route — a one-file change, no layout rework, since the class names
are identical either way.

**OQ 7 — Should the sim-speed slider snap back to ×1 on page load?** The plant
keeps `TIME_SCALE` across a browser reload (state lives in the plant, and the
`applied` echo restores the knob).
*Recommended: do not snap back.* Read the echoed `applied.parameters.TIME_SCALE`
and set the slider from it, which is precisely the documented purpose of that
block (`main.py:441-443`). Forcing ×1 on load would mean every reload silently
writes a parameter the user did not touch.

**OQ 8 — Is `dc_current_a === 0` a safe coast test in JavaScript?** The plant
rounds to 4 decimal places (`main.py:435`) and `-0.0 === 0` is true in JS, so the
test holds for the exact-zero case argued in §3.4. It does **not** hold if a
future scenario sets `R0 ≠ 0`, which PLANT_ORIGIN already forbids for the trace
path but not for the live service.
*Recommended: keep the exact test and add nothing.* If `R0` is ever made non-zero
on the live plant, the coast case degrades to a very small F_trac, which is
visually identical to coasting anyway. Inventing a deadband now would be a guard
against a value the contract says does not arrive.

---

## 7. References

- `battery-sim-ui/main.py`, `page.py`, `app.yaml` — the shipped v1 service.
- `battery-trace-gen/plant/main.py` (lines 84, 90-91, 102, 116, 141-198, 233-247,
  325, 390, 414, 441-455), `parameters.json`, `signals.json`, `lexicon.py`.
- `battery-trace-gen/plant/loader.py` (lines 92-98, 120, 160) — the shim that
  makes §2.4's argument.
- `battery-trace-gen/runner.py`, `generate.py`, `manifest.py:220`.
- `battery-trace-gen/PLANT_ORIGIN` — the vendoring pin and the four recorded edits.
- `dev-planning/battery-sim-ui/spec.md` — v1, including the appended "Template
  facts" and "Charging — decided by the user" sections.
- `docs/architecture-battery-sim-ui.md` — v1 as built.
- `dev-planning/battery-can-traces/test-report-round1.md:17` — the vendored-plant
  diff gate that §2.3 must keep green.
- `quix.yaml` lines 408-471 — the two deployments and the two topics.
- Skills: `quixstreams-idioms`, `quix-service-create`, `quix-python-base-image`.
