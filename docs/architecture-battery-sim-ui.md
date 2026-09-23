# Battery Sim UI — architecture

## What this is

A live, browser-driven front end for the vendored `dc-battery-sim` plant. Two
Quix Cloud services, joined by two Kafka topics: `Battery Sim` (application
folder `battery-trace-gen`) runs the model and ticks its state every
`SAMPLE_TIME / TIME_SCALE` seconds; `battery-sim-ui` serves a Flask
page that polls that state and turns pedal/charge/ambient/heater/chiller/
sim-speed input into the plant's write envelope. A non-specialist pushes an
accelerator or brake slider, or plugs in and sets a charge rate, and watches
SOC, terminal voltage, current and temperature respond within one poll cycle —
and watches a car accelerate, coast and regen-brake on the same numbers.

## Why this architecture

**Two deployments, not one.** The plant (`battery-trace-gen/plant/main.py`) is
already a complete, self-contained QuixStreams service — a consumer thread
applies live writes, a producer thread ticks the model. Deploying it standalone
and building a thin UI around its topics costs two deployments but zero
duplicated model logic and zero risk of a UI-owned copy drifting from the
pinned, patched vendor code (`battery-trace-gen/PLANT_ORIGIN`). Importing the
vendored module into the Flask process, or re-vendoring it a second time, were
both rejected for the same reason: two copies of a hand-patched sign
convention is how they quietly diverge.

**Polling, not WebSockets.** The actual extracted template (Flask + waitress,
a `latest` dict under a lock, `GET /battery/data` at 150 ms, `POST /command`)
already implements exactly this shape with no extra dependency. A WebSocket
under Flask/waitress would need one. The brief's polling directive (5–10 Hz)
is followed literally: `POLL_MS = 150` in `page_script.py`, giving ~6.7 Hz,
comfortably under the plant's own 10 Hz tick rate at `TIME_SCALE = 1`. Above
×1 the plant outruns the poll and the browser samples it — see *Simulation
speed*.

