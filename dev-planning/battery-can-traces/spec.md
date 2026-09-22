# Battery CAN traces — offline generator, DBC and test-spec set

**Status:** Final (rev 3 — wording corrections from Tester round 1; no design change)
**Project:** comma-car-segments-ingest (branch `jama-ui-dev`)
**Created:** 2026-09-22
**Revised:** 2026-09-22 — rev 2: Q1 plant-polarity defect confirmed and patched, Q2–Q5 decided.
rev 3: decoded-group count corrected to 58, `##FH` determinism hazard named, round-1 build
results recorded in §16.
**Planned with:** Buddy
**Phase:** 1 — design only. No code in this document.

---

## 1. Goal

An offline tool, `battery-trace-gen/`, that drives the vendored `dc-battery-sim` plant through a
new thin BMS controller, encodes the result as classic CAN frames against a new
`BATTERY_DC_V1` DBC, and writes **four MF4 bus-log traces** that between them exercise all ten
`BAT-SYS-*` requirements with **exactly four failing** for declared physical or control-logic
reasons. Ships alongside: the DBC (one file, seeded into DCM through the existing
`dcm-seed-dbc` Job), a ten-case battery test-spec set shaped for the DCM `-test-specs`
convention, and a machine-generated expected-verdict manifest.

Nothing in this feature is a Quix deployment. The generator runs on a workstation; its output
enters the platform through the existing MF4 Import path.

---

## 2. Background — the contracts this has to satisfy

### 2.1 The traces are raw CAN, not decoded signals

`mf4-decoder/main.py:512` decodes with
`MDF.extract_bus_logging(database_files={"CAN": [(dbc_path, 0)]})`. Bus `0` means "any bus
channel". The MF4 must therefore contain a **`CAN_DataFrame` structured signal**, not named
measurement channels. Canonical writer to copy: `origin/main:rlog-to-mf4/converter.py`.
Members, in order, renamed `CAN_DataFrame.<member>`:

| Member | dtype | Value this generator writes |
|---|---|---|
| `BusChannel` | `u1` | `1` (1-based; one bus) |
| `ID` | `u4` | 11-bit standard identifier |
| `IDE` | `u1` | `0` |
| `DLC` | `u1` | `8` |
| `DataBytes` | `(8,)u1` | the payload |
| `EDL` | `u1` | `0` (classic CAN) |
| `Dir` | `u1` | `0` (Rx) |

`MDF(version="4.10")`; channel-group source `v4c.SOURCE_BUS` / `v4c.BUS_TYPE_CAN`; the DBC
attached with `mdf.attach(..., mime="application/x-dbc")`;
`mdf.save(path, overwrite=True, compression=2)`.

### 2.2 Provenance lives in the HD comment

`mf4-decoder/provenance.py:42-48` reads five keys out of `<HDcomment><common_properties>`, and
`parse_bus_channels` (`provenance.py:191`) reads a sixth. Every one of these must be present or
the lake row gets the literal `"unknown"` in a Hive partition key.

| MF4 property | Lake column | Value |
|---|---|---|
| `platform` | `platform` | `BATTERY_DC_V1` |
| `source.device` | `device` | `a3f1c07d9b4e2610` |
| `source.route` | `route` | `a3f1c07d9b4e2610--2026-09-22--09-00-00` (one per trace) |
| `source.segment` | `segment` | `0` |
| `dcm.config_id` | `dcm_config_id` | `sha1("dbc-BATTERY_DC_V1")` |
| `bus.channels` | (→ `channel_name`) | `1=battery_hs_can1` |

`parse_header_properties` walks the whole subtree and keeps the **first** occurrence of a name,
so additional non-contract keys are free. The generator also writes `gen.tool`, `gen.version`,
`gen.scenario`, `gen.seed`, `gen.plant_origin`, `gen.plant_patch`, `gen.dbc_sha256`.

### 2.3 The DBC is resolved out of DCM by platform

Three facts that together pin the naming:

* `dcm-seed-dbc/main.py:108` seeds each database with `target_key = <dbc basename>`, not with
  `PLATFORM` (which is informational only — see `dcm-seed-dbc/app.yaml:26-28`).
* `mf4-decoder/main.py:938-940` resolves the lookup key as
  `value.get("platform") or DBC_PLATFORM or "unknown"`.
* `mf4-to-blob/metadata.py:87-98` **does not emit a `platform` field**. Browser and API uploads
  never carry one.

⇒ Two consequences, both load-bearing:

1. The DBC file is named **`BATTERY_DC_V1.dbc`** so that `target_key == platform` and the
   opendbc-style indirection disappears.
2. The new environment's `mf4-decoder` deployment **must** set `DBC_PLATFORM=BATTERY_DC_V1`.
   Without it every battery upload resolves `target_key="unknown"` and decodes nothing.

`dcm_dbc.materialise` (`mf4-decoder/dcm_dbc.py:93`) rebuilds a cantools `Database` from the DCM
JSON, emits `as_dbc_string()` and **re-parses it** before handing it to asammdf, dropping any
signal cantools' reader rejects. A DBC that survives that round trip decodes; one that does not
loses signals silently apart from a WARNING. This is a build gate, not a runtime concern — and
it has since passed (§16).

### 2.4 Enum signals must not carry `VAL_` tables

`mf4-decoder/main.py:166-183,289` routes a channel to the float `value` column or the string
`value_text` column **once per channel, from its numpy dtype**. A DBC `VAL_` table makes
cantools/asammdf return strings, so an enum with a value table lands in `value_text` and every
numeric criterion against it breaks.

The repo's own hand-authored database already follows this rule:
`dcm-seed-dbc/dbc/ACC_ADAS_TC011.dbc:42` declares `ACC_Status` as a bare 3-bit unsigned with
unit `"1"`, and `acc-system-test-specs.json` compares it to `4` with the legend quoted from the
channel comment. **The battery DBC carries no `VAL_` tables. Enum legends go in `CM_ SG_`
comments.**

### 2.5 The lake row

`can_signals_v13`, long format, one row per decoded signal per frame:
`ts_ms, segment, seq, t_rel_ms, t_abs_ms, seg_anchor_ms, channel, channel_name, frame_id,
frame_hex, frame_index, sender_node, frame_name, signal, value, dbc_sha256, __key, device,
platform, route`, partitioned `platform/device/route`. `frame_name` and `sender_node` come from
re-reading the DBC through canmatrix (`provenance.build_signal_frame_map`), `channel_name` from
`bus.channels`. Every requirement measurand must surface as a `signal` value in this table.

### 2.6 Style reference

`AUDI_A3_MK3` (verified live): 50 frames / 798 signals on one channel, rasters 2–200 Hz,
`<Node>_NN` frame names, sender-prefixed signal names, every frame carrying `<Frame>_BZ`
(4-bit counter) + `<Frame>_CRC` (8-bit).

---

## 3. Background — the plant, its confirmed defect, and the three mismatches

Source: `dc-battery-sim` in `C:\repos\quixstreams-tests`, ref `origin/devDB` @
`cae68bd710a247d7fbbd7174bebdcfd593219315`. Discrete-time 2nd-order RC equivalent circuit plus a
lumped thermal node. `SAMPLE_TIME = 0,1 s`, fixed. No per-cell state.

```
ocv   = 720 + 120*soc
I     = solve_dc_current(P_req, ocv, v_rc1, v_rc2, R0)     # power-driven
I    *= derating_lookup(T)
Udc   = ocv - R0*I - v_rc1 - v_rc2
q_act+= I*dt                                               # coulomb counting, clamped [0, Q_MAX]
v_rc_i= alpha_i*v_rc_i + R_i*(1-alpha_i)*I,  alpha_i = exp(-dt/TAU_i)
heat += (KT2*I^2 + KT1*I + KT0 - KE*(T - T_amb) + P_heater - P_chiller)*dt
T     = A_THERMAL*heat
T     = min(T, MAX_BATTERY_TEMP)                           # hard clamp
```

Note `ocv(0 %) = 720 V = Udc_min` and `ocv(100 %) = 840 V = Udc_Max` — the OCV curve *is* the
SAF-001 window, so the window is unsatisfiable under any load unless the BMS stops the current
first. That is why **SAF-001 is a controller requirement** (§6, law L4).

### 3.0 Defect 0 — current-sign mismatch inside the plant. **Confirmed, and patched.**

`solve_dc_current` returns **powertrain-sign** current (`P < 0` on discharge ⇒ `I < 0`), while
`main.py:384` `dc_voltage = ocv - R0*I - v_rc1 - v_rc2` and the RC update both assume
**battery-sign** current (discharge positive). The two conventions meet with no conversion.

Verified numerically by the coordinator: 60 s at `I = −100 A` with stock `R1`, `R2`, `TAU1`,
`TAU2` gives `v_rc1 = −10,000 V`, `v_rc2 = −0,476 V`, `Udc = 790,5 V` against `OCV = 780 V` —
**terminal voltage above OCV while discharging**, which is unphysical. The plant's own suite
never pins direction (`tests/test_rc_circuit.py:54` asserts only `!=`) and
`battery_sim_spec.md` §Circuit Model states the RC dynamics "are ignored in this iteration".

**Decision (user): keep the battery perspective and convert the current.** This is an explicit,
scoped override of D5 "do not modify the vendored plant" — for this conversion and nothing else.

Three changed statements in the vendored `plant/main.py`:

| # | Location | Before | After |
|---|---|---|---|
| 1 | immediately after `dc_current = solve_dc_current(...)` | — | `dc_current = -dc_current` |
| 2 | the two saturation guards | `q_act <= 0 and I < 0 → 0`; `q_act >= Q_MAX and I > 0 → 0` | `q_act <= 0 and I > 0 → 0`; `q_act >= Q_MAX and I < 0 → 0` |
| 3 | the coulomb-counting line | `q_act += dc_current * SAMPLE_TIME` | `q_act -= dc_current * SAMPLE_TIME` |

Plus one documentation line in the vendored `plant/signals.json`: `dc_current_a` becomes
*"positive = discharge, negative = charge (battery perspective)"*.

`dc_voltage`, both RC updates and `KT2*I**2` are **untouched** and become correct by
construction. ArchDev pins the exact line numbers in `PLANT_ORIGIN`.

