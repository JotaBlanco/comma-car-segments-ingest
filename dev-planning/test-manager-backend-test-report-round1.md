# Test Manager backend — verification report, round 1

**Branch:** `V-roundtrip` (uncommitted working tree; nothing staged/committed/reverted by this pass)
**Spec:** `C:\repos\acc_project\dev-planning\test-manager-v\spec.md`, `schemas.md`
**Architecture doc:** `docs`-equivalent at `dev-planning\test-manager-backend-architecture.md` (read in full, including §8 departures, before filing anything below)
**Scope tested:** `backend-api/`, `dynamic-config-manager/`, `mf4-extractor/`, `test-vectors-sink/`, `tm-evaluator/`, `mongo-writer/`
**Not tested (explicitly out of scope per brief):** `frontend/`, unit-test-runner (deferred), `mongodb/`/`quix.yaml`/`init.sh` working-tree diffs (untouched)
**Mongo:** the live deployment is crashlooped and no local `mongod`/docker daemon was available in this sandbox. Every check that needs Mongo runs against `mongomock.MongoClient()`, monkeypatched over `db.get_client`/`db.get_db` in a throwaway harness under `.tmp/` — `backend-api/db.py` itself was never touched. This is noted per-check below.
**Kafka:** no broker or Quix SDK token is configured in this sandbox. This blocked observing the true "first trace upload → 200 created:true" response (see Bug 3); it did not block any of the other checks.

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

All six apps' dependencies installed cleanly from their own `requirements.txt` (including the private `quixportal` feed and `asammdf==8.8.23`) and every module graph is lazy as designed.

### Table 2 — steps

| Step | Command | Exit / result | PASS/FAIL |
|---|---|---|---|
| 1. Import graph | `python -c "import main"` × 6 | 0 × 6 | PASS |
| 2. Schema compilation | `python -c "import schema_registry as s; [s.validator(n) for n in s.schema_names()]"` | `JSONDecodeError` | **FAIL — Bug 1** |
| 3. Lint | `ruff check --isolated --select E4,E7,E9,F <dir>` × 6 | 0 × 6, "All checks passed!" | PASS |
| 4a. `GET /health` (blob=local) | — | 200, `blob_storage.backend=="local"` | PASS |
| 4b. `POST /uploads/requirements` (1 item) | — | 500 Internal Server Error | **FAIL — Bug 1** |
| 4c. manifest-last check | via `signal-catalog` upload (unaffected schema) | 500 Internal Server Error | **BLOCKED — Bug 1** (see below; not a skip) |
| 4d. `GET /openapi.json` | — | 200, 61 paths | PASS |
| 5. Convergence check | real `.reqif` fixture + JSON | 422 `reqif_mapping`, 74 problems | **FAIL — Bug 2, release blocker** |
| 6a. Trace upload, non-MDF4 | — | 422 `not_mdf4` | PASS |
| 6b. Trace upload, raw CAN | — | 422 `unsupported_raw_can` | PASS |
| 6c. Trace upload, idempotent re-upload | after device/device-version registration | 1st call 500 (no Kafka broker — Bug 3), 2nd call 200 `created:false` | PASS with caveat |
| 7a. `units.transform`/`units.equal` | — | both assertions true | PASS |
| 7b. `time_between_edges` midpoint @100 Hz | numeric repro | `elapsed_s=0.05`, `uncertainty_s=0.005` | PASS |
| 7c. `metrics.compute` sum-check, unresulted cases | — | `sum_check_ok: true`, `1+1+3+0+0==5==len(planned)` | PASS |
| 8. Blob unavailable (`TM_BLOB_BACKEND=off`) | 15 endpoint checks | 15/15 PASS | PASS |

### Table 3 — endpoint behaviour, blob=local vs blob=off