**The folder that owns the vendored plant is the application folder.**
`battery-trace-gen/` is the `Battery Sim` application, and the deployed
entrypoint is `plant/main.py`. This is forced by how Quix builds: the docker
build context is the *application's own folder*, not the repository root, so
nothing outside the application folder can be `COPY`ed into the image. An
earlier arrangement — a root-level `battery-sim-plant/` carrying only build
files, whose dockerfile `WORKDIR`ed across to the sibling `battery-trace-gen/plant`
— failed for exactly that reason: `COPY . .` carried only the four build files,
`WORKDIR` then silently *created* an empty `/app/battery-trace-gen/plant`, and
the container crash-looped on `can't open file '/app/battery-trace-gen/plant/main.py'`.
Making the owning folder the application folder keeps the single vendored copy
(`PLANT_ORIGIN`) and adds no duplication: the generator and the live service
share one `plant/`, and the only new file inside it is `plant/requirements.txt`
(the service's two deps), which keeps the sim image from installing the
generator's asammdf/cantools/numpy.

The `COPY` paths and the final `WORKDIR` in `battery-trace-gen/dockerfile` are
parameterised by `${MAINAPPPATH}`, so the image is correct whether the build
context is the application folder (`MAINAPPPATH=.`, giving `/app/./plant`) or
the repository root (`MAINAPPPATH=battery-trace-gen`, giving
`/app/battery-trace-gen/plant`). The final `WORKDIR` lands in `plant/`
because `plant/main.py` uses flat imports (`from lexicon import ...`) and so
needs its own directory as the script directory.

**Server-side control law, one function.** `requested_power_w()` in
`battery-sim-ui/main.py` is the single place the pedal/charge law is computed.
The browser sends raw 0–100 % pedal state and raw watts for the charge slider;
Python converts to the plant's powertrain-sign `requested_power_w` once, on
the `/command` path, so there is exactly one implementation to audit against
`PLANT_ORIGIN`'s sign patch.

**No dataviz skill.** This environment carries no `dataviz` skill (checked
`~/.claude/skills/*/SKILL.md`, absent) — same finding Buddy already recorded in
the spec. Absent that guidance, the palette stays the minimal set the extracted
template already used: one blue accent (`#0078d4`) for every line/fill, amber
(`#f0c020`) for "derating active", red (`#e74c3c`) for the hard thermal limit,
green/blue for nominal/cold. Pedal and charge position are read as bar height
and numeric %/kW, never colour-coded, so no control's state depends on colour
alone.

## Sign conventions — where each appears

Two signed quantities exist in this system and they never share an axis:

1. **`requested_power_w`** — powertrain-sign (negative = discharge). This is
   the plant's *input* signal. It is produced by `battery-sim-ui/main.py` onto
   `ui-data` and is **never read back, stored, or rendered anywhere in the
   page modules**. The browser does not even ask for it — `/battery/data`'s
   raw JSON blob (the plant's tick, relayed verbatim) contains
   `requested_power_w` and its `applied.signals.requested_power_w` echo, and
   `updateUI()` touches neither. The one key it does read out of the echo is
   `applied.parameters.TIME_SCALE` (see *Simulation speed* below).
2. **`dc_current_a`** — battery-sign (positive = discharge), the plant's
   *output* current after `PLANT_ORIGIN`'s patch. Every place it renders — the
   "achieved" readout, the "commanded (est.)" readout, the current chart's
   title — carries the literal label `"battery-sign: + discharge / − charge"`.

**Commanded current is not derived from the wire.** `page_script.py`'s
`commandedPowerBatterySignW()` recomputes commanded power independently,
client-side, in battery-sign, from the browser's own pedal/charge/plug state
and the ceilings fetched from `/config` — the same formula as
`requested_power_w()` but sign-flipped and never touching the actual signal
name. Dividing by the latest `dc_voltage_v` gives an estimated commanded
current, displayed next to the achieved (measured) current. This is a stronger
answer than "label the powertrain-sign number" would have been: the page
simply never receives that number, so there is no unlabelled-axis mistake to
make.

## Control laws, as implemented

`battery-sim-ui/main.py::requested_power_w(accel_pct, brake_pct, charge_plug, charge_rate_w)`:

```
if charge_plug:
    return clamp(charge_rate_w, 0, DC_CHARGE_MAX_W)          # positive = charge

net_pct = clamp(accel_pct - brake_pct, -100, 100)
if net_pct >= 0:
    return -net_pct/100 * PEDAL_DISCHARGE_MAX_W               # accelerating -> discharge
else:
    return -net_pct/100 * PEDAL_CHARGE_REGEN_MAX_W            # braking -> regen/charge
```

Constants (named in `main.py`, overridable per deployment as `app.yaml`
FreeText variables, no rebuild required):

| Constant | Default | `app.yaml` variable |
|---|---|---|
| Accelerator ceiling | 250,000 W | `PEDAL_DISCHARGE_MAX_W` |
| Brake/regen ceiling | 80,000 W | `PEDAL_CHARGE_REGEN_MAX_W` |
| Charge-slider ceiling | 250,000 W | `DC_CHARGE_MAX_W` |

The accelerator ceiling was 60 kW and the regen ceiling 20 kW until the pedals
were found to move the pack ~4× slower than the charge plug: at ~780 V, 60 kW
is 77 A against the plug's 320 A, so the achieved-current readout looked stuck
(the plant has no current slew — `dc_current_a` follows `requested_power_w`
inside one 0.1 s tick, `battery-trace-gen/plant/main.py:372`). Discharge is now
symmetric with the charge slider at the lexicon's own ±250 kW limit for
`requested_power_w`; regen stays lower because a real regen path is limited by
the motor, not the pack. Deployment values in `quix.yaml` override these
defaults.

Charging is a third mode, not a pedal blend: toggling the plug switch
client-side disables and zeroes both pedal sliders and enables the charge
slider (`page_script.py`'s `plugToggle` change handler); `requested_power_w()`
enforces the same rule server-side regardless of what the browser sends, so a
stale client can't put the plant into an inconsistent state.

## The "300 A" clamp — what the deployed plant actually does

The brief's framing (250 kW at ~780 V ≈ 320 A, "above `I_current_Chr_Max` =
300 A") describes a parameter that exists in `battery-trace-gen/controller/`
(a separate, richer BMS-controller model used only by the offline trace
generator) — **not** in the deployed `battery-trace-gen/plant/`. The deployed
plant has no instantaneous current-magnitude clamp at all. Its only limiting
mechanism is `derating_lookup()` against the fixed `DERATING_LUT`: factor 1.0
up to 50 °C, linearly down to 0.0 at 60 °C (`MAX_BATTERY_TEMP`, tunable but
capped at 60 in the lexicon). A 250 kW charge command at a cold pack is applied
in full on the very first tick; the commanded/achieved gap only opens up
**after** sustained high `|I|` drives `KT2·I²` self-heating past 50 °C, which
takes real session time at the default thermal constants.

Consequently the UI does not draw a static "300 A" limit line — there isn't
one to draw. It shows the mechanism that is real: `derating_factor` as a live
readout (turns amber below 1.0), the temperature chart shaded amber ≥50 °C and
red ≥60 °C (`DERATE_BAND_START_C` / `DERATE_HARD_LIMIT_C` in `main.py`,
duplicated as display-only constants because the LUT breakpoints aren't
exposed on any topic), and the commanded-vs-achieved current pair, which only
diverges once derating engages. This is the accurate way to satisfy "don't let
the clamp read as a bug" for *this* deployment.

## Layout — Bootstrap 5.3, stylesheet only

The page is one module-level HTML string served verbatim by Flask: no npm, no
bundler, no build step, no `static/` directory. That rules out anything needing
a compile, which is what picks a plain stylesheet over Tailwind (whose Play CDN
compiles in the browser and is not for production) and over the hand-rolled CSS
v1 shipped (zero `@media` rules and a fixed `max-width: 1080px`, so it neither
filled a 1440 px display nor survived a phone).

Bootstrap owns **every** layout and breakpoint decision — `row`/`col-*`,
`order-*`, `d-none d-*-block`, `ratio`. The surviving `<style>` block
(`page_style.py`) is widget internals only and carries no `@media` rule; if a
rule would need one, it belongs in a Bootstrap class instead.

Two consequences worth knowing. The four main columns — state, car, charts,
controls — live in **one** `row`, because `order-*` reorders siblings only and
the phone order (car → state → controls → charts) crosses what would otherwise
be two rows. And the chart canvases take their drawing buffer from their
laid-out box (`sizeCanvases()` on load and on `resize`) rather than from fixed
`width`/`height` attributes, because a `.ratio` wrapper sizes them from the
column width.

The stylesheet is fetched by the user's browser from jsDelivr, not by the
container. A CSP on a framing page could block it; the fallback is to vendor
`bootstrap.min.css` into the app folder and serve it from Flask, with no change
to any class name.

## Simulation speed — the one new write

The sim-speed slider writes `TIME_SCALE` as a plant **parameter**, not a
signal: `POST /command` now produces `{"signals": {...}, "parameters":
{"TIME_SCALE": N}}` on the same `output_topic.serialize()` +
`producer.produce()` call — no new route, no second produce, no new topic.
`handle_command` in the plant already applies the two objects independently.

The slider's `min`/`max` are exactly the lexicon descriptor's, so no value it
can emit is out of range and the knob never snaps back — the lexicon rejects
rather than clamps, and a second range check in front of it would be a guard
against a value that cannot arrive.

Its position is restored from `applied.parameters.TIME_SCALE`, the echo the
plant already publishes on every change and every `APPLIED_ECHO_PERIOD_S`
otherwise. Forcing ×1 on load would mean every reload silently wrote a
parameter the user never touched. The echo always drives the vehicle
integrator's clock; it stops driving the knob's *position* once the user has
touched the slider, so it cannot fight a drag.

Because the browser samples ~6.7 Hz while the plant publishes up to 500 msg/s
at ×50, the charts decimate — the 60-second rolling window is wall clock and
now spans 50× more sim time. Each chart title carries a `×N` suffix so a reader
knows which clock they are looking at.

## The car — a vehicle model in the browser

The plant publishes no road speed; it is a pack model. Speed is derived in the
browser from the two published signals that carry achieved electrical power,
`P_pack = dc_voltage_v × dc_current_a` (battery-sign, so positive is power
leaving the pack), through a first-order longitudinal model integrated in **sim
time** (`dt_wall × TIME_SCALE`). Integrating in sim time is what keeps the
picture coherent: at ×20 the SOC drains 20× faster and the car drives 20×
faster. A wall-time integrator would show a car crawling while the battery
empties, which reads as a bug.

Driving the wheels from the *achieved* current rather than from the browser's
own pedal state is the same commanded-vs-achieved framing as the current
readouts: when derating engages, `dc_current_a` falls and the car visibly stops
pulling with the pedal still down. That is the mechanism this dashboard exists
to show.

Braking outranks the rest above 50 % brake pedal, because the friction brake
retards the car without touching the pack and the achieved current cannot see
it. Below that, Drive / Coast / Regen are the sign of `dc_current_a` — exact
tests, no invented deadband: with `R0 = 0` the plant returns exactly `0.0` when the
requested power is exactly 0, and both pedals at 0 send exactly 0. Charging is
the one case decided by the browser's own plug state, because a negative
current alone cannot tell a plug from regen. A stalled poll (the existing
`POLL_MS * 4` liveness test) freezes the integrator and desaturates the car
rather than extrapolating — a car still driving on dead data is the one wrong
answer. The mode is spelled out in a chip beside the km/h readout, so no state
depends on colour.

Rendering is inline SVG with `requestAnimationFrame` advancing the angle while
the poll only updates ω. At 6.7 Hz a fast wheel would jump whole revolutions
per poll — a strobe, not a wheel. CSS `@keyframes` was rejected for the same
reason it always is here: changing `animation-duration` restarts the animation,
so every speed change would snap the wheel back to 0°. The *displayed* angular
rate is capped at 2 rev/s so five spokes do not alias at 60 fps; `v` integrates
unclamped and the km/h readout carries the true value.

The seven vehicle constants (`VEHICLE_MASS_KG`, `K_DRAG_N_PER_MPS2`, `K_ROLL_N`,
`DRIVELINE_EFF`, `V_FLOOR_MPS`, `WHEEL_RADIUS_M`, `F_BRAKE_MAX_N`) have no provenance in this
repository — no vehicle model does. They are display constants in exactly the
sense the pedal ceilings are: named in `main.py`, served on `/config`,
overridable per deployment as FreeText variables. `V_FLOOR_MPS` is the launch
floor — tractive force below it is held at its value there — which is both what
keeps `P/v` finite at standstill and the only thing bounding launch
acceleration. It is `15` rather than the `5` the spec assumed, because the spec
sized it against a 60 kW accelerator ceiling: at the 250 kW ceiling this build
ships, 5 m/s would give a 22 m/s² (2.3 g) launch. At 15 m/s the launch is
~7.4 m/s², roughly 0–100 km/h in 5 s, and terminal speed at full pedal is
~290 km/h.

## Data flow

```
Browser                     battery-sim-ui (Flask + QuixStreams)         Battery Sim (vendored plant)
--------                    -------------------------------------        ----------------------------
GET /config      ────────►  static constants (ceilings, derate band,
                            seven vehicle constants, TIME_SCALE range)
GET /battery/data (150ms) ◄──── latest{} (updated by sdf.update() from `battery-data`)  ◄──── ticks every
                                                                                              SAMPLE_TIME / TIME_SCALE
POST /command    ────────►  requested_power_w() computes powertrain-sign W  ────────►  ui-data
  {accel_pct, brake_pct,      { "signals": {requested_power_w, ambient_temp_c,          (consumed, validated
   charge_plug, charge_rate_w,             chiller_setting, heater_setting},             against signals.json /
   ambient_temp_c,            "parameters": {TIME_SCALE} }                               parameters.json,
   heater_setting,                                                                       rejected not clamped)
   chiller_setting,
   time_scale}
```

`battery-sim-ui` runs two `Application` instances (consumer on the main
thread so `consumer_app.run()` registers SIGTERM correctly; producer used
synchronously from the Flask `/command` handler), exactly the pattern in the
extracted uiservice template and `quixstreams-idioms` §1.

## File inventory

| Path | New/modified | Why |
|---|---|---|
| `battery-trace-gen/app.yaml` | new | Declares `input`/`output` topics for the plant deployment; `runEntryPoint: plant/main.py` |
| `battery-trace-gen/dockerfile` | new | Base-image-skill dockerfile; installs `plant/requirements.txt`, final `WORKDIR "/app/${MAINAPPPATH}/plant"` |
| `battery-trace-gen/plant/requirements.txt` | new | The service's deps only: `quixstreams==3.23.1` (matches `PLANT_ORIGIN`'s pin), `python-dotenv` — the one file added inside the vendored folder |
| `battery-trace-gen/README.md` | modified | Gained *The `Battery Sim` deployment* section; the folder is no longer offline-only |
| `battery-sim-ui/main.py` | new | Flask + QuixStreams glue, `requested_power_w()` control law, `/config`/`/battery/data`/`/command` routes |
| `battery-sim-ui/page.py` | modified | The document skeleton; assembles `PAGE_HTML` from the four modules below and carries the Bootstrap `<link>` |
| `battery-sim-ui/page_style.py` | new | Widget-internal CSS only — battery, thermometer, rotated pedal tracks, knobs, SVG car fills. No `@media` rule by construction |
| `battery-sim-ui/page_markup.py` | new | The Bootstrap grid, the inline SVG car, the controls |
| `battery-sim-ui/page_vehicle.py` | new | The browser-side vehicle model and the `requestAnimationFrame` wheel loop |
| `battery-sim-ui/page_script.py` | new | Controls, polling, rolling charts, the control-law mirror for display only |
| `battery-sim-ui/setup_logging.py` | new | Trimmed from the template; now actually called (`main.py` invokes `get_logger()`, the template shipped it unused) |
| `battery-sim-ui/app.yaml` | new | Topics + the three pedal/charge ceiling FreeText variables |
| `battery-sim-ui/dockerfile` | new | Canonical `quix-python-base-image` dockerfile, unmodified |
| `battery-sim-ui/requirements.txt` | new | `quixstreams==3.23.2`, `flask`, `flask_cors`, `flasgger==0.9.7b2`, `waitress`, `python-dotenv` — the extracted template's exact pin set |
| `battery-sim-ui/README.md` | new | Endpoints, control law, env vars |
| `quix.yaml` | modified | Two new deployments (`Battery Sim`, `Battery Sim UI`, `group: Battery`), two new topics (`battery-data`, `ui-data`, 1 partition each) |

## Integration with neighbouring features

No shared code or topics with the ingestion/Test-Manager estate
(`mf4-to-blob`, `mf4-decoder`, `tm-connector`, `api/`, `frontend/`) — this
feature is topic-isolated (`battery-data`/`ui-data`, both new, both 1
partition, single producer/single consumer per the `quix-service-create`
partition-count rule). The only shared artifact is the vendored plant at
`battery-trace-gen/plant/`, which `battery-can-traces`/`battery-trace-gen`
already depend on for offline MF4 generation; this feature adds a second,
independent *consumer* of that same vendored code (via a live deployment
rather than `plant/loader.py`'s test-harness monkeypatch), never a second copy
of it.

## Deviations from spec, and why

- **Transport:** spec's original draft (written before the template was
  unzipped) proposed a WebSocket relay. The extracted template's actual shape
  is Flask + waitress polling; the spec's own appended "Template facts"
  section already calls for re-taking that decision, and this build follows
  the correction.
- **Charge-plug control:** spec's original §3.3 held it back to "Phase 2, open
  question." The spec's own appended "Charging — decided by the user" section
  overrides that and brings it into Phase 1; built as specified there (third
  mode, disabled pedals, commanded-vs-achieved current, derating band shown).
- **Plant deployment path:** spec flagged the nested-`application:` question as
  open and gave an explicit fallback. The fallback was built first (a root-level
  `battery-sim-plant/` holding only build files) and crash-looped in the
  environment 158 times; `application:` stays a root-level folder name, but it
  now names `battery-trace-gen`, the folder that actually contains the plant.
  See "Why this architecture" for the build-context rule that forces this.
- **`page.py` split from `main.py`:** the spec's file inventory (written before
  the template was known to be Flask, not FastAPI-with-`static/`) didn't
  anticipate a page this size. Kept the "one module-level HTML string, no
  template engine" shape but moved it to its own module — this is markup, not
  service topology, so it doesn't trip `quixstreams-idioms`' 300-line-of-code
  trigger, but the combined file would have been unwieldy to review.
- **`setup_logging.py` is now used.** The extracted template shipped it but
  never imported it in `main.py`. Kept the file (spec's build list names it
  explicitly) and actually wired it in, rather than carrying dead code.
- **`os.environ["input"]`, not `os.getenv("input", "battery-data")`.** The
  extracted template used a hardcoded fallback; `quix-service-create` §2 names
  this the exact pitfall it warns against (a renamed topic upstream keeps
  being silently consumed under the old name). Both topics are `required:
  true` in `app.yaml`, so the fallback buys nothing and hides a real failure
  mode. Applied only to `battery-sim-ui/main.py` (my own new file) — the
  vendored `battery-trace-gen/plant/main.py` keeps its own existing
  `os.getenv(...)` fallbacks untouched, per the no-edits constraint.
- **"300 A" derating framing:** see the dedicated section above — implemented
  against what the deployed plant actually does (temperature-only derating),
  not the brief's approximate framing (which describes a different, offline
  controller model).

## Could not do / open items

- **Dataviz skill:** absent in this environment; used the extracted template's
  existing minimal palette instead of a skill-driven one (see "Why this
  architecture").
- **Nested `application:` path:** still unverified and no longer needed —
  `battery-trace-gen` is a root-level folder, so the question does not arise
  for this deployment.
- **Momentary vs. held pedals:** decided **held**, not momentary/spring-back —
  the sliders keep whatever value the user leaves them at, matching a bench
  control panel rather than a physical pedal. No auto-return-to-zero-on-release
  logic was written.
