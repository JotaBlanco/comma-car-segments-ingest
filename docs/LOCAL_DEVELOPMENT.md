# Local development and demo stack

This is the architecture and operating manual for `docker-compose.yml` at the repo
root: what it runs, what it deliberately does not run, and the exact command
sequence from an empty machine to a seeded demo.

It exists because the cloud environment cannot currently run this system
end to end:

- the testrig **Storage Gateway is unreachable**, so no deployment may carry
  `blobStorage: {bind: true}`; in the cloud every blob-backed endpoint answers
  503 naming that cause. Locally the blob seam's `local` backend makes the whole
  artifact half work for real (`backend-api/blob_storage.py`,
  `LocalBlobBackend`);
- the environment has **not been synced**, so `mf4-extractor`,
  `test-vectors-sink`, `tm-evaluator` and `mongo-writer` exist in no Quix
  environment. Docker is the only place they run at all;
- the plant in `C:\repos\acc_project` produces real MF4 files and this backend
  claims to ingest and evaluate them. This stack is where those two meet.

---

## 1. Quick start

```bash
# 1. core: MongoDB + backend-api + frontend. A working UI, nothing else needed.
./scripts/dev.sh up

# 2. add the broker and the four stream services (MF4 ingest, events, Mongo sink)
./scripts/dev.sh up stream

# 3. seed the demo: real requirements, baseline, run, three real MF4 traces
./scripts/dev.sh seed
```

Plain Compose, if you prefer it:

```bash
docker compose --env-file .env.local up -d                        # core
docker compose --env-file .env.local --profile stream up -d       # + broker + streams
docker compose --env-file .env.local --profile tools up -d        # + Redpanda Console
```

| what | URL |
| --- | --- |
| Frontend (Streamlit) | <http://localhost:8501> |
| Backend API | <http://localhost:8000> |
| OpenAPI docs | <http://localhost:8000/docs> |
| Backend health | <http://localhost:8000/health> |
| Dynamic Config Manager | <http://localhost:8002> (profile `stream`) |
| Redpanda Console | <http://localhost:8080> (profile `tools`) |
| MongoDB | `localhost:27017` (user `admin`) |
| Kafka from the host | `localhost:19092` (profile `stream`) |

---

## 2. Why it is layered this way

The stack is a core plus additive profiles rather than one flat `up`, for one
reason: **the demo must survive a failure in an optional part.** MongoDB,
`backend-api` and `frontend` are the demo. The broker and the stream services
extend it. If Redpanda will not pull, or a QuixStreams service crash-loops, the
UI is unaffected because nothing in the core depends on them.

Compose starts a profiled service when a non-profiled service `depends_on` it,
which would quietly defeat the layering, so **no core service declares a
dependency on a profiled one.** `backend-api` is handed the broker address
unconditionally instead. With no broker running:

- everything artifact-shaped works: uploads, versions, diffs, baselines, runs,
  the registry, readiness, reports;
- exactly two endpoints fail, with a 503 that names the cause -
  `POST /uploads/traces` and `POST /test-runs/{id}/evaluate` - because they
  publish (`backend-api/topics.py`, `EventBusUnavailableError`).

`Quix__Broker__Address` is what points every QuixStreams application at
Redpanda. It needs no code change: `Application()` falls back to that variable
when neither `broker_address` nor a Quix SDK token is given
(`quixstreams/app.py:258`, `quixstreams/platforms/quix/env.py:13`). The four new
services additionally read `KAFKA_BOOTSTRAP_SERVERS` themselves (for example
`mf4-extractor/main.py:270`); `backend-api/topics.py:67` and
`dynamic-config-manager/main.py:42` construct `Application()` with no address at
all, so for them the environment variable is the only route.

### Profiles

| profile | adds | why it is opt-in |
| --- | --- | --- |
| (none) | `mongodb`, `backend-api`, `frontend` | the demo core |
| `stream` | `redpanda`, `redpanda-init`, `dynamic-config-manager`, `mf4-extractor`, `tm-evaluator`, `mongo-writer` | needs a broker; heavier build (asammdf, numpy) |
| `tools` | `redpanda-console` (+ broker) | topic inspection UI, not needed to demo |
| `lakehouse` | `test-vectors-sink` | **cannot work locally**; see section 6 |

---

## 3. Service inventory

