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

**The same pattern now covers all four dependencies.** Round 1 found the two
places where it did not, and both had the same shape: a dependency failure that
arrived as an opaque 500 or a bare transport timeout instead of a named 503.

| Dependency | Unavailable looks like | Where |
|---|---|---|
| Blob storage | `503 blob_storage_unavailable` + which variable is unset | `deps.require_blob`, `BlobUnavailableError` handler |
| MongoDB | `503 mongo_unavailable` (or `mongo_not_configured`), inside 3 s | `deps.get_db` for a missing variable; the `PyMongoError` handler for every outage |
| Event bus | `503 event_bus_unavailable` naming the missing broker config | `topics.EventBusUnavailableError` |
| Event bus, after a trace's writes committed | `503 event_bus_unavailable` **plus `trace_key`, `created` and what persisted** | `trace_service.TraceNotPublishedError` |
| Lakehouse Query | which `Quix__Lakehouse__*` variable is missing | `lakehouse.py` |

The Mongo entry is the one with an arithmetic constraint behind it.
`MongoClient` defaults to `serverSelectionTimeoutMS=30000`; the frontend's read
timeout is 10 s. With Mongo stopped, the browser got
`HTTPConnectionPool ... Read timed out` - a transport error naming nothing - while
the API kept a worker blocked for another 20 s on a request nobody was waiting for.
`db.py` therefore pins server selection at 3 s, connect at 3 s and socket at 5 s,
all env-overridable, so the honest 503 arrives well inside any sane client
timeout. **Those values are load-bearing; see section 9.**

**A bound is only a bound if it is paid once.** Round 2 measured the first
Mongo-backed request in a fresh process at **36.94 s** with Mongo unreachable, even
with those timeouts pinned: `deps.get_db` created the schema's indexes inline on
that first request, and `mongo_schema.ensure_indexes` looped over all eleven
collections, paying the full server-selection timeout on each - `11 x 3.3 s`, worse
than the 30 s default the pin exists to prevent. So the rule is now structural, not
incidental:

* **`deps.get_db` does no I/O.** Constructing `MongoClient` and looking up
  `client[db]` are both lazy, so the dependency itself cannot block. Reachability is
  the route query's own business, and `error_handlers`' `PyMongoError` handler turns
  it into the same named 503 after exactly one server-selection timeout. Measured
  bound for the cold path: the same `< 4 s` that `/health/ready` already met.
* **Index creation happens at start-up, in a daemon thread**
  (`deps.start_index_reconciler`, started by `main.lifespan`). A thread rather than
  an inline call because a Mongo outage at boot must neither delay nor fail the boot
  - "every app imports and starts with zero environment variables" is load-bearing
  for Quix deployment. The reconciler retries every `TM_INDEX_RETRY_INTERVAL_S`
  (30 s) until it succeeds, so indexes appear once Mongo returns, with no redeploy.
* **`deps.ensure_indexes_once` latches only on success.** It used to set its flag
  whether or not the attempt worked, so a process that started during an outage
  never created indexes at all. It now pings once (`mongo_status`) before attempting
  anything and returns `False` on any failure, which is the reconciler's cue.
  A lock makes concurrent callers idempotent rather than eleven-times redundant.
* **`mongo_schema.ensure_indexes` distinguishes the two failure kinds.** A
  `ConnectionFailure` (which is what `ServerSelectionTimeoutError`, `AutoReconnect`
  and `NetworkTimeout` all are) is re-raised immediately - the server, not the
  collection, is the problem, so the remaining ten would only buy the same answer at
  the same price. Any other `PyMongoError` (an index-options conflict on one
  collection) is still logged-and-continued, so one legacy conflict cannot cost the
  other ten collections their indexes.

### 2.2.1 One error envelope

Every error response has one shape, built in `error_envelope.py`:

```
{ "error": "<stable code>", "message": "<cause, in words>",
  "problems": [ {code, message, entity_id, pointer} ],   # validation only
  ... case-specific keys: hint, stage, trace_key, persisted, findings }
```

