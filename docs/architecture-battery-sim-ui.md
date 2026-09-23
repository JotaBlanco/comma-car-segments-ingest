# Battery Sim UI — architecture

## What this is

A live, browser-driven front end for the vendored `dc-battery-sim` plant. Two
Quix Cloud services, joined by two Kafka topics: `Battery Sim` (application
folder `battery-trace-gen`) runs the model unmodified and ticks its state at
10 Hz; `battery-sim-ui` serves a Flask
page that polls that state and turns pedal/charge/ambient/heater/chiller input
into the plant's write envelope. A non-specialist pushes an accelerator or
brake slider, or plugs in and sets a charge rate, and watches SOC, terminal
voltage, current and temperature respond within one poll cycle.

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
is followed literally: `POLL_MS = 150` in `page.py`, giving ~6.7 Hz, comfortably
under the plant's own 10 Hz tick rate.

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
   `ui-data` and is **never read back, stored, or rendered anywhere in
   `page.py`**. The browser does not even ask for it — `/battery/data`'s raw
   JSON blob (the plant's tick, relayed verbatim) contains
   `requested_power_w` and its `applied.signals.requested_power_w` echo, but
   the page's `updateUI()` never touches those keys.
2. **`dc_current_a`** — battery-sign (positive = discharge), the plant's
   *output* current after `PLANT_ORIGIN`'s patch. Every place it renders — the
   "achieved" readout, the "commanded (est.)" readout, the current chart's
   title — carries the literal label `"battery-sign: + discharge / − charge"`.

**Commanded current is not derived from the wire.** `page.py`'s
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
| Accelerator ceiling | 60,000 W | `PEDAL_DISCHARGE_MAX_W` |
| Brake/regen ceiling | 20,000 W | `PEDAL_CHARGE_REGEN_MAX_W` |
| Charge-slider ceiling | 250,000 W | `DC_CHARGE_MAX_W` |

Charging is a third mode, not a pedal blend: toggling the plug switch
client-side disables and zeroes both pedal sliders and enables the charge
slider (`page.py`'s `plugToggle` change handler); `requested_power_w()`
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

## Data flow

```
Browser                     battery-sim-ui (Flask + QuixStreams)         Battery Sim (vendored plant)
--------                    -------------------------------------        ----------------------------
GET /config      ────────►  static constants (ceilings, derate band)
GET /battery/data (150ms) ◄──── latest{} (updated by sdf.update() from `battery-data`)  ◄──── ticks every 100ms
                                                                                              (SAMPLE_TIME)
POST /command    ────────►  requested_power_w() computes powertrain-sign W  ────────►  ui-data
  {accel_pct, brake_pct,      { "signals": {requested_power_w, ambient_temp_c,          (consumed, validated
   charge_plug, charge_rate_w,             chiller_setting, heater_setting} }            against signals.json,
   ambient_temp_c,                                                                       rejected not clamped)
   heater_setting,
   chiller_setting}
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
| `battery-sim-ui/page.py` | new | `PAGE_HTML` module-level string: dashboard markup, CSS, vanilla JS (polling, charts, control law mirror for display only) |
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