| service | image / build context | host ports | depends on | healthcheck |
| --- | --- | --- | --- | --- |
| `mongodb` | build `./mongodb` (mongo:8.0.21 + `init.sh`) | 27017 -> 27017 | - | `mongosh ping` (authenticated) |
| `backend-api` | build `./backend-api` | 8000 -> 80 | `mongodb` healthy | `urllib` GET `/health` |
| `frontend` | build `./frontend` | 8501 -> 80 | `backend-api` healthy | `urllib` GET `/_stcore/health` |
| `redpanda` | `redpandadata/redpanda:v24.2.7` | 19092 -> 19092 | - | `rpk cluster health` |
| `redpanda-init` | same image, one-shot | - | `redpanda` healthy | - (runs to completion) |
| `dynamic-config-manager` | build `./dynamic-config-manager` | 8002 -> 80 | `redpanda-init` completed, `backend-api` healthy | `urllib` GET `/health` |
| `mf4-extractor` | build `./mf4-extractor` | - | `redpanda-init` completed | none (stream worker, no endpoint) |
| `tm-evaluator` | build `./tm-evaluator` | - | `redpanda-init` completed, `backend-api` healthy | none |
| `mongo-writer` | build `./mongo-writer` | - | `redpanda-init` completed, `mongodb` healthy | none |
| `redpanda-console` | `redpandadata/console:v2.7.2` | 8080 -> 8080 | `redpanda` healthy | none |
| `test-vectors-sink` | build `./test-vectors-sink` | - | `redpanda-init` completed | none, `restart: "no"` |

`lakehouse-sink` and `mongo-backup-manager` are not in the compose file. Both are
blob-bound cloud services (`quix.yaml` keeps `blobStorage.bind: true` on them)
with nothing to do in a local stack; `lakehouse-sink` consumes the legacy
`test-data-uploads` topic, which nothing in the new chain produces.

### Broker choice

**Redpanda**, single node, `--mode dev-container`. One container and one process;
no ZooKeeper and no KRaft cluster-id bootstrap step to get wrong; `rpk` ships in
the same image, so topic creation and the healthcheck need no extra tooling. It
speaks the Kafka protocol that librdkafka - and therefore QuixStreams - expects,
which is the only property this stack needs from a broker. Two listeners are
advertised: `redpanda:9092` for containers, `localhost:19092` for host tools.

`redpanda-init` creates the 13 topics `quix.yaml` declares with the same
partition counts and retentions, plus `report-requests` and
`unit-test-requests`, which `backend-api/settings.py` (`topic_names()`) can name
but `quix.yaml` does not declare. Topic auto-creation is on in dev-container
mode, but it would give every topic one partition, and the partition count is
part of the design: vector topics are keyed by `trace_key` so per-trace ordering
survives four partitions.

### Volumes

| volume | mounted at | holds |
| --- | --- | --- |
| `mongo_state` | `mongodb:/app/state` | the mongod dbpath (`/app/state/mongodb-v2`) |
| `blobstore` | `backend-api:/app/blobstore`, `mf4-extractor:/app/blobstore` | the local blob store: artifact versions, baselines, trace objects, reports |
| `extractor_state` | `mf4-extractor:/app/state` | QuixStreams state (dedupe of already-extracted traces) |
| `evaluator_state` | `tm-evaluator:/app/state` | QuixStreams state (readiness, one request per run version) |
| `redpanda_data` | `redpanda:/var/lib/redpanda/data` | the broker log |

`mongodb` must have a volume at `/app/state`: `mongodb/init.sh` refuses any
dbpath outside that mount and fails fast if the mount is absent, because
container-local storage is discarded on restart.

The `blobstore` volume being mounted at the **same path in two containers** is
what makes the ingest chain work locally. `backend-api` writes the MF4 object,
`mf4-extractor` reads it back. Two Quix deployments cannot share a filesystem,
which is exactly the caveat `mf4-extractor/blob_seam.py` states in its
docstring; one Docker volume removes it.

---

## 4. Environment variables

Every value below is either a literal in `docker-compose.yml` or a knob in
`.env.local` whose default in the compose file is the same value. Variable names
come from the applications' own `.env.example` files and from `quix.yaml`;
nothing is invented, and there is no secret in the stack (no Quix SDK token, no
blob credential, no lakehouse token).