**Two hard scenario constraints that follow from the patch:**

* **`R0` stays `0.0` in every scenario.** `solve_dc_current`'s quadratic branch for `R0 > 0`
  still assumes the old sign and is *not* converted. With `R0 = 0` that branch is never taken.
* **`KT1` stays `0.0` in every scenario.** The `KT1*I` heating term flips sign under the new
  convention. `KT1 = 0` by default, so nothing changes today — recorded as a known asymmetry
  rather than silently left to bite a future scenario.

**Upstream `quixstreams-tests@devDB` is not changed.** Its dashboard keeps powertrain sign. The
divergence — source SHA, the three changed lines, and why — is recorded in
`battery-trace-gen/PLANT_ORIGIN` and echoed into every MF4 header as `gen.plant_patch`.

**Red-first test.** Per the repo rule that a finding without a red test is only plausible,
`plant/tests/test_polarity.py` asserts, under sustained discharge, `dc_voltage_v < ocv_v` **and**
`dc_current_a > 0`; and under sustained charge, `dc_voltage_v > ocv_v` **and**
`dc_current_a < 0`. It must be **RED on the unpatched plant and GREEN after**. Tester writes and
runs it; ArchDev writes the fix and does not write the test.

### Mismatch 1 — derating band 50→60 vs the required 55→60

`main.DERATING_LUT = [(-30,0),(-20,1),(50,1),(60,0)]` is a module global, not a tunable
parameter, and it ramps 1→0 over **50–60 °C**. `BAT-SYS-SAF-003` requires 1,0→0,0 over
`T_batt_max - T_batt_safety_threshold` … `T_batt_max`, i.e. **55–60 °C**.

**Resolution: the plant does no current derating at all.** `plant/loader.py` reassigns
`main.DERATING_LUT = [(-40.0, 1.0), (200.0, 1.0)]` before the first tick, so the plant becomes a
faithful electrical/thermal model that executes the commanded current, and the **controller** is
the only thing that derates. `BMS_Derating_Fct` on the bus is the controller's factor; the
plant's `derating_factor` output is ignored.

> *Rejected:* reassigning the LUT to `[(-30,0),(-20,1),(55,1),(60,0)]` to match the requirement.
> That makes the plant implement SAF-003, so the test would verify the model rather than the
> system under test, and the two derating stages would multiply wherever both were active.

### Mismatch 2 — `MAX_BATTERY_TEMP` is a hard clamp, so SAF-002 is unfailable

`T = min(T, MAX_BATTERY_TEMP)` with the default 60 °C means the plant can never exceed the
SAF-002 ceiling. The ceiling would be enforced by the model, not by the BMS.

**Resolution: `_plant_base.json` sets `MAX_BATTERY_TEMP = 65` for every scenario.** The clamp
has no counterpart in the requirement set; raising it above the 60 °C ceiling makes the BMS the
only thing holding the ceiling, and leaves a 65 °C backstop that would catch a runaway.

**The clamp lift does not by itself produce an overshoot.** With an ideal derating law the pack
approaches 60 °C asymptotically and never crosses it (at `T = 59 °C`, `d = 0,2`, heat
`= 0,0278·60² = 100 W` against `KE·ΔT = 38 W` → `dT/dt = +0,012 °C/s`; at `T = 60`, `d = 0` and
`dT/dt = −0,008 °C/s`). T1's SAF-002 failure therefore needs a second, declared mechanism — see
§7.1, defect `T_FILT_TAU`.

### Mismatch 3 — heater powers 2500/5000 W vs the required 500/2000 W

`HEATER_POWER_LOW/HIGH = 2500/5000` in the plant; `BAT-SYS-FUN-004` requires
`P_heater_middle = 500 W` and `P_heater_max = 2000 W`.

**Resolution: `_plant_base.json` sets `HEATER_POWER_LOW = 500`, `HEATER_POWER_HIGH = 2000` for
every scenario**, so the heat the plant actually injects and the `BTMS_P_Heater` value on the bus
are the same number, and both match the DCM parameter set.

> *Rejected:* publishing 500/2000 on the bus while the plant heats with 2500/5000. The
> temperature rise would not match the published power, which is a failure indistinguishable
> from a bug — the thing §5 of the brief forbids.

### Headless driving

`dc-battery-sim/tests/conftest.py` already contains the pattern: `sys.modules.pop("main")`,
env set **before** `importlib.import_module("main")`, a fake producer, and `run_ticks(module, n)`
driving the real `run_simulation`. `Application(...)` is built only under `__main__`, so import
is safe. The only wall-clock coupling is `time.sleep(SAMPLE_TIME)` at `main.py:431` and
`time.monotonic()` for the echo timer — monkeypatch `main.time.sleep` to a no-op and 900 s of
simulation is 9 000 ticks, effectively instant.

* Parameter change between ticks: write `main.params[...]` under `main.state_lock`, then call
  `main._recompute_derived()`.
* Setpoint change: write `main.cmd[...]` under `main.state_lock`.
* Initial state: assign the module-level state variables (`q_act`, `heat`, `v_rc1`, `v_rc2` —
  ArchDev confirms the exact names in the vendored source) after import, before the first tick.

`main.params` writes bypass the lexicon validation, which only applies to incoming messages.
That is how `MAX_BATTERY_TEMP = 65` and `TAU2 = 900` get in.

---

## 4. Architecture

```
scenarios/*.json ─┐
                  ├─> Scenario ──> setpoints + plant/controller param overrides
_plant_base.json ─┘                       │
                                          v
   plant/main.py (vendored + the §3.0 polarity patch, nothing else)
                       │ plant.step() ──> payload dict   (battery sign)
                       │
             plant/adapter.py   (unit mapping + power-input negation ONLY)
                       │
                       v  BusState
   controller/{state_machine,laws,cells,bms}.py ──> ControllerOutput
                       │
                       ├──> adapter.to_plant() ──> main.cmd (next tick)
                       v
   bus/encoder.py  (latch signal values) ─> bus/scheduler.py (cycle times)
                       │
             bus/crc.py (BZ counter + CRC-8)
                       v
   bus/mf4.py ──> out/<trace>.mf4  (+ DBC attachment + HD comment)
                  out/manifest.json, out/manifest.csv
```

### Sign convention — one convention, fixed, everywhere

**Battery perspective: current and power positive = *out of* the pack (discharge); negative =
*into* the pack (charge).** This holds for the patched plant's `dc_current_a`, for `BusState`,
for every controller law, for `BMS_I_Dc` on the bus, and for `OBC_I_Out`.

The single exception is the plant's **input** setpoint `main.cmd["requested_power_w"]`, which
keeps its documented powertrain sign (negative = discharge) because the patch did not touch the
input path. `adapter.to_plant` therefore writes `requested_power_w = -P_bus` and that negation
exists in exactly one line of one file.

### Per-tick ordering (dt = 0,1 s, k = 0 … N−1, t = k·dt)

1. **Scenario apply** — write any setpoint or scheduled parameter change for time `t` into
   `main.cmd` / `main.params` under `main.state_lock`; `main._recompute_derived()` if params
   changed.
2. **Plant step** — one tick of the real `run_simulation` body → payload dict.
3. **Adapt** — `adapter.from_plant(payload)` → `BusState`. Units only; `dc_current_a` is already
   battery sign after the patch and passes through unchanged.
4. **Control** — `controller.update(bus_state, t)` → `ControllerOutput` (§6).
5. **Actuate** — `adapter.to_plant(output)` writes `requested_power_w = -P_bus`,
   `heater_setting`, `chiller_setting` into `main.cmd`. These take effect on tick `k+1`: a
   deterministic 100 ms actuation delay, declared rather than compensated.
6. **Latch** — `encoder.sample(t, bus_state, output)` stores the current value of every DBC
   signal.
7. **Emit** — `scheduler.due(t)` yields the frames whose cycle time divides `t`; each is encoded
   from the latched values, its `_BZ` incremented and its `_CRC` computed. Frames due at the same
   `t` are emitted in **ascending CAN id** (arbitration order).

No frame is faster than the plant tick, so no interpolation exists anywhere. 100 Hz frames land
on every tick; 20 Hz on every 5th; 10 Hz on every 10th.

---

## 5. DBC frame catalogue — `BATTERY_DC_V1`

One bus, `battery_hs_can1`, `BusChannel = 1`. Classic CAN, every frame 8 bytes, every signal
little-endian unsigned (`@1+`) unless marked signed (`@1-`). Nodes: `BMS`, `OBC`, `VCU`, `BTMS`.

Every frame except `BMS_Cell_01` carries `<Frame>_BZ` at bits 52|4 and `<Frame>_CRC` at bits
56|8, leaving a 52-bit payload budget. Bit ranges not listed are reserved and transmitted as 0.

### `BMS_01` — 0x100 (256), 100 Hz, sender `BMS`

| Signal | Start\|Len | Sign | Scale, Offset | Min \| Max | Unit | Notes |
|---|---|---|---|---|---|---|
| `BMS_U_Dc` | 0\|16 | + | 0.01, 600 | 600 \| 1255.35 | V | pack terminal voltage |
| `BMS_I_Dc` | 16\|16 | − | 0.05, 0 | −1638.4 \| 1638.35 | A | **battery perspective: positive = discharge, negative = charge** |
| `BMS_State` | 32\|4 | + | 1, 0 | 0 \| 15 | 1 | 0 Off, 1 Sleep, 2 Standby, 3 Charging, 4 Discharging, 5 Heating, 6 Fault |
| `BMS_01_BZ` | 52\|4 | + | 1, 0 | 0 \| 15 | 1 | |
| `BMS_01_CRC` | 56\|8 | + | 1, 0 | 0 \| 255 | 1 | |

The `CM_ SG_` comment on `BMS_I_Dc` states the perspective verbatim — it is the one place a
reader of the decoded lake can recover it.

There is **no separate charge-current signal.** The earlier `BMS_I_Dc_Chg` (an unsigned
`max(I, 0)` duplicate) is removed: with one signed current under one fixed convention, a derived
duplicate is a second place for the sign to go wrong. PRF-001 and SAF-003 read `BMS_I_Dc`
directly (§8).

### `BMS_02` — 0x110 (272), 10 Hz, sender `BMS`

