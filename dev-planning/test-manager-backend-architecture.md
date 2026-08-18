# V-Model Test Manager - backend and ingest architecture

**Phase 3, backend only.** Implements `dev-planning/test-manager-v/spec.md` and
`schemas.md` from the `acc_project` repo. No frontend (separate dispatch), no
unit-test runner (deferred by explicit decision).

Read this before changing anything under `backend-api/`, `mf4-extractor/`,
`test-vectors-sink/`, `tm-evaluator/` or `mongo-writer/`.

---

## 1. What the code does

A test-management system for the right leg of the V at system level. Requirements
(ReqIF or JSON), test specifications, test implementations and a signal catalogue
are uploaded, validated at the door against published JSON Schemas, and stored as
**immutable versioned folders** in blob. A **baseline** pins one version of each of
the four sets; a **test run** references one baseline and freezes the list of test
cases it plans to execute. MF4 traces are uploaded, stored as raw objects, and
turned into Lakehouse test-vector tables by a decoupled ingest path that **never
evaluates on arrival**. Evaluation is triggered separately, finds its input by
`trace_key`, applies a machine-evaluable `pass_criteria` vocabulary, and yields
five-valued verdicts. The API then computes coverage and outcome metrics, the
per-requirement verdict, and renders a self-contained HTML/JSON report that is
reproducible from stored data alone.

## 2. Why this shape

### 2.1 Where the boundaries are, and why they are not where the spec drew them

The spec's deployment matrix (§8.2) names six stream services: `mf4-extractor`,
`test-vectors-sink`, `evaluator`, `run-readiness`, `report-generator`,
`mongo-writer`. This implementation ships four, and the reason is a hard property
of the platform rather than a preference:

> **Quix builds every application from its own folder.** The Docker build context
> is the application directory, so a module cannot be imported across deployment
> boundaries. The only ways to share code are a published package or a duplicated
> copy.

The shared surface here is not small: the JSON Schemas and their hashes, the
canonicalisation rules (JCS + N1-N6), the blob path layout, the artifact store's
staged-commit protocol, the baseline resolver, the §6 metric formulas and the §6.3
verdict precedence. Duplicating those into five services means five copies that can
drift, and **a metric block that disagrees with another copy of itself is worse
than a missing one**. So:

| Concern | Where it lives | Why |
|---|---|---|
| Artifacts, registry, metrics, requirement verdicts, report rendering, blob | `backend-api` | One authority, one blob seam, one copy of every formula |
| Criteria engine + lake queries + readiness trigger | `tm-evaluator` | The only thing the API does not own; needs numpy and the Query API, not blob |
| MF4 -> rows | `mf4-extractor` | Needs `asammdf` (a heavy dependency) and blob; expands 1 message into ~6 400 |
| Rows -> Iceberg | `test-vectors-sink` | Needs `QuixTSDataLakeSink` + blob + catalog; nothing else |
| Stream output -> Mongo | `mongo-writer` | Needs `MongoDBSink`; nothing else |

`report-generator` is folded into `backend-api` (it needs the blob seam and the
baseline resolver, both of which exist exactly once there) and `run-readiness` is a
second dataframe inside `tm-evaluator` (it needs the same `backend_client` and is
not CPU-bound). `tm-evaluator` reaches the API over HTTP on the in-cluster address
`http://backend-api` - the Backend API deployment already declares
`network.serviceName: backend-api` on port 80.

The one place a copy was unavoidable is the blob seam: `mf4-extractor` must read
the raw object itself, so `mf4-extractor/blob_seam.py` is a deliberate second copy
of `backend-api/blob_storage.py`, following the convention already in this repo
(`backend-api/blob_storage.py` and `mongo-backup-manager/blob_storage.py` were
already near-identical). It is 150 lines of adapter with no business rules in it.

### 2.2 The blob seam and honest degradation

The testrig Storage Gateway is unreachable. Any deployment carrying
`blobStorage: {bind: true}` is refused at start, so the Backend API runs unbound
and `Quix__BlobStorage__Connection__Json` is absent.

`backend-api/blob_storage.py` is therefore one interface with **three**
implementations behind a single selector:

```
TM_BLOB_BACKEND = auto | quix | local | off
TM_BLOB_LOCAL_ROOT = <directory>            # used by the local backend
```

* `QuixBlobBackend` - `quixportal.get_filesystem()`, the real thing.
* `LocalBlobBackend` - a directory tree with **identical bucket-relative path
  semantics**. Not a stub: version minting, the staged-commit protocol, the
  manifest-as-commit-marker rule and every read path are exercised through it
  unchanged.