| service | variables it needs | where the local value comes from |
| --- | --- | --- |
| `mongodb` | `MONGO_INITDB_ROOT_USERNAME`, `MONGO_INITDB_ROOT_PASSWORD`, `MONGO_DBPATH` | `mongodb/app.yaml` defaults; `.env.local` `MONGO_USER`/`MONGO_PASSWORD`; dbpath fixed at `/app/state/mongodb-v2` as in `quix.yaml` |
| `backend-api` | `MONGO_HOST/USER/PASSWORD/DB_NAME`, six topic names, `TM_BLOB_BACKEND`, `TM_BLOB_LOCAL_ROOT`, `TM_MAX_UPLOAD_BYTES`, `Quix__Lakehouse__Query__*`, `Quix__Broker__Address` | `backend-api/.env.example` + `quix.yaml`; blob backend forced to `local` with the root on the shared volume; lakehouse variables intentionally empty |
| `frontend` | `BACKEND_API_URL` | `frontend/.env.example`, pointed at `http://backend-api:80` |
| `dynamic-config-manager` | `output`, `BACKEND_API_URL`, `Quix__Broker__Address` | `dynamic-config-manager/.env.example` + `quix.yaml` |
| `mf4-extractor` | `input`, four `output_*`, `output_completed`, `CONSUMER_GROUP`, `AUTO_OFFSET_RESET`, `COMMIT_EVERY`, `COMMIT_INTERVAL`, `TM_BLOB_*`, `Quix__Broker__Address` | `mf4-extractor/.env.example` + `quix.yaml`; blob backend `local` on the shared volume |
| `tm-evaluator` | `input_evaluation_requests`, `input_trace_completed`, `BACKEND_API_URL`, `CONSUMER_GROUP`, `AUTO_OFFSET_RESET`, `COMMIT_*`, `Quix__Lakehouse__Query__*`, `Quix__Broker__Address` | `tm-evaluator/.env.example` + `quix.yaml`; query URL empty (no local lake) |
| `mongo-writer` | five `input_*`, `MONGO_*`, `CONSUMER_GROUP`, `AUTO_OFFSET_RESET`, `BATCH_SIZE`, `COMMIT_INTERVAL`, `Quix__Broker__Address` | `mongo-writer/.env.example` + `quix.yaml` |
| `test-vectors-sink` | four `input_*`, `BATCH_SIZE`, `AUTO_DISCOVER`, `CATALOG_NAMESPACE`, `MAX_WRITE_WORKERS`, `Quix__BlobStorage__Connection__Json`, `Quix__Lakehouse__Catalog__*`, `Quix__Workspace__Id` | `test-vectors-sink/.env.example`; the last four are **empty locally and it cannot start without them** |

`Quix__Sdk__Token` is set nowhere. That is deliberate: a token would make
QuixStreams try to resolve a Quix workspace and prefix topic names, which is not
what a local broker serves.

---

## 5. What works locally, and what does not

| capability | locally? | why |
| --- | --- | --- |
| Requirements upload, ReqIF and `.reqifz` | **yes** | local blob backend; parser is pure Python |
| Requirements upload, canonical JSON | **yes** | same |
| ReqIF/JSON convergence check | **yes** | in-process comparison, no storage needed |
| Immutable artifact versions, diffs, item reads | **yes** | `LocalBlobBackend` implements the whole seam surface the artifact store uses: `open`, `exists`, `ls`, `glob`, `copy`, `size`, including the staged-commit protocol that copies payload first and `manifest.json` last |
| Test specs, test impl, signal catalogue uploads | **yes** | same |
| Baselines (integrity findings, static criteria checks, coverage) | **yes** | blob + Mongo only |
| Device / parameter-set registry | **yes** | Mongo only |
| Test runs: create, submit, attach, readiness | **yes** | blob + Mongo |
| MF4 upload to blob + trace registry row | **yes**, with `--profile stream` | needs the broker for the ingest-request publish; without it the object and the Mongo row are written and the API answers 503 naming the bus |
| MF4 extraction into ~6 400 vector rows across 4 topics | **yes**, with `--profile stream` | `mf4-extractor` reads the object off the shared blob volume; watch `dev.sh logs mf4-extractor` |
| Completion events sunk into Mongo (`traces`, `test_results`, `run_summaries`, `parameter_sets`) | **yes**, with `--profile stream` | `mongo-writer` |
| Readiness-triggered evaluation request | **yes**, with `--profile stream` | `tm-evaluator`'s second dataframe |
| Report generation (HTML/JSON, plots) into blob | **yes** | `report_service` writes through the same seam |
| **Test vectors written to the Lakehouse** | **no** | `test-vectors-sink` needs blob credentials plus an Iceberg REST catalog (`test-vectors-sink/main.py:88-113`). There is no local catalog |
| **Verdicts computed from real samples** | **no** | the evaluator reads vectors only through the Lakehouse Query API (`tm-evaluator/lake_client.py`, `run_query`), so every criterion reports `reason_code: lake_query_failed` with the cause. See section 6 |
| Deferred unit-test runner (executing a `test_impl`) | **no** | not built in this phase, in the cloud either; `evaluate_case.py` says a `trace_required: false` case must be given a manual verdict |
| Quix blob backend (`TM_BLOB_BACKEND=quix`) | **no** | needs `Quix__BlobStorage__Connection__Json` from the platform |
| Mongo backup manager, legacy `lakehouse-sink` | **no** | blob-bound cloud services, not in this compose file |