Before this there were three - `require_blob`'s dict nested under FastAPI's
`detail` key, the `BlobUnavailableError` handler's top-level dict, and door
validation's `{detail, stage, problem_count, problems[]}` - and the frontend had
to carry an `_unwrap` adapter that flattened all three. The 33
`raise HTTPException(...)` sites in the routers were **not** touched: one
`StarletteHTTPException` handler normalises whatever they pass, which is why a
plain-string detail and a coded dict both come out the same way and no route can
invent a fourth shape. `RequestValidationError` (FastAPI's own 422) and any
unhandled exception are folded into the same envelope, so a 500 is never an empty
body again. Existing codes keep their spelling - `blob_storage_unavailable` above
all, which the frontend and the round-1 verification both key on.

The frontend's `_unwrap` adapter is now redundant. It is harmless (it flattens a
shape that is already flat), and `frontend/` is owned by another dispatch, so it
is left alone rather than half-changed.

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
  |     N1 (amended) XHTML flatten   xhtml_text
  |        accepted: <p> <br/> <em> <strong> <code>
  |        everything else (ul li table tr td object a img, nested div)
  |        rejects the upload with reason code xhtml_shape
  |     N2 unescape + NFC  N3 whitespace collapse  N4 punctuation untouched
  |     N5 "" / [] defaults          N6 rule-ordered arrays
  |     unmapped attributes -> source/reqif-passthrough.json  (sidecar, never read)
  |  4. JSON Schema per item, then cross-field rules   validation
  |     ATOMIC: one bad item rejects the whole upload; no partial version
  |  5. canonical_sha256 per item + per set            canonical
  |  6. staged write, manifest LAST, staging discarded artifact_store.commit_version
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

**The staged copy is then deleted, and only then** (`_discard_staging`, via the new
`rm_tree` on the blob seam). Round 2 found staging was write-only: every upload left
a complete second copy of every file it had just committed under `.staging/<token>/`,
with no TTL and no sweeper, so each artifact set permanently cost twice its bytes -
on the real object store, an unbounded silent leak rather than local clutter. A
**failed** commit keeps its staging directory on purpose (departure 20): the staged
bytes are then the only complete record of what was being written, the destination
is invisible anyway because its manifest never appeared, and token directories are
uuid-addressed so nothing can collide with the leftovers. A cleanup failure on the
success path is logged, never raised - the version is already committed, and a 500
about a leftover directory would misreport what happened.

**Convergence.** `POST /uploads/requirements/convergence-check` runs both upload
paths on equivalent input and asserts three things: per-item `canonical_sha256`
equality, set-level hash equality, and byte equality of the two stored
`canonical/requirements.json` documents. The two paths share no parser code, so the
check can actually fail; `converged: false` is a release blocker.

**Amended N1, and why the flattening is exactly this.** Spec 1.1.1 N1 permits
`<xhtml:br/>` as the only nested element. The real export - the acceptance fixture
the spec itself names in 1.1.2 - wraps every `text` and `rationale` value in
`<xhtml:p>`, so the literal rule rejected all 37 requirements with 74
`xhtml_shape` problems and the convergence check could not even be computed. The
exporter is validated against the vendored ReqIF XSD and round-trips attribute by
attribute, so the consumer was relaxed rather than the producer (departure 13).
The flattening, in `xhtml_text.py`:

```
THE-VALUE with no child elements      -> its text, verbatim
THE-VALUE with one <xhtml:div>        -> flatten the div (anything else: reject)
  a run of bare text and <br/>        -> one implicit block
  each <xhtml:p>                      -> one block
  inside a block: <br/>               -> "\n"
                  <em> <strong> <code> -> their text content, markup dropped
                  anything else        -> reject, naming the element
  each block stripped, empty blocks dropped, blocks joined with "\n\n"
then N2-N4 via canonical.normalise_text  (the same call the JSON path makes)
```

