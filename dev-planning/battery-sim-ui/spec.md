# Battery Sim UI — live pedal-controlled DC battery visualisation

**Status:** Draft
**Project:** comma-car-segments-ingest
**Created:** 2026-09-22
**Planned with:** Buddy

## 1. Goal

Deploy the vendored `dc-battery-sim` plant as a running Quix service and add a
served web page with an accelerator and a brake control, so a non-specialist can
push the two pedals and watch SOC, terminal voltage, current and temperature
respond live. Design only — no code in this document.

## 2. Background

### 2a. The template (`uiservice.zip`)

**Could not be unzipped in this session** — no archive-extraction tool was
available to Buddy (Read/Grep/Glob/Write only, no Bash). The file list is known
from the brief: `main.py, app.yaml, dockerfile, requirements.txt,
setup_logging.py, README.md, UiServisPromt.txt, icon.png`. That is exactly the
shape of a FastAPI-served-page Quix service, and this repo already has a
**working, deployed instance of that same shape**: `mf4-to-blob/` — FastAPI app,
`GET /` returns `static/index.html`, `app.yaml` declares the topic + free-text
vars, `quix.yaml` sets `publicAccess.urlPrefix` and a `sidebarItem`. This spec
follows `mf4-to-blob` as the concrete precedent (read in full) rather than
guessing at the zip's contents. Reproduce the template's file set 1:1 in the new
app (§6); `setup_logging.py` becomes a small shared logging-config module,
`UiServisPromt.txt` and `icon.png` are not load-bearing and are dropped.

### 2b. The plant (`battery-trace-gen/plant/`)

Vendored `dc-battery-sim` (`quixstreams-tests@cae68bd7…`), patched so current is
battery-sign (positive = discharge), `R0 = 0`, `KT1 = 0` — see `PLANT_ORIGIN`.
`main.py` is **already a complete, self-contained QuixStreams service**: a
consumer thread applies live `signals`/`parameters` writes from an input topic
(env `input`, default `ui-data`) validated against `signals.json` +
`parameters.json`, and a producer thread ticks the model every
`SAMPLE_TIME = 0.1 s` (10 Hz, fixed) onto an output topic (env `output`, default
`battery-data`). It is not currently deployed anywhere in `quix.yaml` — only
driven headlessly by `plant/loader.py` for trace generation.

Inputs (`main.cmd`, all `direction: input` in `signals.json`):
`requested_power_w` (±250 000 W, **negative discharges** — powertrain sign),
`ambient_temp_c` (−40…60 °C), `chiller_setting`, `heater_setting` (0=Off,
1=Low, 2=High). Outputs each tick: `soc_percent, q_act_as, ocv_v,
dc_voltage_v, dc_current_a, rc1_voltage_v, rc2_voltage_v, temperature_c,
heat_j, derating_factor, requested_power_w, ambient_temp_c`, plus an `applied`
echo block on change or every `APPLIED_ECHO_PERIOD_S` (5 s) — the UI's only
source of truth for control state after a reload.

Write envelope: `{"signals": {...}, "parameters": {...}}`, both optional,
field-level, best-effort (an unknown/out-of-range field is dropped with a
warning; a legal field is applied even if its sibling in the same message was
rejected). `chiller_setting`/`heater_setting` are **signals**, not parameters —
all four pedal-relevant inputs travel in one `signals` object.

### 2c. The pedal law

DBC `VCU_01` (20 Hz) carries `VCU_Accel_Pedal_Pct` / `VCU_Brake_Pedal_Pct`
(0–100 %), `VCU_Veh_State`, `VCU_Kl15`, `VCU_Charge_Plug`. The trace generator's
convention: accelerator → positive `BMS_I_Dc` (discharge, battery-sign — the
same axis as the plant's `dc_current_a` **output**), brake → negative
(regen/charge), both 0 while plug-charging.

The plant's **input** `requested_power_w` is the opposite sign axis (negative =
discharge). The pedal law is therefore the inverse mapping, crossing that sign
flip once, explicitly:

```
net_pct = clamp(accel_pct - brake_pct, -100, 100)
requested_power_w =
    -net_pct/100 * P_DISCHARGE_MAX_W   if net_pct >= 0   (accelerating: power goes negative → discharge)
    -net_pct/100 * P_CHARGE_MAX_W      if net_pct <  0   (braking: power goes positive → charge/regen)

P_DISCHARGE_MAX_W = 60,000   (60 kW accelerator ceiling)
P_CHARGE_MAX_W    = 20,000   (20 kW regen ceiling — deliberately lower than drive power)
```

