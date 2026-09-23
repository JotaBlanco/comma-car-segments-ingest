# battery-trace-gen — architecture

**Implements:** `dev-planning/battery-can-traces/spec.md` (Final, rev 2)
**Branch:** `jama-ui-dev`
**Written:** 2026-09-22 by ArchDev

---

## 1. What the code does

`battery-trace-gen/` is an offline tool that produces four synthetic MF4 bus-log traces
for a DC traction battery. It imports the vendored `dc-battery-sim` plant and runs its
real `run_simulation` loop headlessly, one 0,1 s tick at a time; after each tick a thin
BMS controller reads the pack state, applies its control laws, and returns the setpoints
the plant applies on the next tick. Every controller output and every plant output is
latched as a named `BATTERY_DC_V1` signal, quantised through the DBC's own scale and
offset, and encoded into classic 8-byte CAN frames on a 100 Hz bus grid. The frames go
into a `CAN_DataFrame` structured signal in an MDF 4.10 file with the DBC attached and a
full `<HDcomment>` provenance block. Alongside the traces the tool writes
`out/manifest.json`, an expected-verdict document whose every achieved number is
measured from the run's own recorded history rather than typed in.

The ten `BAT-SYS-*` requirements are covered by ten test cases in
`battery-trace-gen/specs/battery-dc-test-specs.json`, and `verified_by` is filled in on
`backend/seed_data/battery/battery-dc-requirements.json` so traceability agrees in both
directions. Exactly four of the ten are expected to fail, each from one declared rigged
parameter.

---

## 2. Why this shape

### 2.1 One sign convention, converted once, inside the plant

The plant mixes two current conventions: `solve_dc_current` returns powertrain sign
(`P < 0` on discharge ⇒ `I < 0`) while the terminal-voltage line and both RC updates
assume battery sign. The two meet with no conversion, which puts the terminal voltage
*above* OCV on discharge. The spec's decision — an explicit, scoped override of "do not
modify the vendored plant" — is to convert the current immediately after the solver, so
that `dc_voltage`, both RC branches and the `KT2·I²` heating term become correct by
construction rather than by three separate compensations.

Three statements change in `plant/main.py` and one description line in
`plant/signals.json`; `PLANT_ORIGIN` records them verbatim with line numbers and
hashes. The conversion imposes two constraints — `R0 = 0` (the quadratic branch is not
converted) and `KT1 = 0` (that heating term flips sign) — which `scenarios/_plant_base.json`
pins and `generate.py` refuses to let a scenario override. That refusal is the only
guard in the tool; it protects the correctness of the patch itself, not incoming data.

The *input* setpoint `requested_power_w` keeps powertrain sign because the patch did not
touch the input path, so exactly one line in one file negates it:
`plant/adapter.py:to_plant`.

### 2.2 The plant is the model, the controller is the system under test

Three plant behaviours would otherwise have made the BMS untestable, and all three are
resolved through configuration rather than code:

* **Derating.** The plant's `DERATING_LUT` ramps over 50–60 °C, not the required
  55–60 °C, and it is a module global rather than a parameter. `plant/loader.py`
  reassigns it to `[[-40, 1], [200, 1]]`, so the plant executes the commanded current
  faithfully and the controller is the only thing that derates. Retuning the LUT to
  match the requirement was rejected: the test would then verify the model, and two
  derating stages would multiply wherever both were active.
* **The temperature clamp.** `T = min(T, MAX_BATTERY_TEMP)` at the default 60 °C makes
  SAF-002 unfailable — the model would enforce the ceiling. `_plant_base.json` lifts it
  to 65 °C for every scenario, leaving a backstop that would catch a runaway.
* **Heater powers.** The plant heats with 2 500/5 000 W, the requirement specifies
  500/2 000 W. `_plant_base.json` overrides the plant, so the heat injected and the
  `BTMS_P_Heater` value on the bus are the same number. Publishing one while heating
  with the other would make the temperature rise disagree with the published power — a
  failure indistinguishable from a bug.

### 2.3 Initial state is injected through `Q_MAX` and `INITIAL_TEMPERATURE_C`

The spec assumed `q_act`, `heat`, `v_rc1` and `v_rc2` were module globals. They are
**function locals** of `run_simulation`, so they cannot be assigned. Initial SOC is
primed through the quantity the function derives it from:

```
q_act = Q_MAX / 2        -> set main.Q_MAX = 2 * q_target before the run
```