* `NullBlobBackend` - every call raises `BlobUnavailableError` carrying the
  *reason* (which variable is unset, and why the bind is disabled).

`auto` prefers Quix when credentials are injected, falls back to local when
`TM_BLOB_LOCAL_ROOT` is set, and otherwise resolves to Null. **Nothing raises at
import.** Endpoints that need blob call `deps.require_blob()` and return `503` with
`{"error": "blob_storage_unavailable", "message": <cause>, "hint": ...}`;
`error_handlers.py` maps any escaped `BlobUnavailableError` to the same shape.
`GET /health` always answers and reports which backend resolved and why.

Everything that does not need blob works with blob absent: `/health`,
`/health/mongo`, the whole device / device-version / parameter-set registry, run
listing, `GET /results`, and `GET /metrics/{run}/{version}` when `run_metrics` is
already in Mongo.

**What genuinely cannot work without blob**, stated plainly: two Quix deployments
do not share a filesystem, so the local backend cannot carry an object from the API
to `mf4-extractor` in the cloud. The ingest half of the pipeline is blocked on the
gateway. `mf4-extractor` does not pretend otherwise - it marks the trace `failed`
with the blob reason and emits a completion event, so the readiness panel shows a
reason instead of waiting forever.

### 2.3 Lakehouse variables without the bind

On the dev cluster the four `Quix__Lakehouse__*` variables inject **only** when the
deployment carries the blob bind. Since the bind is impossible, `backend-api` and
`tm-evaluator` declare `Quix__Lakehouse__Query__Url` / `__AuthToken` explicitly in
`quix.yaml` - the pattern a BYOX environment has to use anyway. `lakehouse.py` and
`tm-evaluator/lake_client.py` both report which variable is missing rather than
failing at the first query with a null URL.

### 2.4 Validation: two validators, two jobs

JSON Schema (draft 2020-12) is the source of truth for **artifact** documents;
Pydantic v2 with `ConfigDict(extra="forbid")` covers **API-only** bodies. There is
no duplicated artifact model, therefore no drift. The eight published schemas live
in `backend-api/schemas/` and are hashed over their raw bytes, so an artifact-set
manifest records the exact `schema_sha256` it was validated against and
re-validating an old version stays reproducible.

The replaced code is the reason this section exists: `crud.py` took `item: dict` and
inserted it verbatim into implicit collections - `POST /requirements` with `{}`
succeeded, no Pydantic model existed anywhere in the repo, and no index existed.

### 2.5 Human ids, never in `_id`

`crud.py:31` coerced every by-id path parameter through `ObjectId()`, which breaks
the moment an id looks like `ACC-SYS-PRF-020`. `_id` is left to `ObjectId`
everywhere; every by-id route queries the human-id field, and `mongo_schema.serialize`
strips `_id` from responses so a client is never even tempted.

---

## 3. Data flows

### 3.1 Artifact upload (requirements shown; the other three sets are the same shape)

```
POST /uploads/requirements  (multipart: file, uploaded_by, notes)
  |
  |  1. media type + size            routers/uploads.py       (413 / 400)
  |  2. sniff kind                   upload_service.detect_requirements_kind
  |     .reqifz -> zip -> .reqif + figures
  |     .reqif  -> XML
  |     .json   -> canonical items
  |  3. ReqIF -> canonical JSON      reqif_parser  (mapping by ATTRIBUTE-DEFINITION-*-REF)
  |     N1 XHTML flatten (only <br/>; anything else rejects the upload)
  |     N2 unescape + NFC  N3 whitespace collapse  N4 punctuation untouched
  |     N5 "" / [] defaults          N6 rule-ordered arrays
  |     unmapped attributes -> source/reqif-passthrough.json  (sidecar, never read)
  |  4. JSON Schema per item, then cross-field rules   validation
  |     ATOMIC: one bad item rejects the whole upload; no partial version
  |  5. canonical_sha256 per item + per set            canonical
  |  6. staged write, manifest LAST                    artifact_store.commit_version
  v
test-manager/requirements/v0004/
    manifest.json                  <- commit marker; written last
    canonical/requirements.json    <- stored form (indent=2, sort_keys)
    canonical/items/ACC-SYS-PRF-020.json
    source/<original upload>        <- immutable, never read downstream
    source/reqif-passthrough.json
    source/figures/F1-*.svg
    source/upload-receipt.json
```