A **single** `<xhtml:p>` therefore unwraps to its text content exactly, which is
the property the whole convergence proof rests on. Verified on the real fixture:
all 37 `text` values and all 37 `rationale` values flatten byte-identically to the
strings the JSON path carries. Emphasis is dropped rather than rejected because
the canonical field is a plain string and the original `.reqif` is retained under
`source/`, so the audit trail keeps the markup. Structural markup stays a
rejection because flattening a table into running text changes its meaning - the
relaxation must not become "accept arbitrary markup".

The acceptance fixtures are vendored at
`backend-api/tests/fixtures/acc-system-requirements.reqif` and
`...canonical.json`, so the test is hermetic and does not reach into the
`acc_project` repo. `.gitattributes` marks that directory `-text`: an EOL rewrite
would change the flattened text and every hash derived from it. The JSON fixture is
a rendering of the CSV register (`Reqs/data/acc_system_requirements.csv`), a
*sibling* generated artifact of the ReqIF export rather than something derived from
it, and it deliberately keeps the register's authoring order for `system_states` -
which is what makes the N6 ordinal sort load-bearing in that test.

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
  |  same key + same hash -> 200, idempotent; republishes if publish_state != published
  |  different hash       -> 409 trace_key_collision
  |  (device_id, sw_version, hw_version) must be in device_versions
  |                        -> 422 unknown_device_version naming both register calls
  |  write blob:  test-manager/traces/<device>/<trace_key>/trace.mf4
  |               ...                              /trace.meta.json
  |  insert Mongo traces{ingest_status: "stored", publish_state: "pending"}
  |  publish; on success publish_state: "published"
  |           on failure publish_state: "failed" + 503 event_bus_unavailable
  |                     carrying trace_key, created and what persisted
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

**`publish_state`, and why the retry is the reconciliation.** Steps 4-6 commit two
blob writes and a Mongo row and only then produce the extraction request, so a
broker failure at step 6 happens *after* the upload has durably landed. That used
to be an opaque 500: the caller got no `trace_key`, no `created` flag and no way to
tell whether anything had been written, and the only route to the answer was to
upload the same bytes again and read `created: false`. Now the registry row carries
`publish_state = pending | published | failed` plus `publish_attempts`,
`publish_error` and `publish_attempted_utc`, and a failure answers `503` naming the
trace key and exactly what persisted.

Re-uploading the identical file **reconciles**: the content-addressed key finds the
existing row, and if it is not `published` the extraction request is published
again. That is safe because `mf4-extractor` keys its State on `trace_key` and drops
a request it has already handled, so a duplicate request is a no-op rather than
duplicated lake rows - the same idempotency that makes re-upload cheap makes
recovery cheap. Rows written before this existed have no `publish_state` and are
treated as un-published for the same reason. `GET /traces?publish_state=failed`
lists anything stranded.