`Q_MAX` is restored inside `get_producer()`, which `run_simulation` calls **after**
initialising its state and **before** its first loop iteration — the only point at which
a primed value can be put back without a tick seeing it.

The initial pack temperature needs no such trick. The plant reads
`INITIAL_TEMPERATURE_C` and derives `heat` from it, so the host sets that constant to
the scenario's `t_batt_c` and `A_THERMAL` stays at the scenario's real thermal mass
throughout. Until PLANT_ORIGIN (9) this was done by doctoring `A_THERMAL` to
`T0 / 100 000` and restoring it to trigger the plant's heat rebase on tick 0; that back
door tied the starting temperature to the thermal mass, so retuning one moved the other.

### 2.4 The sleep hook is the tick boundary

`run_simulation` is an infinite loop that publishes a payload and then sleeps.
`plant/loader.py` replaces the module's `time` reference with a shim whose `sleep` is the
host's turn and whose `monotonic` is the real one. The result is single-threaded and
fully deterministic: `produce()` hands the payload to the runner, `sleep()` advances the
tick counter, writes the next setpoints under `state_lock`, and raises a private
exception to leave the loop after the last tick. No background thread, no wall clock, no
polling — the spec's `SimulationHarness` pattern without its thread.

### 2.5 Two groups of signals are reported one tick late

A command issued on tick k reaches the plant on tick k+1: the declared 100 ms actuation
delay. Two reports would otherwise contradict the physics on the same bus:

* **The `BMS_03` derating triple** (`BMS_T_Derate_Ref`, `BMS_Derating_Fct`,
  `BMS_I_Chg_Lim`). During T1's steep ramp the derating factor falls by about 0,01 per
  tick, i.e. the limit falls 3 A per tick. Publishing the fresh limit next to a current
  produced by the previous tick's limit shows up to 3 A of apparent excess — against a
  ±0,5 A criterion. Reporting the whole triple one tick late makes it describe *the limit
  in force on the current now on the bus*: the law check (`d` versus `T_ref`) stays exact
  because all three come from the same instant, and the limit check
  (`BMS_I_Dc >= -BMS_I_Chg_Lim`) becomes exact to about 0,002 A.
* **`BTMS_Heater_State` and `BTMS_P_Heater`** — the heat the plant is injecting this
  tick, against `BTMS_Heater_Req`, which is what the BMS is asking for now. This is what
  keeps FUN-004's power-versus-state mapping and the observed temperature rise
  consistent.

### 2.6 The bus grid is finer than the plant grid