| Signal | Start\|Len | Scale, Offset | Min \| Max | Unit |
|---|---|---|---|---|
| `BMS_Soc_Tech` | 0\|16 | 0.01, 0 | 0 \| 655.35 | % |
| `BMS_Soc_Cust` | 16\|16 | 0.01, 0 | 0 \| 655.35 | % |
| `BMS_U_Ocv_Est` | 32\|16 | 0.01, 600 | 600 \| 1255.35 | V |
| `BMS_02_BZ` | 52\|4 | 1, 0 | 0 \| 15 | 1 |
| `BMS_02_CRC` | 56\|8 | 1, 0 | 0 \| 255 | 1 |

### `BMS_03` — 0x111 (273), 10 Hz, sender `BMS`

| Signal | Start\|Len | Scale, Offset | Min \| Max | Unit | Notes |
|---|---|---|---|---|---|
| `BMS_T_Batt` | 0\|12 | 0.1, −50 | −50 \| 359.5 | degC | true pack temperature |
| `BMS_T_Derate_Ref` | 12\|12 | 0.1, −50 | −50 \| 359.5 | degC | the temperature the derating law used |
| `BMS_Derating_Fct` | 24\|10 | 0.001, 0 | 0 \| 1.023 | 1 | |
| `BMS_I_Chg_Lim` | 34\|12 | 0.1, 0 | 0 \| 409.5 | A | **magnitude**, unsigned; the permitted charge current is `−BMS_I_Chg_Lim` |
| `BMS_03_BZ` | 52\|4 | 1, 0 | 0 \| 15 | 1 | |
| `BMS_03_CRC` | 56\|8 | 1, 0 | 0 \| 255 | 1 | |

`BMS_T_Derate_Ref` is what makes SAF-003 (law correctness) and SAF-002 (outcome) separately
observable in T1. Per-cell temperatures were dropped: the plant is a lumped thermal node and has
nothing honest to source them from.

### `BMS_04` — 0x112 (274), 10 Hz, sender `BMS`

| Signal | Start\|Len | Scale, Offset | Min \| Max | Unit |
|---|---|---|---|---|
| `BMS_U_Cell_Min` | 0\|12 | 0.001, 3.0 | 3 \| 7.095 | V |
| `BMS_U_Cell_Max` | 12\|12 | 0.001, 3.0 | 3 \| 7.095 | V |
| `BMS_U_Cell_Min_Idx` | 24\|8 | 1, 1 | 1 \| 256 | 1 |
| `BMS_U_Cell_Max_Idx` | 32\|8 | 1, 1 | 1 \| 256 | 1 |
| `BMS_Balancing_Act` | 40\|1 | 1, 0 | 0 \| 1 | 1 |
| `BMS_U_Cell_Delta` | 41\|11 | 0.0001, 0 | 0 \| 0.2047 | V |
| `BMS_04_BZ` | 52\|4 | 1, 0 | 0 \| 15 | 1 |
| `BMS_04_CRC` | 56\|8 | 1, 0 | 0 \| 255 | 1 |

Payload fills 52 bits exactly. `BMS_U_Cell_Delta` at 0,1 mV resolution is what makes the FUN-003
balancing convergence directly measurable without reading the cell array.

### `BMS_Cell_01` — 0x120 (288), 20 Hz, sender `BMS`, **multiplexed**

| Signal | Start\|Len | Mux | Scale, Offset | Min \| Max | Unit |
|---|---|---|---|---|---|
| `BMS_Cell_Mux` | 0\|8 | **M** | 1, 0 | 0 \| 255 | 1 |
| `Ucell_{4k+1}` | 8\|12 | m*k* | 0.001, 3.0 | 3 \| 7.095 | V |
| `Ucell_{4k+2}` | 20\|12 | m*k* | 0.001, 3.0 | 3 \| 7.095 | V |
| `Ucell_{4k+3}` | 32\|12 | m*k* | 0.001, 3.0 | 3 \| 7.095 | V |
| `Ucell_{4k+4}` | 44\|12 | m*k* | 0.001, 3.0 | 3 \| 7.095 | V |
| `BMS_Cell_01_CRC` | 56\|8 | — | 1, 0 | 0 \| 255 | 1 |

*k* = 0 … 49 → `Ucell_001` … `Ucell_200`, 200 cells. The mux cycles 0→49 at 20 Hz, so the whole
array refreshes every 2,5 s and each cell signal appears at 0,4 Hz.

**This frame keeps `_CRC` and drops `_BZ` (decided).** 8 (mux) + 4 × 12 (cells) + 8 (CRC) = 64
bits exactly, with no room for a counter — and the 8-bit mux index *is* the frame's sequence: it
advances on every transmission and wraps 49 → 0. The `CM_ BO_` comment on the frame states this
so nobody looks for a missing `_BZ`.

On decode, asammdf expands this one frame into **51 channel groups** — see the note on the
decoded-group count in §13 checklist item 4.

### `OBC_01` — 0x200 (512), 20 Hz, sender `OBC`

| Signal | Start\|Len | Sign | Scale, Offset | Min \| Max | Unit | Notes |
|---|---|---|---|---|---|---|
| `OBC_I_Out` | 0\|16 | − | 0.05, 0 | −1638.4 \| 1638.35 | A | **battery perspective: negative = current delivered into the pack** |
| `OBC_U_Out` | 16\|16 | + | 0.01, 600 | 600 \| 1255.35 | V | |
| `OBC_I_Avail` | 32\|12 | + | 0.1, 0 | 0 \| 409.5 | A | magnitude the charger can supply |
| `OBC_Active` | 44\|1 | + | 1, 0 | 0 \| 1 | 1 | |
| `OBC_Fault` | 45\|1 | + | 1, 0 | 0 \| 1 | 1 | |
| `OBC_01_BZ` | 52\|4 | + | 1, 0 | 0 \| 15 | 1 | |
| `OBC_01_CRC` | 56\|8 | + | 1, 0 | 0 \| 255 | 1 | |

### `VCU_01` — 0x300 (768), 20 Hz, sender `VCU`

| Signal | Start\|Len | Scale, Offset | Min \| Max | Unit | Notes |
|---|---|---|---|---|---|
| `VCU_Veh_State` | 0\|4 | 1, 0 | 0 \| 15 | 1 | 0 Off, 1 Sleep, 2 Standby, 3 Drive, 4 Charge |
| `VCU_Kl15` | 4\|1 | 1, 0 | 0 \| 1 | 1 | terminal 15 |
| `VCU_Charge_Plug` | 5\|1 | 1, 0 | 0 \| 1 | 1 | |
| `VCU_Accel_Pedal_Pct` | 8\|10 | 0.1, 0 | 0 \| 102.3 | % | ∝ **positive** `BMS_I_Dc` |
| `VCU_Brake_Pedal_Pct` | 18\|10 | 0.1, 0 | 0 \| 102.3 | % | ∝ **negative** `BMS_I_Dc` |
| `VCU_T_Ambient` | 28\|12 | 0.1, −50 | −50 \| 359.5 | degC | |
| `VCU_01_BZ` | 52\|4 | 1, 0 | 0 \| 15 | 1 | |
| `VCU_01_CRC` | 56\|8 | 1, 0 | 0 \| 255 | 1 | |

### `BTMS_01` — 0x400 (1024), 10 Hz, sender `BTMS`

| Signal | Start\|Len | Scale, Offset | Min \| Max | Unit | Notes |
|---|---|---|---|---|---|
| `BTMS_Heater_State` | 0\|2 | 1, 0 | 0 \| 3 | 1 | 0 off, 1 = `P_heater_middle`, 2 = `P_heater_max` |
| `BTMS_Heater_Req` | 2\|2 | 1, 0 | 0 \| 3 | 1 | state the BMS requested |
| `BTMS_P_Heater` | 4\|12 | 1, 0 | 0 \| 4095 | W | |
| `BTMS_Chiller_State` | 16\|2 | 1, 0 | 0 \| 3 | 1 | |
| `BTMS_P_Chiller` | 18\|13 | 1, 0 | 0 \| 8191 | W | |
| `BTMS_T_Coolant` | 31\|12 | 0.1, −50 | −50 \| 359.5 | degC | |
| `BTMS_01_BZ` | 52\|4 | 1, 0 | 0 \| 15 | 1 | |
| `BTMS_01_CRC` | 56\|8 | 1, 0 | 0 \| 255 | 1 | |

### Totals and bus load

**8 frames, 249 signals, 4 nodes.**
Frames/s = 100 + 10 + 10 + 10 + 20 + 20 + 20 + 10 = **200 frames/s**.
Payload = 1 600 B/s. On the wire (8-byte standard frame ≈ 128 bit incl. stuffing + IFS) ≈
3 200 B/s ≈ 25,6 kbit/s ≈ **5 % of a 500 kbit/s bus**.
Decoded lake rows ≈ **1 190 rows/s**.

| Trace | Duration | Frames | Decoded rows |
|---|---|---|---|
| T1 | 900 s | 180 000 | 1,07 M |
| T2 | 1 440 s | 288 000 | 1,71 M |
| T3 | 1 800 s | 360 000 | 2,14 M |
| T4 | 600 s | 120 000 | 0,71 M |
| **Total** | **4 740 s** | **948 000** | **5,64 M** |

Per-frame cycle times are declared in the DBC as
`BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;` / `BA_DEF_DEF_ "GenMsgCycleTime" 0;` /
`BA_ "GenMsgCycleTime" BO_ <id> <ms>;`. cantools surfaces these as `Message.cycle_time`, and
`dbc_json.to_json` (`dcm-seed-dbc/dbc_json.py:103`) already stores the field, so the DCM document
carries the raster.

### E2E

* **`<Frame>_BZ`** — 4-bit free-running counter, one per frame, incremented on every
  transmission of that frame, wrapping 15 → 0, starting at 0 at t = 0. Absent on
  `BMS_Cell_01`, where the mux index serves.
* **`<Frame>_CRC`** — **CRC-8/SAE-J1850**: polynomial `0x1D`, init `0xFF`, no input or output
  reflection, final XOR `0xFF`. Computed over `[id >> 8, id & 0xFF] + data[0:7]` — the two-byte
  big-endian CAN id acts as the AUTOSAR-style Data ID so a frame's CRC is frame-specific — with
  the CRC byte (byte 7) excluded. 256-entry lookup table, no external dependency.