`ingest_status` is deliberately *not* used to carry this. Its value set is fixed by
spec 0.6 and consumed by the readiness panel and the evaluator; an un-published
trace is not a failed extraction and must not look like one.

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
| `canonical.py` | 211 | JCS hash form, stored form, N2-N6 normalisation, measurand parsing, the frozen `system_states` order |
| `schemas/*.json` | - | The eleven published draft-2020-12 validators |
| `schema_registry.py` | 171 | Schema loading, cross-file `$ref` resolution, `schema_sha256`, `SchemaLoadError` naming the file, `load_errors()` for `/health` |
| `validation.py` | 316 | Door validation: item schema, manifest schema, cross-field rules |
| `reqif_parser.py` | 410 | ReqIF 1.2 -> canonical JSON, passthrough sidecar. The only XML parser |
| `xhtml_text.py` | 154 | **Amended N1**: the accepted XHTML subset and the flattening. Pure, imports nothing |
| `upload_service.py` | 279 | The seven-step door protocol, manifest construction, version commit |
| `impl_service.py` | 227 | Test-impl uploads with carry-forward of the previous version's code |
| `artifact_store.py` | 256 | Versioned write-once storage, staged commit, manifest-last |
| `diff_service.py` | 44 | Version-to-version diff for the upload panel |
| `convergence.py` | 114 | The ReqIF/JSON convergence proof |
| `units.py` | 101 | Unit algebra in base-exponent form |
| `criteria_static.py` | 136 | Static pass-criteria checks against the pinned catalogue |
| `baseline_service.py` | 287 | Baseline creation, integrity, method matrix, `req_links`, bundle load |
| `mongo_schema.py` | 164 | Collection names, **every index**, `_id`-stripping serialisation |
| `db.py` | 71 | Mongo URI assembly + the three pinned timeouts (section 2.2) |
| `deps.py` | 147 | Lazily built client / db / bus, `require_blob()`, `mongo_status()` bounded ping |
| `api_models.py` | 216 | Pydantic v2 API bodies, all `extra="forbid"` |
| `topics.py` | 115 | QuixStreams `Application` + topic objects, lazily built, `EventBusUnavailableError` |
| `lakehouse.py` | 114 | Query API wrapper, CTE guard, missing-variable reporting |
| `metrics.py` | 153 | §6.1/6.2 metrics with both denominators; §6.3 verdict precedence |
| `svg_plot.py` | 168 | Hand-rolled SVG line plot with bound and tolerance band |
| `report_html.py` | 408 | ISO 29119-3 §7.4 skeleton rendered from `report.json` |
| `report_service.py` | 495 | `inputs_digest`, plots, revisions, residual risks, blob write |
| `run_service.py` | 501 | Scope expansion, frozen plan, attach, readiness, finalisation |
| `trace_service.py` | 413 | MF4 sniff, trace key, blob write, registry insert, metadata message, `publish_state` reconciliation |
| `error_handlers.py` | 208 | Domain error -> HTTP status, in one place; normalises every `HTTPException` |
| `error_envelope.py` | 101 | **The one error response shape** (section 2.2.1). Pure, imports nothing |
| `main.py` | 158 | App assembly, router wiring, `/health`, `/health/ready`, `/health/mongo` |
| `routers/uploads.py` | 176 | Four artifact uploads + trace upload + convergence check |
| `routers/artifacts.py` | 136 | Version browsing, diff, source/figure serving, schema publishing |
| `routers/catalog.py` | 393 | Composite reads for pages 1-3 |
| `routers/baselines.py` | 92 | Baseline create / dry-run / read / bundle |
| `routers/registry.py` | 191 | Devices, device versions, parameter sets |
| `routers/traces.py` | 92 | Trace list (incl. `publish_state` filter), neighbourhood, meta, object download |
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
| `.gitattributes` | `backend-api/tests/fixtures/** -text` - the acceptance fixtures are compared byte for byte |
| `ruff.toml` | Added in round 2. The lint gate: explicit `select`, `line-length = 100`, the nine `src` roots, and the FastAPI `B008` exemption |
| `requirements-lint.txt` | Added in round 2. `ruff==0.16.3` - the rules are pinned by `ruff.toml`, the tool that reads them is pinned here |

Round-2 bug-fix changes inside `backend-api/`:

| File | Change |
|---|---|
| `deps.py` | `get_db` no longer creates indexes or does any I/O; new `database()`, `ensure_indexes_once()`, `start_index_reconciler()`, `stop_index_reconciler()`; lazy client construction is now locked, because the reconciler is a second thread |
| `mongo_schema.py` | `ensure_indexes` re-raises the first `ConnectionFailure` (one timeout, not eleven) and still tolerates a collection-local `PyMongoError` |
| `main.py` | A `lifespan` that starts and stops the index reconciler |
| `blob_storage.py` | `rm_tree` on the seam and on all three backends - the first delete the Test Manager has needed |
| `artifact_store.py` | `commit_version` discards the staged copy after the manifest lands (`_discard_staging`) |
| `reqif_parser.py` | Explicit `is not None and len(...)` instead of an ElementTree truth value |
| `schema_registry.py` | `functools.cache`; the blind `except` around validator compilation is justified rather than bare |
| `report_html.py`, `report_service.py`, `svg_plot.py` | Parenthesised the implicit string concatenations inside collection literals |
| `routers/uploads.py` | The deliberate non-context-manager `NamedTemporaryFile` is justified in place |