The spec asserts both `dt = 0,1 s` (with a 100 ms actuation delay, and "900 s is 9 000
ticks") and "100 Hz frames land on every tick". Those are inconsistent: a 0,1 s tick is
10 Hz. The plant's `SAMPLE_TIME` is fixed at 0,1 s and the frame counts, bus load and
lake-row counts in spec §5 and §18 all require a 100 Hz frame, so the resolution is a
**100 Hz bus grid with zero-order hold between plant ticks**: signal values are latched
once per tick and the ten 10 ms slots that follow transmit whatever is due. Nothing is
interpolated — a held value is what a real ECU transmits between its own sampling
instants — and every count in §5 comes out exactly (T1 = 180 000 frames, 1 190 decoded
rows/s, 5,64 M rows over the four traces).

### 2.7 Criteria are decomposed where the vocabulary cannot compare two signals

The test-case schema's `rule.value` is a number, so a criterion cannot say
`BMS_I_Dc >= -BMS_I_Chg_Lim` or `|BMS_Soc_Cust - map(BMS_Soc_Tech)| <= 0,5`. Four cases
(TC-002, TC-004, TC-006, TC-008) decompose their requirement into numeric bounds over
windows keyed on the *other* signal, and say so in their `notes` — the same precedent the
ACC set set for `ACC-SYS-FUN-021`. TC-008 is the cleanest case: a gate pins
`BMS_U_Ocv_Est` at 771,0 V over the evaluation window, which turns the two-signal
tolerance into an absolute bound on `BMS_U_Dc`.

### 2.8 `start_time` is the only clock the file carries

Everything the generator computes is a function of the scenario JSON and the identity's
`cell_seed`: the plant is a fixed-step integrator, the 200 cell offsets come from a pinned
`default_rng(20260922)`, the frame schedule is a modulo on the slot index. The only
wall-clock reads left in the write path are asammdf's own — `HeaderBlock.__init__`
(`asammdf/blocks/v4_blocks.py:6449`) and `FileHistory.__init__`
(`v4_blocks.py:6086,6093`) stamp the `##HD` block and every `##FH` block with `time.time()`
at construction, and asammdf creates an `##FH` block twice per file: once inside
`MDF4.attach()` (`blocks/mdf_v4.py:6861`, "Added new embedded attachment from ...") and
once inside `MDF4.save()` (`mdf_v4.py:11056`, "created"/"updated").

`bus/mf4.py:write()` pins all of it to the scenario's `start_time_utc`. That one aware UTC
`datetime` goes to `mdf.header.start_time` and then to `time_stamp` on every entry of
`mdf.file_history`, and `save(..., add_history_block=False)` suppresses the block asammdf
would otherwise create — and stamp — during the write itself, which is the one FH block the
generator cannot reach beforehand. The `time_stamp` setter (`v4_blocks.py:6157`) re-derives
`abs_time`, `tz_offset`, `daylight_save_time` and `time_flags` from that value, so the
bytes do not depend on the generating machine's timezone either. The saved file keeps a
single `##FH` block, the attachment one, carrying `start_time`.

---

## 3. Data flow

```
scenarios/_identity.json ─┐
scenarios/_plant_base.json├─> scenario.load_all() ──> Scenario (+ SetpointSchedule)
scenarios/_controller_base.json                              │
scenarios/T*.json ────────┘                                  │
backend/seed_data/battery/battery-dc-parameters.json ──> ControllerParams
                                                             │
                                             runner.run(scenario, identity, dbc)
                                                             │
                         plant.loader.load(plant_params, module_overrides)
                                    │  sys.modules.pop("main"); import; DERATING_LUT;
                                    │  params.update; _recompute_derived
                                    v
                         plant.loader.drive(handle, ticks, on_tick=...)
                                    │
     ┌──────────────────────────────┴───────────────────────────────────────┐
     │  per tick k, t = k * 0,1 s                                           │
     │  1. run_simulation body            -> payload dict (battery sign)    │
     │  2. plant.adapter.from_plant       -> BusState                       │
     │  3. SetpointSchedule.at(t)         -> Stimulus                       │
     │  4. BmsController.update           -> ControllerOutput               │
     │  5. bus.encoder.latch              -> quantised sample (history)     │
     │  6. for slot in 10 x 10 ms:                                          │
     │        bus.scheduler.due(slot)     -> frames, ascending CAN id       │
     │        bus.encoder.encode          -> 8 bytes (+ BZ, + CRC-8)        │
     │        bus.mf4.FrameLog.append                                       │
     │  7. plant.adapter.to_plant         -> main.cmd for tick k+1          │
     └──────────────────────────────┬───────────────────────────────────────┘
                                    v
                    bus.mf4.write(out/<trace>.mf4)
                        CAN_DataFrame + FLAG_CG_BUS_EVENT + SOURCE_BUS
                        + attached BATTERY_DC_V1.dbc + <HDcomment>
                                    │
                    manifest.build(runs) ──> out/manifest.json, out/manifest.csv
```

Downstream, unchanged: MF4 Import → `mf4-to-blob` → `mf4-decoder`
(`extract_bus_logging(database_files={"CAN": [(dbc, 0)]})`, DBC resolved from DCM by
`platform`) → `can_signals_v13` in the lake, partitioned `platform/device/route`.

### Per-tick ordering, stated once

Steps 5 and 7 are where the design decisions live. The latch in step 5 takes the plant
state of tick k together with the controller output of tick k, and the controller output
already carries the two one-tick-late reports of §2.5. Step 7's setpoints take effect on
tick k+1 and that delay is never compensated anywhere — no integrator, no lead term.

---

## 4. File inventory

### Created — `battery-trace-gen/`

| Path | Why |
|---|---|
| `README.md` | How to run it, the four traces, the sign convention, the new-environment checklist |
| `requirements.txt` | The three pins plus `quixstreams` (the plant imports it at module level) and `requests` (for `feed_dcm.py`) |
| `PLANT_ORIGIN` | Source commit, the four edits verbatim with line numbers, vendored-file hashes, the `R0`/`KT1` constraints, the red-first test contract |
| `generate.py` | CLI; loads scenarios, refuses non-zero `R0`/`KT1`, runs each trace, writes MF4 + manifest, prints the sanity table |
| `runner.py` | The per-tick loop of §3; owns the frame log and the signal history |
| `scenario.py` | Scenario, identity, setpoint and defect documents as typed data; `SetpointSchedule` |
| `manifest.py` | The ten expectation measurements and the `manifest.json` / `manifest.csv` writers |
| `meta.py` | Tool and plant-origin identity, shared by the MF4 header and the manifest |
| `feed_dcm.py` | Posts the DBC document and the test-spec set to DCM from a workstation |
| `plant/main.py` | Vendored, patched per §3.0 of the spec and nothing else |
| `plant/signals.json` | Vendored, one description line changed |
| `plant/lexicon.py`, `plant/parameters.json` | Vendored verbatim |
| `plant/loader.py` | Fresh import, `DERATING_LUT` reassignment, parameter injection, initial-state priming, the `time` shim, the tick driver |
| `plant/adapter.py` | `BusState`; `from_plant` (rename only) and `to_plant` (the single negation) |
| `controller/params.py` | The eleven DCM parameters plus the controller calibrations, with per-scenario overrides |
| `controller/state_machine.py` | `BMS_State`, seven states, conditions on bus-side quantities |
| `controller/laws.py` | L1–L7 and L9 as pure functions; every limit is an argument |
| `controller/cells.py` | L8: seeded 200-cell offsets, spread decay, balancing hysteresis, min/max/delta/index |
| `controller/bms.py` | `ControllerOutput` and the controller's three pieces of state |
| `bus/dbc.py` | Loads `BATTERY_DC_V1` from its single home; sha256 and DCM config id |
| `bus/crc.py` | CRC-8/SAE-J1850 table, the per-frame BZ counters, the mux counter |
| `bus/scheduler.py` | Cycle times → ordered `(slot, frame)` stream, ascending CAN id within a slot |
| `bus/encoder.py` | The signal latch (quantised) and `Message.encode` per frame, including the mux slot |
| `bus/mf4.py` | `FrameLog` and the `CAN_DataFrame` / attachment / HD-comment writer |
| `scenarios/_identity.json` | Platform, device, bus name and channel, cell seed |
| `scenarios/_plant_base.json` | The shared plant overrides and the flattened derating LUT |
| `scenarios/_controller_base.json` | The controller calibrations that have no requirement counterpart |
| `scenarios/T1..T4_*.json` | One arc each: initial state, overrides, defects, setpoints, expectations |
| `specs/battery-dc-test-specs.json` | Ten test cases, `BAT-SYS-TC-001` … `-010` |

### Created elsewhere

| Path | Why |
|---|---|
| `dcm-seed-dbc/dbc/BATTERY_DC_V1.dbc` | The database's only home: 8 frames, 249 signals, 4 nodes, no `VAL_` tables |

### Modified

| Path | Change |
|---|---|
| `dcm-seed-dbc/platform_dbc.json` | One entry, `"BATTERY_DC_V1": {"pt": "BATTERY_DC_V1"}` |
| `backend/seed_data/battery/battery-dc-requirements.json` | `verified_by` filled on all ten items; `set_canonical_sha256` recomputed to `3f8ca3d7cc9a2917ed603628237942ad13e6606abee9e222b93f7419f68c5ed3` |

---

## 5. Integration points

* **DBC → DCM.** `type = "dbc"`, `target_key = "BATTERY_DC_V1"`, id
  `sha1("dbc-BATTERY_DC_V1")`. The file is named after the platform so that
  `dcm-seed-dbc`'s basename key and `mf4-decoder`'s platform lookup are the same string
  and the opendbc-style indirection disappears. `bus/dbc.py` recomputes the config id
  from two constants at write time; it is never hard-coded.
* **MF4 → decoder.** The writer copies `origin/main:rlog-to-mf4/converter.py` exactly —
  the `CAN_DataFrame` members (classic CAN, so no `DataLength`/`BRS`), the
  `FLAG_CG_BUS_EVENT` plus `SOURCE_BUS`/`BUS_TYPE_CAN` acquisition source, the
  `CAN_DataFrame.<member>` renaming that asammdf's bus-logging reader requires, the
  attachment `mime="application/x-dbc"`, and `save(overwrite=True, compression=2)`.
* **MF4 → lake provenance.** All five keys `mf4-decoder/provenance.py:42-48` reads are
  written, plus `bus.channels = 1=battery_hs_can1` for `parse_bus_channels`. Missing any
  of them puts the literal `"unknown"` into a Hive partition key.
* **Test specs → DCM.** `type = "battery-test-specs"`, `target_key = "battery-dc"`,
  `category = "vmodel"`, per §4.4 of `dev-planning/dcm-requirements-source/spec.md`. The
  `-test-specs` ingest handler does not exist on this branch, so the document is stored
  and readable but not yet turned into a register.
* **Requirements → DCM.** The updated requirement set is fed as `battery-requirements`
  v3 by the coordinator. Only `verified_by` and the canonical hash change; the envelope
  `version` stays `v0001` because `artifact_version` is content-addressed on the items.

---

## 6. Deviations from the spec, and why

1. **§3 "assign the module-level state variables (`q_act`, `heat`, `v_rc1`, `v_rc2`)".**
   They are function locals of `run_simulation`, not module globals. Initial SOC is
   primed through `Q_MAX` and restored inside `get_producer()`; the pack temperature is
   set through `INITIAL_TEMPERATURE_C` (§2.3 above). `v_rc1` and `v_rc2` start at zero,
   which every scenario wants.
2. **§4 "100 Hz frames land on every tick" at `dt = 0,1 s`.** Arithmetically impossible;
   a 0,1 s tick is 10 Hz. Resolved with a 100 Hz bus grid and zero-order hold between
   plant ticks (§2.6). Every frame count, bus load and lake-row figure in §5 and §18 is
   preserved exactly, as is the 100 ms actuation delay, which only holds at `dt = 0,1 s`.
3. **§7.1 `T_FILT_TAU` 2 s → 5 s, "expect 3–8 s".** Integrating T1's thermal loop
   (`dT/dt = A(KT2·(300d)² − KE·ΔT)`, `dT_ref/dt = (T − T_ref)/τ`, `d = clamp((60 − T_ref)/5,0,1)`,
   `dt = 0,1 s`) gives peaks of 59,4 °C at τ = 2 s, 59,5 °C at τ = 5 s and 60,7 °C at
   τ = 8 s — all short of the required 61,0–62,0 °C band. **τ = 9,0 s** is shipped: peak
   61,2 °C, dwell above 60 °C 157,6 s, both inside the spec's bands. The scenario's
   `nominal` stays 2,0 s. This is the one number to adjust after the first real run; the
   manifest records the achieved peak and dwell for exactly that purpose.
4. **§7.4's illustrative T4 timeline.** The table has heater state 1 starting at t ≈ 87 s
   when the pack reaches 5 °C, but law L7 enters state 1 at `T_batt_min + HEAT_HYST_1`
   = 12 °C, which happens at t ≈ 39 s. Integrating the law as specified gives state
   dwells of 38,8 s / 543,0 s / 18,2 s and a FUN-005 violation of ≈ 277 s rather than the
   spec's ≈ 398 s. The law, the defect and both verdicts are unchanged — under the
   correct `HEAT2_ON = 5 °C` the same scenario limit-cycles 5 ↔ 8 °C with a violation of
   0,0 s.
5. **§18's `±0,01` tolerance on the derating law.** `BMS_T_Derate_Ref` has 0,1 °C
   resolution, which propagates ±0,01 into a factor recomputed from it, plus the factor's
   own 0,001 step. A ±0,01 criterion can therefore fail on quantisation alone. TC-002
   uses **±0,02** and states the arithmetic in its `description`.
6. **§6 L3/L4 read literally would make charging always win.** L3 assigns
   `I_target = -min(I_chg_lim, OBC_I_Avail)` unconditionally and L4 then takes
   `min(I_target, I_dis_lim)`, which is always the negative one. The demand's sign
   selects the branch instead: a negative `i_demand_a` takes the charge branch and clamps
   to `min(I_chg_lim, OBC_I_Avail, |demand|)`, a positive one takes the discharge branch
   and clamps to `I_dis_lim`. This reproduces every number the spec states for T1, T2 and
   T3 — full 250 A in T2 down to `ocv = 795 V`, then a 900 s taper.
7. **§7's `evaluates: ["BAT-SYS-..."]` is a list of objects, not strings.** Each entry
   carries `req_id`, `measurand`, `signal`, `limit` and `check`, so the manifest's display
   metadata and the name of the measurement function are data rather than Python
   literals, per D6.
8. **Three modules and one document beyond the §13 build list.** `runner.py` and
   `manifest.py` split what §13 put inside a "100-line `generate.py`" (the tick loop and
   the ten measurements are ~150 lines each); `meta.py` holds the identity strings the
   MF4 header and the manifest share; `scenarios/_controller_base.json` holds the
   controller calibrations that have no requirement counterpart, so they are data like
   everything else. `controller/params.py` is the reader for both parameter sources.
9. **`set: "test-specs"`** in the test-spec envelope, per spec §10. The ACC fixture uses
   `"test_specs"`. Nothing on this branch consumes either, so the spec's spelling is
   used.
10. **`numpy==2.2.6`, not `numpy>=1.26,<3`** (spec §14). The 200 cell offsets come from
    `numpy.random.default_rng(20260922).uniform(...)`; a generator change would move
    them and with them T3's balancing numbers. Reproducibility needs a pin.
11. **`requests` added to `requirements.txt`**, for `feed_dcm.py`. Same pin as
    `dcm-seed-dbc`.
12. **`BTMS_P_Chiller` and `BTMS_Chiller_State` are published as commanded, not as
    applied**, unlike the heater pair. The chiller is a scenario stimulus that changes
    once in the whole trace set (T3 at t = 900 s) and no criterion reads it, so the
    one-tick alignment was not worth the extra state.
13. **`mdf.save(..., add_history_block=False)`, not the spec §2.1 call verbatim.** Spec
    §2.1 and the `rlog-to-mf4/converter.py` template both write
    `mdf.save(path, overwrite=True, compression=2)`, which leaves asammdf free to append a
    freshly wall-clock-stamped `##FH` block during the write. Round-1 Tester found three
    runs of T4 giving three sha256 values over an identical 125 136-byte file, differing
    only in the `abs_time` fields of two `##FH` blocks. The writer now assigns the
    scenario's `start_time` to `time_stamp` on every `mdf.file_history` entry (the one
    `MDF4.attach()` creates) and passes `add_history_block=False` so `save()` adds no
    second one. §2.8 has the field-by-field detail. The header, the `CAN_DataFrame`
    payload, the attachment and the `<HDcomment>` block are unchanged; the file loses one
    FH block relative to Round 1's output.