Both are fully deterministic — see the determinism requirement below.

### Timestamps

`header.start_time` per trace comes from the scenario JSON (fixed UTC values, §7). CAN frame
timestamps run `0,000 … duration` seconds; the decoder computes `ts_ms = start_ms + t·1000`.
One MF4 = one route = one segment (`segment = 0`).

**No jitter.** Frame `f` with cycle `c_f` ms is emitted at exactly `t = n·c_f`.

> *Rejected:* ±1 ms uniform jitter. It makes byte-for-byte reproducibility depend on an RNG
> seed for no analytical gain, and any evaluator has to cope with cross-raster alignment either
> way.

Records are written sorted by `(t, frame_id)`; the MDF4 master must be non-decreasing.

### Determinism, and the one hazard that breaks it

**Requirement: two runs of the same scenario, into two different output directories, must produce
sha256-identical MF4 files.** Everything the generator computes is deterministic by construction
— the plant is fixed-step, the frame schedule has no jitter, the `_BZ` counters and CRCs are
pure functions of frame history, `header.start_time` is a constant in the scenario JSON, and the
only RNG is the seeded cell-offset draw. The per-trace `sha256` recorded in the manifest (§9) is
meaningless unless this holds.

**Named hazard: asammdf 8.8.9 stamps a wall-clock time into the `##FH` (File History) blocks it
generates automatically on `append()`, `attach()` and `save()`.** Those eight bytes are the one
thing that differs between two otherwise byte-identical runs. The writer must neutralise them by
setting every FH block's timestamp to the trace's `header.start_time` rather than leaving
asammdf to stamp `now()`. This is a requirement on `bus/mf4.py`; the mechanism, not the patch,
belongs here.

---

## 6. Controller — the system under test

A thin BMS. Every numeric limit is read at run time from
`backend/seed_data/battery/battery-dc-parameters.json` — the same eleven values that are in DCM
— and may be shadowed per scenario by `controller_param_overrides`. No limit is a Python
literal.

All laws are in **battery sign** (§4): positive = discharge.

### States (`BMS_State`)

`0 Off · 1 Sleep · 2 Standby · 3 Charging · 4 Discharging · 5 Heating · 6 Fault`

**Balancing is not a top-level state.** It is the orthogonal flag `BMS_Balancing_Act`, asserted
inside a Sleep residency.

> *Rejected:* a distinct `Balancing` top-level state matching the requirement's `system_states`
> list. It would end the Sleep residency mid-relaxation and make PRF-002's "when the system
> enters the Sleep state" edge ambiguous. The ASPICE mapping is stated instead: requirement
> system-state `Balancing` ⇔ `BMS_State == 1 AND BMS_Balancing_Act == 1`.

Transitions (all conditions on bus-side quantities):

| From | To | Condition |
|---|---|---|
| any | `Charging` (3) | `VCU_Charge_Plug == 1 AND OBC_Active == 1` |
| any | `Discharging` (4) | `VCU_Veh_State == 3 AND P_req_bus > 0` |
| any | `Heating` (5) | `BTMS_Heater_Req > 0 AND` not charging/discharging |
| any | `Standby` (2) | `VCU_Kl15 == 1`, no current demand |
| any | `Sleep` (1) | `VCU_Kl15 == 0 AND VCU_Charge_Plug == 0` |
| any | `Fault` (6) | never reached in these four traces |

### L1 — OCV estimate

```
ocv_est = Udc_min + (Udc_Max - Udc_min) * soc_tech/100
```
Derived from the two DCM parameters; no new constants. Published as `BMS_U_Ocv_Est`.

### L2 — Derating (SAF-003)

```
T_ref     += (T_batt - T_ref) * dt / T_FILT_TAU          # first-order lag, published as BMS_T_Derate_Ref
derating   = clamp((T_batt_max - T_ref) / T_batt_safety_threshold, 0.0, 1.0)
```
With `T_batt_max = 60` and `T_batt_safety_threshold = 5` this is 1,0 at ≤ 55 °C, 0,0 at ≥ 60 °C,
linear between — exactly the requirement text. `T_FILT_TAU` models the cell-temperature averaging
window the derating path uses; nominal **2 s**, overridden per scenario.

### L3 — Charge limit (PRF-001, SAF-003)

```
I_chg_lim   = I_current_Chr_Max * derating          # magnitude, published as BMS_I_Chg_Lim
I_target    = -min(I_chg_lim, OBC_I_Avail)          # negative: current into the pack
```

### L4 — Discharge power limit / rail guard (SAF-001)

The plant's OCV curve *is* the SAF-001 window, so the window is unsatisfiable under load unless
the BMS backs off. The controller uses the textbook resistance-based discharge limit:

```
I_dis_lim = clamp( (U_dc - Udc_min) / R_INT_EST , 0.0, I_DIS_MAX )     # R_INT_EST = 0.15 ohm
I_target  = min(I_target, I_dis_lim)                                    # discharge is positive
```

`R_INT_EST` is a controller calibration matching the pack's full-current internal drop
(`(R1+R2)·I = 0,15 · I`). Quasi-steady state is `U_dc = (ocv + Udc_min)/2`, which approaches
720 V asymptotically as `ocv → 720 V` and never crosses it. Full 250 A is available down to
`ocv = 795 V` (≈ 62,5 % SOC), after which the current tapers exponentially with a 900 s time
constant.

> *Rejected:* a hard cut-off at the rail. One sample would sit on the wrong side of the limit
> before the contactor logic reacted, turning a correct design into a spurious SAF-001 failure.
>
> *Rejected:* a linear guard band on `U_dc`. A band narrower than the full-current internal drop
> (37,5 V at 250 A) chatters between full current and zero; a band wide enough to be stable
> (≥ 60 V) starts limiting at 81 % SOC. The resistance form is both stable and physical.

### L5 — Power request

`R0 = 0` in every scenario (§3.0), so `U_dc = ocv − v_rc1 − v_rc2` exactly and `I = P / U_dc`
exactly. The controller converts its current target to a power request using the previous tick's
terminal voltage:

```
P_req_bus = I_target * U_dc_prev            # battery sign; adapter.to_plant negates it
```

One-tick error at 300 A: `U_dc` moves ~1,3·10⁻⁵ relative per tick, i.e. ~0,004 A. No integrator,
no correction term, no guard.

### L6 — SOC map (FUN-002)

```
soc_cust = clamp( (soc_tech - SOC_tech_at_cust_0pct)
                  / (SOC_tech_at_cust_100pct - SOC_tech_at_cust_0pct) * 100, 0, 100 )
```
`soc_tech` is the plant's `soc_percent` (pure coulomb counting) republished unchanged.

### L7 — Heater law (FUN-004, FUN-005)

Latching, two-level hysteresis, all thresholds from parameters:

```
if   T_batt <  HEAT2_ON   : state = 2      # HEAT2_ON  nominal = T_batt_min (5 degC)
elif state == 2 and T_batt <  T_batt_min + HEAT_HYST_2 : state = 2   # latch, HEAT_HYST_2 = 3 K
elif T_batt <  T_batt_min + HEAT_HYST_1   : state = 1               # HEAT_HYST_1 = 7 K
else                                       : state = 0
P_heater = {0: 0, 1: P_heater_middle, 2: P_heater_max}[state]
```
`HEAT2_ON` is a named controller parameter defaulting to `T_batt_min`. T4's defect moves it.

### L8 — Cell model (FUN-003)

```
d[i]   = default_rng(CELL_SEED).uniform(-0.020, +0.020)   # V, 200 values, drawn once
u_cell[i](t) = U_dc / N_CELLS + d[i] * s(t)               # N_CELLS = 200
s(0) = 1.0
s    *= exp(-dt / TAU_BAL)   while  BMS_State == 1 and BMS_Balancing_Act == 1
```
`TAU_BAL = 300 s`. `BMS_Balancing_Act` rises when `BMS_State == 1 AND U_Cell_Delta > 0,030 V`
and falls when `U_Cell_Delta < 0,010 V`. Per-cell bleed current is ~100 mA and invisible at pack
level, so balancing draws no pack current — declared, not modelled.

`BMS_U_Cell_Min/Max/Delta` and `_Idx` are computed from the same array the mux frame transmits,
so `BMS_04` and `BMS_Cell_01` can never disagree.

### L9 — Pedals (D7, illustrative only)

```
accel_pct = 0 if VCU_Charge_Plug else 100 * max( I_dc, 0) / I_DIS_MAX     # I_DIS_MAX = 400 A
brake_pct = 0 if VCU_Charge_Plug else 100 * max(-I_dc, 0) / I_CHG_MAX     # I_CHG_MAX = 300 A
```
Gas ∝ discharge (positive current), brake ∝ regen (negative current), both zero while plugged in.
Not covered by any requirement.

### Signal roles

* **stimulus** — `VCU_T_Ambient`, `VCU_Charge_Plug`, `VCU_Kl15`, `VCU_Veh_State`, `OBC_I_Avail`
* **response** — every measurand signal in §8
* **diagnostic** — everything else (`Ucell_*`, `OBC_I_Out`, `OBC_U_Out`, `BTMS_P_Chiller`,
  pedals, `_BZ`, `_CRC`)

---

## 7. Scenarios

Shared, applied to every scenario (`scenarios/_plant_base.json`):

```json
{ "plant_param_overrides": { "MAX_BATTERY_TEMP": 65,
                             "HEATER_POWER_LOW": 500, "HEATER_POWER_HIGH": 2000,
                             "R0": 0.0, "KT1": 0.0 },
  "plant_module_overrides": { "DERATING_LUT": [[-40.0, 1.0], [200.0, 1.0]] } }
```

`R0` and `KT1` are pinned to 0,0 here, and `generate.py` refuses to load a scenario that
overrides either — the §3.0 patch is only correct while they are zero. This is the one place in
the design where a value is checked, and it guards the correctness of the polarity conversion
itself, not incoming data.

Identity (`scenarios/_identity.json`): `platform = BATTERY_DC_V1`,
`device = a3f1c07d9b4e2610`, `bus_name = battery_hs_can1`, `bus_channel = 1`,
`cell_seed = 20260922`, `route_template = "{device}--{date}--{time}"`.