The staged write goes to `test-manager/.staging/<token>/`, then copies payload files
into the version folder, then copies `manifest.json`. `list_versions()` globs for
`v*/manifest.json`, so a crash mid-write leaves an **invisible** folder rather than a
half-version.

**Convergence.** `POST /uploads/requirements/convergence-check` runs both upload
paths on equivalent input and asserts three things: per-item `canonical_sha256`
equality, set-level hash equality, and byte equality of the two stored
`canonical/requirements.json` documents. The two paths share no parser code, so the
check can actually fail; `converged: false` is a release blocker.

### 3.2 Baseline creation

```
POST /baselines {requirements_version, test_specs_version, test_impl_version,
                 signal_catalog_version}
  -> read all four versions from blob
  -> integrity checks (spec 2.3)
       1 every covers_req_ids entry resolves        error unresolved_req_ref
       2 every impl_ref.impl_id resolves            error unresolved_impl_ref
       3 static pass-criteria checks                error unknown_signal /
                                                          signal_group_mismatch /
                                                          unit_algebra_mismatch /
                                                          reference_group_signal
       4 method compatibility matrix (spec 2.4)     error method_incompatible
       5 orphans + uncovered requirements           WARNING, listed not rejected
  -> any error finding  =>  422, no baseline id consumed
  -> mint BL-nnnn, write test-manager/baselines/BL-nnnn.json (immutable)
  -> mirror into Mongo: baselines + req_coverage (the verified_by link block)
```

`POST /baselines/dry-run` runs the same checks without consuming an id.

The unit algebra lives in `units.py`: a unit is parsed to base-exponent form, so
`m/s^2`, `m*s^-2` and `m/(s^2)` compare equal - the check is about dimensions, not
spelling. `derivative` multiplies by `s^-1`, `integral` by `s^1`, `duration_true` /
`time_between_edges` / `settling_time` become `s`, `count_edges` becomes `1`,
everything else is identity.

`verified_by` handling: the canonical requirement keeps the field **exactly as
uploaded** (empty in Phase 1), because writing links into it would mutate an
immutable version folder. The populated mirror lives in `baselines/<BL>.json ->
req_links` and in Mongo `req_coverage`, and the API surfaces it under the same name
`verified_by`, so the field name is unchanged end to end.

### 3.3 Decoupled ingest - sink first, never evaluate on arrival

```
POST /uploads/traces  (multipart: file, device_id, sw_version, hw_version,
                       [test_run_id], [tc_ids])
  |  stream to a temp file, hashing as it goes        (bytes never held in memory)
  |  sniff MF4 header; reject non-MDF4 and raw CAN    BEFORE storing anything
  |  trace_key = TRC-<device_id>-<sha256[:12]>
  |  same key + same hash -> 200, idempotent, steps below skipped
  |  different hash       -> 409 trace_key_collision
  |  write blob:  test-manager/traces/<device>/<trace_key>/trace.mf4
  |               ...                              /trace.meta.json
  |  insert Mongo traces{ingest_status: "stored"}
  v
trace-ingest-requests   key=trace_key   {trace_key, blob_path, meta_path, ...}
        (metadata only - the file bytes never enter Kafka)
  |
  v  mf4-extractor
  |  State["extracted"] keyed by trace_key (== the message key, so in-context)
  |  read object from blob, open with asammdf
  |  FLAG_CG_BUS_EVENT or CAN_DataFrame* -> unsupported_raw_can, no rows
  |  trace_epoch_ms = HD start_time if > 0 else uploaded_utc; epoch_source recorded
  |  one row dict per sample per channel group
  |  commit_every = 1   (1 message -> ~6 400 rows; the standard expand-then-produce OOM)
  |
  +-> test-vectors-pt-can-100hz    key=trace_key
  +-> test-vectors-radar-obj-50hz
  +-> test-vectors-hmi-10hz
  +-> test-vectors-sim-ref-100hz
  |     (row branches are defined BEFORE the completion branch, so readiness never
  |      sees a trace reported complete before its rows were produced)
  +-> merge the extraction report into trace.meta.json, State["extracted"]=True
  +-> trace-ingest-completed  {ingest_status, lake_rows, signals, groups, t_s span}
        |
        +-> mongo-writer  -> traces (upsert by trace_key)
        +-> tm-evaluator/readiness -> group_by(test_run_id) + State -> at most one
                                       evaluation request per (run, run_version)

test-vectors-sink: four dataframes -> four QuixTSDataLakeSink, catalog_url set.
```