### `backend-api/tests/` - added in round 1 of verification

Written by ArchDev as regression cover for the six round-1 findings; the suite,
the harnesses and the lint gate remain Tester's to run.

| File | Lines | What it pins |
|---|---|---|
| `conftest.py` | 16 | The `sys.path` bootstrap, once, so test modules import at the top of the file |
| `fixtures/acc-system-requirements.reqif` | - | The real 37-requirement export, vendored byte-for-byte |
| `fixtures/acc-system-requirements.canonical.json` | - | The canonical-JSON rendering of the same 37, from the CSV register |
| `test_schema_registry.py` | 120 | Every schema parses; every `pattern` compiles; a broken file is named with its parse position |
| `test_xhtml_subset.py` | 145 | Amended N1: what flattens and how, what is refused, and the `xhtml_shape` reason code |
| `test_reqif_json_convergence.py` | 86 | The spec 1.1.2 acceptance test on the real fixture, plus field-by-field equality |
| `test_canonical_normalisation.py` | 72 | The frozen `system_states` order, its idempotence, and that N3 keeps hard newlines |
| `test_error_envelope.py` | 89 | One error shape; `blob_storage_unavailable` unchanged; `problems[]` preserved |
| `test_trace_publish.py` | 137 | A failed publish is recorded and raised, and the body names what persisted |
| `test_mongo_index_lifecycle.py` | 179 | Added in round 2: the cold-start 503 lands inside 4 s, start-up does not wait on Mongo, index creation is retried after a failure, and `ensure_indexes` aborts after one transport failure while still tolerating a per-collection one |
| `test_artifact_store_staging.py` | 104 | Added in round 2: a successful commit leaves no staged copy, the manifest-last marker still works after cleanup, and a failed commit leaves exactly one recoverable staging directory |

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
| Mongo `traces` | Trace registry, ingest status and `publish_state` | `trace_key` | unique; `device_id`, `content_sha256`, `mf4.config_hash12`, `ingest_status` |
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
| `frontend/` | Being rebuilt as the five-page app by a separate dispatch; not touched from here. Its `_unwrap` error adapter is now redundant (section 2.2.1) but harmless, so it is left alone rather than half-changed. Its 10 s read timeout is the constraint the Mongo timeouts in `db.py` are set against |
| `backend-api/tests/test_db.py` | Still valid. `db.py` gained explicit timeouts (departure 17) but `build_mongo_uri`, the only thing that test touches, is unchanged |

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

Departures 13-18 were added after round 1 of verification. The spec lives in a repo
this one must not edit, so this list is the record.

13. **N1 is implemented as amended: a constrained XHTML subset, not `<br/>` alone.**
    Spec 1.1.1 N1 says "the only permitted nested element is `<xhtml:br/>`; any other
    element => reject the upload". Applied literally - which is what the first
    implementation did, faithfully - it rejects the acceptance fixture that spec
    1.1.2 names: all 37 requirements, 74 `xhtml_shape` problems, because the real
    export wraps every `text` and `rationale` value in `<xhtml:p>`. **The rule is too
    narrow, and the consumer was relaxed rather than the producer.** `<xhtml:p>` is
    entirely ordinary in ReqIF XHTML attribute values, and that exporter is validated
    against the vendored ReqIF XSD and passes an export -> re-import ->
    attribute-by-attribute round-trip with zero mismatches; narrowing a validated
    exporter to satisfy an over-strict consumer would be the wrong way round.
    Accepted: `<xhtml:p>`, `<xhtml:br/>`, `<xhtml:em>`, `<xhtml:strong>`,
    `<xhtml:code>`. Refused, with reason code `xhtml_shape` naming the element:
    everything structural - `ul`, `li`, `table`, `thead`, `tbody`, `tr`, `th`, `td`,
    `object`, `a`, `img`, a nested `div`, a `p` inside a `p`. The flattening rule is
    in section 3.1; the code is `xhtml_text.py`.
    The subset was chosen by inspecting the export, not guessed. Its mapped XHTML
    fields are 74 x `div(p)` with no nested elements at all, while the *unmapped*
    `AD-SECTION-BODY` values - which go to the passthrough sidecar and never through
    N1 - do carry tables, lists and emphasis. So the emphasis elements are accepted
    because this exporter demonstrably emits them and flattening them to their text
    is convergence-safe, and the structural ones stay refused because flattening a
    table into running text changes its meaning. **Spec 1.1.1 should be amended to
    match.**
