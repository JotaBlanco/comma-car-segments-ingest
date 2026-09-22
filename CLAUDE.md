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

Regenerate this file with `battery-trace-gen/tools/gen_claude_md.py` after editing any
of them; never edit the tables by hand.

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
                                                                  partitions platform/work_order/run_id
```
- **DBC comes from DCM**, not the file: `type=dbc`, `target_key=<platform>`; the decoder runs
  with `DBC_PLATFORM=BATTERY_DC_V1` because MF4 Import never emits `platform`. The DBC file
  must be named `<PLATFORM>.dbc` (`dcm-seed-dbc` keys by basename) and carry no `VAL_` tables.
- **Run-id ladder** (`mf4-decoder/identity.py`, mirrored by `tm-connector`): `declared.run_id`
  → HD-comment `test.run_key` → `TAS-\d+` in the filename → minted `<platform>_<route>`.
  A batch with no run at all is dropped by the sink. HD-comment `test.*` properties feed the
  run (`test.rig`, `test.work_order`, `test.definitions`, `test.description`, …).
  `test.definitions` is a COMMA-SEPARATED SET: one trace fulfils several test definitions,
  and the run stores them as `test_runs.definition_ids`.
- **Registration happens only on the `file_complete` marker.** Files decoded by an older
  decoder never register; the decoder dedups on file sha256, so re-uploading identical bytes
  is skipped — change the route timestamp to re-ingest.
- **Reproducible traces**: two runs of `generate.py` must be sha256-identical (asammdf `##FH`
  timestamps are pinned to `start_time`). `out/` is gitignored.
- Lake table is the `LAKE_TABLE` project variable (`battery_data_v1` in jamaui); `dcm_config_id`
  on every row is the DCM document id. Query API from a workstation:
  `https://lh-query-3d7475f5-testrigorg-global.testrig-depl.dev.quix.io` with a PAT.

## Seeding the Test Manager (Tomas's `api/`)

