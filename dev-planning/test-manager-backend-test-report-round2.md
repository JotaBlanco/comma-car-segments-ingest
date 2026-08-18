# Test Manager backend — verification report, round 2

**Branch:** `V-roundtrip` (uncommitted working tree; nothing staged/committed/reverted by this pass)
**Spec:** `C:\repos\acc_project\dev-planning\test-manager-v\spec.md`, `schemas.md`
**Architecture doc:** `dev-planning\test-manager-backend-architecture.md` — read in full including §2.2, §2.2.1, §3.1, §3.3, §4, §8 (departures 13-18), §9 before filing anything below
**Round 1 report:** `dev-planning\test-manager-backend-test-report-round1.md`
**Scope tested:** `backend-api/`, `dynamic-config-manager/`, `mf4-extractor/`, `test-vectors-sink/`, `tm-evaluator/`, `mongo-writer/`
**Not tested (per brief):** deferred unit-test runner; `mf4-extractor`/`test-vectors-sink` blob paths (binds commented out, gateway down); `frontend/`
**Environment:** the venv built in round 1 (`.tmp/venv`, all six apps' deps + `mongomock` + `pytest` + `ruff`) was reused as-is; nothing new needed installing. Python 3.12.10.
**Mongo:** no local `mongod`/docker available in this sandbox (checked: no service, no docker daemon). Two techniques used, stated per check: (a) `mongomock.MongoClient()` monkeypatched over `deps._client`/`deps._db` for the "Mongo up" happy-path checks; (b) a **real** `pymongo.MongoClient` pointed at the reserved, unroutable address `240.0.0.1:27017` for the "Mongo down" timing checks — this exercises the actual pinned timeouts end to end (real socket-level `AutoReconnect`), which is a stronger proof than round 1's mongomock-only approach could give for the timing claim specifically.
**Kafka:** deliberately left unconfigured (`Quix__Sdk__Token`/broker address blanked in-process) to reproduce "no broker" for Bug 3 checks; a working bus was simulated via `main.api.dependency_overrides[deps.get_bus]` for the republish/idempotency checks. **Caveat:** one ad hoc, now-superseded harness call inadvertently picked up a real `Quix__Sdk__Token` from `C:\repos\acc_project\.env` (via `load_dotenv()`'s upward search from this sandbox's default working directory) and made one real HTTP call to the live Quix testrig portal API, which answered `409 WorkspaceOutOfSync` and mutated nothing. All harnesses used for the findings below explicitly blank `Quix__Sdk__Token`/`Quix__Portal__Api`/`Quix__Workspace__Id`/`Quix__Pat__Token` first and were re-verified hermetic. Flagged for transparency, not filed as a product bug — it is an artifact of this sandbox's `.env`, not of the code under test.

---

## Sanity print

### Table 1 — `import main`, no env vars set

| App dir | import main | exit code |
|---|---|---|
| backend-api | success | 0 |
| dynamic-config-manager | success | 0 |
| mf4-extractor | success | 0 |
| test-vectors-sink | success | 0 |
| tm-evaluator | success | 0 |
| mongo-writer | success | 0 |

No regression. All six still import cleanly with zero env vars.

### Table 2 — steps

| Step | Command | Exit / result | PASS/FAIL |
|---|---|---|---|
| 1. Install | none needed; round-1 venv reused | — | PASS |
| 2. Import graph | `python -c "import main"` × 6 | 0 × 6 | PASS |
| 3. Lint (ruff defaults, no `--select`) | `python -m ruff check --isolated <dir>` × 6 | 101+8+12+6+14+7 = **148 findings**, exit 1 × 6 | **FAIL — Bug 2.3** |
| 4. `pytest backend-api/tests` | — | **53 passed**, 0 failed, 222 warnings, 1.97s | PASS |
| 5a. `GET /health`, Mongo down | real unreachable IP | 200 in 3.19s; `schema_registry.compiled=true, errors=[]`; `mongo.available=false`; `ready=false` | PASS |
| 5b. `GET /health/ready`, Mongo down | — | 503 in 3.09s | PASS (within the 4s bound) |
| 5c. `GET /devices`, Mongo down, **first request in a fresh process** | — | 503 `mongo_unavailable` in **36.94–37.00s** | **FAIL — Bug 2.1, blocker** |
| 5d. same route, 2nd/3rd call, same process | — | 503 in 3.06–3.08s | PASS |
| 6a. `POST /uploads/requirements`, blob=local | 37-item vendored JSON fixture | 200, `version=v0001, item_count=37` | PASS (was 500 in round 1) |
| 6b. `POST /uploads/signal-catalog`, blob=local | 1-item payload | 200, `version=v0001, item_count=1` | PASS (was 500 in round 1) |
| 6c. manifest-last mechanism | `manifest.json` present, `list_versions()` sees `v0001` | confirmed | PASS |
| 6d. staged-commit token cleanup | `.staging/<token>/` dirs after commit | **left behind, never deleted** | **FAIL — Bug 2.2, new** |
| 7a. Convergence check, vendored fixtures | `tests/fixtures/*.reqif` + `*.canonical.json` | 200, `converged:true`, 37/37, all 3 assertions true | PASS — release blocker resolved |
| 7b. Convergence check, real `acc_project` pair | `Reqs/export/acc-system-requirements.reqif` + `Reqs/export/json/acc-system-requirements.json` | 200, `converged:true`, 37/37, all 3 assertions true, **identical `set_canonical_sha256`** to 7a | PASS — release blocker resolved |
| 8a. Trace upload, no broker | fresh device/version registered first | 503 `event_bus_unavailable`, `created:true`, `persisted` names `blob_object`, `blob_meta`, `mongo_traces_row:true`, `publish_state:"failed"`, `lake_rows:false` | PASS |
| 8b. Re-upload identical bytes, broker still down | — | 503, `created:false`, `published:false` (unchanged, correct — bus is still down) | PASS |
| 8c. Re-upload identical bytes, broker now up (override) | — | 200, `created:false`, `published:true`, `publish_state:"published"`, `publish_attempts:2` | PASS |
| 9. Mongo stopped, any Mongo-backed route | `/devices`, `/parameter-sets`, `/test-runs` | 2nd+ calls in-process: 503 in ~3.1s; **1st call in a fresh process: 37s** (see 5c) | **PARTIAL FAIL — Bug 2.1** |
| 10a. `GET /openapi.json` | — | 200, 62 paths (round 1: 61 — +1, no missing paths, expected from `?publish_state=` addition) | PASS |
| 10b. Trace 422 `not_mdf4` / `unsupported_raw_can` | — | both exact-match | PASS |
| 10c. Idempotent re-upload | — | 1st 200 `created:true`, 2nd 200 `created:false`, same `trace_key` | PASS |
| 10d. `units.transform`/`units.equal` | — | both assertions true | PASS |
| 10e. `time_between_edges`/`alignment.uncertainty_s` @100Hz | — | `0.005` | PASS |
| 10f. `metrics.compute` sum-check | 5 planned, 2 resulted | `tc_passed=1, tc_failed=1, tc_not_run=3, tc_error=0, tc_inconclusive=0`, `sum_check_ok:true`, `5==5` | PASS |

### Table 3 — endpoint envelope shape, blob=local vs blob=off vs door-validation

| Endpoint | blob=local | blob=off | Envelope shape correct (Y/N) |
|---|---|---|---|
| `POST /uploads/requirements` | 200 (fixed) | 503 top-level `{error:"blob_storage_unavailable", message, hint}` | **Y** — no `detail` nesting anywhere |
| `POST /uploads/test-specs` | not exercised this round (no new logic vs. requirements path) | 503, same flat shape | Y |
| `POST /uploads/signal-catalog` | 200 (fixed) | 503, same flat shape | Y |
| `POST /uploads/traces` | 503 `event_bus_unavailable` naming trace_key/persisted (no broker) | 503 `blob_storage_unavailable` | Y |
| `POST /baselines` | not exercised | 503, same flat shape | Y |
| `GET /requirements`, `GET /test-cases` | not exercised | 503, same flat shape | Y |
| `GET /graph/requirement/{id}` | not exercised | 503, same flat shape | Y |
| `GET /artifacts/requirements/{v}` | 404 (version doesn't exist in that run) | — | Y, flat `{error:"not_found", message}` |
| `POST /uploads/requirements` (bad item) | **422** `{error:"upload_rejected", message, problems[], stage, problem_count}` — exact re-baselined shape | (blob=off pre-empts this) | Y |
| `GET /devices`, `POST /devices`, `GET /parameter-sets`, `GET /test-runs` (no blob dependency) | 200/201 in both blob modes | 200/201 | Y |

15/15 blob-dependent cases re-checked against the flat shape; **zero** instances of `{"detail": {...}}` nesting observed anywhere in this round (403/404/422/503 all checked).

### Table 4 — convergence-check, both pairs

| | Vendored fixtures | Real `acc_project` pair |
|---|---|---|
| HTTP status | 200 | 200 |
| `converged` | **true** | **true** |
| `per_item_hashes_equal` | true | true |
| `set_hash_equal` | true | true |
| `stored_bytes_equal` | true | true |
| item counts | 37 / 37 | 37 / 37 |
| `set_canonical_sha256` (reqif side) | `5f4df40b4560f67f…` | `5f4df40b4560f67f…` (identical) |
| `set_canonical_sha256` (json side) | `5f4df40b4560f67f…` | `5f4df40b4560f67f…` (identical) |
| `only_in_reqif` / `only_in_json` / `mismatched_ids` | `[]` / `[]` / `[]` | `[]` / `[]` / `[]` |

**The release blocker from round 1 is resolved, against both fixture pairs.** The real `acc_project` pair converges byte-for-byte identically to the vendored pair (same hash), which is exactly what departure 13's exporter-round-trip claim predicts.

### Table 5 — Mongo-down timing

| Route | Status | Seconds to respond |
|---|---|---|
| `GET /health` (probe-only, no `ensure_indexes`) | 200 | 3.19s |
| `GET /health/ready` (probe-only) | 503 | 3.09s |
| `GET /devices`, **first Mongo-backed request in a fresh process** | 503 | **36.94s (reproduced twice: 36.94s, 37.00s)** |
| `GET /parameter-sets`, `GET /test-runs`, same process, after the first | 503 | 3.06s, 3.08s |

---

## Round-1 findings, re-verified

- **Bug 1.1 (schema JSON escape) — FIXED.** `requirement-1.0.0.schema.json:39` now `\\.`; `schema_registry.validator()` compiles for all 11 published schemas; `pytest tests/test_schema_registry.py` (6 tests) confirms, including a dedicated "a broken schema is reported with its file name" test. `GET /health.schema_registry` reports `{count:11, compiled:true, errors:[]}` even under Mongo-down (Table 1, row 5a).
- **Bug 1.2 (manifest-last blocked by 1.1) — FIXED, and now directly exercised.** `POST /uploads/requirements` and `/signal-catalog` both 200 under `blob=local`; `manifest.json` is present and is the newest file in the version folder; `artifact_store.list_versions("requirements")` returns `["v0001"]`. New finding while verifying this: staged files are never cleaned up (Bug 2.2 below).
- **Bug 2.1 round 1 (N1 rejects the real ReqIF export) — FIXED by design change, not a code patch.** Documented as departure 13: N1 amended to accept `<p> <br/> <em> <strong> <code>`. Convergence now succeeds 37/37 against both the vendored and the real `acc_project` fixture pair (Table 4). `pytest tests/test_xhtml_subset.py` (16 cases) and `test_reqif_json_convergence.py` (5 cases) both green.
- **Bug 3.1 (opaque 500 after trace writes committed) — FIXED.** First upload with no broker: 503 `event_bus_unavailable`, body names `trace_key`, `created:true`, and `persisted:{blob_object, blob_meta, mongo_traces_row:true, publish_state:"failed", lake_rows:false}` — exactly the departure-15 contract. Re-upload with the bus still down stays `created:false, published:false`; re-upload once the bus is reachable republishes and flips to `200 {created:false, published:true, publish_state:"published", publish_attempts:2}`. `pytest tests/test_trace_publish.py` (4 cases) green.
- **Bug 4.1 (undocumented device-registration precondition) — FIXED as documentation, confirmed as departure 16.** The 422 now names both missing device_id and both calls required to clear it (`POST /devices`, then `POST /devices/{id}/versions`).

All five round-1 findings: **FIXED.**

---

## New bugs, round 2

### Bug 2.1: Mongo down → first request in a process takes ~37s, not the promised ~3s — `ensure_indexes` pays the full server-selection timeout once per collection, sequentially

**Test:** `GET /devices` (any Mongo-backed route reached via `Depends(deps.get_db)`) as the *first* such request in a fresh process, against a real unreachable Mongo host (`240.0.0.1:27017`, reserved/black-hole address, forcing the genuine `serverSelectionTimeoutMS` to fire rather than an instant connection-refused)
**Spec reference:** architecture doc §2.2 / departure 17: "so a datastore outage becomes a named 503 inside any sane client read timeout instead of a bare transport timeout 20 s after the client gave up"; this round's brief: "Mongo stopped → any Mongo-backed route returns `503 mongo_unavailable` within ~3 s, not a 30 s hang. That was the user-visible symptom."
**Expected:** 503 within ~3s (one `serverSelectionTimeoutMS` budget), matching `/health` and `/health/ready`'s measured 3.09–3.19s.
**Actual:** **36.94s and 37.00s** (reproduced twice, isolated fresh-process runs both times). `deps.get_db()` calls `mongo_schema.ensure_indexes(_db)` exactly once per process (guarded by `deps._indexes_done`), and `ensure_indexes` (mongo_schema.py:134-148) loops over **11 collections** — `devices, device_versions, parameter_sets, baselines, req_coverage, traces, run_trace_links, test_runs, run_metrics, results, req_verdicts` — calling `db[name].create_indexes(models)` for each, catching `PyMongoError` and logging a warning **per collection** rather than failing fast after the first. Each of the 11 calls independently pays the full ~3.0-3.4s server-selection timeout before the loop moves on, so the first request that happens to trigger index creation is blocked for roughly `11 × 3.3s ≈ 37s` — worse than the original, pre-fix 30s PyMongo default hang that departure 17 exists to eliminate.

Reproduction:
```
cd backend-api
python -c "
import os, time, sys
os.environ['TM_BLOB_BACKEND']='off'
os.environ['MONGO_HOST']='240.0.0.1:27017'
os.environ['MONGO_USER']='u'; os.environ['MONGO_PASSWORD']='p'; os.environ['MONGO_DB_NAME']='test_manager'
import main
from fastapi.testclient import TestClient
client = TestClient(main.api)
t0=time.monotonic(); r=client.get('/devices'); t1=time.monotonic()
print(r.status_code, t1-t0)
"
# -> 503 37.00
```
Log evidence: 11 separate `WARNING:mongo_schema:Could not create indexes on <collection>: ...(configured timeouts: socketTimeoutMS: 3000.0ms, connectTimeoutMS: 3000.0ms), Timeout: 3.0s...` lines precede the 503.

Second-order consequence, same root cause: `deps.get_db()` sets `_indexes_done = True` unconditionally after calling `ensure_indexes`, whether or not it succeeded (`deps.py`: `if not _indexes_done: mongo_schema.ensure_indexes(_db); _indexes_done = True`). If the first attempt fails because Mongo happened to be down at cold-start, indexes are **never retried** for the rest of that process's life even after Mongo recovers — a related but distinct gap from the timing issue.

**Root cause layer:** code
**Suspected root cause:** `mongo_schema.ensure_indexes` was written to "log and continue on a single failure" (its own docstring), which is correct for *durability* but not for *latency* — it does not short-circuit after the first `PyMongoError`, so an outage multiplies the pinned timeout by the collection count instead of paying it once.
**Suggested fix (ArchDev's call):** either (a) have `ensure_indexes` stop after the first `PyMongoError` (an outage affecting one collection affects all of them on the same client/server, so there is nothing to gain from retrying 10 more times), or (b) call `mongo_status()`'s cheap ping once before attempting any `create_indexes`, and skip the whole loop if the ping already failed, or (c) run index creation in a background thread at startup rather than inline on the first request's critical path. Any of the three restores the ~3s bound this departure exists to guarantee.

### Bug 2.2: Staged upload files are never deleted from `.staging/`, on every artifact-set commit — new

**Test:** `artifact_store.commit_version` via `POST /uploads/requirements` and `/signal-catalog`, `blob=local`
**Spec reference:** architecture doc §3.1 / artifact_store.py docstring: "everything is staged under `test-manager/.staging/<uuid>/` and then copied into place" — the doc describes the staging step but is silent on cleanup, and nowhere in the codebase (`grep -rn staging backend-api/*.py`) is a staged directory ever removed.
**Expected:** either the staged copy is deleted once the real copy is committed, or the architecture doc names a separate GC mechanism (a cron, a TTL, an explicit "reclaim" endpoint).
**Actual:** after two commits (`requirements v0001`, `signal_catalog v0001`), `test-manager/.staging/` contains two permanent, orphaned token directories (`requirements-v0001-d4eb3f23e84f47008668f8b64dae21fc`, `signal_catalog-v0001-c0a81702ae51472ca3ab0a919663fa85`), each a full duplicate of every file just committed. `artifact_store.commit_version` (lines 66-88) stages, copies payload, copies the manifest last — and returns, never calling `backend.delete`/`shutil.rmtree`/any equivalent on the staged token directory.
**Reproduction:**
```
cd backend-api
# after any successful POST /uploads/requirements or /uploads/signal-catalog with TM_BLOB_BACKEND=local,
# TM_BLOB_LOCAL_ROOT/test-manager/.staging/ still contains the token directory used for that upload.
```
**Root cause layer:** code
**Suspected root cause:** `artifact_store.commit_version` (backend-api/artifact_store.py:66-88) has no cleanup step after the manifest copy.
**Suggested fix:** delete the staged token directory (`paths.staging_dir(token)`) after the manifest copy succeeds. Every artifact upload permanently doubles the bytes it writes under `.staging/` with no expiry — on the real Quix/S3-backed blob this is an unbounded, silent storage leak, not just clutter on a local disk. ArchDev/Buddy decide whether cleanup happens inline (simplest) or via a separate sweep (if leaving the staged copy briefly is wanted as an audit trail).

### Bug 2.3: `ruff check` with no config (the stated gate: "no `.pre-commit-config.yaml`; ruff defaults") finds 148 violations across the six app directories — round 1's "0 findings, PASS" used a narrower selection than the repo's actual unscoped default

**Test:** lint gate, `python -m ruff check --isolated <dir>` (no `--select`) for each of the six app directories; `ruff` 0.16.3 (the version installed in the round-1 venv; no pin exists anywhere in the repo — confirmed via `grep -rn ruff` across `*.txt/*.toml/*.cfg/*.md`, no hit outside a vendored `pandas` package and round-1's own report)
**Spec reference:** this round's brief: "No `.pre-commit-config.yaml`; ruff defaults (E4/E7/E9/F)." Round 1's report: "`ruff check --isolated --select E4,E7,E9,F <dir>` × 6 | 0 × 6, 'All checks passed!' | PASS."
**Expected:** either round 1's `--select E4,E7,E9,F` genuinely *is* this ruff version's unscoped default (in which case a plain `ruff check <dir>` with no `--select` should also report 0 findings), or, if it is not, the true default gate should be run and any findings reported.
**Actual:** it is not. Empirically verified on a 2-line throwaway file (`import os` alone): `ruff check --isolated --select E4,E7,E9,F` → "All checks passed!"; `ruff check --isolated` (no select) → `F401` (expected, in both) **plus, on a second throwaway file with an out-of-order import, `I001` (import sorting)** — a rule outside `E4/E7/E9/F` that the plain, unscoped invocation still flags. Running the true unscoped gate over all six app directories:

| App dir | Findings (unscoped `ruff check`) | Dominant codes |
|---|---|---|
| backend-api | 101 | `B008`×57 (FastAPI `Depends()` in every default arg), `I001`×19, `RUF100`×11, `ISC004`×6, `UP033`×4, others×4 |
| dynamic-config-manager | 8 | `RUF100`×7, `I001`×1 |
| mf4-extractor | 12 | `RUF100`×10, `I001`×1, `RUF046`×1 |
| test-vectors-sink | 6 | `RUF100`×5, `I001`×1 |
| tm-evaluator | 14 | `RUF100`×9, `I001`×4, `RUF046`×1 |
| mongo-writer | 7 | `RUF100`×6, `I001`×1 |
| **Total** | **148** | |

Three distinct shapes worth calling out individually:
1. **`B008` (57 hits, all in `backend-api`)** is exclusively the FastAPI `Depends(...)`/`Query(...)` idiom in route signatures (`db=Depends(deps.get_db)` etc.) — every hit is idiomatic, correct FastAPI code that ruff's unscoped default flags as "function call in argument default" because ruff has no framework awareness and nothing in this repo tells it to exempt `fastapi.Depends`.
2. **`RUF100` ("unused noqa", 48 hits across all six dirs)** — e.g. `main.py:5` carries `# noqa: E402`, but `E402` is **not** in this ruff version's actual unscoped default set, so the suppression comment itself is now a violation. Same pattern for `# noqa: BLE001` in `blob_storage.py:200`. These `noqa`s were written for a rule set that does not match what an unconfigured `ruff check` on this toolchain actually enables.
3. **`I001` (import sorting, 27 hits), `ISC004`, `UP033`, `RUF046`, `PLR1711`, `RET501`, `SIM115`** are straightforward style findings this round's toolchain's default catalogue includes but round 1's narrower `--select` did not exercise.

**Root cause layer:** unclear — this is a gap between "no ruff config exists in the repo to pin either the rule selection or a FastAPI exemption" and "the code was written assuming a rule set (`E4/E7/E9/F` plus some `noqa`-worthy others) that does not match what this ruff version's bare default actually is." None of the 148 findings reflect a functional defect; most (`B008`, the `noqa` mismatches) are an artifact of there being no `pyproject.toml`/`ruff.toml` in this repo to encode either the true intended rule set or the FastAPI `Depends()` exemption every FastAPI codebase needs. The substantive style ones (`I001`, `ISC004`, `UP033`, `RUF046`, `PLR1711`, `RET501`, `SIM115`) are real and independent of that gap.
**Suggested fix:** Buddy/ArchDev decide whether to (a) add a `pyproject.toml`/`ruff.toml` pinning the intended rule set plus `extend-immutable-calls = ["fastapi.Depends", "fastapi.Query"]` (the standard fix for `B008` in FastAPI projects, eliminating 57 of 148 findings at a stroke) and a pinned ruff version, or (b) accept the unscoped default as the gate and have ArchDev clear the remaining ~91 findings. Full per-directory output: `.tmp/round2/ruff_<dir>.txt` (throwaway, not committed).
**Note, not filed as a bug:** `pytest --collect-only -q` on `backend-api/tests` collects all 53 tests cleanly with no import/fixture errors, independent of the ruff finding above.

### Bug 2.4 (low severity, forward-compat): `ElementTree` truth-value comparison in `reqif_parser.py` will break on a future Python

**Test:** `pytest backend-api/tests/test_reqif_json_convergence.py` — 222 `DeprecationWarning`s, one per element evaluated
**Spec reference:** none directly; flagged because it is a real, reproducible warning surfaced while re-verifying the departure-13 fix
**Expected:** no deprecation warnings from a clean test run.
**Actual:**
```
backend-api\reqif_parser.py:334: DeprecationWarning: Testing an element's truth value will always return True in future versions.  Use specific 'len(elem)' or 'elem is not None' test instead.
    "spec_type": _ref_text(_first(spec_object, "TYPE") or spec_object,
```
`_first(spec_object, "TYPE") or spec_object` relies on an `xml.etree.ElementTree.Element`'s bool being `False` when it has no children — a behaviour Python has deprecated and will remove. It currently works; it will silently start always taking the truthy branch (`_first(...)`, even when `None`... actually `_first` returning `None` is falsy regardless, so this specific line is likely safe either way, but the pattern is present here and is worth ArchDev's attention before it recurs elsewhere).
**Root cause layer:** code
**Suggested fix:** `_first(spec_object, "TYPE") if _first(spec_object, "TYPE") is not None else spec_object`, or cache the lookup in a local variable and test `is not None`. Not a functional bug today; filed so it doesn't get rediscovered as a mystery test failure on a future Python.

---

## Checks that passed cleanly (for the record)

- Import graph, all six apps, zero env vars (Table 1) — no regression.
- `pytest backend-api/tests`: **53/53 passed**, 1.97s (`test_canonical_normalisation.py` ×7, `test_db.py` ×2, `test_error_envelope.py` ×9, `test_reqif_json_convergence.py` ×5, `test_schema_registry.py` ×6, `test_trace_publish.py` ×4, `test_xhtml_subset.py` ×20).
- `GET /health` and `/health/ready` under a genuinely unreachable Mongo: both respond inside the stated bound (3.19s / 3.09s, vs. the brief's 4s ceiling) — **when they don't also trigger `ensure_indexes`** (see Bug 2.1 for the one path that does).
- `POST /uploads/requirements` and `/signal-catalog`, `blob=local`: both **200** (round 1: 500). Manifest-last mechanism confirmed working.
- Convergence check: **both** fixture pairs converge, `converged:true`, 37/37, all three assertions true, identical hashes between the vendored and real pairs.
- Trace upload: no-broker 503 names `trace_key`/`created`/`persisted` correctly; re-upload reconciliation flips `publish_state` from `failed` to `published` once the bus is reachable; `GET /traces?publish_state=failed|published` filter works.
- Door-validation 422 re-baselined shape confirmed: `{error:"upload_rejected", message, problems[], stage, problem_count}`.
- 15/15 blob=off checks: flat envelope, no `detail` nesting, in every category (503/404/422).
- Regression set: `/openapi.json` 62 paths; trace 422 `not_mdf4`/`unsupported_raw_can`; idempotent re-upload; `units.transform`/`units.equal`; `alignment.uncertainty_s` = 0.005; `metrics.compute` sum-check with unresulted cases.

## Harness artifacts (throwaway, not committed)

- `.tmp/round2/harness_health.py`, `harness_uploads.py`, `harness_convergence.py`, `harness_trace.py`, `harness_trace_republish.py`, `harness_blob_off.py`, `harness_door_validation.py`, `harness_regressions.py`, `harness_mongo_route.py`, `harness_mongo_indexes_isolated.py`, `harness_publish_state_filter.py` — Tester scaffolding, `backend-api/` untouched.
- `.tmp/round2/ruff_<dir>.txt` — full unscoped `ruff check` output per app directory (Bug 2.3 evidence).
- `.tmp/round2/blob_local/`, `blob_trace/`, `blob_door/`, `blob_regress/`, `blob_pf2/` — local blob backend roots used per harness; each shows the `.staging/` leak from Bug 2.2.
- `mongomock` reused from round 1's `.tmp/venv`; a real unreachable-IP `MongoClient` (`240.0.0.1:27017`) was used specifically for the timing checks in Table 5, which mongomock cannot exercise.