---

## 6. The evaluation hole, stated plainly

The intended chain is:

```
MF4 upload ─ backend-api ─ trace-ingest-requests ─ mf4-extractor
                                                        │
                        four test-vectors-* topics ──────┤
                                                        ▼
                                             test-vectors-sink ──► Iceberg (Lakehouse)
                                                                       │
   tm-evaluator ── Lakehouse Query API (POST /query, SQL, CSV back) ────┘
        │
        └─ per-case results ─► backend-api /internal/evaluations ─► metrics, requirement
                                                                    verdicts, report
```

Locally the two boxes on the right do not exist. Rows reach the four topics and
stop there. `tm-evaluator` therefore runs, fetches its input from the API,
queries the lake, gets `LakeUnavailableError`, and reports each trace as
`verdict: error`, `reason_code: lake_query_failed` with the cause in the note
(`tm-evaluator/evaluate_case.py`, the `except (LakeQueryError,
LakeUnavailableError)` branch). The API still computes metrics from those
results, so `GET /metrics/{run}/{version}` answers - with errors, not passes.
**A local demo cannot show a pass/fail verdict derived from real samples until
one of the options below is built.**

The options, with the code evidence:

1. **A local Query API shim (recommended).** The evaluator's only seam is one
   function: `lake_client.load_group` (`tm-evaluator/lake_client.py:158`), called
   from `evaluate_case.load_groups` (`evaluate_case.py:109`), and its endpoint is
   already environment-driven: `query_url()` reads
   `Quix__Lakehouse__Query__Url` or `QUIXLAKE_URL`
   (`lake_client.py:43-53`). The contract is small and fully specified in
   `run_query` (`lake_client.py:111-135`): `POST {url}/query`, body is raw SQL
   text, `Authorization: Bearer <token>`, response is CSV with a header row.
   Queries are always single-level `SELECT <cols> FROM <table> WHERE device_id =
   … AND scenario = … AND trace_key = … ORDER BY t_s`. A new local-only service
   that consumes the four vector topics into DuckDB and serves that one endpoint
   would give **real verdicts from the real evaluator on real MF4-derived rows,
   with zero changes to any existing service** - only two environment variables
   change. Cost: one new folder, roughly 150 lines (a QuixStreams sink plus a
   FastAPI route), and a spec deciding whether that folder is a permanent local
   fixture or throwaway.
2. **Pre-seeded results through the public API (zero code).**
   `POST /internal/evaluations` (`backend-api/routers/internal.py:133`) takes an
   `EvaluationSubmission` and hands it to `run_service.finalize_evaluation`,
   which owns the metric formulas, the requirement-verdict precedence, the blob
   archive and the outgoing topics. Hand-authored per-case results therefore
   produce **genuinely computed** metrics, coverage and requirement verdicts, and
   a real report. What is authored is the verdict itself, so this demonstrates
   the machinery and the traceability, not a judgement about the plant. It needs
   the broker (that endpoint publishes `test-results` and `run-summaries`).
3. **Teach `mf4-extractor` a local vector store** (parquet on the blob volume,
   or Mongo). This means changing `mf4-extractor/main.py` (`build_pipeline`,
   lines 280-305) *and* adding a read path in `tm-evaluator`, i.e. two services
   diverging from their cloud behaviour, with the local path untested in the
   cloud and the cloud path untested locally. Not recommended.