Both pedals at 0 sends `requested_power_w = 0` (true idle — supersedes the
plant's own `-8000 W` module default, which only applies before the UI's first
message). **Standstill:** the model has no vehicle-speed state — it is a
battery-only proxy, not a full vehicle — so "brake at standstill" is not
specially handled; the law applies uniformly regardless of implied speed. Noted
as a known simplification in §8, not something to fix.

## 3. Design decisions

**1. One service or two → two, joined by the plant's existing topics.**
The plant is *already* a complete two-threaded QuixStreams service built for
exactly this dashboard-in/dashboard-out shape (comments in `main.py` literally
say "dashboard-in envelope"). Deploying it standalone and building a thin
UI service around its topics costs two deployments and two 1-partition topics,
but zero duplicated model logic and zero risk of the UI's copy drifting from
the pinned plant. A single combined service would require importing the
vendored module into the FastAPI process — against the instruction to leave
`battery-trace-gen/plant/` untouched and importable-as-is, and wasteful of a
plant that already runs standalone. **Rejected:** single combined service (drift
risk, defeats the vendoring pin); re-vendoring the plant a second time under a
new UI-owned copy (same drift risk, now duplicated).

**2. Transport → one WebSocket, not SSE/polling.**
`/ws` on the UI service: every `battery-data` record consumed is relayed
verbatim (JSON) to all connected browsers (in-process fan-out, no server-side
state); every pedal/control change the browser sends over the same socket is
packaged into the `signals` envelope and produced to `ui-data`. One connection,
both directions, matches the two topics 1:1. **Rejected:** SSE (one-way only,
would still need a separate POST endpoint for controls — two code paths for one
job); polling (10 Hz polling is wasteful and laggier than a push socket).

**3. Exposed controls, kept small.** Accelerator %, brake %, ambient °C,
heater (Off/Low/High), chiller (Off/Low/High) — five controls, all riding in
one `signals` write. **Hidden for Phase 1:** `charge_plug` (no corresponding
plant behaviour beyond "power request", so it adds a UI state with nothing new
to show yet — §8 open question), and every `parameters.json` entry (pack
capacity, RC time constants, thermal coefficients) — those are tuning knobs for
scenario design, not something a pedal demo should expose.

**4. What the page shows.** No `dataviz` skill was found in this environment
(checked `~/.claude/skills/*/SKILL.md` — 14 skills present, none matched).
Absent that guidance, the palette is kept deliberately minimal rather than
invented: one neutral accent hue for every time-series line, one amber
"warning" hue reserved for the derating/thermal-limit indicator, and pedal
position shown as bar height + numeric %, not colour (colourblind-safe, and
sidesteps picking a "discharge colour" that could be read as contradicting the
sign-convention text in §4). See §7 for the layout.

**5. Sign convention, kept apart on the page.** `requested_power_w` (input,
powertrain-sign, negative = discharge) is never shown as a headline number —
the pedals themselves are the UI's record of driver intent, already unsigned
0–100 %. The only signed current on screen is `dc_current_a` (output,
battery-sign, positive = discharge), and its axis/tooltip is labelled
`"battery-sign: + discharge / − charge"` every time it renders. If
`requested_power_w` is ever surfaced (e.g. a debug/raw panel), it is labelled
`"(plant input, powertrain-sign)"` inline — the two signed quantities never
share an unlabelled axis.

**6. Faster than real time → no live speed control.** `SAMPLE_TIME` is fixed
and the plant's loop sleeps in wall-clock time; changing that means editing the
pinned `plant/main.py`, which is out of scope. The honest Phase 2 answer is a
**separate replay view** (§3.7), not a speed knob on the live session.

**7. Relationship to the traces → replay the generated MF4s, Phase 2.**
Recommend reading `battery-trace-gen/out/*.mf4` (+ `manifest.json`) and
streaming the recorded rows through the same chart components at a
user-chosen multiplier, decoupled entirely from the live plant. **Rejected:**
driving the plant via `plant/loader.py`'s `time.sleep` monkeypatch inside the
UI service — that module is a test/generation harness (`sys.modules` popping,
module-global rebinding), not a pattern safe to run inside a long-lived web
process, and doing so would re-import the plant a second way outside the one
live deployment. **Exporting a live session as MF4** is a real ask but its
feasibility depends on whether `battery-trace-gen/bus/mf4.py`'s writer accepts
arbitrary tick dicts (not read this session, time-boxed) — flagged as an open
question (§8), not assumed either way.

