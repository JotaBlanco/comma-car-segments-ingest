# Battery Sim UI

Browser dashboard for the DC battery plant: pedals, a charge control, ambient/
heater/chiller controls, a simulation-speed control, a car whose wheels turn
with the achieved pack power, and live gauges + rolling charts. Runs as a Quix
service that bridges the browser with the Kafka pipeline the plant
(`battery-trace-gen/plant/`, deployed as `Battery Sim`) reads and writes.

```
battery-data  ──►  Battery Sim UI  ──►  ui-data
                       │
                  HTTP :80 (Flask/waitress)
                       │
                    Browser (polls GET /battery/data, POSTs /command)
```

## Endpoints

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | The dashboard page (`PAGE_HTML`, assembled in `page.py`) |
| `/config` | GET | Pedal/charge power ceilings, the derating-band constants, the seven vehicle constants and the `TIME_SCALE` range, for the browser to size its controls, its chart shading and its vehicle model |
| `/battery/data` | GET | Latest plant tick, polled by the browser every 150 ms |
| `/command` | POST | `{accel_pct, brake_pct, charge_plug, charge_rate_w, ambient_temp_c, heater_setting, chiller_setting, time_scale}` - converted server-side into `{"signals": {...}, "parameters": {"TIME_SCALE": ...}}` and produced to `ui-data` |

## Control law

`accel_pct - brake_pct = net_pct`, clamped to [-100, 100]. Accelerating
(`net_pct >= 0`) discharges up to `PEDAL_DISCHARGE_MAX_W` (default 250 kW);
braking (`net_pct < 0`) regens/charges up to `PEDAL_CHARGE_REGEN_MAX_W`
(default 80 kW). Charging is a third mode: with the plug in, both pedals are
disabled and zeroed client-side, and the charge slider commands positive
power directly up to `DC_CHARGE_MAX_W` (default 250 kW). All three ceilings
are `app.yaml` FreeText variables - see `docs/architecture-battery-sim-ui.md`
for the full rationale and sign-convention treatment.

The discharge ceiling matches the charge ceiling because they are the same
lexicon limit (`requested_power_w`, ±250 kW) and a pedal that moved the pack
four times slower than the charge plug read as a stuck current. Regen stays
lower: a real regen path is limited by the motor, not by the pack.

Past half brake travel the browser adds a friction brake (below), which is
mechanical and changes nothing in this law - the pack sees the same regen
request at 60 % pedal as it always did.

## Simulation speed

The header slider (and, on a phone, its twin in the controls row) writes the
plant's `TIME_SCALE` **parameter**, ×1 to ×50. The plant divides only its
inter-tick sleep by it, so every published value is identical at any speed and
only the rate at which ticks arrive changes - the pack reaches the derating
band, SOC saturation and the RC2 relaxation in seconds instead of tens of
minutes. The slider's ends are exactly the lexicon's `min`/`max`, so nothing it
emits is rejected.

Its position is restored from the plant's own `applied.parameters.TIME_SCALE`
echo, not reset on reload; the echo is ignored once the user has touched the
slider, so it never fights a drag. The `×N` suffix on each chart title says how
much sim time the 60-second rolling window now spans.

## Car visualisation

The plant is a pack model and publishes no road speed, so the browser
integrates one from the achieved electrical power - `dc_voltage_v ×
dc_current_a`, battery-sign, so positive is power leaving the pack:

```
F_trac   = P_pack × DRIVELINE_EFF / max(v, V_FLOOR_MPS)
F_resist = K_DRAG_N_PER_MPS2 × v²  +  K_ROLL_N
F_brake  = max(0, brake_pct − 50) / 50 × F_BRAKE_MAX_N
a        = (F_trac − F_resist − F_brake) / VEHICLE_MASS_KG
v        = max(0, v + a × dt_wall × TIME_SCALE)
ω        = v / WHEEL_RADIUS_M
```

Driving the wheels from the *achieved* current rather than the pedal is the
point: when derating engages, the current falls and the car visibly stops
pulling with the pedal still down. Drive / Coast / Regen are the sign of
`dc_current_a`; Braking outranks all three past half brake travel, where the
discs do the retarding and no pack current can show it; Charging is the
browser's own plug state (a negative current alone cannot tell a plug from
regen); a stalled poll freezes the integrator and desaturates the car rather
than driving on dead data. The mode is spelled out in a chip beside the km/h
readout, so it never depends on colour, and the brake lamps light whenever the
brake pedal is off its stop.