For Friday: demo the artifact chain, traceability and ingest for real
(option 1 if there is time to build the shim, otherwise the chain up to
`ingest_status: vectorised`), and if a verdict has to appear on screen, use
option 2 and say out loud that the verdict was submitted, not measured.

---

## 7. End-to-end walkthrough (verbatim)

`./scripts/dev.sh seed` runs exactly this and prints each call before making it.
The steps below are the same calls, to paste one at a time. `$BASE` is
`http://localhost:8000`; `$ACC` is `C:/repos/acc_project`.

Steps 1-8 need only the core. Steps 9-12 need `--profile stream`.

```bash
BASE=http://localhost:8000
ACC=C:/repos/acc_project
```

**0. Confirm the blob backend is `local`.** If this says `unavailable`, nothing
below works and the message names the reason.

```bash
curl -s $BASE/health | python -m json.tool | grep -A4 blob_storage
```

**1. Requirements as ReqIF** (the real 37-requirement export):

```bash
curl -X POST $BASE/uploads/requirements \
  -F "file=@$ACC/Reqs/export/acc-system-requirements.reqif;type=application/xml" \
  -F "uploaded_by=demo" -F "notes=ReqIF export"
# -> {"set":"requirements","version":"v0001", ...}
```

**2. The same requirements as canonical JSON** - a second immutable version, so
the Requirements page has a diff to show:

```bash
curl -X POST $BASE/uploads/requirements \
  -F "file=@$ACC/Reqs/export/json/acc-system-requirements.json;type=application/json" \
  -F "uploaded_by=demo" -F "notes=canonical JSON"
# -> {"version":"v0002", ...}
curl -s "$BASE/artifact-sets/requirements/diff?from_version=v0001&to_version=v0002"
```

**3. Prove the two paths converge** (mints nothing; `converged: false` is a
release blocker):

```bash
curl -X POST $BASE/uploads/requirements/convergence-check \
  -F "reqif_file=@$ACC/Reqs/export/acc-system-requirements.reqif" \
  -F "json_file=@$ACC/Reqs/export/json/acc-system-requirements.json"
```

**4. Signal catalogue** - 65 channels generated from the plant's own channel
table (`acc_stim/mf4/signals.py`), so every name, unit and dtype is the one the
MF4 files actually carry:

```bash
curl -X POST $BASE/uploads/signal-catalog \
  -F "file=@scripts/seed/signal-catalog.json;type=application/json" \
  -F "uploaded_by=demo"
```

**5. Test specifications** - three cases whose thresholds are quoted from the
requirements they cover (`ACC-SYS-PRF-020` 3,5 m/s² over a 2 s moving average,
`ACC-SYS-PRF-022` 2,0 m/s², `ACC-SYS-PRF-003` the 2,5 m clearance floor):

```bash
curl -X POST $BASE/uploads/test-specs \
  -F "file=@scripts/seed/test-specs.json;type=application/json" \
  -F "uploaded_by=demo"
```

**6. One test implementation.** The artifact set has to exist for a baseline to
pin it. The file is inert on purpose - the unit-test runner is deferred, and a
stub returning `pass` would be a fabricated result:

```bash
curl -X POST $BASE/uploads/test-impl \
  -F "file=@scripts/seed/acc_sys_tc_001.py;type=text/x-python" \
  -F "tc_id=ACC-SYS-TC-001" -F "entrypoint=acc_sys_tc_001.py" \
  -F "language=python" -F "uploaded_by=demo"
```

**7. Baseline.** Dry-run first: it reports the integrity findings without
consuming an id. Expect ~34 `uncovered_requirement` warnings (three cases cover
three requirements) and zero errors:

```bash
PIN='{"requirements_version":"v0002","test_specs_version":"v0001",
      "test_impl_version":"v0001","signal_catalog_version":"v0001",
      "label":"local demo baseline","created_by":"demo"}'
curl -X POST $BASE/baselines/dry-run -H 'Content-Type: application/json' -d "$PIN"
curl -X POST $BASE/baselines      -H 'Content-Type: application/json' -d "$PIN"
# -> 201 {"baseline_id":"BL-0001", ...}
```