| Endpoint | blob=local | blob=off | Expected | Actual |
|---|---|---|---|---|
| `GET /health` | 200, `available:true, backend:"local", reason:null` | 200, `available:false, backend:"unavailable", reason:"blob storage disabled by TM_BLOB_BACKEND=off"` | both 200, self-describing | match |
| `GET /devices` | n/a | 200 | 200 | match |
| `POST /devices` | n/a | 201 | 200s | match |
| `GET /parameter-sets` | n/a | 200 | 200 | match |
| `GET /test-runs` | n/a | 200 | 200 | match |
| `POST /uploads/requirements` | **500** (Bug 1) | 503 `blob_storage_unavailable` | 200 (local) / 503 (off) | mismatch (local) / match (off) |
| `POST /uploads/test-specs` | not run (blocked by Bug 1's blast radius) | 503 `blob_storage_unavailable` | — / 503 | — / match |
| `POST /uploads/signal-catalog` | **500** (Bug 1) | 503 `blob_storage_unavailable` | 200 (local) / 503 (off) | mismatch (local) / match (off) |
| `POST /uploads/traces` | 422 (validation) → 200 `created:false` on 2nd call | 503 `blob_storage_unavailable` | — / 503 | match / match |
| `POST /baselines` | not run | 503 `blob_storage_unavailable` | — / 503 | — / match |
| `GET /requirements` | not run | 503 `blob_storage_unavailable` | — / 503 | — / match |
| `GET /test-cases` | not run | 503 `blob_storage_unavailable` | — / 503 | — / match |
| `POST /test-runs` | not run | 503 `blob_storage_unavailable` | — / 503 | — / match |
| `POST /test-runs/{id}/report` | not run | 503 `blob_storage_unavailable` | — / 503 | — / match |
| `GET /graph/...` | not run | 503 `blob_storage_unavailable` | — / 503 | — / match |

Every `blob=off` 503 body was checked for exact shape: `{"error": "blob_storage_unavailable", "message": <non-null>}` (nested under FastAPI's `"detail"` key for the `HTTPException(detail={...})` routes, and top-level for the registered `BlobUnavailableError` handler). All 10 upload/baseline/requirements/test-cases/test-runs/report/graph checks carried the correct shape. No 500 and no silent 200 was observed anywhere in blob=off mode.

### Table 4 — convergence-check

| | Value |
|---|---|
| HTTP status | **422**, not 200 |
| `converged` | not computed — request rejected before comparison logic runs |
| assertion 1 (`per_item_hashes_equal`) | not computed |
| assertion 2 (`set_hash_equal`) | not computed |
| assertion 3 (`stored_bytes_equal`) | not computed |
| Failure point | `reqif_parser.parse_reqif()`, stage `reqif_mapping`, 74 `xhtml_shape` problems (one `text` + one `rationale` per requirement, for all 37 items) |

This is **worse** than the "converged: false is a release blocker" case the spec anticipates: the endpoint cannot even complete a comparison against the one real acceptance fixture named in spec §1.1.2. See Bug 2.

---

## Bugs

### Bug 1.1: Invalid JSON escape in `requirement-1.0.0.schema.json` breaks door validation for every artifact set, not just requirements

**Test:** `schema_registry.validator(name)` for any `name`, exercised via `pytest`-style harness and directly via `POST /uploads/requirements`, `POST /uploads/signal-catalog`
**Spec reference:** spec §3.3 ("JSON Schema is the source of truth for artifact documents"); schemas.md §1 (`revision` pattern `"^[0-9]+\\.[0-9]+$"`)
**Expected:** `requirement-1.0.0.schema.json` parses as valid JSON; `schema_registry.validator("requirement-1.0.0")` returns a compiled `Draft202012Validator`.
**Actual:**
```
json.decoder.JSONDecodeError: Invalid \escape: line 39 column 56 (char 2011)
```
Reproduction:
```
cd backend-api
python -c "import schema_registry as s; [s.validator(n) for n in s.schema_names()]"
```
**File:line:** `backend-api/schemas/requirement-1.0.0.schema.json:39`:
```json
    "revision": { "type": "string", "pattern": "^[0-9]+\.[0-9]+$" },
```
`\.` is not a legal JSON string escape (valid escapes are `\" \\ \/ \b \f \n \r \t \uXXXX`); this file fails `json.loads` outright. The companion line in `backend-api/schemas/test-case-1.0.0.schema.json:80` is correctly double-escaped (`"^[0-9]+\\.[0-9]+$"`) and parses fine — confirming this is a one-line typo, not a systemic escaping choice.

**Blast radius, and why this is a blocker, not a cosmetic issue:** `schema_registry._registry()` (line 76-83) eagerly `json.loads`-parses **every** published schema file to build the cross-file `$ref` registry, and every call to `schema_registry.validator(name)` — for *any* `name` — calls `_registry()`. Confirmed directly:
```
cd backend-api
python -c "import upload_service, json
item={'schema_version':'1.0.0','signal':'VehAccel_mps2','channel_group':'PT_CAN_100Hz','table':'acc_pt_can_100hz','unit':'m/s^2','dtype':'float32','raster_hz':100,'role':'response','source_spec':'x'}
upload_service.ingest_signal_catalog('c.json', json.dumps([item]).encode(), 'x','x')"
# -> same JSONDecodeError, same traceback, through validation.run_door_validation -> schema_registry.iter_errors -> validator -> _registry
```
So this single typo breaks door validation for **all four artifact sets** (requirements, test-specs, test-impl, signal-catalog), not only requirements. `POST /uploads/requirements` and `POST /uploads/signal-catalog` both return an unhandled `500 Internal Server Error` (no exception handler registered for `JSONDecodeError` in `error_handlers.py`, so FastAPI's default handler fires). `/health` is unaffected only because `schema_sha256()` hashes raw bytes without parsing.
**Root cause layer:** code
**Suspected root cause:** single missing backslash, `backend-api/schemas/requirement-1.0.0.schema.json:39`.
**Suggested fix:** `"pattern": "^[0-9]+\\.[0-9]+$"` (matches schemas.md's own listing and the sibling file). Given the blast radius, ArchDev may also want `schema_registry._registry()`/`_files()` to fail loudly and individually per file (naming the broken file) rather than propagating a bare `JSONDecodeError with no filename`, so a future typo in one schema doesn't take down validation for sets that never reference it.

### Bug 1.2 (consequence of 1.1): manifest-last staged-commit protocol could not be verified this round

**Test:** intended `POST /uploads/requirements` with a 1-item payload, checking `manifest.json` is the newest file in the version folder and `list_versions()` sees it (spec §3.1)
**Spec reference:** spec §3.1 ("a version folder is written once, atomically... the manifest's presence is the commit marker")
**Expected:** a mintable, verifiable version.
**Actual:** blocked by Bug 1 for every one of the four artifact sets — no upload path reaches `artifact_store.commit_version` this round.
**Reproduction:** as Bug 1.1.
**Root cause layer:** code (same as Bug 1.1)
This is filed as a **blocker**, per instructions, rather than silently skipped: I could not exercise `artifact_store`'s staged-write/manifest-last mechanism through any upload endpoint in this round.

### Bug 2.1: Convergence check rejects the real acceptance fixture outright — N1's XHTML rule does not match the actual ReqIF export shape

**Test:** `browser`/HTTP-level: `POST /uploads/requirements/convergence-check` with `reqif_file=C:\repos\acc_project\Reqs\export\acc-system-requirements.reqif`; also reproduced directly via `reqif_parser.parse_reqif(data)`
**Spec reference:** spec §1.1.2 ("Verification of convergence... upload `Reqs/export/acc-system-requirements.reqif`... assert (a)... A convergence failure is a release blocker, not a warning."); spec §1.1.1 N1 ("the only permitted nested element is `<xhtml:br/>`; any other element ⇒ reject the upload")
**Expected:** `converged: true`, all three assertions true (or, at worst, a computed `converged: false` naming the mismatching fields).
**Actual:** `422 Unprocessable Entity`, stage `reqif_mapping`, **74** `xhtml_shape` problems — one for `text` and one for `rationale` on every one of the 37 requirements. The comparison logic in `convergence.py` never runs; there is no `converged` value to inspect.
**Reproduction:**
```
cd backend-api
python -c "
import reqif_parser
with open(r'C:\repos\acc_project\Reqs\export\acc-system-requirements.reqif','rb') as f:
    data = f.read()
reqif_parser.parse_reqif(data)"
# -> validation.UploadRejected: 74 validation problem(s) at stage 'reqif_mapping'
```
First two problems verbatim:
```
{'code': 'xhtml_shape', 'message': 'text: the only permitted nested XHTML element is <xhtml:br/>, found <p>', 'entity_id': '_e476a4f9-8494-5d33-81fb-4f3f6dd36c33', 'pointer': '/text'}
{'code': 'xhtml_shape', 'message': 'rationale: the only permitted nested XHTML element is <xhtml:br/>, found <p>', 'entity_id': '_e476a4f9-8494-5d33-81fb-4f3f6dd36c33', 'pointer': '/rationale'}
```
Raw XML at the flagged location (`Reqs/export/acc-system-requirements.reqif`):
```xml
<ATTRIBUTE-VALUE-XHTML>
  <THE-VALUE>
    <xhtml:div>
      <xhtml:p>The ACC system shall provide the operating states Off, Standby, Active-Cruise, Active-Follow, ...
```
Every `text`/`rationale` value in the real export wraps its paragraph content in a single `<xhtml:p>`, and `reqif_parser._xhtml_to_text` (`backend-api/reqif_parser.py:82-121`) implements spec N1 literally: it requires exactly one `<xhtml:div>` whose only children are `<xhtml:br/>` elements, and raises `xhtml_shape` on any other element — including the universally-present wrapping `<p>`. The code is a faithful, literal implementation of N1 as written; the fixture that spec §1.1.2 names as the acceptance test simply cannot pass it.
**Root cause layer:** spec — N1 as written in `spec.md` §1.1.1 is incompatible with the one real ReqIF export it is supposed to validate against. This is not one of the 12 documented departures in `dev-planning/test-manager-backend-architecture.md` §8, so ArchDev did not flag it as a deliberate choice.
**Suggested fix (Tester's opinion, ArchDev/Buddy decide):** N1 likely needs to read "a single wrapping `<xhtml:p>`, if present as the sole child of the div, is unwrapped before applying the `<xhtml:br/>`-only rule" — i.e., tolerate the one paragraph-wrapper shape real ReqIF authoring tools always emit, while still rejecting anything richer (lists, tables, nested divs). Whether that's a spec text fix or a `reqif_parser.py` fix is Buddy/ArchDev's call; flagging as spec per this role's instructions since the code matches the literal spec text.

### Bug 3.1: Trace upload — a bus-publish failure after blob+Mongo writes have already committed surfaces as an opaque 500, with no `created`/`trace_key` in the response

**Test:** `trace_service.ingest_trace()` called directly and via `POST /uploads/traces`, first call for a fresh trace (device/device-version pre-registered)
**Spec reference:** spec §4.2 step 6 ("Produce **one metadata message** to `trace-ingest-requests`... the file bytes never enter Kafka"); contrast with spec §8.2/architecture §2.2's "honest degradation" pattern for blob (`deps.require_blob()` -> named 503) and lakehouse
**Expected:** either (a) 200 with `created: true` and a `trace_key`, or (b) if a downstream dependency (the broker) is unavailable, an error naming that cause — never a bare 500 that hides a side effect that already happened.
**Actual:** first upload call: `500 Internal Server Error` (opaque, no body). Investigated with a full traceback (bypassing the TestClient's swallowed 500):
```
Traceback (most recent call last):
  File "trace_service.py", line 197, in ingest_trace
    bus.publish(...)
  File "topics.py", line 52, in publish
    topic = self._topic(name)
  File "topics.py", line 43, in _topic
    self._topics[name] = self._application().topic(...)
  File "topics.py", line 38, in _application
    self._app = Application(consumer_group=self._consumer_group)
  File ".../quixstreams/app.py", line 324, in __init__
    raise ValueError(
ValueError: Either "broker_address" or "quix_sdk_token" must be provided
```
By this point `artifact_store.write_trace_object`, `artifact_store.write_trace_meta` and the `db[TRACES].insert_one(...)` in `trace_service.py` had **already run and committed** (confirmed: a second, byte-identical upload afterwards returned `200 {"trace_key": "...", "created": false, ...}`, proving the first call's side effects were durable despite the 500). The client that received the 500 has no `trace_key`, no `created` flag, and no indication that anything was written — it can only discover the trace exists by re-uploading and getting `created: false`.
**Note on environment:** this sandbox has no Kafka broker / `Quix__Sdk__Token` configured, which is why `bus.publish` fails here specifically with the `ValueError` above. That absence is expected for an offline verification pass and is not itself being filed as a bug. What *is* being filed is the gap it exposed: `topics.EventBus`/`trace_service.ingest_trace` have no honest-degradation seam analogous to `blob_storage.require_blob()` — any bus failure (broker outage, misconfiguration, quota) after the writes have committed will reproduce this same opaque-500-after-real-side-effect shape in production, not just in this sandbox.
**Root cause layer:** architecture
**Suggested fix:** either move the `bus.publish` call earlier and treat its failure as fatal-before-any-write (changes the spec §4.2 step order), or wrap it the same way `deps.require_blob()`/`BlobUnavailableError` wrap blob, returning e.g. `503 {"error": "event_bus_unavailable", "message": ..., "trace_key": ...}` so a client that hit this can still discover/retry-idempotently using the `trace_key` it would have minted. ArchDev/Buddy decide.

### Bug 4.1: `POST /uploads/traces` requires the `(device_id, sw_version, hw_version)` to already be registered in `device_versions`, undocumented in spec §4.2 and not listed as a departure

**Test:** `POST /uploads/traces` against an unregistered device/version, before and after registering via `POST /devices` + `POST /devices/{id}/versions`
**Spec reference:** spec §4.2 (the seven-step upload protocol has no "check device is registered" step); architecture doc §8 (12 departures, none mention this)
**Expected:** either spec §4.2 documents this precondition, or the architecture doc lists it as departure #13, or the upload doesn't require it.
**Actual:** first attempt (unregistered device) returns `422 unknown_device_version`: `"device version plant-sim-01/1.0/1.0 is not registered; register it before uploading traces for it"` (`backend-api/trace_service.py:144-157`). Once registered, upload succeeds as expected.
**Root cause layer:** spec (undocumented departure — the check itself is defensible given `device_versions` is the registry of record, but it is neither in spec §4.2 nor in the architecture doc's §8 departure list, so a reader following either document would not expect it).
**Suggested fix:** add as architecture §8 departure #13, or note in spec §4.2 that trace upload has a registry precondition. No code change implied.

---

## Checks that passed cleanly (for the record)

- Import graph, all six apps, zero env vars (Table 1).
- Lint: `ruff check --isolated --select E4,E7,E9,F` clean across all six app directories — zero findings.
- `GET /health` (blob=local): 200, `blob_storage.backend == "local"`.
- `GET /openapi.json`: 200, 61 paths (router/model wiring is sound).
- `POST /uploads/traces` 422 `not_mdf4` and 422 `unsupported_raw_can` — both exact-match spec §0.6 reason codes.
- `POST /uploads/traces` idempotent re-upload: second call for byte-identical content returns `200 {"created": false, "trace_key": "TRC-plant-sim-01-8317fce18d5e", ...}` — content-addressed idempotency confirmed.
- `units.transform("m/s^2", "derivative") == units.parse("m/s^3")` → `{'m': 1, 's': -3} == {'m': 1, 's': -3}` → True.
- `units.equal("m/s^2", "m*s^-2")` → True.
- `time_between_edges` midpoint convention, numeric repro at 100 Hz (from `-0.3` threshold crossing between samples 9/10, to a rising edge between samples 14/15): `from_s=0.095, to_s=0.145, elapsed_s=0.05`; `alignment.uncertainty_s(["PT_CAN_100Hz"]) == 0.005`. Matches schemas.md §4's worked brake-lamp example exactly.
- `metrics.compute` with 5 planned cases, results for only 2: `tc_passed=1, tc_failed=1, tc_not_run=3, tc_error=0, tc_inconclusive=0`, `sum_check_ok: true`, `1+1+3+0+0 == 5 == len(planned_tc_ids)`. The no-result-yet cases correctly resolve to `not_run` inside `metrics.compute` itself (not only in `run_service.finalize_evaluation`).
- Blob unavailable (`TM_BLOB_BACKEND=off`): `GET /health` → `available:false`, `reason` non-null; `GET /devices`, `POST /devices`, `GET /parameter-sets`, `GET /test-runs` all still 200/201; and all 10 checked blob-dependent routes (`POST /uploads/requirements`, `/test-specs`, `/signal-catalog`, `/traces`, `POST /baselines`, `GET /requirements`, `GET /test-cases`, `POST /test-runs`, `POST /test-runs/{id}/report`, `GET /graph/requirement/{id}`) return exactly `503 {"error": "blob_storage_unavailable", "message": <non-null>}` — never 500, never 200.

## Harness artifacts (throwaway, not committed)

- `.tmp/harness_local.py`, `.tmp/harness_off.py` — Tester scaffolding, `backend-api/` untouched.
- `.tmp/harness_local_results.json`, `.tmp/harness_off_results.json` — raw captured results.
- `mongomock` was installed into `.tmp/venv` and used only to monkeypatch `db.get_client`/`db.get_db` at runtime inside the harness scripts; `backend-api/db.py` was never edited.
