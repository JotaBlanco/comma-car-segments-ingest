# comma-car-segments-ingest — project directives

Complements the global golden rules; does not restate them. Branch `jama-ui-dev`;
target environment `testrigorg-commacarsegmentsingest-jamaui`.

## Battery DC — the seed

These tables are the human-readable statement of record. The machine-readable seed
the pipeline consumes lives beside the generator and must stay identical to them:

| Artifact | Source of truth |
|---|---|
| 10 requirements (EARS, ASPICE SYS.2 attributes) | `battery-trace-gen/data/battery-dc-requirements.json` |
| 11 parameters (values the requirement tokens resolve to) | `battery-trace-gen/data/battery-dc-parameters.json` |
| 10 test cases (one per requirement, `covers_req_ids`, pass criteria) | `battery-trace-gen/specs/battery-dc-test-specs.json` |
| Expected verdicts per trace (6 pass / 4 fail, mechanism for each fail) | `battery-trace-gen/out/manifest.csv` (generated) |
| CAN database `BATTERY_DC_V1` (8 frames, 249 signals, 4 nodes) | `dcm-seed-dbc/dbc/BATTERY_DC_V1.dbc` |
| Spec / architecture / test reports | `dev-planning/battery-can-traces/` |

Regenerate this file with `scratchpad/gen_claude_md.py` after editing any of them; never
edit the tables by hand.

### Requirements
Requirement text carries `{parameter}` tokens; rendering substitutes `name (value unit)`.
`BMS_I_Dc` is **battery-sign: positive = discharge**, so a charge limit reads `>= -limit`.

| ID | Pattern | Requirement (tokens resolve against the parameter set) | Measurands |
|---|---|---|---|
| `BAT-SYS-PRF-001` | StateDriven | While the battery system is in the Charging state, the battery system shall limit the DC charging current to not more than {I_current_Chr_Max}. | `i_dc_chg` |
| `BAT-SYS-FUN-001` | Ubiquitous | The battery system shall determine the technical state of charge by integrating the measured DC current over time. | `soc_technical`, `i_dc`, `t` |
| `BAT-SYS-FUN-002` | Ubiquitous | The battery system shall derive the customer state of charge from the technical state of charge by a linear mapping in which a technical state of charge of {SOC_tech_at_cust_0pct} yields a customer state of charge of 0 % and a technical state of charge of {SOC_tech_at_cust_100pct} yields a customer state of charge of 100 %, clamped to the range 0 % to 100 %. | `soc_technical`, `soc_customer` |
| `BAT-SYS-PRF-002` | EventDriven | When the battery system enters the Sleep state, the battery terminal voltage shall converge to the open-circuit voltage within {t_transient_Voltage_sec}. | `u_dc`, `u_ocv`, `t` |
| `BAT-SYS-FUN-003` | StateDriven | While the battery system is in the Sleep state, the battery system shall equalise the cell voltages by the active discharge mechanism. | `u_cell_min`, `u_cell_max`, `balancing_active` |
| `BAT-SYS-SAF-001` | Ubiquitous | The battery system shall maintain the battery terminal voltage within the range {Udc_min} to {Udc_Max}. | `u_dc` |
| `BAT-SYS-SAF-002` | Ubiquitous | The battery system shall limit the battery temperature to not more than {T_batt_max}. | `t_batt` |
| `BAT-SYS-SAF-003` | StateDriven | While the battery temperature is not less than {T_batt_max} minus {T_batt_safety_threshold} and not more than {T_batt_max}, the battery system shall apply to the actual charging current limit a derating factor that decreases linearly from 1,0 to 0,0 across that band. | `t_batt`, `derating_factor`, `i_dc_chg` |
| `BAT-SYS-FUN-004` | Ubiquitous | The battery system shall provide the heater states 0, 1 and 2, corresponding to the heater being off, the heater operating at {P_heater_middle} and the heater operating at {P_heater_max}. | `heater_state`, `p_heater` |
| `BAT-SYS-FUN-005` | UnwantedBehaviour | If the battery temperature is below {T_batt_min}, then the battery system shall command heater state 2. | `t_batt`, `heater_state`, `p_heater` |

### Parameters
| Parameter | Value | Used by |
|---|---|---|
| `I_current_Chr_Max` | 300 A | BAT-SYS-PRF-001 |
| `t_transient_Voltage_sec` | 600 s | BAT-SYS-PRF-002 |
| `Udc_min` | 720 V | BAT-SYS-SAF-001 |
| `Udc_Max` | 840 V | BAT-SYS-SAF-001 |
| `T_batt_max` | 60 degC | BAT-SYS-SAF-002, BAT-SYS-SAF-003 |
| `T_batt_safety_threshold` | 5 degC | BAT-SYS-SAF-003 |
| `P_heater_middle` | 500 W | BAT-SYS-FUN-004 |
| `P_heater_max` | 2000 W | BAT-SYS-FUN-004 |
| `T_batt_min` | 5 degC | BAT-SYS-FUN-005 |
| `SOC_tech_at_cust_0pct` | 25 % | BAT-SYS-FUN-002 |
| `SOC_tech_at_cust_100pct` | 90 % | BAT-SYS-FUN-002 |