Raw MF4 objects live under `test-manager/traces/...`, **outside** any `data-lake/`
prefix, so Iceberg catalog discovery (which scans
`{workspaceId}/data-lake/time-series/`) never walks a file that has no schema.

### 3.4 Evaluation, triggered separately

```
POST /test-runs/{id}/evaluate {trigger: manual|readiness}
  -> status := evaluating,  publish evaluation-requests {test_run_id, run_version}
  -> 202. Nothing is evaluated inline.

tm-evaluator
  GET /internal/evaluation-input/{run}?run_version=
      -> run + device + expected_config_hash12 + planned_tc_ids
       + the baseline's test cases and signal catalogue
       + traces_by_case[tc_id] = [{trace_key, device_id, scenario, config_hash12,
                                   signals, ingest_status}]
      (one call, so the evaluator cannot mix versions by fetching pieces separately)

  per (tc_id, trace_key):
      ingest_status != vectorised            -> not_run / trace_not_vectorised
      config_hash12 mismatch                 -> inconclusive / provenance_mismatch
                                                (unless allow_provenance_mismatch)
      one query per needed table, columns narrowed:
        SELECT t_s, trace_key, channel_group, sample_index, <signals>
        FROM acc_pt_can_100hz
        WHERE device_id='..' AND scenario='..' AND trace_key='..' ORDER BY t_s
        - no WITH/CTE (silently returns zero rows)
        - no aggregation in SQL (30 s timeout); reduce in numpy, ~6 400 rows
        - device_id + scenario are the Hive partitions, so the filter pushes down
      align: base group = the criterion's primary signal's group;
             coarser groups ZOH forward-filled; uncertainty_s = half the coarsest
             contributing raster period, REPORTED, never subtracted from a bound
      preconditions.gates first -> inconclusive / precondition_gate_unmet
      window -> mask + spans;  reduce -> scalar or series;  rule + tolerance +
      quantifier -> pass/fail;  combine with pass_criteria_logic
      several traces per case -> WORST verdict (error > fail > inconclusive > pass)

  POST /internal/evaluations {results[], queries[], warnings[]}
      -> the API fills in every planned case that produced no result as
         not_run / no_evidence_attached  (this is where the frozen plan pays off)
      -> result_sha256 per case
      -> metrics.compute + metrics.requirement_verdicts
      -> blob archive  test-manager/evaluations/<run>/v<n>/results.json
      -> publish one test-results message per case, then run-summaries
      -> status := evaluated

mongo-writer: test-results -> results; run-summaries -> run_metrics + req_verdicts
```

The API owns the metric formulas and the verdict precedence, not the evaluator, so
they exist exactly once and the §6.2 sum-check invariant cannot disagree between two
copies.

### 3.5 Report generation

`POST /test-runs/{id}/report` renders in-process:

1. results from Mongo `results`, falling back to the blob evaluation archive;
2. metrics from `run_metrics`, recomputed from the same inputs if the sink lags;
3. `inputs_digest` = SHA-256 over the canonical JSON of the baseline + its four
   pinned versions and set hashes, device triple, config identity and hash, sorted
   `planned_tc_ids`, sorted `(tc_id, trace_key, content_sha256)` triples, sorted
   `(tc_id, result_sha256)` pairs, evaluator version, generator version;
4. plots: one SVG per criterion, rendered by hand from the decimated series the
   evaluator stored **inside the result document** - so a report stays renderable
   even if the lake is gone, while the exact queries stay printed so the full data
   remains addressable;
5. `report.json` validated against `report-1.0.0.schema.json`, `report.html`
   rendered from `report.json` alone (so the two are twins, not two independent
   summaries), both written to
   `test-manager/reports/<run>/v<n>/rev<NN>/` with `report.json` last;
6. if the digest matches the previous revision, the body must be byte-identical
   apart from `generated_utc`; the generator asserts that and records
   `reproducible`. A mismatch there is recorded as a generator defect, not hidden.

HTML is a single self-contained file: inline SVG, embedded stylesheet with two
breakpoints and a print stylesheet, no CDN, no external font, no JavaScript needed
to read it. Chosen over server-side PDF because the report must carry clickable
links back to requirements, test cases and implementations, and a PDF would need a
headless browser in the image.

---

## 4. File inventory

### `backend-api/` - created