**8. Device, device version, run.** The trace upload requires a registered
`(device_id, sw_version, hw_version)`; the values below come from the MF4
sidecars in `$ACC/Data`. No `config_id` is pinned, so no provenance check runs:

```bash
curl -X POST $BASE/devices -H 'Content-Type: application/json' -d '{
  "device_id":"acc-plant-sim-01","name":"ACC plant simulation 01",
  "kind":"plant-sim","description":"acc_stim plant, MF4 writer 0.2.0"}'

curl -X POST $BASE/devices/acc-plant-sim-01/versions \
  -H 'Content-Type: application/json' -d '{
  "sw_version":"acc_stim-0.2.0","hw_version":"plant-sim",
  "plant_spec_ref":"dev-planning/acc-plant-mf4/spec.md (rev 2)",
  "tool_name":"acc_stim","tool_version":"0.2.0","asammdf_version":"8.8.9",
  "make_current":true}'

curl -X POST $BASE/test-runs -H 'Content-Type: application/json' -d '{
  "baseline_id":"BL-0001","device_id":"acc-plant-sim-01",
  "device_sw_version":"acc_stim-0.2.0","device_hw_version":"plant-sim",
  "scope":{"kind":"by_test_case",
           "tc_ids":["ACC-SYS-TC-001","ACC-SYS-TC-002","ACC-SYS-TC-003"]},
  "label":"local demo run","created_by":"demo"}'
# -> 201 {"test_run_id":"TR-20260818-001", ...}

curl -X POST $BASE/test-runs/TR-20260818-001/submit   # freezes the plan
```

**9. Upload three real MF4 files** (needs `--profile stream`; each is ~40-60 s of
plant data, one per test case). The upload attaches the trace to the case in the
same call:

```bash
curl -X POST $BASE/uploads/traces \
  -F "file=@$ACC/Data/lead_brake_3mps2/lead_brake_3mps2__v100__f8aeb2756729.mf4" \
  -F "device_id=acc-plant-sim-01" -F "sw_version=acc_stim-0.2.0" \
  -F "hw_version=plant-sim" -F "test_run_id=TR-20260818-001" \
  -F "tc_ids=ACC-SYS-TC-001" -F "uploaded_by=demo"

curl -X POST $BASE/uploads/traces \
  -F "file=@$ACC/Data/cruise_set_speed/cruise_set_speed__v100__9a10ca54c894.mf4" \
  -F "device_id=acc-plant-sim-01" -F "sw_version=acc_stim-0.2.0" \
  -F "hw_version=plant-sim" -F "test_run_id=TR-20260818-001" \
  -F "tc_ids=ACC-SYS-TC-002" -F "uploaded_by=demo"

curl -X POST $BASE/uploads/traces \
  -F "file=@$ACC/Data/follow_steady_timegap/follow_steady_timegap__tau08__80c3cb927293.mf4" \
  -F "device_id=acc-plant-sim-01" -F "sw_version=acc_stim-0.2.0" \
  -F "hw_version=plant-sim" -F "test_run_id=TR-20260818-001" \
  -F "tc_ids=ACC-SYS-TC-003" -F "uploaded_by=demo"
```

A 503 here means the broker is not running: `./scripts/dev.sh up stream`.

**10. Watch the extraction.** Each trace becomes ~6 400 rows across the four
vector topics plus one completion event:

```bash
./scripts/dev.sh logs-f mf4-extractor
curl -s $BASE/test-runs/TR-20260818-001/readiness   # ingest_status per trace
# with profile tools: rpk from inside the broker container
docker compose exec redpanda rpk topic list
docker compose exec redpanda rpk topic consume test-vectors-pt-can-100hz -n 1
```

**11. Trigger the evaluation** (asynchronous - the API only publishes):

```bash
curl -X POST $BASE/test-runs/TR-20260818-001/evaluate \
  -H 'Content-Type: application/json' -d '{"trigger":"manual","requested_by":"demo"}'
# -> 202
./scripts/dev.sh logs tm-evaluator
```

**12. Read the metrics and the requirement verdicts:**

```bash
curl -s $BASE/metrics/TR-20260818-001/1 | python -m json.tool
curl -s $BASE/requirement-verdicts/TR-20260818-001/1 | python -m json.tool
```

Locally, expect `tc_error: 3` and every criterion carrying
`reason_code: lake_query_failed` - the vectors are on the topics but nothing can
query them. That is section 6, not a bug.