14. **`system_states` is ordinal-ordered on the JSON path too.** N6 says arrays are
    emitted "in the order given by the table", and for `AD-SYSTEM-STATES` that table
    says "sorted by the frozen `KEY` ordinal". The ReqIF path read that order from
    the ReqIF `ENUM-VALUE` `KEY` attributes; the JSON path had no KEY table and so
    preserved authoring order - and five of the 37 real requirements list their states
    in the register in an order the ordinal does not agree with, so the same
    requirement hashed differently depending on which way it was uploaded. The frozen
    order is now a constant in `canonical.py` and both paths apply it. This is a spec
    *clarification* rather than a departure, but it changes documented behaviour on
    the JSON path and so is recorded: a `.json` upload's `system_states` order is not
    preserved, it is normalised.
15. **A bus-publish failure after the trace writes have committed is a 503, and the
    registry row says so.** Spec 4.2 orders the writes before the publish and that
    order is kept - but the spec does not say what happens when step 6 fails after
    steps 4-5 have committed, and an opaque 500 is not an answer. The row carries
    `publish_state`, the response names the trace key and what persisted, and
    re-uploading the identical file republishes. Section 3.3.
16. **Trace upload requires the `(device_id, sw_version, hw_version)` triple to be
    registered.** Spec 4.2's seven steps do not mention it. The check itself is
    right - `device_versions` is the registry of record for the triple every
    verdict's provenance is quoted against, and a trace for a triple nobody declared
    cannot be attributed - but it was undocumented, which is a defect in itself. It
    is documented here now, and the `422 unknown_device_version` message names both
    calls needed to clear it (`POST /devices`, then `POST /devices/{id}/versions`).
    **Spec 4.2 should gain this precondition.**
17. **Mongo timeouts are pinned, and readiness is a separate endpoint.**
    `serverSelectionTimeoutMS=3000`, `connectTimeoutMS=3000`, `socketTimeoutMS=5000`
    instead of PyMongo's 30 s default, so a datastore outage becomes a named 503
    inside any sane client read timeout instead of a bare transport timeout 20 s
    after the client gave up. `/health` gains a `mongo` block and a `ready` flag but
    still answers **200** while Mongo is down, deliberately: it is the liveness
    signal, and a liveness probe that fails on a datastore outage restarts a process
    that has nothing wrong with it, for as long as the outage lasts.
    `/health/ready` is the one that answers 503, and it is what a deployment probe
    should key on. There is no `require_mongo()`; the reasoning is in the `deps.py`
    module docstring.
18. **One error envelope, everywhere.** Three shapes became one, centrally, without
    touching the 33 `raise HTTPException(...)` sites. Section 2.2.1. Codes already in
    use keep their spelling.

Departures 19-20 were added after round 2 of verification.