The displayed rotation rate is capped at 2 rev/s so the five spokes do not
alias at 60 fps; `v` integrates unclamped and the km/h readout carries the true
value.

The seven vehicle constants have no provenance in this repository. They are
display constants in the same sense as the pedal ceilings, served on `/config`
and overridable per deployment. `V_FLOOR_MPS` is the launch floor and is the
only thing bounding launch acceleration: at the 250 kW pedal ceiling it is what
keeps the launch at ~7.4 m/s² instead of ~22 m/s².

## Braking

Up to 50 % pedal the brake is regen alone, and regen is weak by construction:
80 kW at 30 m/s is 2.4 kN on a 2-tonne car, 0.12 g, which is a car that takes
half a minute to stop. Past 50 % a friction brake rises linearly from zero to
`F_BRAKE_MAX_N` at full pedal - 14,700 N, which is 0.75 g of disc braking on
2,000 kg. Blended with regen and the resistive terms, full pedal is ~0.90 g at
30 m/s and stops the car from 100 km/h in ~41 m (mean 0.96 g).

That force is mechanical. It is applied only in `page_vehicle.py`'s
integration, so `requested_power_w`, the pack current and every plant signal
are exactly what they were; the pedal law in `main.py` did not move. The
retarding terms only dissipate, so a step that would carry `v` through zero
lands on zero and the car never rolls backwards.

## Layout

Bootstrap 5.3 CSS, loaded from the jsDelivr CDN by a single `<link>` in
`page.py` - no build step, no JS bundle, no `static/` directory. Bootstrap owns
every layout and breakpoint decision; the `<style>` block in `page_style.py`
carries widget internals only and no `@media` rule. If a framing page's CSP
ever blocks the CDN, vendor `bootstrap.min.css` next to `page.py` and serve it
from Flask - the class names do not change.

| Module | Holds |
|---|---|
| `page.py` | The document skeleton; assembles `PAGE_HTML` |
| `page_style.py` | Widget-internal CSS (battery, thermometer, pedal tracks, knobs, car fills) |
| `page_markup.py` | The Bootstrap grid, the inline SVG car, the controls |
| `page_vehicle.py` | The vehicle model and the `requestAnimationFrame` wheel loop |
| `page_script.py` | Controls, polling, rolling charts |

## Environment variables

| Variable | Type | Default | Description |
|---|---|---|---|
| `input` | InputTopic | `battery-data` | Plant telemetry, relayed to the browser |
| `output` | OutputTopic | `ui-data` | Commands produced from the browser |
| `PEDAL_DISCHARGE_MAX_W` | FreeText | `250000` | Accelerator ceiling |
| `PEDAL_CHARGE_REGEN_MAX_W` | FreeText | `80000` | Brake/regen ceiling |
| `DC_CHARGE_MAX_W` | FreeText | `250000` | Charge-slider ceiling |
| `VEHICLE_MASS_KG` | FreeText | `2000` | Car visualisation - vehicle mass, kg |
| `K_DRAG_N_PER_MPS2` | FreeText | `0.40` | Car visualisation - drag, N/(m/s)² |
| `K_ROLL_N` | FreeText | `196` | Car visualisation - rolling resistance, N |
| `DRIVELINE_EFF` | FreeText | `0.90` | Car visualisation - pack-to-wheel efficiency |
| `V_FLOOR_MPS` | FreeText | `15` | Car visualisation - launch floor, m/s |
| `WHEEL_RADIUS_M` | FreeText | `0.34` | Car visualisation - wheel radius, m |
| `F_BRAKE_MAX_N` | FreeText | `14700` | Car visualisation - friction brake force at 100 % pedal, N |
| `Quix__Deployment__Id` | Auto | `battery-sim-ui` | Kafka consumer group |

Deployment values in `quix.yaml` override these defaults; a variable named
there wins over `app.yaml`.

## Running locally

```bash
pip install -r requirements.txt
# .env: input=battery-data, output=ui-data, Quix__Broker__Address=localhost:19092
python main.py
# Dashboard at http://localhost:80
```
