# Test Manager API

The registry API. Built to the agreed contract in `../plans/API-CONTRACT.md` (now v1.1).
Every contract endpoint answers from **MongoDB** — the stub layer is gone. The lanes moved
the endpoints to Mongo one ticket at a time (see `../plans/BUILD-PLAN-LANES.md`); the lane
sheets under `../plans/lanes/` are the per-ticket record.

## Run it

Requires [uv](https://docs.astral.sh/uv/) and Docker Desktop (WSL2 backend).

```powershell
# 1. Set a token. Copy ..\.env.example to ..\.env, or set it in the shell:
$env:TM_API_TOKEN = "pick-a-long-random-string"

# 2. Start the API with reload (PowerShell / Git Bash):
.\scripts\dev.ps1
./scripts/dev.sh

# Or start the whole system in Docker (from the repo root):
docker compose -f docker-compose.local.yml up
```

Every `/api/v1` call needs `Authorization: Bearer <TM_API_TOKEN>`.
`/health` and `/ready` are open. Interactive docs: `http://localhost:8010/docs`
for the local stack, or the port you set in `TM_API_PORT`.

## The platform identity check

The static token proves that somebody holds a string. It names nobody, so the
`actor` on every write is a claim the client typed. One variable turns on a real
check against the Quix platform, and **the platform injects that variable**:

```powershell
$env:Quix__Portal__Api = "https://portal-api.dev.quix.io"
```

- **Unset — the demo path.** Nothing changes. The static token is the only key,
  and this process asks nobody. The local stack runs on this path, because
  `docker-compose.local.yml` sets the name and leaves the value empty.
- **Set — the platform path.** The static token still works, and it is still
  tried first, so the demo never breaks. A token that is not the static one goes
  to the Quix platform, which names the caller. **Every Quix deployment takes
  this path**, because Portal injects `Quix__Portal__Api` into every deployment
  (`DeploymentService.cs:2173`).

**Set `Quix__Workspace__Id` as well.** The check then also proves that the
caller may use that workspace. Unset, the check proves identity only, so any
live Quix token on the whole platform passes. The API logs one warning at the
first such request, so an operator can see it. The platform injects both names
into every workspace deployment (`DeploymentService.cs:2170,:2173`).

**The name changed on 19 Aug 2026.** This module read our own
`TM_QUIX_PORTAL_URL` until then, so that a deployment never turned the new path
on with nobody deciding. Nobody ever set it, and the front-end proxy meanwhile
started to prefer the viewer's Portal token, so a signed-in viewer would get 401
on every screen (`../plans/design/DEPLOYED-AUTH-DIAGNOSIS.md` section 9). The
backend lead ended the switch. `api/quix_identity.py` holds the full history.

`Quix__Workspace__Id` carries a second duty. It also leads every blob key this
service writes — read "Blob keys carry the workspace folder" below.

What the platform path costs and what it buys:

| | Static token | Platform check |
|---|---|---|
| Calls per new token | 0 | 1, or 2 with a workspace |
| Calls per repeat token | 0 | 0 for a minute, then 1 |
| The actor on a write | the client's claim | a user id the platform proved |
| The journal | a record of a string holder | an audit record |

`api/quix_identity.py` holds the calls and cites the platform source for each
one. It copies what `Quix.Auth.Middleware` does in .NET
(`QuixAuthenticationHandler.cs:79-97`) and what QuixLake, DevSessions and the
first Test Manager do in Python. Two Portal traps are written down there, with
tests: the permission parameter is `permission` and not `permissions`, and a
denial answers 200 with the body `false`.

Failures fail closed and never fall back to a pass:

- The platform refuses the token: **401** `unauthorized`, with the same body the
  contract already states. The reason stays out of the body, because "the caller
  may not use this workspace" would confirm that the token itself is good.
- The platform does not answer: **503** `platform_unavailable`. A 401 would say
  the token is bad, which we do not know, and a 200 would let an unproven
  caller write.

## The two compose files

| File | What it does | Use it for |
|---|---|---|
| `docker-compose.local.yml` | **Runs** a QuixLake, MongoDB, the API, the planning mock, the front end and a one-shot seed. Every value carries a default. | Development, and integration tests that need a lake. |
| `docker-compose.yml` | **Points at** a QuixLake somebody else runs. It hard fails without a lake URL and a lake token. | The demo, and the PR build. |

The local stack runs its own QuixLake, so **the query screens (Explore and the
per-signal statistics) read a real lake there**. The run-detail Signals tab does
not: it reads the numbers the ingestion pipeline measured, and it says so. It pulls two pinned lakehouse images from a private
registry, so run `az acr login --name quixcontainerregistry` once first.

**`../docs/LOCAL-STACK.md` is the one place that holds the command.** It also
holds the ports, the rebuild rule, the reset, the checks, the limits and the
test-harness seam. This file does not repeat the recipe.

## Test it

```powershell
.\scripts\test.ps1        # or: ./scripts/test.sh, or: uv run --all-groups pytest
```

- The harness starts one `mongo:7` testcontainer per session. Run `docker pull mongo:7` once first.
- If antivirus kills the Ryuk cleanup container, set `TESTCONTAINERS_RYUK_DISABLED=true`
  and clean up containers by hand.
- Lint: `uv run ruff check .`

**The suite runs in parallel.** `pyproject.toml:61` sets `addopts = "-n auto"`, so
pytest-xdist spreads the run over every core. That took the suite from 10h31m down
to about 5 minutes on 20 Aug 2026. Pass `-p no:xdist` when you debug one test and
you need the output in order.

**Measured 21 Aug 2026 at tip `74bb164`: 2472 passed, 4 skipped, 0 failed.** The command is
`uv run --all-groups pytest -n 4 tests`. The figure before it, 2084 passed and 4 skipped on
20 Aug 2026, is history. Two files were red for days and both are fixed:
`tests/test_explore_seed_sql.py` stopped testing anything when `buildSeedSql()` gained a
parameter, and `tests/test_fixtures_inventory.py` counted a journal entry that commit `796118f`
moved from the run onto the result.

## The schema is always open

`/docs` and `/openapi.json` answer on every environment. A `TM_ENV` switch closed
them until 20 Aug 2026, and the switch is gone — a reviewer needs the schema more
than an attacker gains from it. Evidence: `api/main.py:44`, `tests/test_docs_gate.py`.

## Files carry a lifecycle, a stage status and a version

Three route families landed on 20 Aug 2026. Each one journals its write.

| Route | What it does | Requirement |
|---|---|---|
| `PATCH /files/{id}` | Changes `sync_status`, `upload_status`, `conversion_status` and `stage_error`. `POST /files` sets them first. | FR-DM-006b |
| `DELETE /files/{id}` | Soft delete. It never removes bytes. | FR-DM-040 |
| `POST /files/{id}/archive` | Archives the file. | FR-DM-040 |
| `POST /files/{id}/restore` | Restores an archived or a soft-deleted file. | FR-DM-040 |
| `POST /files/{id}/versions` | Registers a new version. It sets `version`, `supersedes` and `version_group`. | FR-DM-103 |
| `GET /files/{id}/versions` | Lists the version group. | FR-DM-103 |

`lifecycle` is a separate field from `status` (`api/routers/files.py:146` `_lifecycle`).
**The retention purge empties the recycle bin** (24 Aug 2026, FR-DM-042). A file
that stays `deleted` for `TM_FILE_RETENTION_DAYS` days loses its registry record:
the `files` document and its `file_signals` rows go, and its run re-derives
`file_count`. The pass writes a `file.purged` journal event **before** it removes
the record. **It still deletes no byte** — the stored object stays and the storage
layer owns it — and it never touches a quarantined file, because the never-drop
rule keeps a file the registry could not place. `TM_FILE_RETENTION_DAYS=0` turns
the pass off. An in-process worker runs it every hour
(`api/services/retention.py`), so no route and no scheduler is involved.

Evidence: `api/routers/files.py:181,346,382,422,498,612`;
`tests/test_files_stage_status.py`, `tests/test_files_lifecycle.py`,
`tests/test_files_versions.py`, `tests/test_files_retention.py`.

## Blob keys carry the workspace folder

`Quix__Workspace__Id` leads every blob key this service builds:

| Key | Builder |
|---|---|
| `{workspace}/test-manager/results/{run}/{uuid}-{name}` | `api/services/file_writes.py` `result_blob_key` |
| `{workspace}/test-manager/landing` | `ingest/store.py` `default_blob_prefix` |

SAG reads the first folder under the bucket as the workspace. The Portal grants
a deployment ReadWrite under that folder and Read on everything else, so a key
that misses the folder matches the read grant alone and the `PUT` answers 403.
See `../plans/reference/LAKE-STORES.md` section 9.9.

Outside a deployment the name is unset and both keys stay bare, which is what a
test and a local store want. `docker-compose.local.yml` sets the name on `api`,
`seed` and `file-bytes`, so the local stack builds the deployed key shape and
can no longer hide this fault. `TM_BLOB_PREFIX` still overrides the landing
prefix.

The demo seed states each file's `storage_ref` through the same rule
(`ingest/store.py` `stamp_workspace`), and `ingest/blob_seed.py` writes the bytes
at that key. So the reference and the bytes always name one key, and the
download route opens the reference it holds. **It never guesses a second key.**

The seed states its one processed result the same way. It calls `result_blob_key`
(`seed/fixtures_inventory.py` `_stamp_results`), so the seeded reference names
the key an upload would write. No bytes lie behind that key, because the contract
gives a result no download route.

## Statistics need QuixLake

QuixLake is the default statistics provider. Set these variables before you run the API:

- URL: `Quix__Lakehouse__Query__Url`, or `QUIX_LAKE_URL` as the fallback.
- Token: `Quix__Lakehouse__Query__AuthToken` first, then `Quix__Sdk__Token`. The
  lakehouse bind writes the first name (`LakehouseSinkBindInjector.cs:219`). The
  Portal injects the second into every workspace-scoped deployment
  (`DeploymentService.cs:2180-2183`), so it always holds a value.
- Table: `TM_LAKE_TABLE`, default `test_signal_samples`.
- Permission to drop that table: `TM_SEED_MAY_DROP`. `seed --reset` drops the
  table it names itself. It refuses to drop a table `TM_LAKE_TABLE` points it
  at, because another writer may own it, unless `TM_SEED_MAY_DROP` names that
  exact table. A refusal skips the lake step and the Mongo reset still runs.

`API_AUTH_TOKEN` is absent from that list on purpose. It is the lake service's own
shared secret. It passes authentication by string equality and carries no user
identity, so the lake's read gate filters the data to nothing. The query then answers
200 with zero rows and reports no error. Never add the name back.

An unset URL breaks `GET /signals/{name}/stats` and the Explore queries. It does
NOT break `GET /test-runs/{run_id}/signals`: that route reads the registry alone
since 21 Aug 2026, so it holds its 200 with no lake at all. No route falls back
to Mongo numbers for a lake question, on purpose. `docker-compose.yml` therefore
refuses to start without the URL and the token, and it prints the missing name.
`docker-compose.local.yml` needs neither name: it starts its own QuixLake and it points
the API at `http://lake-query:80`.

**There is no lake-free path for a lake question, and no switch.**
`TM_STATS_PROVIDER=mongo` was the opt-out until 20 Aug 2026, and it could make the
demo's "computed lakeside" caption lie. The switch is gone and it must not come
back. A lake this service cannot reach answers 503 `lake_unavailable` on every
route that asks it, and it never invents a number.

**The run-signals list asks no lake question — DECIDED 21 Aug 2026.** The
`mf4-stats` stage measures the four numbers, `tm-connector` posts them and this
service stores them on `file_signals`, so that list reads them straight back. A
signal nobody measured lists blank, and the envelope states how much of the run
the pipeline measured. One lake outage can no longer cost a person the whole
Signals tab.

## The run key comes in on the wire

The ingestion pipeline resolves the run key. This service never opens a measurement
file. The pipeline sends the key on `POST /files`, and this service takes it as a
claim, not as a fact.

An unknown run key quarantines the file at the API door. `api/api/routers/files.py`
holds that order, so a bad resolution can never forge a link. The file still lands in
the registry, so the never-drop rule holds.

**A quarantine raises an alert** (24 Aug 2026, FR-DM-004). The channel is a
structured WARNING log line, `QUARANTINE ALERT file=... reason=...`, because no SMTP
host and no webhook URL reaches this deployment. A cluster log rule reads the line and
the Home needs-attention panel counts the files. The alert runs AFTER the file and its
journal entry land, and it swallows its own failure, so a broken channel loses the
alert and never the file (`api/services/alerts.py`).

`TM_RUN_KEY_PATTERN` belongs to the pipeline. Set it there. This service reads no such
variable.

**History.** `api/ingest/watcher.py` and `api/ingest/mf4.py` owned the three-step
resolution — manifest `test_id`, then the file header, then the filename — until
19 Aug 2026. The team moved that code to the ingestion pipeline in the demo repository.
See `plans/design/INGEST-SPLIT.md`.

## The contract snapshot

`docs/openapi.v1.json` is committed and the FE generates types from it.
`tests/test_contract_snapshot.py` fails when the app drifts from it.
A shape change goes: contract file first, then `scripts/snapshot.ps1` (or `.sh`),
both in the same commit. Never hand-edit the snapshot.

## v1.1 switches — applied

The team accepted contract v1.1 on **Mon 17 Aug 2026**. The three switches are applied:
`Source` now ships `api:catalogue`, the model field is `catalogue_ref`, and `RequestModel`
uses `extra="forbid"`, so every write body rejects an unknown field with 422.
~~The other v1.1 changes (results replay, the download route) are route behavior, not model
shape — they land with their milestones.~~ That line was wrong about the download route. Results
replay is route behavior, not model shape. It lands with its ticket. The download route is
de-scoped: ticket B-04 decided Option B on 17 Aug 2026, so the API exposes no download route. We
show a link to the SAG blob explorer instead. See `../plans/design/FILE-DOWNLOAD.md` (section
"Outcome") and the decisions table in `../plans/STATUS.md`.

## The `tm` command line

FR-DM-107 asks for the same metadata through three interfaces: the UI, the API
and a CLI. `cli/tm.py` is the third one. It is a thin client over the same
routes, so it runs no query of its own and it adds no dependency.

```bash
# The address and the token both come from the environment.
export TM_API_URL=http://localhost:8000
export TM_API_TOKEN=...            # tm asks at a terminal when this is empty

uv run tm runs --status complete   # a table for a person
uv run tm run TAS-88214            # one run and its metadata
uv run tm files --run TAS-88214
uv run tm signals --unit rpm
uv run tm search "rig-7"
uv run tm runs --output json       # the API body, unchanged, for a script
uv run tm runs --output csv > runs.csv   # a spreadsheet, or a pipe
```

There is no `--token` option, and there never will be one. A command line
lands in the shell history and in the process list.

`--output json` prints the API body without touching it. That is how the CLI
proves the second acceptance clause: every interface serves one structure.

`--output csv` writes the same columns the table shows, and it keeps the rules
of the server export (`api/services/exports.py`): RFC 4180 quoting, UTF-8, and
an empty value written as an empty field. A grouped command prints
`value,count`. The rows go to standard output, so a person pipes them to a
file (FR-DM-095).

## Layout

- `cli/tm.py` — the `tm` command line. `pyproject.toml` declares the console
  script, so `uv run tm` works. The wheel ships this package only.
- `api/main.py` — app factory; registers **all** routers on day 1; frozen after the base.
- `api/auth.py`, `api/errors.py`, `api/settings.py`, `api/models/common.py` — frozen; BE lead only.
- `api/quix_identity.py` — the platform identity check behind `Quix__Portal__Api`;
  frozen with `auth.py`. It reads its own environment variables, the way
  `api/services/lake.py` does, so it changes neither `settings.py` nor `main.py`.
- `api/db.py`, `tests/conftest.py` — shared; append only inside your lane's marked region.
- `api/stub_data.py` — the test-factory cast. No route reads it; the test factories
  (`tests/factories.py`, `factories_planning.py`, `factories_signals.py`) and the golden-request
  fixtures do. `api/stub_state.py` is deleted, along with the conftest fixture that reset it.
- `api/provenance.py` — Lane A owns it. The real body landed on 17 Aug 2026 (commit `05fc67f`).
  It enforces write precedence `manual > api:* > embedded`. `set_field` returns `None` when
  precedence blocks a write, so a caller must test the return before it uses the entry.
- Lane ownership and the seam table: `../plans/BUILD-PLAN-LANES.md` §3–4.

## Rules that never bend

- No token or secret in a file, a URL or a log line. Environment variables only.
- Never weaken a validation, an auth check, a journal write or the provenance gate.
- Contract-first: `../plans/API-CONTRACT.md` changes before any code shape does.