14. **The requirement and parameter sets live in `battery-trace-gen/data/`, not
    `backend/seed_data/battery/`** (spec §10, §14). `backend/` was removed upstream in
    `1148def`, so the generator now reads both documents from `TOOL_ROOT / "data"`;
    earlier `backend/seed_data/battery/...` paths in §1, §3 and §4 refer to that
    location. Only the manifest's `requirements_source` / `parameters_source` strings
    change with it — the MF4 bytes do not.

## 7. Known consequences the spec did not anticipate

* **The first published tick carries zero current.** `main.cmd["requested_power_w"]`
  starts at 0 W rather than at the lexicon default of −8 000 W, so tick 0 is a
  zero-current sample and the controller's first command lands on tick 1. It is visible
  as one sample of `BMS_I_Dc = 0` at t = 0 in every trace, and as `BMS_U_Dc = 840,00 V`
  exactly at t = 0 in T2 — which is inside the closed SAF-001 interval, and TC-005's
  `description` says so.
* **`BMS_State` is `Charging` in T1 from t = 0**, including that zero-current sample,
  because the state is decided by the plug and the OBC rather than by the current.
  TC-001's windows carry `settle_s: 0.5` so the criteria do not read it.
* **The plant's `derating_factor` output is meaningless in these traces** — the LUT is
  flattened, so it is 1,0 everywhere. `BMS_Derating_Fct` on the bus is the controller's
  factor and is the only one any criterion reads.
* **`main.params` is written directly, bypassing the lexicon.** That is how
  `MAX_BATTERY_TEMP = 65` (lexicon max 60) and `TAU2 = 900` get in. The validation only
  guards the wire path, which this tool never uses.

---

## 8. The exact plant diffs

Line numbers are of the patched `battery-trace-gen/plant/main.py`.

```
374  +            # Battery perspective from here on: positive = discharge. See PLANT_ORIGIN.
     +            dc_current = -dc_current

377  -            if q_act <= 0.0 and dc_current < 0.0:
     +            if q_act <= 0.0 and dc_current > 0.0:
379  -            if q_act >= Q_MAX and dc_current > 0.0:
     +            if q_act >= Q_MAX and dc_current < 0.0:

390  -            q_act += dc_current * SAMPLE_TIME
     +            q_act -= dc_current * SAMPLE_TIME
```

`plant/signals.json:143`:

```
-      "description": "DC current after temperature derating. Negative = discharge, positive = charge.",
+      "description": "DC current after temperature derating. Positive = discharge, negative = charge (battery perspective).",
```

Source: `quixstreams-tests@cae68bd710a247d7fbbd7174bebdcfd593219315:dc-battery-sim`.
Upstream is deliberately unchanged.