Scenario file schema (one per trace):

```json
{
  "trace_id": "T1",
  "title": "...",
  "route": "a3f1c07d9b4e2610--2026-09-22--09-00-00",
  "start_time_utc": "2026-09-22T09:00:00Z",
  "duration_s": 900,
  "plant_initial_state":     { "soc_pct": 20.0, "t_batt_c": 35.0 },
  "plant_param_overrides":   { },
  "controller_param_overrides": { },
  "defects": [ { "target": "controller", "parameter": "T_FILT_TAU",
                 "nominal": 2.0, "value": 5.0,
                 "breaks": "BAT-SYS-SAF-002",
                 "mechanism": "derating law correct, temperature input stale" } ],
  "setpoints": [ { "t_s": 0.0, "charge_plug": 1, "kl15": 0, "veh_state": 4,
                   "ambient_c": 35.0, "chiller_setting": 0, "obc_i_avail_a": 300.0,
                   "i_demand_a": -300.0 } ],
  "evaluates": ["BAT-SYS-PRF-001", "BAT-SYS-SAF-003", "BAT-SYS-SAF-002"]
}
```

`setpoints` is a time-ordered list; each entry applies from its `t_s` until the next.
`i_demand_a` is in battery sign. Everything that varies between traces is in these files — per
D6, no scenario, defect, expectation or identity is a Python literal, so a service can serve
these documents unchanged later.

### 7.1 T1 — Charge & thermal · 900 s · `BAT-SYS-PRF-001` pass, `SAF-003` pass, **`SAF-002` FAIL**

Initial 20 % SOC, 35 °C pack, 35 °C ambient, plug in, `OBC_I_Avail = 300 A`, `i_demand_a = −300`
(charge), **chiller off**.

**The chiller stays off by scenario design.** Engaging it would suppress the overshoot entirely:
2 500 W of cooling against 2 502 W of I²R heating at 300 A pins the pack near 55 °C and SAF-002
would pass. The uncommanded cooling loop is the scenario's stated condition, not a defect.

Arc: charge at −300 A → `0,0278·300² = 2 502 W` → `dT/dt ≈ 0,50 °C/s` → 55 °C at t ≈ 40 s →
derating engages → current magnitude tapers → peak → slow cool-down for the remaining ~750 s.
Terminal voltage rises above OCV while charging (`U_dc = ocv + 0,15·|I|`), from ≈ 774 V to
≈ 783 V — comfortably inside the SAF-001 window, which T2 owns.

**Defect: `T_FILT_TAU` 2 s → 5 s.** The BMS derates on a lagged pack temperature, so the current
falls behind the heating. The derating *law* is exactly right (SAF-003 passes against
`BMS_T_Derate_Ref`); its *input is stale*, so the true temperature crosses 60 °C. That is the
wording the manifest carries.

ArchDev bisects `T_FILT_TAU` — one number in the scenario JSON, expect 3–8 s — until peak
`BMS_T_Batt` lands in **[61,0 ; 62,0] °C**, and records the achieved peak and dwell in the
manifest.

**Dwell above 60 °C is accepted at 150–200 s.** The verdict is the ceiling breach, not the dwell.
With `KE = 1,6 W/°C` and the chiller off, post-peak cooling is only 0,008 °C/s.

### 7.2 T2 — Full discharge sweep · 1 440 s · `FUN-001` pass, `SAF-001` pass, **`FUN-002` FAIL**

Start **100 % SOC**, 25 °C, ambient 25 °C, `VCU_Veh_State = 3`, `Kl15 = 1`,
**`chiller_setting = 2`**, `i_demand_a = +250` (discharge).

**+250 A, not +100 A (decided).** At ≈ 780 V that is ≈ 195 kW, inside the plant's ±250 kW input
cap and inside the ±400 A range the bus signal carries. It brings the sweep down from 3 600 s to
**1 440 s** and the trace from ≈ 4,3 M to **1,71 M** lake rows.

The chiller is mandatory: `0,0278·250² = 1 738 W` against `KE = 1,6 W/°C` gives an equilibrium
`ΔT` of 1 086 K, so without it the pack would sit pinned at the `MAX_BATTERY_TEMP` backstop for
the whole run. With it the pack settles at `COOLANT_TEMP = 20 °C`.

Arc: full 250 A from 100 % SOC down to ≈ 62,5 % (t ≈ 540 s), then L4's resistance limit tapers
the current with a 900 s time constant, reaching ≈ 23 % technical SOC at t = 1 440 s. `U_dc`
falls from 840 V toward 720 V and approaches it asymptotically without crossing — which is what
SAF-001 verifies, and the reason D8 calls SAF-001 a controller requirement.

**Defect: `SOC_tech_at_cust_0pct` 25 → 20 (controller override).** The customer SOC map is
anchored 5 points low, so at `soc_tech = 25 %` the BMS reports `soc_cust = 7,14 %` where the
requirement says 0 %. Error `= −0,1099·soc_tech + 9,890` over the mapped band, so the **peak
absolute error is 7,14 % at `soc_tech = 25 %`** — inside the swept range — against a 0,5 %
criterion.

`FUN-001` passes by construction (the plant *is* a coulomb counter); the criterion integrates
`BMS_I_Dc` at 100 Hz against the `BMS_Soc_Tech` delta. Quantisation contributes at most
`0,05 A × 1 440 s = 72 As = 0,02 %` of the 360 000 As pack.

### 7.3 T3 — Sleep & balance · 1 800 s · `FUN-003` pass, **`PRF-002` FAIL**

Phase A, 0–900 s: `VCU_Veh_State = 3`, `Kl15 = 1`, `chiller_setting = 2`, discharge at
**+150 A** from 80 % SOC → 42,5 % SOC.
Phase B, 900–1 800 s: `Kl15 = 0`, plug 0, no current → `BMS_State = 1 (Sleep)`.

**Defect: plant `TAU2` 600 s → 900 s.** The diffusion time constant is longer than the 600 s the
requirement budgets.

```
v_rc2(sleep entry) = R2 · I · (1 - e^(-900/900)) = 0,05 · 150 · 0,6321 = 4,74 V
|U_dc - U_ocv_est| at t_sleep + 600 s      = 4,74 · e^(-600/900)       = 2,43 V   > 2,0 V -> FAIL
crosses the 2,0 V tolerance at             = 900 · ln(4,74/2,0)        = 777 s
```

Direction under the battery convention: during phase A the RC terms *depress* the terminal
voltage (`U_dc = ocv − v_rc1 − v_rc2`), and in Sleep **`U_dc` rises toward OCV** as they decay.
`v_rc1` (τ₁ = 1 s) is gone within 5 s and contributes nothing.

**Tolerance `U_ocv_tol = 2,0 V`** — 0,24 % of the 840 V rail, and 1/60 of the 120 V OCV span,
i.e. 1,7 % of SOC if the reading were used for OCV recalibration.

> D2's illustrative "~1,8 V at 600 s" becomes **2,43 V**; the mechanism, the requirement and the
> rigged parameter are unchanged. The arithmetic is computed against the plant's actual RC model.

`FUN-003` passes in phase B: the cell spread starts at ≈ 38 mV (200 offsets drawn uniform on
±20 mV, seed 20260922), `BMS_Balancing_Act` rises at sleep entry (delta > 30 mV) and falls at
t ≈ 400 s into the sleep window (delta < 10 mV) with `TAU_BAL = 300 s`. Criterion: while
balancing is active, `BMS_U_Cell_Delta` is non-increasing and its end value is ≤ 50 % of its
start value. Achieved ≈ 26 %.

### 7.4 T4 — Cold heater · 600 s · `FUN-004` pass, **`FUN-005` FAIL**

Initial 20 °C pack, 50 % SOC, **ambient −10 °C**, `Kl15 = 1`, `VCU_Veh_State = 2 (Standby)`,
plug 0, `i_demand_a = 0`.

**Scenario condition (not a defect): plant `KE` 1,6 → 40 W/°C.** With the stock value a pack at
20 °C needs 2 166 s just to fall to 5 °C — longer than the whole trace. `KE = 40` is the
cold-soak thermal-loss coefficient of an uninsulated pack in a −10 °C draught; it is declared in
`plant_param_overrides` and it is what makes a 600 s cold test possible. It also puts the
500 W state-1 heater *below* the loss at ΔT = 14 K (560 W), which is what gives the defect
something to bite on.

**Defect: controller `HEAT2_ON` `T_batt_min` (5 °C) → 3 °C.** The state-2 entry threshold is
2 K too low, so the pack sits below `T_batt_min` on the 500 W heater, which cannot hold it.

| t (s) | `BTMS_Heater_State` | `BMS_T_Batt` | FUN-005 |
|---|---|---|---|
| 0 – 87 | 0 | 20 → 5 °C (cooling, τ = 125 s toward −10 °C) | ok |
| 87 – 288 | **1** | 5 → 3 °C (500 W < 560 W loss, equilibrium 2,5 °C) | **violated, 201 s** |
| 288 – 305 | 2 | 3 → 8 °C (2 000 W, +0,296 °C/s) | ok |
| 305 – 600 | 1 | 8 → ~3,2 °C (cooling toward 2,5 °C) | **violated from t ≈ 403 s, 197 s** |

All three heater states are occupied, so `FUN-004` passes on both its criteria (power mapping and
state coverage). `FUN-005` is violated for ≈ 398 s of 600 — unmistakable.

Under the **correct** law (`HEAT2_ON = 5 °C`) the same scenario limit-cycles 5 ↔ 8 °C with a
~109 s period and never sits below 5 °C outside state 2, so the defect is the only difference.

---

## 8. Measurand → signal map

Every measurand resolves to exactly one `response` signal.