| Module | Lines | Concern |
|---|---|---|
| `settings.py` | 129 | Env-derived settings, set names, group/table maps, fixed Hive columns |
| `blob_storage.py` | 272 | **The blob seam**: Protocol + Quix + Local + Null backends, selector |
| `paths.py` | 122 | Blob path layout (spec 3.1). Pure functions, no I/O |
| `ids.py` | 95 | Id regexes and minting (version, baseline, run, revision, trace key) |
| `canonical.py` | 179 | JCS hash form, stored form, N2-N6 normalisation, measurand parsing |
| `schemas/*.json` | - | The eight published draft-2020-12 validators |
| `schema_registry.py` | 100 | Schema loading, cross-file `$ref` resolution, `schema_sha256` |
| `validation.py` | 307 | Door validation: item schema, manifest schema, cross-field rules |
| `reqif_parser.py` | 432 | ReqIF 1.2 -> canonical JSON, N1, passthrough sidecar. The only XML parser |
| `upload_service.py` | 279 | The seven-step door protocol, manifest construction, version commit |
| `impl_service.py` | 227 | Test-impl uploads with carry-forward of the previous version's code |
| `artifact_store.py` | 256 | Versioned write-once storage, staged commit, manifest-last |
| `diff_service.py` | 44 | Version-to-version diff for the upload panel |
| `convergence.py` | 114 | The ReqIF/JSON convergence proof |
| `units.py` | 101 | Unit algebra in base-exponent form |
| `criteria_static.py` | 136 | Static pass-criteria checks against the pinned catalogue |
| `baseline_service.py` | 287 | Baseline creation, integrity, method matrix, `req_links`, bundle load |
| `mongo_schema.py` | 164 | Collection names, **every index**, `_id`-stripping serialisation |
| `db.py` | 28 | Mongo URI assembly (unchanged) |
| `deps.py` | 85 | Lazily built db / bus, `require_blob()` honest-degradation guard |
| `api_models.py` | 216 | Pydantic v2 API bodies, all `extra="forbid"` |
| `topics.py` | 68 | QuixStreams `Application` + topic objects, lazily built |
| `lakehouse.py` | 114 | Query API wrapper, CTE guard, missing-variable reporting |
| `metrics.py` | 153 | §6.1/6.2 metrics with both denominators; §6.3 verdict precedence |
| `svg_plot.py` | 168 | Hand-rolled SVG line plot with bound and tolerance band |
| `report_html.py` | 408 | ISO 29119-3 §7.4 skeleton rendered from `report.json` |
| `report_service.py` | 495 | `inputs_digest`, plots, revisions, residual risks, blob write |
| `run_service.py` | 501 | Scope expansion, frozen plan, attach, readiness, finalisation |
| `trace_service.py` | 269 | MF4 sniff, trace key, blob write, registry insert, metadata message |
| `error_handlers.py` | 76 | Domain error -> HTTP status, in one place |
| `main.py` | 107 | App assembly, router wiring, `/health` |
| `routers/uploads.py` | 176 | Four artifact uploads + trace upload + convergence check |
| `routers/artifacts.py` | 136 | Version browsing, diff, source/figure serving, schema publishing |
| `routers/catalog.py` | 393 | Composite reads for pages 1-3 |
| `routers/baselines.py` | 92 | Baseline create / dry-run / read / bundle |
| `routers/registry.py` | 191 | Devices, device versions, parameter sets |
| `routers/traces.py` | 82 | Trace list, neighbourhood, meta, object download |
| `routers/test_runs.py` | 159 | Create, submit, attach, readiness, evaluate, report, lessons |
| `routers/results.py` | 147 | Results, metrics, requirement verdicts, report artifacts |
| `routers/graph.py` | 142 | Traceability neighbourhood as nodes/edges with relation ids |
| `routers/internal.py` | 161 | The evaluator contract |

### `backend-api/` - deleted

| File | Why |
|---|---|
| `crud.py` | One generic router factory for four resources; `item: dict` inserted verbatim, no validation, `ObjectId()` on every path id |
| `config_store.py`, `config_consumer.py` | A single last-write-wins in-memory slot, lost on restart; a run must pin a specific `(config_id, config_version)` |
| `transform.py` | Built the `test-data-uploads` message that no longer exists |
| `tests/test_config_store.py`, `tests/test_transform.py`, `tests/test_main_upload.py` | Tests of the three deleted modules. `tests/test_db.py` is untouched and still valid |

### New applications