**8. Standalone vs framed.** `frontend/components/shared/quixlab-frame.tsx`
can embed an external tool via a postMessage auth-token handshake, but that
exists for tools reading protected Jama/DCM data through the Test Manager's
own auth. This UI only touches Kafka topics it owns — **standalone**, same
pattern as `mf4-to-blob` and `quixlab` (`publicAccess.urlPrefix` +
`sidebarItem`). **Rejected:** framed-only (adds a token handshake this
service has no protected resource to justify).

## 4. Architecture and topics

```
[battery-sim deployment]                    [battery-sim-ui deployment]
 battery-trace-gen/plant/main.py              battery-sim-ui/main.py (FastAPI)
 (unmodified, new deploy-only files            GET /            -> static/index.html
  added beside it — §6)                        WS  /ws          -> relay + control sink
                                                GET /config      -> topic/law constants

   consumes ui-data  <───────────────────────────  produces ui-data
   produces battery-data ───────────────────────>  consumes battery-data
```

Topics (root `quix.yaml`, both new, 1 partition each — single producer, single
consumer on each, per `quix-service-create` §4: decide the count before there
is data):

```yaml
topics:
  - name: battery-data
    configuration:
      partitions: 1
  - name: ui-data
    configuration:
      partitions: 1
```

`battery-sim-ui` uses `quixstreams.Application` for both directions — a
background consumer thread (SDF `.update()` relaying each value onto the
WebSocket fan-out set) and a producer used synchronously from the WebSocket
handler, exactly the `Application`/`app.topic()` idiom from
`quixstreams-idioms` §1; no hand-rolled Kafka client.

## 5. The page

Single `static/index.html` + inline JS (template's own shape — no new
frontend framework, per constraints). On load: `GET /config` for topic/law
constants, then open `/ws`. Every inbound WebSocket message is one
`battery-data` tick; every pedal/dropdown change posts a `signals` object over
the same socket, client-throttled to 10 Hz (no point exceeding the plant's own
tick rate).

Charts: rolling ~60 s window, matching the "recent behaviour" framing a
non-specialist pedal demo needs (not a full-session history browser).

## 6. Sign conventions — restated as an implementation checklist

- Every place `dc_current_a` renders: axis/tooltip text
  `"battery-sign: + discharge / − charge"`.
- `requested_power_w` never appears unlabelled; default UI omits it entirely.
- Pedal position is the UI's own 0–100 % state, never derived by re-reading
  `requested_power_w` back off the wire (the `applied.signals` echo is used
  only to resync after reconnect/reload, per the plant's own documented
  purpose for that block).

## 7. Deployment

### 7a. New files

```
battery-trace-gen/plant/app.yaml         (new — deploy-only, plant code untouched)
battery-trace-gen/plant/dockerfile       (new)
battery-trace-gen/plant/requirements.txt (new — trimmed: quixstreams, python-dotenv)

battery-sim-ui/main.py                   (new — FastAPI, WS relay + control producer)
battery-sim-ui/setup_logging.py          (new — from template)
battery-sim-ui/app.yaml                  (new)
battery-sim-ui/dockerfile                (new)
battery-sim-ui/requirements.txt          (new — fastapi[standard], quixstreams, python-dotenv)
battery-sim-ui/static/index.html         (new)
battery-sim-ui/README.md                 (new)
```

Precedent in `battery-trace-gen/PLANT_ORIGIN` already carves out one exception
to "vendored, do not touch" for `plant/tests/test_polarity.py`; `app.yaml` /
`dockerfile` / `requirements.txt` are the same kind of exception — deployment
plumbing, zero edits to `main.py`, `lexicon.py`, `signals.json`,
`parameters.json`. **Open question:** whether `quix.yaml`'s `application:`
field accepts `battery-trace-gen/plant` as a nested path — every existing
entry in this repo's `quix.yaml` is a root-level directory name (checked, none
nested). ArchDev must verify against `quix-samples`/`quix-docs` per
`quix-service-create` step 1–2 before building; if nested paths are not
supported, fall back to a root-level `battery-sim/` plumbing folder whose
`dockerfile` `COPY`s `battery-trace-gen/plant/` in as build context (still zero
edits to the vendored files, just a different `MAINAPPPATH`).

### 7b. `battery-trace-gen/plant/app.yaml`

```yaml
name: Battery Sim
language: python
variables:
  - name: input
    inputType: InputTopic
    description: Live signal/parameter writes (pedals, ambient, heater, chiller)
    defaultValue: ui-data
    required: true
  - name: output
    inputType: OutputTopic
    description: Pack state, one message per SAMPLE_TIME (10 Hz)
    defaultValue: battery-data
    required: true
dockerfile: dockerfile
runEntryPoint: main.py
defaultFile: main.py
```