| Requirement | Measurand | Signal | Frame | Unit |
|---|---|---|---|---|
| BAT-SYS-PRF-001 | `i_dc_chg` | `BMS_I_Dc` (negative while Charging) | BMS_01 | A |
| BAT-SYS-FUN-001 | `soc_technical` | `BMS_Soc_Tech` | BMS_02 | % |
| BAT-SYS-FUN-001 | `i_dc` | `BMS_I_Dc` | BMS_01 | A |
| BAT-SYS-FUN-001 | `t` | frame timestamp (`ts_ms`) | — | s |
| BAT-SYS-FUN-002 | `soc_technical` | `BMS_Soc_Tech` | BMS_02 | % |
| BAT-SYS-FUN-002 | `soc_customer` | `BMS_Soc_Cust` | BMS_02 | % |
| BAT-SYS-PRF-002 | `u_dc` | `BMS_U_Dc` | BMS_01 | V |
| BAT-SYS-PRF-002 | `u_ocv` | `BMS_U_Ocv_Est` | BMS_02 | V |
| BAT-SYS-PRF-002 | `t` | frame timestamp (`ts_ms`) | — | s |
| BAT-SYS-FUN-003 | `u_cell_min` | `BMS_U_Cell_Min` | BMS_04 | V |
| BAT-SYS-FUN-003 | `u_cell_max` | `BMS_U_Cell_Max` | BMS_04 | V |
| BAT-SYS-FUN-003 | `balancing_active` | `BMS_Balancing_Act` | BMS_04 | 1 |
| BAT-SYS-SAF-001 | `u_dc` | `BMS_U_Dc` | BMS_01 | V |
| BAT-SYS-SAF-002 | `t_batt` | `BMS_T_Batt` | BMS_03 | degC |
| BAT-SYS-SAF-003 | `t_batt` | `BMS_T_Batt` | BMS_03 | degC |
| BAT-SYS-SAF-003 | `derating_factor` | `BMS_Derating_Fct` | BMS_03 | 1 |
| BAT-SYS-SAF-003 | `i_dc_chg` | `BMS_I_Dc` (negative while Charging) | BMS_01 | A |
| BAT-SYS-FUN-004 | `heater_state` | `BTMS_Heater_State` | BTMS_01 | 1 |
| BAT-SYS-FUN-004 | `p_heater` | `BTMS_P_Heater` | BTMS_01 | W |
| BAT-SYS-FUN-005 | `t_batt` | `BMS_T_Batt` | BMS_03 | degC |
| BAT-SYS-FUN-005 | `heater_state` | `BTMS_Heater_State` | BTMS_01 | 1 |
| BAT-SYS-FUN-005 | `p_heater` | `BTMS_P_Heater` | BTMS_01 | W |

`i_dc_chg` is the charging **direction** of `BMS_I_Dc`, which is negative under the battery
convention. Every criterion that names it is written as a **lower** bound
(`BMS_I_Dc >= -I_current_Chr_Max`) and is windowed on `BMS_State == 3 (Charging)`.

`t` is the sample timestamp, not a bus signal — the only measurand with no `SG_` entry.
Witnesses used by criteria but not named as measurands: `BMS_T_Derate_Ref` (SAF-003 law input),
`BMS_I_Chg_Lim` (SAF-003 derived limit magnitude), `BMS_State` (state windows),
`BMS_U_Cell_Delta` (FUN-003 reduction).

---

## 9. Expected-verdict manifest

`out/manifest.json` — written by the generator, never hand-edited.

```json
{
  "schema": "battery-trace-manifest/1",
  "generated_utc": "2026-09-22T...",
  "generator":    { "name": "battery-trace-gen", "version": "0.1.0", "cell_seed": 20260922 },
  "plant_origin": { "repo": "quixstreams-tests",
                    "ref": "cae68bd710a247d7fbbd7174bebdcfd593219315",
                    "path": "dc-battery-sim",
                    "patch": "current-sign conversion to battery perspective, 3 statements" },
  "sign_convention": "battery: I > 0 = discharge, I < 0 = charge",
  "requirements_source": "backend/seed_data/battery/battery-dc-requirements.json",
  "parameters_source":   "backend/seed_data/battery/battery-dc-parameters.json",
  "dbc": { "path": "dcm-seed-dbc/dbc/BATTERY_DC_V1.dbc", "sha256": "...",
           "dcm": { "type": "dbc", "target_key": "BATTERY_DC_V1", "config_id": "..." },
           "counts": { "frames": 8, "signals": 249, "nodes": 4 } },
  "platform": "BATTERY_DC_V1", "device": "a3f1c07d9b4e2610",
  "traces": [
    { "trace_id": "T1", "file": "T1_charge_thermal.mf4", "route": "...", "segment": 0,
      "start_time_utc": "...", "duration_s": 900, "frame_count": 180000, "sha256": "...",
      "plant_param_overrides": {}, "controller_param_overrides": {},
      "expectations": [
        { "req_id": "BAT-SYS-SAF-002", "tc_id": "BAT-SYS-TC-003", "expected": "FAIL",
          "measurand": "t_batt", "signal": "BMS_T_Batt", "limit": "<= 60 degC",
          "measured": { "max": 61.6, "dwell_above_limit_s": 173.2 },
          "mechanism": "derating law correct, temperature input stale",
          "rigged": { "target": "controller", "parameter": "T_FILT_TAU",
                      "nominal": 2.0, "value": 5.0 } }
      ] }
  ]
}
```

`measured` is filled from the generator's own recorded signal history, so no achieved number is
ever written by hand. The per-trace `sha256` is only meaningful under the determinism
requirement of §5. `out/manifest.csv` flattens the ten expectation rows for the sanity print.

---

## 10. Test-spec set and bidirectional traceability

`battery-trace-gen/specs/battery-dc-test-specs.json`. Envelope matches
`battery-dc-requirements.json` (`schema_version: "1.0.0"`, `set: "test-specs"`,
`version: "v0001"`, `item_count: 10`, `item_ids`, `items`, `set_canonical_sha256`).

Items match the ACC test-spec item schema exactly (`tc_id`, `title`, `objective`,
`covers_req_ids`, `verification_method`, `technique`, `priority`, `status`, `revision`,
`schema_version`, `regression_flag`, `preconditions{prose,gates[]}`, `steps[]`,
`pass_criteria[]`, `pass_criteria_logic`, `entry_criteria`, `exit_criteria`,
`data_requirements{min_traces,trace_required,required_channel_groups,required_signals}`,
`stimulus{scenario_ref,variant_id,config_ref,notes}`, `test_environment`, `impl_ref`, `notes`,
`last_change`, `mnemonic`).

Battery-specific conventions:

* `tc_id` ∈ `BAT-SYS-TC-001` … `BAT-SYS-TC-010`, one per (trace, requirement) pair, so every
  `covers_req_ids` holds exactly one id and the ten cases cover the ten requirements.
* **`channel_group` and `required_channel_groups` carry CAN frame names** (`BMS_01`, `BTMS_01`,
  …), which is what the lake's `frame_name` column holds. The ACC set's `PT_CAN_100Hz` style has
  no counterpart in a bus-logging file.
* Every criterion on a current is written in battery sign, with the perspective restated in its
  `description`.
* `stimulus.scenario_ref` = the trace id (`T1`…`T4`); `stimulus.config_ref` = the first 12 hex of
  the scenario file's sha256; `variant_id` = `"nominal"` or the defect parameter name.
* `notes` states the expected verdict and, for the four failures, the mechanism and rigged
  parameter — mirroring §9 so the two can be diffed.
* `test_environment` names the plant origin ref **and the polarity patch**, the DBC sha256 and
  the DCM config id.

DCM registration: `type = "battery-test-specs"`, `target_key = "battery-dc"`,
`category = "vmodel"` — the §4.4 suffix convention of
`dev-planning/dcm-requirements-source/spec.md`. **The `-test-specs` ingest handler does not exist
on this branch** (`backend/api/vmodel_dcm.py:17-19` knows only `-requirements` and
`-parameters`); recovering `ingest_test_specs` from commit `8e95173` is separate work, out of
scope here.

### Bidirectional traceability — in scope (decided)

`verified_by` is `[]` on all ten requirements today. ASPICE audits the link in both directions,
and a requirement naming a test case the test case does not claim back is a finding, not a typo.

ArchDev therefore, in the same change:

1. allocates the ten `tc_id`s;
2. writes `verified_by: ["BAT-SYS-TC-nnn"]` onto each of the ten requirements in
   `backend/seed_data/battery/battery-dc-requirements.json`;
3. recomputes `set_canonical_sha256` for that file;
4. asserts the two directions agree — every `verified_by` entry appears in exactly one test
   case's `covers_req_ids`, and every `covers_req_ids` entry appears in that requirement's
   `verified_by`. A mismatch fails the build.

The coordinator feeds the updated set to DCM as `battery-requirements` **v3**.

---

## 11. DBC → DCM

**The DBC has exactly one home: `dcm-seed-dbc/dbc/BATTERY_DC_V1.dbc`.** The generator reads it
from there through a path constant.

> *Rejected:* a copy under `battery-trace-gen/dbc/`. The `dbc_sha256` stamped into the MF4 header
> and the bytes DCM serialises must be the same file; two copies guarantee they eventually are
> not.

`dcm-seed-dbc/platform_dbc.json` gains:

```json
"BATTERY_DC_V1": { "pt": "BATTERY_DC_V1" }
```

Seeding needs **no new code** — the existing Job does it:

```
DCM_TYPE=dbc  DBC_NAMES=BATTERY_DC_V1  PLATFORM=BATTERY_DC_V1
CONFIG_API_URL=http://config-api-svc  REPLACE=true
```

It logs `frames`, `signals` and `dbc sha256` (`dcm-seed-dbc/main.py:97-103`) and the derived
`config_id = sha1("dbc-BATTERY_DC_V1")` (`main.py:65-71`). `bus/mf4.py` recomputes that same
sha1 from two constants at write time — the value is never hard-coded. The live registration is
recorded in §16.

---

## 12. New-environment checklist

Four things must be true in the environment that ingests these traces, or nothing reaches the
lake. Every one of them was a live trap found while writing this spec.

1. **`mf4-decoder` sets `DBC_PLATFORM=BATTERY_DC_V1`.** `mf4-to-blob/metadata.py:87-98` never
   emits a `platform` field, so `main.py:938-940` falls through to this env var. Without it the
   lookup key is `"unknown"` and no configuration resolves.
2. **The DBC file is named `BATTERY_DC_V1.dbc`.** `dcm-seed-dbc/main.py:108` keys DCM by the file
   *basename*; the decoder looks up by *platform*. The two only meet if they are the same string.