19. **Index creation is a start-up reconciler, not a request-path side effect.**
    Nothing in the spec says where `createIndexes` runs, and the first
    implementation put it on the first Mongo-backed request of the process, once,
    which is the obvious place until Mongo is down: eleven collections x one
    3.3 s server-selection timeout = the **36.94 s** first request round 2
    measured, worse than the PyMongo default that departure 17 exists to prevent.
    Index creation now runs in a daemon thread started by the application lifespan
    and retried every `TM_INDEX_RETRY_INTERVAL_S` (30 s) while Mongo is
    unreachable; `deps.get_db` does no I/O at all. Two behaviours a reader could
    otherwise be surprised by: **(a)** on a *fresh* database the first few requests
    may run against collections whose indexes are still being created - they are
    correct, just unindexed, and every unique constraint is asserted moments later,
    which is the same window a redeploy has always had; **(b)** a process that
    never runs its lifespan (a `TestClient` used without its context manager) never
    creates indexes at all. Both are the price of keeping the request path free of
    a datastore timeout, and both are cheaper than the 37 s they replace.
20. **A failed artifact commit keeps its staging directory; a successful one
    deletes it.** Spec 3.1 says a version folder is written once via a staged copy
    and is silent on what happens to the staging area afterwards. Round 2 found
    the answer was "nothing, ever": each upload permanently doubled its stored
    bytes. Cleanup now happens immediately after the manifest copy - and *only*
    there. A commit that dies part-way keeps its `.staging/<token>/` directory as
    the sole complete record of what was being written, because the destination
    version is invisible to every reader without its manifest and recovery is
    manual and rare. Cleaning up on failure too would be tidier and would destroy
    the evidence. There is no sweeper: a failed commit is the only thing that can
    leave a staged directory behind, and it leaves exactly one.

### Also fixed in round 2 of verification, without departing from the spec

* **The lint gate is pinned in the repo** (`ruff.toml`, `requirements-lint.txt`).
  Round 1 reported "0 findings" with `--select E4,E7,E9,F`; round 2 ran a true
  unscoped `ruff check` on the same code and got **148**. Neither number was wrong:
  there was no ruff config anywhere in the repo, so the gate meant whatever the
  installed ruff's built-in default happened to be - and that default has moved
  (it no longer enables `E402`, which is why eleven deliberate `# noqa: E402`
  comments became `RUF100` "unused noqa" findings between the two rounds). The
  config states the rule set explicitly, states `line-length = 100`, and declares
  the nine per-application `src` roots, without which ruff cannot tell
  `import deps` from a PyPI package and reports `I001` on 27 correctly-grouped
  files. `B008` stays *enabled* with `extend-immutable-calls` naming the nine
  FastAPI parameter helpers, so the 57 `Depends()`/`Query()`/`File()` findings are
  exempted by configuration rather than by 57 `noqa` comments, while a genuine
  mutable default is still caught. The rules the config deliberately does **not**
  select, and why, are listed in the file itself.
* **Two `# noqa: BLE001` markers were removed** (`mf4-extractor/mf4_reader.py:58`,
  `tm-evaluator/main.py:107`) - the only edits round 2 made outside
  `backend-api/`, both comment-only. Ruff's `BLE001` already exempts a blind
  handler that re-raises or that calls `logging.exception`, which is exactly what
  those two do, so the suppression was dead and `RUF100` says so. The reason each
  handler is broad survives as an ordinary comment.
* **The genuine style findings behind that number are fixed**: `functools.cache`
  for the four `lru_cache(maxsize=None)` decorators, parentheses around the six
  implicit string concatenations inside collection literals (`ISC004` - the same
  shape a missing comma makes), a justified `noqa` on the two deliberate blind
  `except Exception` handlers and on the one deliberate `NamedTemporaryFile` that
  cannot be a context manager, and one redundant `return None`.
* **`reqif_parser` no longer relies on an ElementTree element's truth value.**
  `_first(spec_object, "TYPE") or spec_object` produced one `DeprecationWarning`
  per element (222 in a clean test run) and will change meaning in a future
  Python. The replacement is explicit - `is not None and len(...)` - and preserves
  the old semantics exactly, including the part that matters: an *empty* `<TYPE>`
  element carries no `SPEC-OBJECT-TYPE-REF`, so the SPEC-OBJECT is still the place
  to look. Nothing in the canonical hash depends on it (`spec_type` is passthrough
  sidecar data), which is why the convergence hashes are unchanged.