**Hierarchy (user's definition, 2026-09-22):** a **work order** is a test campaign and
contains several **test runs**; one test run (one trace / one bench session) **covers several
test definitions**; a **test definition** is one test case for one requirement. Runs claim
their work order and definitions from the HD comment (`test.work_order`, `test.definitions`).
- Definitions and work orders enter **only** via planning: `POST /api/v1/planning/sync` with
  `work_orders[]`, `test_definitions[{id, work_order_id, title, planned_runs,
  requirements_files[{name, content}]}]`, `links[]`. Requirements files are markdown. There
  is no `POST /test-definitions`; the in-cluster `Planning Sync Mock` is not reachable from a
  workstation. A PAT authorises the write.
- Uploaded traces link themselves to their definitions through the HD-comment `test.*`
  claims; `links[]` confirms the linkage afterwards and never overwrites a `manual` edit.
  Repeated `links[]` rows for one run are ADDITIVE, and a re-post answers `links_unchanged`.
- Each definition also carries one executable implementation: `POST /api/v1/test-definitions/
  {td}/implementation` (multipart) stores one `.py` in blob and records its sha256.
  `python -m seed all` from `battery-trace-gen/` does the whole seed.

## Backlog — everything we discuss lands here

`dev-planning/backlog.json` is the ticket store; this table is generated from it. Every item
carries one of **to do · discuss · in progress · finished**, and the status is updated in the
same change that moves the work. Nothing agreed in conversation stays only in conversation.

| ID | Status | Item | Notes |
|---|---|---|---|
| `BL-04` | **in progress** | Upstream plant polarity fix (dc-battery-sim, battery-sign current) | verified 53/53 in C:/repos/quixstreams-tests-polarity; commit there, then re-vendor here |
| `BL-05` | **in progress** | QuixLab + Lakehouse framed inside Test Manager (no new window) | gated READY; committed; deployed handshake check after push |
| `BL-06` | **in progress** | TM backend: one run covers several definitions (definition_ids), claims test.definitions, lake partitions platform/work_order/run_id | spec dev-planning/tm-multi-definition-runs; ArchDev building |
| `BL-07` | **in progress** | One implementation .py per test case in blob (test-manager/implementations/<td>/), linked from the definition, opened via QuixLab | part of BL-06; storage path = per-TD folder (user may flip to dated MF4 prefix) |
| `BL-08` | to do | Seed the Test Manager: 1 work order, 10 definitions, 4 run links via POST /planning/sync | after BL-06; work order lands in DCM automatically |
| `BL-09` | to do | Regenerate traces with test.* claims + new timestamps, upload, verify battery_data_v1 and registration | old 4 routes stay in legacy mf4_signals_v5 |
| `BL-10` | to do | Commit + push battery feature and TM adaptation; rebase onto Portal auto-commits | user authorised commit+push 2026-09-22 |
| `BL-11` | to do | Run the 10 implementations against the lake and write verdicts | explicitly out of scope of BL-06; next feature |
| `BL-12` | to do | Wave 2: visualisation service (battery, gas/brake pedals) from uiservice.zip on Tomas's API |  |
| `BL-19` | to do | Covered != Tested: TESTED needs a confirmed link at (R@v,TC@w) AND a pass pinned to TC version w | shapes BL-11 (running implementations -> verdicts) |
| `BL-13` | discuss | TM_RUN_KEY_PATTERN is an unbound project variable on decoder + connector (literal string) | harmless for us (header rung); tell Tomas |
| `BL-14` | discuss | Legacy rows: 4 battery routes in mf4_signals_v5 (pre-marker decode) | leave or delete |
| `BL-15` | discuss | Requirements seeding into the new TM model (requirements-files per definition) | seed markdown covers it per definition; direct upload route exists |
| `BL-17` | discuss | verified_by must be DERIVED from covers_req_ids, never authored (SYS.2 BP5, Miro) | we currently WRITE verified_by into battery-dc-requirements.json — conflicts with the board's D1 rule |
| `BL-18` | discuss | verification_criteria: new mandatory authored field on requirements (Miro) | today pass criteria live only on the test spec; board wants it on the requirement and agreeing with the spec |
| `BL-20` | discuss | Status lifecycle NEW/Draft/Ready for Review/In Review/Reviewed/Implemented/Tested + Rejected/Obsolete | our 10 reqs are all Draft; adopt the enum when the TM models it |
| `BL-01` | finished | DBC BATTERY_DC_V1 in jamaui DCM (type=dbc), decoder DBC_PLATFORM set | d527f90a…, 0 dropped, decoder resolves it |
| `BL-02` | finished | Battery trace generator: 4 deterministic MF4s, 10 TCs, 6 pass / 4 fail | battery-trace-gen/, Tester round 2 READY; commit pending in BL-10 |
| `BL-03` | finished | Requirements + parameters + test cases as the statement of record | CLAUDE.md tables generated from battery-trace-gen/data + specs |
| `BL-16` | finished | Old backend/ Test Manager + DCM-source design | superseded by Tomas's api/; archived as archive/dcm-source-on-old-backend |
| `BL-21` | finished | Parallel agents when code paths are disjoint; QA by the user in the Portal; no Tester round | working agreement 2026-09-22 |

## Working agreement
- **QA is the user's**, in the Quix Portal. No Tester round unless asked; the lint/type gate
  still runs when a build touches code that has one.
- **Parallel agents** whenever their file sets are disjoint; never two agents in one file.
- **Code and comments stay aligned**: a comment that outlives the code it described is a defect.
- Commit per feature, right after its gate. Push is authorised.

## Requirements workflow (ASPICE SYS.2 — the Miro board)
Board: `https://miro.com/app/board/uXjVHsQqWhY=/` · spec artifact linked from it.
- **BP5 is what this system adds**: `verified_by` is **derived** from the test cases'
  `covers_req_ids` and never authored; coverage is computed at baseline seal, not asserted.
- **Covered != Tested.** TESTED needs a *confirmed* verifies link at `(R@v, TC@w)` **and** a pass
  for that TC in a run whose manifest pinned TC at exactly version `w`. A suspect link blocks it.
- A link goes **suspect** on a `normative_sha256` change only: `text`, `measurand`,
  `system_states`, `verification_method`, `verification_criteria`, attachment refs. `status`,
  `rationale` and `title` are excluded, so Draft -> Reviewed suspects nothing.
- Lifecycle: NEW -> Draft -> Ready for Review -> In Review -> Reviewed -> Implemented -> *Tested*
  (derived); Rejected from review; Obsolete never reuses an id.
- Refusals: `identity_unavailable` (401), `no_op_mint`, `stale_parent`, `id_reuse`.

## Environment notes
- Auto-injected Quix variables (`Quix__BlobStorage__Connection__Json`, `Quix__Lakehouse__*`)
  do not belong in `quix.yaml`; secret-typed variables bind with `variableKey`.
- Never force-push a branch an environment builds from; the Portal's clone then rejects every
  git operation. Recover with `git commit-tree <tree> -p <portal tip>`.
- Portal variable edits auto-commit to the branch: fetch and rebase before pushing.
- Parked by the user (2026-09-22): the old `backend/` Test Manager and its DCM-source design
  (`archive/dcm-source-on-old-backend`); the upstream polarity fix lives in
  `C:\repos\quixstreams-tests-polarity` on `fix/dc-battery-sim-polarity`, verified 53/53.
