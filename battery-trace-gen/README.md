# battery-trace-gen

Offline generator for four synthetic battery CAN traces. It drives the vendored
`dc-battery-sim` plant through a thin BMS controller, encodes the result as classic CAN
frames against `BATTERY_DC_V1`, and writes MF4 bus-log files that between them exercise
all ten `BAT-SYS-*` requirements with exactly four declared failures.

Nothing here is a Quix deployment. It runs on a workstation; the output enters the
platform through the existing MF4 Import path.

## Run it

```
pip install -r requirements.txt
python generate.py --scenario all           # or --scenario T1
```

Traces, the expected-verdict manifest and its flat CSV land in `out/`, which is
gitignored.

| Trace | File | Duration | Requirements | Expected |
|---|---|---|---|---|
| T1 | `T1_charge_thermal.mf4` | 900 s | PRF-001, SAF-003, SAF-002 | pass, pass, **FAIL** |
| T2 | `T2_discharge_sweep.mf4` | 1 440 s | FUN-001, SAF-001, FUN-002 | pass, pass, **FAIL** |
| T3 | `T3_sleep_balance.mf4` | 1 800 s | FUN-003, PRF-002 | pass, **FAIL** |
| T4 | `T4_cold_heater.mf4` | 600 s | FUN-004, FUN-005 | pass, **FAIL** |

Each failure comes from one rigged parameter declared in the scenario's `defects` block
and repeated in `out/manifest.json`. None comes from a missing channel, a broken signal
or a schema error.

## Sign convention

**Battery perspective, everywhere: current and power positive = out of the pack
(discharge), negative = into the pack (charge).** This holds for the patched plant's
`dc_current_a`, for every controller law, for `BMS_I_Dc` and for `OBC_I_Out`. The single
exception is the plant's *input* setpoint `requested_power_w`, which keeps its
documented powertrain sign; the conversion is one line in `plant/adapter.py`.

The plant is vendored, not imported — `PLANT_ORIGIN` records the source commit, the
three patched statements that make the conversion, and why `R0` and `KT1` must stay
zero. `generate.py` refuses a scenario that sets either non-zero.

## Re-seeding the DBC

`BATTERY_DC_V1.dbc` has exactly one home, `dcm-seed-dbc/dbc/BATTERY_DC_V1.dbc`. The
generator reads it from there and stamps its sha256 into every MF4 header, so the bytes
DCM serialises and the bytes the header names cannot drift apart.

Seeding needs no new code — the existing Job does it:

```
DCM_TYPE=dbc  DBC_NAMES=BATTERY_DC_V1  PLATFORM=BATTERY_DC_V1
CONFIG_API_URL=http://config-api-svc  REPLACE=true
```

From a workstation, `feed_dcm.py` posts the same document plus the ten-case test-spec
set:

```
CONFIG_API_URL=http://config-api-svc python feed_dcm.py
```

## New-environment checklist

Four things must be true in the environment that ingests these traces, or nothing
reaches the lake.

1. **`mf4-decoder` sets `DBC_PLATFORM=BATTERY_DC_V1`.** `mf4-to-blob/metadata.py:87-98`
   never emits a `platform` field, so `mf4-decoder/main.py:938-940` falls through to
   this environment variable. Without it the lookup key is `"unknown"` and no
   configuration resolves.
2. **The DBC file is named `BATTERY_DC_V1.dbc`.** `dcm-seed-dbc/main.py:108` keys DCM by
   the file *basename* while the decoder looks up by *platform*; the two only meet if
   they are the same string.
3. **The MF4 header carries `bus.channels = 1=battery_hs_can1`.** Without it
   `provenance.parse_bus_channels` returns `{}` and every row's `channel_name` is
   `"unknown"` — a Hive partition key.
4. **No `VAL_` tables anywhere in the DBC.** They turn enum signals into strings in
   `value_text` and break every numeric criterion
   (`mf4-decoder/main.py:166-183`). Enum legends live in `CM_ SG_` comments instead.

`mf4-decoder` also needs `DBC_SOURCE=dcm` and `DCM_TYPE=dbc`; both are the defaults.

## Seed the Test Manager

The generator writes the evidence; `seed/` writes the plan the evidence answers to —
one work order, ten test definitions with a rendered requirements document each, one
run/work-order link per trace, and one executable `.py` implementation per definition.

```
export TM_API_URL=https://<backend-api host>
export TM_API_TOKEN=<the registry's API token>

python -m seed render     # write out/seed/ and out/impl/, post nothing
python -m seed catalog    # POST the work order + the 10 definitions, no links
python -m seed impl       # POST the 10 implementations
# ... upload the 4 MF4s through MF4 Import ...
python -m seed links      # POST the same catalog + the 4 links (idempotent)
```

Each trace states its own chain in its MF4 header — `test.run_key`,
`test.work_order` and `test.rig` — so a run links itself to its work order on upload
and `links` only confirms it. The four run keys are `TAS-1001 … TAS-1004`. A trace
claims no test definition: the definitions of a run are assigned from the Test Run
page in the Test Manager.

## Layout

```
generate.py            CLI: load scenarios, run, write MF4 + manifest
runner.py              the per-tick loop
scenario.py            scenarios, identity and setpoints as data
manifest.py            the expected-verdict manifest, measured from the run
meta.py                tool and plant-origin identity
feed_dcm.py            post the DBC and the test-spec set to DCM
plant/                 vendored dc-battery-sim + the polarity patch + the driver
controller/            the BMS under test: state machine, laws, cells, parameters
bus/                   DBC access, CRC, scheduler, encoder, MF4 writer
scenarios/*.json       T1..T4, the shared plant baseline and controller calibrations
data/                  the ten-requirement set and the DCM parameter set
specs/                 the ten-case battery test-spec set
seed/                  the Test Manager seed: planning payload, docs, implementations
tools/                 gen_claude_md.py — regenerate the project CLAUDE.md
out/                   generated traces, manifest, seed bodies (gitignored)
```

Design rationale is in `dev-planning/battery-can-traces/architecture.md`.