### 7c. `battery-sim-ui/app.yaml`

```yaml
name: Battery Sim UI
language: python
variables:
  - name: input
    inputType: InputTopic
    description: Pack state consumed and relayed to the browser
    defaultValue: battery-data
    required: true
  - name: output
    inputType: OutputTopic
    description: Pedal/control writes produced from the browser
    defaultValue: ui-data
    required: true
dockerfile: dockerfile
runEntryPoint: main.py
defaultFile: main.py
```

### 7d. `quix.yaml` deployment blocks

```yaml
  - name: Battery Sim
    group: Battery
    application: battery-trace-gen/plant   # see open question, §7a
    version: latest
    deploymentType: Service
    resources:
      limits: { cpu: 500, memory: 500 }
    variables:
      - name: input
        inputType: InputTopic
        required: true
        value: ui-data
      - name: output
        inputType: OutputTopic
        required: true
        value: battery-data

  - name: Battery Sim UI
    group: Battery
    application: battery-sim-ui
    version: latest
    deploymentType: Service
    resources:
      limits: { cpu: 500, memory: 500 }
    variables:
      - name: input
        inputType: InputTopic
        required: true
        value: battery-data
      - name: output
        inputType: OutputTopic
        required: true
        value: ui-data
    publicAccess:
      enabled: true
      urlPrefix: battery-sim
    plugin:
      sidebarItem:
        show: true
        label: Battery Sim
        icon: battery_charging_full
        order: 1
```

Both dockerfiles follow `quix-python-base-image` verbatim
(`FROM python:3.13-slim-trixie`, the `MAINAPPPATH` template); `battery-sim-ui`'s
`ENTRYPOINT` is `uvicorn main:app --host 0.0.0.0 --port 80` in place of the
template's `python3 main.py`, matching `mf4-to-blob`'s FastAPI serving style
(that dockerfile itself predates the base-image skill and is not copied
verbatim — only its `uvicorn` entrypoint shape is).

## 8. Phase 1 scope

Smallest thing that demonstrates the model with pedals, live:

1. `battery-trace-gen/plant` deployed standalone on `ui-data`/`battery-data`.
2. `battery-sim-ui` deployed, WebSocket relay both directions.
3. Page: accelerator slider, brake slider, ambient/heater/chiller controls,
   SOC bar, terminal-voltage line, current line (labelled per §6),
   temperature line with derating shading.
4. No replay, no MF4 export, no charge-plug control, no parameter tuning UI.

## 9. Build list for ArchDev

1. `battery-trace-gen/plant/app.yaml` + `dockerfile` + `requirements.txt` —
   deploy-only, per §7a/§7b. Verify the nested-`application:` open question
   first (quix-samples/quix-docs).
2. `battery-sim-ui/main.py` — FastAPI app; `Application` producer + consumer
   per `quixstreams-idioms` §1; `/ws` relay per §4; pedal law per §2c/§3.2
   implemented once, shared by the WS handler and `/config`'s echoed constants.
3. `battery-sim-ui/static/index.html` — page per §5/§7 layout sketch; palette
   per §3.4.
4. `battery-sim-ui/app.yaml`, `dockerfile`, `requirements.txt`,
   `setup_logging.py`, `README.md` — template shape per §2a.
5. `quix.yaml` — two deployment blocks (§7d) + `battery-data`/`ui-data` under
   root `topics:` (§4).

## 10. Open questions

- Does `quix.yaml` `application:` accept a nested path (`battery-trace-gen/plant`),
  or does the plant need a root-level plumbing folder instead? (§7a)
- Charge-plug (`VCU_Charge_Plug`): expose in Phase 2 as a toggle that zeroes
  and disables both pedals, or leave it out entirely? No plant behaviour
  currently distinguishes "plugged" from "brake pedal charging" — same
  `requested_power_w > 0` either way.
- Live-session MF4 export: does `battery-trace-gen/bus/mf4.py`'s writer accept
  arbitrary tick dicts, or is it coupled to the DBC/bus encoding path used by
  the trace generator? Unread this session — check before promising export.
- `P_DISCHARGE_MAX_W = 60 kW` / `P_CHARGE_MAX_W = 20 kW`: reasonable EV-scale
  defaults, not derived from any spec in this repo — confirm with the user or
  leave as the stated default.