3. **The MF4 header carries `bus.channels = 1=battery_hs_can1`.** Without it
   `provenance.parse_bus_channels` returns `{}` and every row's `channel_name` is `"unknown"`.
4. **No `VAL_` tables anywhere in the DBC.** They turn enum signals into strings in `value_text`
   and break every numeric criterion (`mf4-decoder/main.py:166-183`).

Also: `mf4-decoder` needs `DBC_SOURCE=dcm` and `DCM_TYPE=dbc` (both are the defaults).

---

## 13. Build list for ArchDev

New top-level `battery-trace-gen/` — an offline tool. No `app.yaml`, no `quix.yaml` entry, no
Dockerfile.

| Path | ~Lines | What |
|---|---|---|
| `battery-trace-gen/README.md` | 60 | How to run; the four traces; how to re-seed the DBC; the sign convention |
| `battery-trace-gen/requirements.txt` | 6 | pins, §14 |
| `battery-trace-gen/PLANT_ORIGIN` | 20 | repo, SHA `cae68bd710a247d7fbbd7174bebdcfd593219315`, source paths, vendoring date, **the three patched statements with before/after and why**, the `R0 = 0` / `KT1 = 0` constraints, and the note that upstream `devDB` is deliberately not changed |
| `battery-trace-gen/generate.py` | 100 | CLI `--scenario {all,T1..T4} --out out/`; loads scenarios, refuses non-zero `R0`/`KT1`, runs, writes MF4 + manifest |
| `plant/main.py` | +3 stmts | vendored, **patched only per §3.0** |
| `plant/signals.json` | +1 line | `dc_current_a` doc string |
| `plant/lexicon.py`, `plant/parameters.json` | — | vendored verbatim |
| `plant/loader.py` | 70 | env before import, `sys.modules.pop`, `importlib`, `time.sleep` no-op, `DERATING_LUT` reassign, param/state injection under `state_lock` |
| `plant/adapter.py` | 50 | `from_plant(payload) -> BusState` (units only), `to_plant(output) -> cmd` (the single `requested_power_w = -P_bus` negation) |
| `controller/state_machine.py` | 90 | the 7-state machine of §6 |
| `controller/laws.py` | 120 | L1–L7, L9; parameters injected, no literals |
| `controller/cells.py` | 80 | L8: seeded offsets, spread decay, min/max/delta/idx |
| `controller/bms.py` | 130 | `update(bus_state, t) -> ControllerOutput`; owns `T_ref` and `s(t)` |
| `bus/dbc.py` | 60 | load `../dcm-seed-dbc/dbc/BATTERY_DC_V1.dbc` via cantools; frame/cycle-time access; sha256 |
| `bus/crc.py` | 40 | CRC-8/SAE-J1850 table + per-frame `_BZ` counters |
| `bus/encoder.py` | 120 | latch signal values; `Message.encode` per frame; mux slot selection |
| `bus/scheduler.py` | 70 | cycle times → ordered `(t, frame_id)` stream, ascending id within a tick |
| `bus/mf4.py` | 150 | `CAN_DataFrame` structured signal, HD comment, `attach`, `save(compression=2)`, **and the `##FH` timestamp pinning of §5** |
| `scenarios/_identity.json` | 12 | §7 |
| `scenarios/_plant_base.json` | 12 | §7 |
| `scenarios/T1..T4_*.json` | 60 ea. | §7.1–7.4 |
| `specs/battery-dc-test-specs.json` | — | §10, 10 items |
| `dcm-seed-dbc/dbc/BATTERY_DC_V1.dbc` | 280 | hand-authored, §5 |
| `dcm-seed-dbc/platform_dbc.json` | +3 | one entry |
| `backend/seed_data/battery/battery-dc-requirements.json` | +10 | `verified_by` per requirement + new `set_canonical_sha256` (§10) |

Largest module 150 lines; the ~500-line ceiling is nowhere near. `out/` is already ignored by
`.gitignore:19`.

The plant's own unit tests are **not** vendored, with one exception:
`plant/tests/test_polarity.py` (§3.0), which Tester writes. `PLANT_ORIGIN` records the ref so the
rest can be run at source.

### Verification checklist (Tester, not ArchDev)

1. **Red-first polarity test** — `plant/tests/test_polarity.py` is RED against the unpatched
   vendored `main.py` and GREEN against the patched one. Assertions: sustained discharge ⇒
   `dc_voltage_v < ocv_v` and `dc_current_a > 0`; sustained charge ⇒ `dc_voltage_v > ocv_v` and
   `dc_current_a < 0`.
2. `cantools.database.load_file("dcm-seed-dbc/dbc/BATTERY_DC_V1.dbc")` → 8 frames, 249 signals,
   4 nodes, no exception.
3. DCM round trip: `dbc_json.to_json(db, ...)` → `dcm_dbc.materialise(doc, tmp)` returns
   **`dropped == 0`**. A dropped signal here means the multiplexed frame did not survive
   cantools' reader and the cell array is gone from the lake.
4. `MDF(out/T1_charge_thermal.mf4).extract_bus_logging({"CAN":[(dbc,0)]})` → **58 channel
   groups, not 8.** asammdf splits a multiplexed frame into one group per multiplexor value, so
   `BMS_Cell_01` alone yields 50 mux groups plus one for its non-multiplexed signals, alongside
   the seven other frames: 50 + 1 + 7 = 58. **That is standard mux extraction, not a defect** —
   the DBC still holds 8 frames / 249 signals / 4 nodes, and `Ucell_200` is present at exactly
   0,4 Hz (≈ `duration_s × 0,4` samples). Do not file the group count as a bug.
5. `provenance.parse_header_properties` on each MF4 → all five contract keys plus `bus.channels`
   resolve; `build_provenance` yields no `"unknown"`.
6. `out/manifest.csv` has exactly 10 rows and exactly 4 `FAIL`, and every `FAIL` row's `measured`
   value is on the violating side of its `limit`.
7. Traceability both ways: every requirement's `verified_by` ↔ exactly one test case's
   `covers_req_ids`, with no orphan on either side.
8. **Determinism (§5):** two runs of the same scenario into two *different* output directories
   produce sha256-identical MF4 files. If they differ, the first suspect is the `##FH` wall-clock
   stamp.

---

## 14. Dependencies

`battery-trace-gen/requirements.txt`:

```
asammdf==8.8.9        # the version mf4-decoder runs against (main.py:790 comment)
cantools==42.0.3      # same pin as dcm-seed-dbc and mf4-decoder
numpy>=1.26,<3
quixstreams==3.23.1   # the vendored plant imports it at module level
python-dotenv
```

> *Rejected:* stubbing `sys.modules["quixstreams"]` in `plant/loader.py` to avoid the install.
> It is a workaround around a package the plant genuinely imports, it would break the moment the
> plant touches a QS symbol at import time, and the project's standing directive is not to
> hand-roll around QuixStreams.

---

## 15. Out of scope

* **Visualisation UI service** (`c:\Users\lbazj\Downloads\uiservice.zip`) — wave 2.
* **A service that serves scenarios / specs / expectations.** This phase puts all of it in JSON
  documents with stable schemas so a service can later serve them unchanged; it does not build
  the service.
* **The `-test-specs` DCM ingest handler** in `backend/api/vmodel_dcm.py`. Recovery path for
  `ingest_test_specs` is commit `8e95173` (see `dev-planning/dcm-requirements-source/spec.md`
  §10).
* **Fixing the polarity defect upstream** in `quixstreams-tests@devDB`. The divergence is
  recorded, deliberate, and left for that repo to decide on.
* **An evaluator.** Nothing here reads the lake back and computes verdicts; the manifest states
  what an evaluator *should* find.
* **`quix.yaml` and deployment changes**, beyond the §12 checklist.
* **Any other edit to the vendored plant**, or anything under `backend/api/vmodel_fixtures/`.

---

## 16. Resolved decisions and build results

No open questions remain. The five that were open in rev 1:

| # | Question | Resolution |
|---|---|---|
| Q1 | Plant terminal-voltage polarity under load | **Confirmed defect** (v_rc1 = −10,000 V, v_rc2 = −0,476 V, Udc = 790,5 V vs OCV 780 V at −100 A). **Decided:** battery perspective everywhere; three statements patched in the vendored plant (§3.0); `R0` and `KT1` pinned to 0; red-first test; provisional `u_guard_rail` field and the run-time probe **removed**. |
| Q2 | `BMS_Cell_01` missing `_BZ` | **Decided:** keep `_CRC`, drop `_BZ`; the mux index is the sequence, stated in the frame catalogue and in the frame's `CM_ BO_` comment. |
| Q3 | T2 discharge current | **Decided:** +250 A (≈195 kW at 780 V), 1 440 s, 1,71 M rows. |
| Q4 | T1 dwell above 60 °C | **Decided:** 150–200 s accepted; the verdict is the ceiling breach. `T_FILT_TAU` 2 → 5 s stays the mechanism, worded "derating law correct, temperature input stale". Chiller off by design. |
| Q5 | `verified_by` empty on all ten requirements | **Decided:** fill it. ArchDev allocates the tc ids, writes them in, recomputes `set_canonical_sha256`, and asserts both directions agree; the coordinator feeds `battery-requirements` v3. |

### Confirmed during build — Tester round 1, 2026-09-22

* **Mux round-trip gate PASSED.** `dbc_json.to_json` → `dcm_dbc.materialise` →
  `cantools.load_string` returns **`dropped = 0`**, with **249 signals / 8 frames / 4 nodes**
  preserved. The 200-cell multiplexed frame survives the DCM round trip intact — this was the
  riskiest item in rev 1 and it is closed.
* **DBC live in the jamaui DCM**: `type = dbc`, `target_key = BATTERY_DC_V1`, config id
  `d527f90a80a9bcc8e81133a8d808f82679778a9d`, **version 1**, seeded 2026-09-22. This is the value
  `dcm.config_id` must carry in every MF4 header.
* **Decoded-group count is 58, not 8** — standard asammdf multiplexed-frame extraction, corrected
  in §13 checklist item 4. Not a defect.
* **`##FH` wall-clock timestamps** identified as the only source of run-to-run byte difference;
  the determinism requirement and its mechanism are now stated in §5.

