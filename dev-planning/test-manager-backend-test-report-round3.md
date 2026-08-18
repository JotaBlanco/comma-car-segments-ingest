# Test Manager backend — verification report, round 3

**Branch:** `V-roundtrip` (ArchDev's round-2 fixes are uncommitted; nothing staged/committed/reverted/cleaned by this pass)
**Spec:** `C:\repos\acc_project\dev-planning\test-manager-v\spec.md`, `schemas.md`
**Architecture doc:** `dev-planning\test-manager-backend-architecture.md` — read in full including §2.2, §3.1, departures 19–20, the round-2 subsection, §9, before filing anything below
**Round 2 report:** `dev-planning\test-manager-backend-test-report-round2.md`
**Scope tested:** `backend-api/`, `dynamic-config-manager/`, `mf4-extractor/`, `test-vectors-sink/`, `tm-evaluator/`, `mongo-writer/` (gate); `frontend/`, `lakehouse-sink/`, `mongo-backup-manager/` (informational only)
**Demo:** presentation is Friday 2026-08-21 — anything that would break a live demo is called out separately below, tagged `DEMO-BLOCKING` or `demo-safe`.
**Live stack respected:** `tm-mongo` (container, `:27017`), backend on `:8080`, Streamlit on `:8501` were left running and unmodified throughout (re-verified at the end, see Table 6). All test runs used a separate `TM_MONGO_DB_NAME`/`TM_BLOB_LOCAL_ROOT` under `.tmp/round3/` or a scratch Mongo database (`tester_round3_up`, `tester_round3_down`), dropped after use.
**Note on repo state:** partway through this round, two new local commits (`4ecf629`, `738090b`) appeared on `V-roundtrip`, authored by Ludvík — a Streamlit `height=None` fix and a new local-docker-stack commit. Neither was made by Tester (no `git add`/`commit`/`checkout`/`clean` was run this round beyond `git status`/`log`/`branch`), and neither touches any file under this round's gate scope (`backend-api/`, `dynamic-config-manager/`, `mf4-extractor/`, `test-vectors-sink/`, `tm-evaluator/`, `mongo-writer/`). ArchDev's round-2 fixes remain uncommitted exactly as described in the brief. Flagged for transparency only.

---

## Sanity print

### 1. Steps

| Step | Command | Exit code | PASS/FAIL |
|---|---|---|---|
| 0. Install pinned lint tool | `pip install -r requirements-lint.txt` | 0 (already satisfied: ruff==0.16.3) | PASS |
| 1. Lint gate, pinned config | `python -m ruff check backend-api dynamic-config-manager mf4-extractor test-vectors-sink tm-evaluator mongo-writer` | 0, "All checks passed!" | **PASS** |
| 1b. Lint, informational | `python -m ruff check frontend lakehouse-sink mongo-backup-manager` | 1, 11 findings (not gate failures per brief) | informational only |
| 2. Import graph | `python -c "import main"` × 6, zero env vars | 0 × 6 | PASS |
| 3. `pytest backend-api/tests` | `python -m pytest tests -q` | 0, **61 passed**, 1 warning, 7.95–8.29s | PASS (expected 61 = 53+8; time in the "+7s" ballpark round 2 predicted) |
| 4. Cold-start repro (Bug 2.1) | `TestClient(main.api)` with lifespan, `MONGO_HOST=240.0.0.1:27017`, `GET /devices` fresh process | 503 in 3.078s | **PASS — FIXED** |
| 5. Staging cleanup, success (Bug 2.2) | `POST /uploads/requirements`, `/signal-catalog`, `blob=local` | 200/200, staging empty after both | **PASS — FIXED** |
| 5b. Staging cleanup, forced failure | monkeypatched `backend.copy` to raise on the manifest copy, direct `artifact_store.commit_version` call | staging dir survives, `list_versions` does not see the version | **PASS — matches departure 20 by design** |
| 6. Convergence, vendored fixtures | `POST /uploads/requirements/convergence-check` | 200, `converged:true`, 37/37, hash `5f4df40b4560f67f…` | PASS — regression protected |
| 6b. Convergence, real `acc_project` pair | same endpoint, `Reqs/export/acc-system-requirements.reqif` + `Reqs/export/json/acc-system-requirements.json` | 200, `converged:true`, 37/37, **identical hash** to 6 | PASS — regression protected |
| 6c. `reqif_parser` DeprecationWarning (Bug 2.4) | `pytest tests/test_reqif_json_convergence.py -W error::DeprecationWarning` | 0, 5 passed, no warning raised as error | **PASS — FIXED** |
| 7. Index lifecycle, Mongo up | `with TestClient(main.api)` against real `tm-mongo` (scratch DB `tester_round3_up`) | boot 0.0s, `/health` available=true ready=true, `/health/ready` 200, all 11 collections' custom indexes present | PASS |
| 7b. Index lifecycle, Mongo down | `with TestClient(main.api)`, unroutable host | boot < 1s (also pinned by `test_start_up_does_not_wait_for_mongo_and_still_answers_health`, part of step 3's 61) | PASS |
| 8. Regression: `/openapi.json` | `GET /openapi.json` | 200, 62 paths (matches round 2) | PASS |
| 8b. Regression: trace 422 codes | `POST /uploads/traces` with non-MDF4 and raw-CAN bytes | `not_mdf4` and `unsupported_raw_can`, exact match to round 2 | PASS |
| 8c. Regression: idempotent re-upload | same bytes twice | 1st `created:true`, 2nd `created:false`, same `trace_key` | PASS |
| 8d. Regression: `units.transform`/`units.equal` | direct call | both assertions true | PASS |
| 8e. Regression: `time_between_edges`/`alignment.uncertainty_s` @100Hz | `alignment.uncertainty_s(["PT_CAN_100Hz"])` | `0.005` | PASS |
| 8f. Regression: `metrics.compute` sum-check | 5 planned, 2 resulted | `tc_passed=1, tc_failed=1, tc_not_run=3, tc_error=0, tc_inconclusive=0`, `sum_check_ok:true`, 5==5 | PASS |
| 8g. Regression: blob=off flat envelope | 8 representative blob-dependent routes | all 503/404/422, **zero** `{"detail":{...}}` nesting | PASS |

### 2. Cold start: route, status, seconds, index warnings

| Route | Status | Seconds | Index warnings logged |
|---|---|---|---|
| `GET /health` | 200 | 3.125 | 0 (health never triggers index creation) |
| `GET /health/ready` | 503 | 3.016 | 0 |
| `GET /devices`, first Mongo-backed request, fresh process, lifespan active | **503** | **3.078** | **2** — one `"Skipping index creation: MongoDB is not reachable..."` and one summary `"MongoDB indexes still not created after 1 attempt(s); retrying every 30s"`, both from a **single** reconciler attempt, not 11 per-collection warnings |
| `GET /parameter-sets` (0.5s later, same process) | 503 | not separately timed; reconciler is a background thread, request path unaffected | 0 additional |

**Round 2 measured 36.94 s / 37.00 s for this exact repro. Round 3 measures 3.078 s — an ~12x improvement, and inside the 4 s bound the brief specifies.** The "at most one index warning, not eleven" bar is met: the two lines observed both describe one reconciler attempt (the per-attempt "skipping" line plus its own summary line), not the eleven distinct per-collection warnings round 2 found.

### 3. Convergence: pair, converged, 37/37, hash

| Pair | Status | `converged` | Item counts | `set_canonical_sha256` (reqif / json) |
|---|---|---|---|---|
| Vendored fixtures | 200 | true | 37/37 | `5f4df40b4560f67fe8fe5ee14a85a6b3c5fe9e4206901b63f0a3d0e1545714b2` (both sides) |
| Real `acc_project` pair | 200 | true | 37/37 | `5f4df40b4560f67fe8fe5ee14a85a6b3c5fe9e4206901b63f0a3d0e1545714b2` (both sides, identical to vendored) |

All four hashes across both pairs are identical. `only_in_reqif`/`only_in_json`/`mismatched_ids` are `[]`/`[]`/`[]` in both. **The protected release-blocker result holds exactly.**

### 4. Staging: after success, after failure

| Scenario | `.staging/` after the operation |
|---|---|
| `POST /uploads/requirements` success | empty — token directory removed |
| `POST /uploads/signal-catalog` success | empty — token directory removed |
| Forced failure (manifest copy raises `OSError`) | **one token directory survives** (`signal_catalog-v9999-<uuid>`), and the version never appears in `list_versions("signal_catalog")` |

This matches departure 20 exactly: cleanup happens only after a successful manifest copy, and a failed commit's staging directory is the deliberate recovery evidence, not a leak.

### 5. Ruff: gate dirs findings, informational dirs findings

| Scope | Command | Findings |
|---|---|---|
| Gate (six app dirs) | `ruff check backend-api dynamic-config-manager mf4-extractor test-vectors-sink tm-evaluator mongo-writer` | **0** — "All checks passed!" |
| Informational (`frontend`, `lakehouse-sink`, `mongo-backup-manager`) | `ruff check frontend lakehouse-sink mongo-backup-manager` | **11**, exit 1 — not a gate failure per this round's brief; matches the architecture doc's statement that these three directories "have never been audited against it" |

---

## Round-2 findings, re-verified

- **Bug 2.1 (cold-start ~37 s) — FIXED.** Fresh-process, lifespan-active `GET /devices` against an unroutable Mongo answers 503 `mongo_unavailable` in 3.078 s, not 36.94–37.00 s. `deps.get_db` performs no I/O (confirmed by reading `deps.py`: `database()` is a pure lookup once the client exists, and index creation lives entirely in `ensure_indexes_once`/`_reconcile_indexes`, started by `main.lifespan` in a daemon thread). Log output during the cold-start repro carries exactly one reconciler attempt's worth of warnings (2 lines, one attempt), not eleven per-collection warnings. `mongo_schema.ensure_indexes` re-raises the first `ConnectionFailure` and swallows only per-collection `OperationFailure` — both properties directly pinned by `test_ensure_indexes_pays_one_timeout_not_one_per_collection` and `test_ensure_indexes_still_survives_one_collections_own_failure` in `tests/test_mongo_index_lifecycle.py`, both green. Also re-verified live against the real `tm-mongo` container (scratch DB): boot time 0.0 s, all 11 collections' non-`_id_` indexes present after ~1 s.
- **Bug 2.2 (staging never cleaned up) — FIXED.** Success path leaves zero token directories under `.staging/` for both `/uploads/requirements` and `/uploads/signal-catalog`. A forced failure (monkeypatched `backend.copy` raising on the manifest copy specifically) leaves exactly one staged token directory behind and the version never becomes visible via `list_versions` — this is departure 20's documented behaviour, not a defect, and is not re-filed.
- **Bug 2.3 (unpinned lint gate, 148 findings) — FIXED.** `ruff.toml` + `requirements-lint.txt` pin the rule set (`E4,E7,E9,F,I,B008,BLE,ISC004,UP033,SIM115,RET501,PLR1711,RUF100`), the nine `src` roots, `extend-immutable-calls` for the nine FastAPI helpers, and ruff `0.16.3` exactly. `ruff check` over the six gate directories returns **0** findings, verbatim: `"All checks passed!"`.
- **Bug 2.4 (ElementTree truthiness DeprecationWarning) — FIXED.** `pytest tests/test_reqif_json_convergence.py -W error::DeprecationWarning` passes 5/5 with the warning promoted to an error, i.e. zero instances raised. `reqif_parser.py` now uses `_first(...) is not None and len(_first(...))`-style explicit checks per the architecture doc's round-2 subsection.

All four round-2 findings: **FIXED.** All five round-1 findings remain fixed (protected result, re-confirmed via the full 61-test pytest pass and the convergence checks above).

---

## No new bugs this round

Everything targeted by the brief passed. No spec questions, no new code defects, no lint regressions in the gate scope.

---

## Checks that passed cleanly (for the record)

- Lint gate (pinned): **0** findings across all six application directories, exact command from `ruff.toml`'s own header comment.
- Informational lint baseline: 11 findings across `frontend`/`lakehouse-sink`/`mongo-backup-manager` — not a gate failure, consistent with the architecture doc's statement these are unaudited.
- Import graph, all six apps, zero env vars — no regression.
- `pytest backend-api/tests`: **61/61 passed** (53 carried forward + 8 new in `test_mongo_index_lifecycle.py` and `test_artifact_store_staging.py`), 7.95–8.29 s.
- Cold-start repro: 3.078 s, well inside the 4 s bound, down from round 2's 36.94–37.00 s.
- `/health` (3.125 s) and `/health/ready` (3.016 s) under a genuinely unreachable Mongo — both within bound, unchanged from round 2.
- Staging: clean on success (both artifact sets), correctly preserved on a forced failure.
- Convergence: both fixture pairs converge, 37/37, identical `set_canonical_sha256` (`5f4df40b4560f67f…`) across all four hash values (reqif/json × vendored/real).
- Index lifecycle: Mongo up → all 11 collections get their custom indexes via the start-up reconciler (not the request path); Mongo down → boot completes without blocking and the process stays live.
- Full regression set: `/openapi.json` (62 paths), trace 422 `not_mdf4`/`unsupported_raw_can`, idempotent re-upload, `units.transform`/`units.equal`, `alignment.uncertainty_s`=0.005 @100Hz, `metrics.compute` sum-check (5 planned, 2 resulted, sum-check ok), 8/8 representative blob=off routes flat-enveloped with zero `detail` nesting.
- Live demo stack (`tm-mongo`, `:8080`, `:8501`) confirmed running and untouched before and after this round's testing (Table 6, see below).

### Table 6 — live stack, before/after

| Check | Before | After |
|---|---|---|
| `tm-mongo` container | Up | Up (unchanged) |
| `GET :8080/health` | 200 | 200 |
| `:8501` (Streamlit) | 200 | 200 |
| `testmanager` DB present, scratch DBs absent | — | confirmed: `admin, config, local, testmanager` only |

---

## Harness artifacts (throwaway, not committed)

- `.tmp/round3/ruff_gate.txt`, `ruff_informational.txt` — full ruff output for both scopes.
- `.tmp/round3/harness_mongo_down.py`, `harness_mongo_up.py` — cold-start and warm-Mongo lifecycle repros, both using the real pinned timeouts against `240.0.0.1:27017` and the real `tm-mongo` container (scratch DB, dropped after use).
- `.tmp/round3/harness_staging.py`, `harness_staging2.py` — success-path and forced-failure staging cleanup checks.
- `.tmp/round3/harness_convergence.py` — both fixture pairs via the live endpoint.
- `.tmp/round3/harness_regressions.py`, `harness_blob_off.py` — round-1/2 regression re-checks (openapi, trace 422s, idempotency, units, blob=off envelope shape).
- `.tmp/round3/blob_local/`, `blob_local2/`, `blob_regress/` — local blob backend roots used per harness.

---

## Exit condition

**All tests green — exit condition (a) met.** Every round-2 finding is FIXED and re-verified; no new bugs; no lint regressions in the gate scope; both protected release-blocker results (convergence hash, all five round-1 findings, 61/61 pytest) hold exactly. **Nothing is demo-blocking for Friday.** Recommend closing the ArchDev↔Tester loop for this feature.