## Decisions

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Topology | Two services over `ui-data`/`battery-data` | Single combined service; re-vendor plant into UI | Plant already runs standalone; avoids a second, drift-prone copy |
| Transport | One WebSocket, both directions | SSE + POST; polling | One connection matches the two topics; push beats poll at 10 Hz |
| Speed | No live speed control | Patch the plant's sleep loop | Plant is pinned/vendored, out of scope |
| Trace relationship | Phase 2 MF4 replay, decoupled reader | Drive plant via `loader.py` inside the UI | `loader.py` is a test harness, not a service-safe pattern |
| Embedding | Standalone (`publicAccess.urlPrefix`) | Framed via `quixlab-frame.tsx` | No protected resource here to justify the auth handshake |
| Plant deploy files | New plumbing beside vendored code, zero edits | Re-vendor a full copy under a new app dir | Matches the `test_polarity.py` precedent; no drift risk |

## Page layout sketch

```
+--------------------------------------------------------------------+
|  Battery Sim                                              [● live] |
+--------------------------------------------------------------------+
|  SOC  [############........]  62 %      Temp  34.2 C  [derate band]|
+--------------------------------------------------------------------+
|  Terminal Voltage (V)                    Current (A, battery-sign) |
|  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~            + discharge / - charge    |
|  [ line chart, ~60s window ]             [ line chart, ~60s window]|
+--------------------------------------------------------------------+
|   ACCEL           BRAKE          Ambient °C   Heater    Chiller    |
|   [ | ] 45%       [ | ] 0%       [ 15    ]    [Off v]   [Off v]    |
|   (vertical bar)  (vertical bar)                                   |
+--------------------------------------------------------------------+
```

## 11. References

- `battery-trace-gen/PLANT_ORIGIN` — the vendoring pin and the four-edit patch.
- `battery-trace-gen/plant/main.py`, `signals.json`, `parameters.json`,
  `lexicon.py`, `loader.py`.
- `mf4-to-blob/main.py`, `app.yaml`, `dockerfile` — served-page precedent.
- `quix.yaml` — existing deployment/topic conventions.
- Skills: `quix-service-create`, `quix-python-base-image`,
  `quixstreams-idioms`.

## Template facts — read from `uiservice.zip` after the spec was drafted

Buddy had no archive access and inferred this section from `mf4-to-blob/`. The actual
template, extracted by the architect, differs in two ways that change §4.2:

* **Flask + waitress**, not FastAPI: `flask`, `flask_cors`, `flasgger==0.9.7b2`, `waitress`,
  `python-dotenv`, `quixstreams==3.23.2`. The page is a module-level `HTML` string returned
  by `@flask_app.route("/")` — no `static/` directory, no template engine.
* **Polling, not WebSocket.** The template keeps a `latest` dict under a `threading.Lock`,
  updated by `sdf.update(update_latest)` on the consumer thread, and serves it from
  `GET /battery/data` as JSON; commands go up through `POST /command`, which produces to the
  output topic. Flask runs in a daemon thread while the QuixStreams consumer holds the main
  thread.
* Its `app.yaml` already declares exactly the topic pair this spec proposes:
  `input: battery-data` (InputTopic), `output: ui-data` (OutputTopic).

**Consequence:** the WebSocket decision in §4.2 should be re-taken against this. Polling
`GET /battery/data` at 5–10 Hz is what the template already does and needs no extra
dependency; a WebSocket under Flask + waitress needs one. Recommend adopting the template's
polling shape for phase 1 and recording the WebSocket as the rejected alternative.

## Charging — decided by the user

DC fast charging up to **250 kW** is in scope for the UI, alongside the pedals.

* The plant already accepts it: `requested_power_w` ranges ±250 000 W in `signals.json`, and
  positive power charges (input convention, powertrain-sign). No plant change is needed.
* It is a **third input mode**, not a pedal: charging happens at standstill with the plug in,
  so `VCU_Charge_Plug` is set, both pedals read 0 %, and the charge rate is its own control
  (a slider or preset steps up to 250 kW). This matches the trace generator, where pedals are
  0 while plug-charging.
* At 250 kW and ~780 V the current is roughly 320 A, which exceeds `I_current_Chr_Max`
  (300 A). The BMS controller's charge limit and its thermal derating are what hold it — so
  the UI must render the *commanded* rate against the *achieved* current, or a viewer will
  read the clamp as a bug. Show both, and label the derating band.
* Phase 1 scope therefore becomes: accelerator, brake, **charge rate**, ambient, heater,
  chiller — with the charge control disabled unless the plug is in.