| App | Files | Concern |
|---|---|---|
| `mf4-extractor/` | `main.py` 319, `mf4_reader.py` 191, `rows.py` 151, `blob_seam.py` 149 | MF4 -> rows, raw-CAN rejection, State idempotency, `commit_every=1` |
| `test-vectors-sink/` | `main.py` 144, `README.md` | Four dataframes -> four `QuixTSDataLakeSink` with `catalog_url` |
| `tm-evaluator/` | `evaluate_case.py` 441, `reduce_ops.py` 304, `rules.py` 236, `main.py` 195, `lake_client.py` 184, `windows.py` 140, `events.py` 112, `alignment.py` 108, `readiness.py` 94, `backend_client.py` 82 | Criteria engine, ZOH alignment, midpoint convention, readiness trigger |
| `mongo-writer/` | `main.py` 163, `selectors_map.py` 144, `matchers.py` 56 | `MongoDBSink` per collection with custom `document_matcher` |

### Modified

| File | Change |
|---|---|
| `dynamic-config-manager/transform.py` | Emits the real Quix DCM event shape plus flat `(config_id, config_version, params, canonical_sha256, config_hash12)` |
| `dynamic-config-manager/main.py` | Pydantic body, monotonic version minted from the registry, publishes to `config-events`; read path is the API's `/parameter-sets` |
| `quix.yaml` | DCM + Backend API variables; four new deployments; eleven new topics with 7-30 d retention |
| `.gitignore` | `.tmp/`, `.blobstore/` |

`lakehouse-sink/` is untouched: it stays as the no-code-change fallback if the
pinned QuixStreams version refuses four dataframes in one `Application` (deploy it
four times with different `input`/`TABLE_NAME`/`HIVE_COLUMNS`).

---

## 5. Stores

| Store | What lives there | Key | Index / partition columns |
|---|---|---|---|
| Blob `test-manager/{requirements,test-specs,test-impl,signal-catalog}/v000n/` | Canonical artifacts, original uploads, ReqIF passthrough, figures, receipts, manifests | version path segment + item id | none (path lookup, not a query) |
| Blob `test-manager/baselines/BL-nnnn.json` | The four pins, integrity findings, counts, `req_links` | `baseline_id` | none |
| Blob `test-manager/traces/<device_id>/<trace_key>/` | `trace.mf4`, `trace.meta.json` | `trace_key` (content-addressed) | none; deliberately outside `data-lake/` |
| Blob `test-manager/reports/<run>/v<n>/rev<NN>/` | `report.html`, `report.json`, `plots/*.svg` | `(run, run_version, revision)` | none |
| Blob `test-manager/evaluations/<run>/v<n>/results.json` | Frozen result archive (Mongo recovery path) | `(run, run_version)` | none |
| Mongo `devices` | Device registry | `device_id` | unique `device_id` |
| Mongo `device_versions` | SW/HW version per device, `dbc_id` extension point | `(device_id, sw_version, hw_version)` | unique compound; `device_id` |
| Mongo `parameter_sets` | Model parameterisation per config version | `(config_id, config_version)` | unique compound; `config_id`, `canonical_sha256`, `config_hash12` |
| Mongo `baselines`, `req_coverage` | Queryable baseline mirror + `verified_by` link block | `baseline_id`, `(baseline_id, req_id)` | unique; `created_utc` |
| Mongo `traces` | Trace registry and ingest status | `trace_key` | unique; `device_id`, `content_sha256`, `mf4.config_hash12`, `ingest_status` |
| Mongo `run_trace_links` | The trace <-> case M:N table, run-scoped | `(test_run_id, run_version, tc_id, trace_key)` | unique compound; `trace_key`, `(test_run_id, run_version)` |
| Mongo `test_runs` | Runs, the frozen plan, report ref | `test_run_id` | unique; `baseline_id`, `device_id`, `status`, `created_utc` |
| Mongo `results` | One result per case per run version | `(test_run_id, run_version, tc_id)` | unique compound; `(run, version, verdict)`, `req_ids` |
| Mongo `run_metrics`, `req_verdicts` | Metrics and per-requirement verdicts | `(run, version)`, `(run, version, req_id)` | unique compound |
| Lakehouse `acc_pt_can_100hz`, `acc_radar_obj_50hz`, `acc_hmi_10hz`, `acc_sim_ref_100hz` | Test vectors extracted from MF4 | `(trace_key, t_s)` | `hive_columns = [device_id, scenario]`, `timestamp_column = ts_ms` |