---

## 8. Demo seed data

`scripts/seed/` holds the three artifacts the walkthrough needs that do not
already exist anywhere:

| file | provenance |
| --- | --- |
| `signal-catalog.json` | 65 entries generated from `acc_stim/mf4/signals.py`: names, units, dtypes and rasters are the plant's. `role` is an authored classification (SIM_REF -> `reference`, driver/road/other-object channels -> `stimulus`, validity/ID/status/enum channels -> `diagnostic`, everything else -> `response`). Units are rewritten from the plant's `m/s²` to `m/s^2`, the form `backend-api/units.py` parses |
| `test-specs.json` | three cases. Requirement ids, methods and every numeric threshold are quoted from the real ReqIF; the criteria, windows and reductions are authored, and each case's `notes` says so. `ACC-SYS-TC-003` deliberately asserts only the 2,5 m floor of `ACC-SYS-PRF-003`, not its time-gap product term, which needs a derived signal |
| `acc_sys_tc_001.py` | an implementation that returns `not_run` / `runner_deferred` rather than a verdict |

Requirements are **not** seeded from a file in this repo: the real exports in
`$ACC/Reqs/export/` are used directly, both the ReqIF and the canonical JSON.

Re-running the seed script is safe but not idempotent: every upload mints a new
immutable version and a new run. Nothing is ever deleted. `./scripts/dev.sh
clean` is the reset, and it removes the Mongo data and the whole blob store.

---

## 9. Operating notes

```bash
./scripts/dev.sh status              # containers + the URL list
./scripts/dev.sh logs backend-api    # last 100 lines
./scripts/dev.sh logs-f mf4-extractor
./scripts/dev.sh shell backend-api   # bash, falling back to sh
./scripts/dev.sh rebuild stream      # after changing application code
./scripts/dev.sh down                # stop, keep data
./scripts/dev.sh clean               # stop and DELETE volumes
```

**First `up` builds eight images.** `mf4-extractor` (asammdf) and
`tm-evaluator`/`test-vectors-sink` (numpy, pyarrow) are the slow ones; the core
three are quick, which is the other reason the core is a separate layer.

**Inspecting the blob store** - it is a plain directory tree inside the volume,
with the same bucket-relative paths as the cloud:

```bash
docker compose exec backend-api ls -R /app/blobstore/test-manager | head -50
```

**Troubleshooting**

| symptom | cause and remedy |
| --- | --- |
| `/health` says `blob_storage.available: false` | `TM_BLOB_LOCAL_ROOT` not writable. Check the `blobstore` volume mount |
| Every upload answers 503 naming blob storage | same as above; the message states the cause |
| `POST /uploads/traces` answers 503 | no broker: `./scripts/dev.sh up stream` |
| mongod exits immediately, complaining about `/app/state` | the state volume is missing; `init.sh` fails fast rather than writing to container-local storage |
| Mongo authentication failures after changing `MONGO_PASSWORD` | the root user is created on the **first** start only. `./scripts/dev.sh clean`, or bump `MONGO_DBPATH` to a new directory under `/app/state` as `quix.yaml` documents |
| `mf4-extractor` logs a blob-unavailable failure and marks the trace failed | it is not sharing the `blobstore` volume - check the mount path is `/app/blobstore` in both containers |
| `test-vectors-sink` exits at once | expected. See section 6 |
| Streamlit shows a blob 503 on Requirements | the backend is running without the local blob root; the page prints the cause it was given |

---

## 10. Relationship to the cloud deployment

The compose file is a mirror of `quix.yaml`, not a second design: the same topic
names, the same partition counts and retentions, the same variable names, the
same service names. Two differences are deliberate and both are visible in the
compose file:

1. `Quix__Broker__Address` replaces `Quix__Sdk__Token`. Locally there is no Quix
   workspace, so no topic-name prefixing and no platform-managed consumer groups.
2. `TM_BLOB_BACKEND=local` replaces the (currently impossible) `blobStorage.bind`
   plus `TM_BLOB_BACKEND=auto`. The seam is the same code path in both cases; the
   local backend is a first-class implementation, not a stub, and it exercises
   version minting and the staged-commit protocol unchanged.

Anything that behaves differently between the two is therefore either the
Lakehouse (absent locally) or the blob backend (`local` vs `quix`) - a short list
worth keeping short.