### Also fixed in round 1, without departing from the spec

* **`requirement-1.0.0.schema.json` line 39** carried `\.` where JSON requires
  `\\.`, so the file did not parse. `_registry()` parses every published schema to
  resolve cross-file `$ref`s, so that one character broke door validation for **all
  four** artifact sets, and both affected endpoints answered 500 with no file name
  anywhere in the response. Audit of the other ten files: exactly two lines in the
  whole directory contain a backslash at all, and the other one
  (`test-case-1.0.0.schema.json:80`) was already correct; all 65 regex patterns
  across the eleven files compile. `schema_registry` now raises `SchemaLoadError`
  naming the file and its parse position, collects every offending file instead of
  dying on whichever one `sorted()` reached first, and `GET /health` reports
  `schema_registry.{count, compiled, errors}` - it previously hashed the raw bytes
  without ever parsing them, which is exactly why it stayed green while every upload
  endpoint was broken.
* **The registry stays strict on purpose.** One unparseable schema still fails every
  artifact set, not only the sets that reference it: a partially built registry would
  let a `$ref` go unresolved and quietly validate less than it claims to. What
  changed is that the failure names the culprit, not that it tolerates one.

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
* **Nothing on a request path may pay a Mongo timeout, and nothing may pay one
  more than once.** `deps.get_db` is I/O-free by design; index creation lives in
  the start-up reconciler. Putting *any* server round trip back into a FastAPI
  dependency multiplies it by however many collections, retries or dependencies sit
  behind it - that is precisely how one 3 s budget became 37 s. If a new
  dependency needs to check the server, it belongs in `mongo_status()` (one ping,
  bounded, never raises) or in the reconciler, not in `get_db`.
* **`mongo_schema.ensure_indexes` must keep re-raising `ConnectionFailure` and
  swallowing everything else.** Both halves are load-bearing: swallow the transport
  failure and the cost is per-collection again; re-raise the collection-local
  conflict and one legacy index costs the other ten collections theirs.
* **Staging is deleted on success only.** Do not add a `finally`, and do not add a
  sweeper that deletes staging directories by age - the one that survives a failed
  commit is the recovery evidence (departure 20).
* **The lint gate is `ruff.toml`, not a ruff default.** Do not lint with
  `--isolated` or with an ad hoc `--select`: that is exactly how rounds 1 and 2
  produced 0 findings and 148 findings for the same code. Install
  `requirements-lint.txt` and run `ruff check` over the six application
  directories. Widening `select` is a task with a verification pass attached, not
  a config edit.
* **The Mongo timeouts in `db.py` must not go back to defaults.** 30 s server
  selection against a 10 s client read timeout is how a stopped datastore became a
  bare `Read timed out` with no cause named. Any new value must stay comfortably
  below the slowest client's read timeout.
* **Do not invent a second error shape.** Build bodies with
  `error_envelope.envelope(...)` or raise `HTTPException` and let the central
  handler normalise it. A fourth shape would be worse than the three that were
  there. And do not rename `blob_storage_unavailable`.
* **Amended N1's accepted set is a decision, not an oversight.** Widening it to
  lists or tables breaks the convergence guarantee (there is no way for the JSON
  path to reproduce a flattened table), and narrowing it back to `<br/>` alone
  un-parses the acceptance fixture. If it must change, change
  `xhtml_text.BLOCK_ELEMENTS`/`INLINE_ELEMENTS` and re-run the convergence test -
  the two vendored fixtures are the evidence.
* **`system_states` order is normalised, not preserved.** If a new array field ever
  needs the same treatment, put its order in `canonical.py` next to
  `SYSTEM_STATE_ORDER` so both upload paths share one rule; a second copy is how the
  five-requirement divergence happened in the first place.
* **A trace's `publish_state` is the only thing that says the extraction request was
  actually sent.** Do not fold it into `ingest_status`, and do not drop the
  republish-on-re-upload path: it is the entire recovery story for a broker outage.
