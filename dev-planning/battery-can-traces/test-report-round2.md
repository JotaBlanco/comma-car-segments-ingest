# Battery CAN traces — verification report, Round 2

**Spec:** `dev-planning/battery-can-traces/spec.md` (Final, rev 2)
**Architecture:** `dev-planning/battery-can-traces/architecture.md`
**Code under test:** `battery-trace-gen/` (uncommitted, branch `jama-ui-dev`)
**Round 1 bugs re-verified:** Bug 1.1 (determinism, blocker) — FIXED. Bug 1.2 (ruff format nit) — FIXED. Bug 1.3 (spec wording, "8 vs 58 groups") — out of scope this round per Buddy's ownership, still valid as spec-layer note, not re-litigated.

---

## Sanity print

| Gate | Result | Numbers |
|---|---|---|
| `ruff check` (defaults, excl. vendored `plant/main.py`/`plant/lexicon.py`) | PASS | 0 findings |
| `ruff format --check` (same scope) | PASS | "23 files already formatted" — `runner.py` fix confirmed, no more reformats needed |
| Determinism (T4 × 2 fresh runs + existing `out/`) | PASS | all three sha256 identical: `a1217f4df891870e2a79cabf774a5d8942fd53d33c87f5f69b2d7f74ddd20c60` (scratch dir A, scratch dir B, and pre-existing `out/T4_cold_heater.mf4`) |
| FH block count (all 4 traces) | PASS | `len(mdf.file_history) == 1` for T1, T2, T3, T4 — the fix (`time_stamp = start_time` + `add_history_block=False`) confirmed across the whole set, not just T4 |
| Decoded MF4 (T2 discharge_sweep) | PASS | `extract_bus_logging` → 58 channel groups (mux-split, per round-1 Bug 1.3 resolution — expected, not a regression); 307 total channels = 58 time channels + 249 decoded signal channels |
| `BMS_I_Dc` polarity (T2) | PASS | min 0.0 / max 250.7 A, positive for 99.99% of samples — the residual is the declared zero-current dwell at trace start (consistent with round-1 finding), no negative values during discharge |
| `Ucell_200` rate (T2) | PASS | 576 samples / 1437.5 s = 0.4008 Hz ≈ 0.4 Hz (T2's duration is 1437.5 s, not T4's 600 s — rate is correct once duration is read from the trace itself) |
| DBC attachment | PASS | `BATTERY_DC_V1.dbc`, mime `application/x-dbc`, sha256 `1f86e4f5eb14d09a3e898b077475e2120e5168e7aad5b6e6340fa505e06d4899` — one attachment |
| `mf4-decoder/provenance.py build_provenance` (all 4 traces) | PASS | T1/T2/T3/T4 each resolve `platform`, `device`, `route`, `segment`, `dcm_config_id` with zero `"unknown"` values |
| `plant/tests/` (4 polarity tests) | PASS | `test_discharge_pulls_terminal_voltage_below_ocv`, `test_discharge_current_is_positive_in_battery_convention`, `test_charge_lifts_terminal_voltage_above_ocv`, `test_charge_current_is_negative_in_battery_convention` — 4/4 in 0.63s |

---

## Bug list

None. All Round 1 blockers and nits resolved; no new issues found.

---

## Notes

* Confirmed `out/T3_*.mf4` is named `T3_sleep_balance.mf4`, not `T3_high_power_pulse.mf4` as referenced in the brief — a naming mismatch in the brief text itself, not the code. No functional impact; the file exists and decodes cleanly under its actual name.
* `manifest.json` `generated_utc` timestamp variance across runs was not re-checked this round — already established in Round 1 as spec-mandated (§9), not a determinism target.
* `feed_dcm.py` not run, per constraint.
* No production code touched this round (verification only).

---

## Verdict

**READY TO UPLOAD.** Both Round 1 blockers (determinism, ruff format) are confirmed fixed and did not regress across the full 4-trace set. Lint gate clean, determinism clean, FH block count correct on every trace, decoded shape/polarity/rate all match spec, provenance clean, polarity test suite green. Bug 1.3 remains a spec-wording item owned by Buddy, not a code defect — does not block upload.
