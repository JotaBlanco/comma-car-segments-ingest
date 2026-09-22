# Battery CAN traces — verification report, Round 1

**Spec:** `dev-planning/battery-can-traces/spec.md` (Final, rev 2)
**Architecture:** `dev-planning/battery-can-traces/architecture.md`
**Code under test:** `battery-trace-gen/` (uncommitted, branch `jama-ui-dev`)
**Tester:** this round
**New test file:** `battery-trace-gen/plant/tests/test_polarity.py` (+ `plant/tests/conftest.py`)

---

## Sanity print

| Gate | Result | Numbers |
|---|---|---|
| ruff check (defaults, excl. vendored `main.py`/`lexicon.py`) | PASS | 0 findings |
| ruff format --check (same scope) | NIT | `runner.py` would reformat (2 long-line wraps); not requested by the checklist but part of "ruff defaults" |
| Vendored plant diff vs `cae68bd7` | PASS | main.py: exactly the 3 statements (lines 373-374, 377, 379, 390); signals.json: exactly the 1 description line; lexicon.py, parameters.json: byte-identical; `plant/main.py` sha256 `05d10db2...5ed3` matches `PLANT_ORIGIN` |
| Mux round-trip (DCM) | PASS | `dropped=0`; reparsed 8 frames / 249 signals / 4 nodes; `BMS_Cell_01` multiplexed, 200 `Ucell_*` + mux signal intact; 0 `VAL_` tables |
| Polarity RED (pristine `cae68bd7`) | RED confirmed | discharge: `dc_voltage_v=789.7052 > ocv_v=779.8053`, `dc_current_a=-98.771` (wrong sign); charge: `dc_voltage_v=770.0495 < ocv_v=780.1988`, `dc_current_a=101.2922` (wrong sign) |
| Polarity GREEN (patched `plant/main.py`) | GREEN confirmed | discharge: `dc_voltage_v=769.6475 < ocv_v=779.8012`, `dc_current_a=101.3451`; charge: `dc_voltage_v=790.0905 > ocv_v=780.1946`, `dc_current_a=-98.7229`; all 4 pytest assertions pass |
| Decoded MF4 (T1, T4) | PASS w/ spec-checklist mismatch | 58 asammdf channel groups (not the checklist's literal "8"); 8 distinct frame identities confirmed; `Ucell_200` 240 samples / 600 s = exactly 0,4 Hz; provenance clean on all 4 traces (no `"unknown"`); DBC attachment `mime=application/x-dbc`; T2 `BMS_I_Dc` positive throughout the discharge leg except the 10 declared zero-current samples at t=0,00–0,09 s |
| Manifest 10/4 | PASS | 10 rows, exactly 4 FAIL: T1→SAF-002, T2→FUN-002, T3→PRF-002, T4→FUN-005; every FAIL `measured` value on the violating side of its `limit` |
| Traceability | PASS | bidirectional check: 0 mismatches; `battery-dc-requirements.json` `set_canonical_sha256` and `battery-dc-test-specs.json` `set_canonical_sha256` both recompute exactly |
| Measurand → signal coverage | PASS | all 12 distinct measurand signals resolve in the 249-signal DBC |
| Determinism (T4 × 3 runs) | **BLOCKER — FAIL** | sha256 `2265dd89...`, `2627e366...`, `65ee123f...` — all different, same 125 136-byte size; diff isolated to two 8-byte fields inside asammdf's auto-generated FH (File History) blocks |
| `platform_dbc.json` | PASS | valid JSON, `"BATTERY_DC_V1": {"pt": "BATTERY_DC_V1"}` present, 189 total entries |

---

## Bug list

### Bug 1.1 — MF4 output is not byte-identical across runs (asammdf FH-block timestamp)

**Test:** manual determinism check per checklist item 8 (`generate.py --scenario T4 --out <scratch>` × 3)
**Spec reference:** spec.md §5 "Both are fully deterministic, so two runs of the same scenario produce byte-identical MF4 payloads," and the §13 Tester checklist item 8: "Two consecutive runs of the same scenario produce identical `sha256` for the MF4."
**Expected:** `T4_cold_heater.mf4` sha256 identical across repeated runs of the same scenario.
**Actual:** Three independent runs into three scratch output dirs produced three distinct sha256 values (`2265dd89727d9e24e80c3d639d6e5f73bfabd078f22b717848ff529f3a86b1cd`, `2627e366049fcc1ce8d3309ea9c8fd2bd9b6601bd8ce038fcc9547679499abde`, `65ee123fcf84a67edffc826be1733e986c088f4d2756fb168da8c3387dc06db4`). Files are identical in size (125 136 bytes). Byte-level diff isolates to exactly 8 differing bytes, split across two 8-byte fields inside two `##FH` (File History) blocks — consistent with a little-endian int64 wall-clock nanosecond timestamp that asammdf writes internally on `mdf.append()`/`mdf.attach()`/`mdf.save()`. `bus/mf4.py`'s `write()` never touches `mdf.file_history` or neutralizes these timestamps; every other byte in the file (all 120 000 `CAN_DataFrame` samples, the DBC attachment bytes, the `<HDcomment>` provenance block) is confirmed identical.
**Reproduction:**
```
cd battery-trace-gen
python generate.py --scenario T4 --out <scratchA>
python generate.py --scenario T4 --out <scratchB>
python -c "import hashlib; print(hashlib.sha256(open('<scratchA>/T4_cold_heater.mf4','rb').read()).hexdigest())"
python -c "import hashlib; print(hashlib.sha256(open('<scratchB>/T4_cold_heater.mf4','rb').read()).hexdigest())"
```
**Root cause layer:** code
**Suspected root cause:** asammdf's `MDF.append()`/`MDF.attach()` each append a new `##FH` block recording `time.time_ns()` (or equivalent) as part of the standard MDF4 "file history" mechanism. `bus/mf4.py:write()` does not override or zero these after the fact.
**Suggested fix:** after building the MDF and before `mdf.save(...)`, iterate `mdf.file_history` and set each entry's timestamp to a fixed value derived from the scenario (e.g. `start_time_utc`), the way `mdf.header.start_time` is already pinned from scenario data. Whether the FH blocks are in scope of the spec's "byte-identical" claim, or whether that claim should be narrowed to "identical `CAN_DataFrame` payload, DBC bytes and HD comment" (excluding FH metadata that MDF4 itself defines as an audit trail), is ArchDev's/Buddy's call — but the current behavior does not satisfy the literal checklist item as written.

### Bug 1.2 — `runner.py` fails `ruff format --check`

**Test:** `lint gate` (`ruff format --check battery-trace-gen --exclude .../main.py --exclude .../lexicon.py`)
**Spec reference:** CLAUDE.md (project) "ArchDev writes code that would pass the linters clean (ruff defaults, project conventions)"; CLAUDE.md (user) "Write Python test code that conforms to ruff's default ruleset" applies to Tester's own code, but the project's own directive that ArchDev's code must pass ruff defaults clean extends to `ruff format`.
**Expected:** `ruff format --check` reports no reformatting needed.
**Actual:** `battery-trace-gen/runner.py` would be reformatted — two lines exceed ruff's default line-length wrap point:
```
--- battery-trace-gen\runner.py
+++ battery-trace-gen\runner.py
@@ -48,9 +48,7 @@
-    log = FrameLog(
-        scheduler.frame_count(ticks * SLOTS_PER_TICK), identity.bus_channel
-    )
+    log = FrameLog(scheduler.frame_count(ticks * SLOTS_PER_TICK), identity.bus_channel)
@@ -112,8 +110,7 @@
-            name: np.array([sample[name] for sample in samples])
-            for name in samples[0]
+            name: np.array([sample[name] for sample in samples]) for name in samples[0]
```
**Reproduction:** `python -m ruff format --check battery-trace-gen --exclude battery-trace-gen/plant/main.py --exclude battery-trace-gen/plant/lexicon.py`
**Root cause layer:** code
**Suspected root cause:** manual line-wrapping that ruff's formatter would collapse; purely cosmetic, `ruff check` (the lint ruleset) is clean.
**Suggested fix:** run `ruff format battery-trace-gen/runner.py`.
**Severity:** nit.

### Bug 1.3 — spec's Tester checklist item 4 states "8 decoded groups," asammdf returns 58

**Test:** `browser e2e` n/a; manual decode check per checklist item 4 (`MDF(...).extract_bus_logging(...)`)
**Spec reference:** spec.md §13 Tester checklist item 4: "`MDF(out/T1_charge_thermal.mf4).extract_bus_logging({"CAN":[(dbc,0)]})` → 8 decoded groups; `Ucell_200` present with ≈ `duration_s × 0,4` samples."
**Expected:** 8 decoded channel groups (one per DBC frame).
**Actual:** `extract_bus_logging` returns 58 channel groups for both T1 and T4: the 7 non-multiplexed frames (1 group each) plus `BMS_Cell_01` split into 51 groups by asammdf (1 "common" group carrying `BMS_Cell_Mux`/`_CRC`, plus one group per of the 50 distinct multiplexor values, each carrying its own 4 `Ucell_*` signals). This is asammdf's/cantools' standard handling of a multiplexed CAN message during bus-logging extraction — different mux slots carry structurally different signals and cannot share one flat channel group — and is not something the generator controls. The 8-frame catalogue itself is intact (verified: 8 distinct `acq_name` values `CAN1 message ID=0x100...0x400`), `Ucell_200` is present at exactly 240 samples / 600 s = 0,4 Hz as required, and `frame_name`/provenance attribution is unaffected (confirmed separately via `build_signal_frame_map`).
**Reproduction:**
```python
from asammdf import MDF
mdf = MDF("battery-trace-gen/out/T1_charge_thermal.mf4")
extracted = mdf.extract_bus_logging(database_files={"CAN": [("dcm-seed-dbc/dbc/BATTERY_DC_V1.dbc", 0)]})
len(extracted.groups)  # 58, not 8
```
**Root cause layer:** spec
**Suspected root cause:** the checklist item's literal "8 decoded groups" did not account for asammdf's mux-splitting behavior when the spec was written; the underlying frame/signal catalogue is correct.
**Suggested fix:** none needed in code. Suggest Buddy revise the checklist wording to "8 distinct decoded frame identities (`acq_name`), noting `BMS_Cell_01` expands into 51 channel groups under asammdf's multiplexed-message extraction" so a future Tester round doesn't re-flag this as a regression.
**Severity:** informational / spec wording only — no functional defect found.

---

## What I could not verify

* **T2/T3 full decoded-shape checks** (beyond `BMS_I_Dc` positivity and provenance) were not exhaustively re-derived against every criterion in the manifest — the manifest's own `measured` fields were cross-checked for FAIL-side violation but not independently recomputed signal-by-signal from the raw MF4 for every one of the 10 test cases. This is a reasonable scope cut for Round 1; flag if a deeper per-criterion recompute is wanted.
* **`feed_dcm.py`** was not run (explicitly out of scope — it posts to a live DCM).
* **DCM seed Job** (`dcm-seed-dbc` with `DCM_TYPE=dbc DBC_NAMES=BATTERY_DC_V1 ...`) was not run live; only the JSON round-trip (`to_json`/`materialise`) was exercised locally, per the brief.