Every Mongo document is **derived and rebuildable** from blob artifacts, lake rows
and `run_trace_links`. Blob is the record of truth for anything that appears in a
report. Indexes are created only by `backend-api/mongo_schema.ensure_indexes`, so
the definitions have exactly one owner; the sink matchers reproduce the same
identities, which makes an upsert correct even before the index exists.

### Why `hive_columns` is fixed at `[device_id, scenario]`

Both are low cardinality (a handful of devices, 16 scenarios). `trace_key` is a
column on **every** row but is deliberately **not** a partition column: it is
per-trace, which is exactly the high-cardinality case that must not partition.
Evaluator queries still push down because the trace registry supplies `device_id`
and `scenario` alongside the `trace_key`.

**Changing `hive_columns` later is a migration, not a tweak.** The sink validates
the partition set against catalog metadata *and* the on-disk Hive paths at
`setup()` and raises. A layout change means a new table name and a re-sink of every
trace. That is why the value is a module constant in `test-vectors-sink/main.py`
rather than an environment variable.

`ts_ms` is `trace_epoch_ms + round(t_s * 1000)` and is **wall-clock-tainted**: in
the plant's byte-identical mode the MF4 header start time is a fixed epoch, so
`trace_epoch_ms` falls back to the upload time and `epoch_source` records which was
used. **Every verdict uses `t_s`, never `ts_ms`.**

---

## 6. Metrics

Notation for a run on baseline `B`: `R_all` = requirements in `B`; `R_test` =
those with `verification_method == "Test"`; `TC_plan` = `scope.planned_tc_ids`,
frozen at submit; `TC_exec` = planned cases whose verdict is `pass` or `fail`;
`Cov` = requirements covered by a case in `TC_exec`; `Ver` = those whose covering
case passed.

| Metric | Formula | Denominator |
|---|---|---|
| `requirement_coverage_all` | `\|Cov\| / \|R_all\|` | all requirements in the baseline |
| `requirement_coverage_testable` | `\|Cov ∩ R_test\| / \|R_test\|` | requirements with method `Test` - the headline figure |
| `requirement_coverage_chapter[ch]` | `\|Cov ∩ R_ch\| / \|R_ch\|` | requirements in that chapter |
| `requirement_verification_coverage` | `\|Ver\| / \|R_all\|` | all requirements, covered **and** passing |
| `baseline_coverage_static` | covered-by-any-case / `\|R_all\|` | all requirements, run-independent |
| `tc_passed` / `tc_failed` / `tc_not_run` / `tc_error` / `tc_inconclusive` | counts over `TC_plan` | absolute counts |
| `tc_pass_rate_planned` | `tc_passed / \|TC_plan\|` | the frozen plan |
| `tc_pass_rate_executed` | `tc_passed / \|TC_exec\|` | executed only (`pass` + `fail`) |
| `tc_execution_rate` | `\|TC_exec\| / \|TC_plan\|` | the frozen plan |
| `sum_check_ok` | `passed+failed+not_run+error+inconclusive == \|TC_plan\|` | - |

Both coverage denominators are reported because the `_all` denominator can never
reach 1.0 (three requirements are `Inspection`/`Demonstration`/`Analysis`) and a
permanently capped metric gets ignored. Both pass-rate denominators are reported
because quoting one without the other is how "97 % pass" hides 40 unexecuted cases.
An empty denominator yields `null`, not `0.0`: 0/0 is not 0 %.

`tc_not_run` is only computable because the plan is persisted at run **creation**
and frozen at **submit**, before any data arrives. `run_service.finalize_evaluation`
fills in every planned case the evaluator returned nothing for as
`not_run / no_evidence_attached`, which is what makes the sum-check hold by
construction.

Per-requirement verdict precedence, top to bottom: `error` if any covering case in
the run errored, else `fail`, else `inconclusive`, else `pass` if every covering
case passed, else `partial` if some passed, else `not_run`.

---

## 7. Integration with what already existed

| Existing thing | Relationship |
|---|---|
| `mongodb` deployment | Unchanged. `state.enabled: true, size: 1` is still adequate: the collections hold bytes, not vectors |
| `mongo-backup-manager` | Unchanged. Mongo is derived, but a backup still shortens recovery |
| `lakehouse-sink` + `test-data-uploads` | Left in place as the documented four-deployment fallback for `test-vectors-sink`; the topic is marked legacy in `quix.yaml` |
| `config-updates` topic | Marked legacy. Nothing consumes it; `config-events` replaces it |
| `frontend/` | **Untouched, and it will break**: it calls `GET /evaluate`, `GET/POST /requirements`, `/test-specs`, `/test-runs` in the old generic-CRUD shape. Rebuilding it as the five-page app is the next dispatch |
| `backend-api/tests/test_db.py` | Still valid; `db.py` is unchanged |

