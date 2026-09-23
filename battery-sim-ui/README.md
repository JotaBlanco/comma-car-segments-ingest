# Battery Sim UI

Browser dashboard for the DC battery plant: pedals, a charge control, ambient/
heater/chiller controls, and live gauges + rolling charts. Runs as a Quix
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
| `/` | GET | The dashboard page (module-level HTML string in `page.py`) |
| `/config` | GET | Pedal/charge power ceilings and the derating-band constants, for the browser to size its controls and chart shading |
| `/battery/data` | GET | Latest plant tick, polled by the browser every 150 ms |
| `/command` | POST | `{accel_pct, brake_pct, charge_plug, charge_rate_w, ambient_temp_c, heater_setting, chiller_setting}` - converted server-side to the plant's `requested_power_w` (see `requested_power_w()` in `main.py`) and produced to `ui-data` |

## Control law

`accel_pct - brake_pct = net_pct`, clamped to [-100, 100]. Accelerating
(`net_pct >= 0`) discharges up to `PEDAL_DISCHARGE_MAX_W` (default 60 kW);
braking (`net_pct < 0`) regens/charges up to `PEDAL_CHARGE_REGEN_MAX_W`
(default 20 kW). Charging is a third mode: with the plug in, both pedals are
disabled and zeroed client-side, and the charge slider commands positive
power directly up to `DC_CHARGE_MAX_W` (default 250 kW). All three ceilings
are `app.yaml` FreeText variables - see `docs/architecture-battery-sim-ui.md`
for the full rationale and sign-convention treatment.

## Environment variables

| Variable | Type | Default | Description |
|---|---|---|---|
| `input` | InputTopic | `battery-data` | Plant telemetry, relayed to the browser |
| `output` | OutputTopic | `ui-data` | Commands produced from the browser |
| `PEDAL_DISCHARGE_MAX_W` | FreeText | `60000` | Accelerator ceiling |
| `PEDAL_CHARGE_REGEN_MAX_W` | FreeText | `20000` | Brake/regen ceiling |
| `DC_CHARGE_MAX_W` | FreeText | `250000` | Charge-slider ceiling |
| `Quix__Deployment__Id` | Auto | `battery-sim-ui` | Kafka consumer group |

## Running locally

```bash
pip install -r requirements.txt
# .env: input=battery-data, output=ui-data, Quix__Broker__Address=localhost:19092
python main.py
# Dashboard at http://localhost:80
```