### Test cases → traces
Four MF4 traces cover the ten cases; exactly four fail, each for a distinct, declared
mechanism (thermal overshoot with a stale temperature filter; SOC-map calibration anchor
at 20 % instead of 25 %; wrong relaxation time constant; heater threshold set at 3 °C).

| Test case | Trace | Covers | Expected | Title |
|---|---|---|---|---|
| `BAT-SYS-TC-001` | T1 | BAT-SYS-PRF-001 | PASS | DC charging current held at or below I_current_Chr_Max |
| `BAT-SYS-TC-002` | T1 | BAT-SYS-SAF-003 | PASS | Charging current derating ramps linearly to zero across the safety band |
| `BAT-SYS-TC-003` | T1 | BAT-SYS-SAF-002 | **FAIL** | Battery temperature held at or below T_batt_max |
| `BAT-SYS-TC-004` | T2 | BAT-SYS-FUN-001 | PASS | Technical state of charge tracks the integrated DC current |
| `BAT-SYS-TC-005` | T2 | BAT-SYS-SAF-001 | PASS | Terminal voltage stays inside the Udc_min to Udc_Max window |
| `BAT-SYS-TC-006` | T2 | BAT-SYS-FUN-002 | **FAIL** | Customer state of charge maps linearly from the technical value |
| `BAT-SYS-TC-007` | T3 | BAT-SYS-FUN-003 | PASS | Cell voltages equalise while the battery system sleeps |
| `BAT-SYS-TC-008` | T3 | BAT-SYS-PRF-002 | **FAIL** | Terminal voltage relaxes to the open-circuit voltage within the budget |
| `BAT-SYS-TC-009` | T4 | BAT-SYS-FUN-004 | PASS | Heater provides the three specified power states |
| `BAT-SYS-TC-010` | T4 | BAT-SYS-FUN-005 | **FAIL** | Heater commanded to maximum below the minimum battery temperature |

## Ingestion pipeline (Tomas's `1148def` line — how a trace becomes data)

```
MF4 Import  --mf4_metadata-->  MF4 Decoder  --"samples" + ONE "file_complete" marker-->  mf4-to-msg
                                     |                                         |                 |
                     resolves run_id ONCE (ladder below)          DataLake Sink -> LAKE_TABLE   tm-connector -> POST /test-runs, /files
                                                                  partitions platform/work_order/test_definition/run_id
```
- **DBC comes from DCM**, not the file: `type=dbc`, `target_key=<platform>`; the decoder runs
  with `DBC_PLATFORM=BATTERY_DC_V1` because MF4 Import never emits `platform`. The DBC file
  must be named `<PLATFORM>.dbc` (`dcm-seed-dbc` keys by basename) and carry no `VAL_` tables.
- **Run-id ladder** (`mf4-decoder/identity.py`, mirrored by `tm-connector`): `declared.run_id`
  → HD-comment `test.run_key` → `TAS-\d+` in the filename → minted `<platform>_<route>`.
  A batch with no run at all is dropped by the sink. HD-comment `test.*` properties feed the
  run (`test.rig`, `test.work_order`, `test.definition`, `test.description`, …).
- **Registration happens only on the `file_complete` marker.** Files decoded by an older
  decoder never register; the decoder dedups on file sha256, so re-uploading identical bytes
  is skipped — change the route timestamp to re-ingest.
- **Reproducible traces**: two runs of `generate.py` must be sha256-identical (asammdf `##FH`
  timestamps are pinned to `start_time`). `out/` is gitignored.
- Lake table is the `LAKE_TABLE` project variable (`battery_data_v1` in jamaui); `dcm_config_id`
  on every row is the DCM document id. Query API from a workstation:
  `https://lh-query-3d7475f5-testrigorg-global.testrig-depl.dev.quix.io` with a PAT.

## Seeding the Test Manager (Tomas's `api/`)
- Definitions and work orders enter **only** via planning: `POST /api/v1/planning/sync` with
  `work_orders[]`, `test_definitions[{id, work_order_id, title, planned_runs,
  requirements_files[{name, content}]}]`, `links[]`. Requirements files are markdown. There
  is no `POST /test-definitions`; the in-cluster `Planning Sync Mock` is not reachable from a
  workstation. A PAT authorises the write.
- Uploaded traces link themselves to a definition through the HD-comment `test.*` claims;
  `links[]` corrects the linkage afterwards and never overwrites a `manual` edit.

## Environment notes
- Auto-injected Quix variables (`Quix__BlobStorage__Connection__Json`, `Quix__Lakehouse__*`)
  do not belong in `quix.yaml`; secret-typed variables bind with `variableKey`.
- Never force-push a branch an environment builds from; the Portal's clone then rejects every
  git operation. Recover with `git commit-tree <tree> -p <portal tip>`.
- Portal variable edits auto-commit to the branch: fetch and rebase before pushing.
- Parked by the user (2026-09-22): the old `backend/` Test Manager and its DCM-source design
  (`archive/dcm-source-on-old-backend`); the upstream polarity fix lives in
  `C:\repos\quixstreams-tests-polarity` on `fix/dc-battery-sim-polarity`, verified 53/53.