---

## 8. Departures from the spec, and why

1. **Four stream deployments instead of six.** `report-generator` folded into the
   API, `run-readiness` folded into `tm-evaluator`. Reason: Quix per-folder build
   contexts would force the metric formulas, the canonicalisation rules and the
   blob seam to be duplicated. Section 2.1.
2. **Workers read through the API, not directly from blob and Mongo.** Same reason.
   `/internal/*` is the contract.
3. **`blobStorage: bind: true` is commented out on `mf4-extractor` and
   `test-vectors-sink`.** Any deploy carrying it is aborted while the Storage
   Gateway is unreachable. Both services need blob, so the ingest half of the
   pipeline is blocked until the gateway is healthy; nothing pretends otherwise.
4. **Lakehouse Query variables declared explicitly** on `backend-api` and
   `tm-evaluator` rather than relying on the blob bind to inject them.
5. **`baseline_coverage_static` added to `baseline-1.0.0.schema.json`.** The schema
   in `schemas.md` is `additionalProperties: false` and does not list the field, but
   spec §6.1 says it is stored in the baseline JSON. Resolved by adding the
   property; flag if the schema was meant to win.
6. **Raw-CAN detection at the door is a byte scan** for `CAN_DataFrame*` markers,
   not an `asammdf` inspection - that keeps `asammdf` out of the API image. The
   authoritative check (`FLAG_CG_BUS_EVENT`) runs in the extractor, which rejects
   with `unsupported_raw_can` if the scan let one through.
7. **Series-valued reductions do not *require* an explicit `rule.quantifier`.**
   schemas.md §3.1 says they do, but the schema itself gives `quantifier` a
   `default: "all"`, so absence is legal JSON. The evaluator applies the default and
   **reports the effective quantifier on every criterion**. This conflict needs a
   decision: either drop the default from the schema or drop the sentence.
8. **Multi-trace combination rule invented.** The spec fixes `min_traces` but never
   says how several traces combine for one case. Implemented as worst-case
   (`error > fail > inconclusive > pass`), the only choice consistent with "no fudge
   factors": a requirement that holds in one trace and fails in another has failed.
9. **`duration_true` is quantised to the base raster period** (`count(non-zero) *
   sample_period`). The spec says "total time the series is non-zero" without fixing
   an integration rule; this is the raster-exact reading and is stated in the code.
10. **Residual risks: the plant spec's `NOT CHECKABLE by design` topics are not
    quoted verbatim.** That spec lives in the `acc_project` repo, not here. The
    report reads them from an operator-maintained
    `test-manager/residual-risks.json` and, when it is absent, says so explicitly
    rather than silently omitting the section.
11. **`unit-test-runner` and the `unit-test-requests` topic are not built** -
    deferred by explicit decision. A case with `trace_required: false` therefore
    resolves to `not_run / manual_verdict_pending` with that reason spelled out, and
    the manual-verdict endpoint is the way to close it.
12. **`report-requests` topic not created.** Report generation is synchronous in the
    API; `report-completed` is published for `mongo-writer`. Reintroducing the
    request topic later needs no schema change.

## 9. Things to be careful about when changing this

* **`hive_columns` and `TABLE_NAME` are migrations.** See section 5.
* **Never write parquet to blob without `catalog_url`.** That, not the sink itself,
  is what corrupts Iceberg. Tables go through `QuixTSDataLakeSink`; raw files go
  through the blob seam and are never registered in the catalog. The two paths never
  mix.
* **Never put a CTE in a lake query.** It returns zero rows silently.
  `lake_client.run_query` and `lakehouse.query_csv` both refuse `WITH`.
* **`commit_every` on `mf4-extractor` must stay 1.** It counts *input* messages, and
  one input message is ~6 400 output rows.
* **Do not move the metric formulas into the evaluator.** Two copies will disagree,
  and the sum-check invariant is the thing that catches it - which only works while
  there is one implementation.
* **Do not make the blob seam optional in a new module.** Import
  `blob_storage.require()` (or `deps.require_blob()` in a route) so an absent
  backend is a 503 naming the cause, never a silent success.