---

## 17. References

* `dev-planning/battery-can-traces/test-report-round1.md` — Tester round 1, source of the rev 3
  corrections.
* `dev-planning/dcm-requirements-source/spec.md` (Final) — DCM-as-source, §4.4 type-suffix
  convention, §10 recovery path for `ingest_test_specs`.
* `mf4-decoder/{main.py, provenance.py, dcm_dbc.py, dbc_json.py}` — decode contract.
* `dcm-seed-dbc/{main.py, app.yaml, platform_dbc.json, dbc/ACC_ADAS_TC011.dbc}` — DCM seed
  contract and DBC house style.
* `origin/main:rlog-to-mf4/converter.py` — canonical `CAN_DataFrame` writer.
* `backend/seed_data/battery/{battery-dc-requirements.json, battery-dc-parameters.json}` — the
  ten requirements and eleven parameters, DCM v2 (→ v3 for `verified_by`).
* `quixstreams-tests@cae68bd710a247d7fbbd7174bebdcfd593219315:dc-battery-sim/{main.py,
  battery_sim_spec.md, signals.json, tests/conftest.py, tests/test_rc_circuit.py}` — the plant,
  the headless-drive pattern, and the test that failed to pin current direction.
* `CLAUDE.md` (project) — ASPICE chain, EARS patterns, house style, the 6/4 failure split rule.

---

## 18. Sanity print

Sign convention for every current below: **battery perspective, positive = discharge.**

### (a) Trace × requirement — 10 rows, exactly 4 FAIL

| Trace | Requirement | Signal | Limit | Expected | Mechanism if FAIL |
|---|---|---|---|---|---|
| T1 | BAT-SYS-PRF-001 | `BMS_I_Dc`, windowed on `BMS_State == 3` | ≥ −300 A (charge magnitude ≤ `I_current_Chr_Max`) | **PASS** | — |
| T1 | BAT-SYS-SAF-003 | `BMS_Derating_Fct` vs `BMS_T_Derate_Ref`; `BMS_I_Chg_Lim` vs `BMS_I_Dc` | `d = clamp((60−T)/5,0,1)` ±0,01; `BMS_I_Dc ≥ −BMS_I_Chg_Lim` ±0,5 A | **PASS** | — |
| T1 | BAT-SYS-SAF-002 | `BMS_T_Batt` | ≤ 60 degC | **FAIL** | Derating law correct, temperature input stale: controller `T_FILT_TAU` 2 s → 5 s. Peak ≈ 61,5 degC, ≈ 150–200 s above the ceiling. Plant clamp lifted to 65 degC so the model no longer hides it; chiller off by scenario design. |
| T2 | BAT-SYS-FUN-001 | `BMS_Soc_Tech` vs ∫`BMS_I_Dc` | ≤ 0,2 % over the sweep | **PASS** | — |
| T2 | BAT-SYS-SAF-001 | `BMS_U_Dc` | 720 … 840 V, all samples | **PASS** | — |
| T2 | BAT-SYS-FUN-002 | `BMS_Soc_Cust` vs `BMS_Soc_Tech` | \|err\| ≤ 0,5 % | **FAIL** | SOC map anchored low: controller `SOC_tech_at_cust_0pct` 25 → 20. Peak error **7,14 %** at `soc_tech = 25 %`, inside the 100 % → 23 % swept range. |
| T3 | BAT-SYS-FUN-003 | `BMS_U_Cell_Delta`, `BMS_Balancing_Act` | non-increasing; end ≤ 50 % of start | **PASS** | — |
| T3 | BAT-SYS-PRF-002 | \|`BMS_U_Dc` − `BMS_U_Ocv_Est`\| | ≤ 2,0 V at t_sleep + 600 s | **FAIL** | Diffusion constant longer than the budget: plant `TAU2` 600 → 900 s. 2,43 V at 600 s; crosses 2,0 V at 777 s. `U_dc` rises toward OCV during relaxation. |
| T4 | BAT-SYS-FUN-004 | `BTMS_P_Heater` vs `BTMS_Heater_State` | 0/500/2000 W ±1 W; all 3 states ≥ 1 s | **PASS** | — |
| T4 | BAT-SYS-FUN-005 | `BTMS_Heater_State` while `BMS_T_Batt` < 5 degC | == 2, all samples | **FAIL** | Heater threshold bug: controller `HEAT2_ON` 5 → 3 degC. Pack sits below 5 degC on the 500 W state for ≈ 398 s of 600. |

### (b) Decisions

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Current sign | Battery perspective everywhere (+ = discharge); plant patched in 3 statements | Powertrain sign; or leaving the plant as-is and re-anchoring SAF-001 to the upper rail | The plant mixes the two conventions and puts `U_dc` above OCV on discharge — confirmed numerically. One convention, converted once, is the only form in which all ten requirements read naturally. |
| Scope of the plant patch | `dc_current` negation, the two saturation guards, the coulomb line, one doc line | Also converting `solve_dc_current`'s `R0 > 0` quadratic | That branch is dead while `R0 = 0`, which every scenario pins. Converting unreachable code is where PR1110 starts. |
| `R0`, `KT1` | Pinned to 0,0 in `_plant_base.json`; `generate.py` refuses otherwise | Leaving them free | `R0 > 0` reaches the unconverted quadratic; `KT1 ≠ 0` flips the sign of a heating term. The check guards the patch's own correctness, not incoming data. |
| Charge-current signal | One signed `BMS_I_Dc`; criteria are lower bounds windowed on `BMS_State == 3` | A derived unsigned `BMS_I_Dc_Chg` | A derived duplicate is a second place for the sign to go wrong, and it cost 12 bits in the 100 Hz frame. |
| Enum encoding | Bare unsigned integers, legend in `CM_ SG_` comments | DBC `VAL_` tables | `mf4-decoder/main.py:166-183` routes value-table signals to `value_text` as strings; every numeric criterion on `BMS_State` / `BTMS_Heater_State` would break. `ACC_ADAS_TC011.dbc` already does it this way. |
| DBC filename | `BATTERY_DC_V1.dbc`, so `target_key == platform` | opendbc-style `battery_dc_v1` + `DBC_PLATFORM` override | `dcm-seed-dbc` seeds under the *basename* while the decoder looks up by *platform*; matching them removes the indirection. |
| DBC location | Only `dcm-seed-dbc/dbc/`; generator reads it from there | A second copy under `battery-trace-gen/dbc/` | The `dbc_sha256` in the MF4 header and the bytes DCM stores must be the same file. |
| Plant derating LUT | Flattened to 1,0 everywhere; the controller is the only derater | Retuned to `(55,1),(60,0)` to match SAF-003 | A retuned LUT makes the *plant* implement SAF-003, so the test would verify the model, and two derating stages would multiply. |
| `MAX_BATTERY_TEMP` | Raised to 65 degC in **every** scenario, declared as a model artefact | Raised only in T1, as T1's "defect" | The clamp alone produces no overshoot; calling it the defect would misname the mechanism. The real T1 defect is `T_FILT_TAU`. |
| Heater powers | Plant overridden to 500 / 2000 W for every scenario | Publish 500/2000 while the plant heats with 2500/5000 | The temperature rise would not match the published power — a failure indistinguishable from a bug. |
| Balancing | Flag `BMS_Balancing_Act`, `BMS_State` stays `Sleep` | A top-level `Balancing` state | A state change would end the Sleep residency and make PRF-002's entry edge ambiguous. |
| SAF-001 guard | Resistance-based discharge limit `(U_dc − Udc_min)/R_INT_EST` | Hard cut-off; or a linear guard band on `U_dc` | A hard cut puts one sample past the limit. A band narrower than the 37,5 V full-current drop chatters; one wide enough to be stable starts limiting at 81 % SOC. |
| `BMS_Cell_01` E2E | Mux + 4 × 12-bit cells + CRC = 64 bits; mux index is the sequence, no `_BZ` | 3 cells/frame (198 cells) to fit a 4-bit `_BZ` | Keeps D3's 4 × 12-bit / 200-cell shape and a round cell count. |
| T2 discharge current | +250 A → 1 440 s, 1,71 M rows | +100 A → 3 600 s, 4,3 M rows | Same arc, ≈195 kW inside the ±250 kW cap, and the peak FUN-002 error at 25 % SOC is still inside the swept range. |
| T1 dwell above 60 degC | 150–200 s accepted, chiller off | Raising `KE` or running the chiller to shorten it | The verdict is the ceiling breach. Cooling at 2 500 W against 2 502 W of I²R heating would suppress the overshoot and SAF-002 would pass. |
| `BMS_03` contents | `T_Batt`, `T_Derate_Ref`, `Derating_Fct`, `I_Chg_Lim` | `T_Batt`, `T_Min`, `T_Max`, `Derating_Fct` | The plant is a lumped thermal node with no honest source for per-cell temperatures; `T_Derate_Ref` lets SAF-003 (law) and SAF-002 (outcome) be judged separately in one trace. |
| Frame cadence | Deterministic, no jitter; `BMS_Cell_01` and `OBC_01` at 20 Hz | 100 Hz cell/OBC frames with ±1 ms jitter | 20 Hz matches real BMU/OBC rasters, cuts the lake to ~1 190 rows/s, and jitter would tie byte-for-byte reproducibility to an RNG seed for no gain. |
| MF4 determinism | Pin every `##FH` block timestamp to `header.start_time` | Leave asammdf to stamp `now()` and compare files with FH blocks masked out | The manifest records a per-trace `sha256`; a hash that changes per run cannot vouch for anything, and a masked comparison would need a bespoke reader. |
| Test-spec `channel_group` | CAN frame names (`BMS_01`, …) | ACC-style raster group names (`PT_CAN_100Hz`) | Frame name is what the lake's `frame_name` column holds for a bus-logging file. |
| `verified_by` | Filled in this change, both directions asserted | Deferred to the phase that ingests test specs | A requirement naming a test case that does not claim it back is an ASPICE finding; the assertion costs four lines. |
| `quixstreams` dependency | Installed, matching the plant's own pin | `sys.modules` stub in `plant/loader.py` | A stub is a workaround around a package the plant genuinely imports, against the project's QuixStreams-first directive. |
