# Run a definition — a button that produces the verdict

**Status:** Draft
**Project:** comma-car-segments-ingest
**Branch / HEAD:** `jama-ui-dev` @ `db88268`
**Created:** 2026-09-23
**Planned with:** Buddy
**Backlog:** builds `BL-11` (run the ten implementations and write verdicts) and answers the
runner half of `BL-37`. It is the **writer** `dev-planning/test-results-page/spec.md` §2.3 names
as missing. It unblocks `BL-19` / `BL-24` by producing the first `verdict` document this estate
has ever held. It deliberately does **not** build `BL-40` (`/runs/{id}/execute`, `/status`,
`/summary`) or `BL-41` (reports) — §8 says why.

The user's sentence:

> *"I need buttopn to run it, n ot to go directly to quixlab"*

Today the only affordance on a test definition is **Download** (`implementation-panel.tsx:66-79`)
and, on a run, **Open in a tab / Embed here** for QuixLab (`quixlab-panel.tsx:170-206`). Both hand
the work to a person. Nothing in this estate has ever executed a stored `.py`, so
`processed_results` holds zero documents with a `verdict` key.

---

## 1. What "Run" means

**One question, answered for one pair:** *did test case `TC` pass against the data of run `R`?*

A person opens a test definition or a test run, presses **Run** on a row that names the other
half of the pair, and within seconds the row reads `PASS`, `FAIL` or `ERROR` with the measured
numbers beside it. Behind the button: the registry fetches that definition's stored `.py` out of
blob, executes its `evaluate(run_id, table)` against the run's rows in QuixLake, and stores the
answer as one `processed_results` document carrying the shipped `verdict` block. The verdict is
the artefact; the button is only its trigger.

**What it is not.** It is not "execute the run" — a run is a trace that was recorded on a bench
long ago and is never re-executed. It is not a notebook session: QuixLab stays exactly where it
is, for the interactive work of *figuring out why* a verdict came out the way it did. The button
removes the human from the **repeatable** half only: fetch the file, call one function, record
what it said.

---

## 2. Where the code executes

### 2.1 The decision

**In the `api/` container, in a short-lived child process, synchronously inside the request.**

Three things decide it, and all three are facts about what is already deployed:

1. **`api/` already holds every input the runner needs, and nothing else does.** The
   implementation bytes (`FileBytesProvider.open(blob_path)`, the same call
   `download_implementation` makes at `test_definitions.py:966`); the lake credentials
   (`Quix__Lakehouse__Query__Url` / `QUIX_LAKE_URL` and `Quix__Lakehouse__Query__AuthToken` /
   `Quix__Sdk__Token`, `lake.py:32-43`) — **the identical four names the generated module reads
   at `implementations.py:62-63`**, so a child process inherits the parent environment and needs
   no new binding; the run's table (`test_runs.lake_table`, `api/api/models/runs.py:229`); the
   definition mirror; and the verdict writer (`results._store_result`). `numpy` is already in the
   runtime image (`pyproject.toml:63`, installed by `uv sync --group ingest`, `Dockerfile:37`).
   A separate service would have to be given all of that again.
2. **The work is seconds, not minutes, and it is not a stream.** One evaluation is one HTTP
   query to QuixLake plus one numpy reduction. There is no Kafka topic anywhere in this path —
   the lake is read over HTTP (`implementations.py:75-89`, the same shape as `lake.py:160-171`).
   `dev-planning/test-results-page/spec.md` §2.3 already recorded this: **no QuixStreams
   primitive applies here and none is being avoided.** A request topic would be a topic invented
   to carry a request that already has an HTTP route in front of it.
3. **The implementations are ours.** They are generated from
   `battery-trace-gen/seed/implementation_cases.py` by a template in this repo
   (`implementations.py:28-162`) and uploaded by our own seed. This is not third-party code and
   the problem is not sandboxing.

### 2.2 The trade-off accepted, stated plainly

**Accepted: an implementation can consume the API deployment's CPU and memory while it runs.**
The `Test Manager - API` deployment is capped at cpu 1000 / memory 1000 (`quix.yaml:87-90`), and
that budget is now shared with whatever `evaluate()` allocates. A module that reads a very large
run can make the registry slow for everyone using it at that moment. That is the price of not
operating a second deployment, and at ten modules over four traces it is the right price.

**Blast radius of a bad implementation: one child process.** The evaluation never runs in the
API's own interpreter. `verdict_runner` spawns `sys.executable -m api.services.verdict_child`,
so a module that segfaults, exhausts memory or calls `sys.exit()` kills a child and leaves the
API serving. A module that writes to the filesystem writes into the temp directory the parent
made and the parent removes. It inherits the lake token — which it already needs to read the
lake, and which it already had when a person ran the same file in QuixLab.

**A hang is bounded by `EVALUATION_DEADLINE_SECONDS = 180`**, enforced by
`subprocess.run(..., timeout=…)`, which kills the child. The number is derived, not chosen from
the air: the generated module gives its own lake call 120 s (`TIMEOUT_SECONDS`,
`implementations.py:64`, the same value as `lake.TIMEOUT_SECONDS`, `lake.py:23`), so any deadline
at or below 120 s would kill a query the module is still legitimately waiting on. 180 s leaves
the lake its full budget and 60 s for the process start and the reduction. A kill produces an
`error` verdict (§5.3), never a hung request.

**This is why a thread was rejected.** A Python thread cannot be killed; `asyncio.to_thread` plus
a timeout abandons the work and the thread keeps running and keeps holding memory. A child
process is the only bound that actually bounds. `run_deletion.py:201` already uses a pool of
workers inside this API, so a subprocess is not a new kind of thing here.

### 2.3 The two rejected options, briefly

| Option | Why not |
|---|---|
| **A separate Quix service on a request topic** (the old `tm-evaluator` shape, `BL-37`) | A new deployment, a new image, a new topic and a new lakehouse/blob binding, to carry a request that is already one HTTP call. It also makes the button fire-and-forget: the page could then only learn the outcome by polling for a result document, so the UI cost goes **up** while the isolation gain is one container boundary. If a customer ever needs a queue of thousands of evaluations, this is the shape to move to — and the verdict document does not change when it does, so the move is free later and expensive now. If it is ever built: `Application` + `app.topic` + `sdf.group_by(test_run_id)` + `State`, never a hand-rolled consumer loop. |
| **A QuixLab kernel driven over its API** | It is the thing the user asked to stop going to. It needs a live kernel, a session, an upload and an output-parsing contract, and it fails in ways ("the kernel died", "the session expired") that have nothing to do with the test case. |

### 2.4 The one dependency this adds

**`requests` is not in the runtime image and the generated modules import it**
(`implementations.py:47`). `uv.lock` carries `requests` 2.34.2 (`uv.lock:1440-1441`) only as a
dependency of `docker` (`uv.lock:530`), which arrives with `testcontainers` in the **dev** group
(`pyproject.toml:46`); the project's own `requires-dist` names `httpx` and not `requests`
(`uv.lock:1544-1552`), and the image builds with `--no-dev` (`Dockerfile:37`). So today a child
process would die on `import requests`.

**Fix: add `requests>=2.34.2` to `api/pyproject.toml`'s `dependencies`** (the version already
resolved in `uv.lock:1441`) and re-lock. One line.

**Do not instead rewrite the generator to use `httpx`.** That would change the bytes of all ten
modules, therefore all ten sha256 digests, therefore the blob key of each
(`file_writes.py:147`), therefore `test_definitions.implementation.sha256` on all ten definitions
— and every verdict pins that digest (`api/api/models/results.py:96-98`). A one-line dependency
is cheaper than re-seeding the artefact every verdict cites.

---

## 3. The trigger and its contract

### 3.1 One route

```
POST /api/v1/test-runs/{run_id}/definitions/{td_id}/evaluate
```

Body: **none**. Everything the evaluation needs is addressed by the two path segments (§4.3).
Answer: **201** with the stored result — the shipped `ResultBody`
(`api/api/models/results.py:125-142`), whose `verdict` block carries the outcome. The caller gets
the verdict in the same response as the trigger; there is no second read.

It lives in `api/api/routers/test_runs.py`'s neighbourhood but in its own module,
`api/api/routers/verdicts.py`, registered in `main.py`'s router tuple (`main.py:587-605`), so it
inherits the `/api/v1` bearer dependency (`main.py:586`) like every other route.

**It is synchronous and it is a plain `def`.** FastAPI runs a non-async route in its threadpool,
so a 4-second evaluation never blocks the event loop and never delays another request's response.
Every route in this API is already a plain `def`.

**No job id, no `/status`, no polling, no progress stream.** A single evaluation is bounded at
180 s (§2.2), well inside what the ingress tolerates — the ingress problem
`run_deletion.py:70-73` records is a *minutes*-long request, which this never is. The whole-set
case is ten of these calls made one at a time by the browser (§7), so no request is ever longer
than one evaluation. Introducing a job store, a job collection and a poll loop to avoid a
four-second wait would be the heaviest part of this feature and it would buy nothing.

### 3.2 Refusals

| Code | Status | When |
|---|---|---|
| `run_not_found` | 404 | the registry holds no such run — the code `GET /test-runs/{run_id}` already answers (`main.py:289`) |
| `td_not_found` | 404 | the mirror holds no such definition (`test_definitions.py:185`) |
| `implementation_not_found` | 404 | the definition carries no `.py` (`test_definitions.py:961`) |
| `storage_unreachable` | 503 | blob did not answer, so nothing ran and nothing was stored (`test_definitions.py:968`) |
| `version_conflict` | 409 | inherited from `_store_result` (`results.py:510-512`) |

These five go into `main.py`'s refusal map (`main.py:230-314`) as the route's entry.

**There is deliberately no refusal for a definition the run does not carry.** `test_runs`
records `definition_ids`, and a pair outside that set is still a *real* evaluation: the module
genuinely ran against that run's rows and the numbers it measured are genuine. Refusing it would
be the registry asserting a judgement about which questions a person may ask of their own data.
The UI only ever offers linked pairs (§6), so this path is reached by a person who typed it on
purpose.

**There is no refusal for a lake that is down.** See §5.3: every failure inside the child becomes
an `error` verdict. One rule, no classification tree.

### 3.3 The sequence

```
POST .../{run_id}/definitions/{td_id}/evaluate
  ->  routers/verdicts.py
        read test_runs[run_id]                            404 run_not_found
        read test_definitions[td_id]                      404 td_not_found
        implementation = definition["implementation"]     404 implementation_not_found
  ->  services/verdict_runner.evaluate_pair(db, run, definition, identity)
        bytes_provider.open(implementation["blob_path"])  503 storage_unreachable
        write the bytes to a temp dir
        subprocess.run([sys.executable, "-m", "api.services.verdict_child",
                        <path>, run_id, table],
                       capture_output=True, timeout=180)
  ->  services/verdict_child.py   (a separate interpreter)
        import the module by path
        answer = module.evaluate(run_id, table)
        print(json.dumps(answer))
  ->  back in verdict_runner
        parse stdout            -> outcome = answer["verdict"].lower()
        non-zero / timeout /
        unparsable stdout       -> outcome = "error"
        remove the temp dir
  ->  results._store_result(db, ResultCreateRequest(...), identity)
        mints version N+1, sets supersedes, writes the journal entry
  ->  201  ResultBody (verdict inside)
```

### 3.4 Where the code goes

| File | What |
|---|---|
| `api/api/routers/verdicts.py` | the one route, the three reads, the five refusals |
| `api/api/services/verdict_runner.py` | fetch the bytes, spawn the child, turn its answer into a `ResultCreateRequest`, call `results._store_result` |
| `api/api/services/verdict_child.py` | the child entry point: load one module by path, call `evaluate`, print one JSON object |
| `api/pyproject.toml` + `api/uv.lock` | `requests>=2.34.2` (§2.4) |

Nothing in `results.py`, `test_definitions.py`, `queries_requirements.py` or `planning_sync.py`
is modified. The verdict is written **through** the shipped `POST /results` code path, not beside
it, so the version chain, the replay rule, the provenance gate and the journal entry all hold
without being re-implemented.

---

## 4. What the implementation is handed

### 4.1 The entry point, quoted

From `battery-trace-gen/seed/implementations.py:147-161`, the template every one of the ten
modules is rendered from:

```python
def evaluate(run_id, table="battery_data_v1"):
    """Answer one verdict for one run.

    `table` is the lake table that holds the run's samples. The registry records
    it per run as `lake_table`, so a run outlives a table bump with its pointer
    intact.
    """
    history, times, dt_s = _history(run_id, table)
    evidence = _measure(history, times, dt_s)
    return {
        "tc_id": TC_ID,
        "run_id": run_id,
        "verdict": "PASS" if _passed(evidence) else "FAIL",
        "evidence": evidence,
    }
```

The name is not hard-coded by the runner: the definition document records it, as
`implementation.entrypoint`, defaulting to `"evaluate"`
(`IMPLEMENTATION_ENTRYPOINT`, `test_definitions.py:802`, written at `:892`). The runner calls
`getattr(module, implementation["entrypoint"])`.

### 4.2 The whole input surface is two strings

| Argument | Where the runner gets it |
|---|---|
| `run_id` | the path segment, which is `test_runs._id` |
| `table` | `test_runs.lake_table` (`api/api/models/runs.py:229`), which `tm-connector` claims on every run from the `LAKE_TABLE` project variable (`quix.yaml:184-185`). When a run carries none, the API's own `TM_LAKE_TABLE` (`quix.yaml:115-118`) stands in, through the reader `queries_stats._lake_table()` that `explore_query.py:56` already calls. |

**Nothing else is passed, and no parameters are read from the registry.** Every number each
module enforces is baked into its own `LIMITS` dict at generation time — that is the stated rule
at `implementation_cases.py:11-12` (*"the uploaded `.py` carries its own limits and needs no
catalogue to read them"*) — and the `BMS_State` encodings are module constants
(`implementations.py:175-179`, values from `implementation_cases.py:22`). So the runner never
resolves a parameter, never reads `battery-dc-parameters.json`, and cannot make a module measure
against a limit other than the one its bytes state. The digest therefore pins the *whole*
decision, not half of it.

### 4.3 How it reads the lake — no CTEs, no `DESCRIBE`

The module reads the lake **itself**; the runner hands it no client and no connection. It POSTs
one flat statement to `{base}/query?union_by_name=true` with the SQL as a `text/plain` body and a
bearer token, and parses the CSV answer (`implementations.py:75-89`) — byte for byte the
interface `api/api/services/lake.py:160-171` uses.

The statement, from `implementations.py:93-99`:

```sql
SELECT ts_ms, signal, value FROM <table>
 WHERE run_id = '<run_id>'
   AND signal IN ('BMS_T_Batt', ...)
 ORDER BY ts_ms
```

That is one `SELECT`, one `WHERE`, one `IN` list, one `ORDER BY`. **No CTE, because there is
nothing to name twice**, and **no `DESCRIBE`, because the column set (`ts_ms`, `signal`, `value`)
and the signal names are both constants in the module** — `SIGNALS` is rendered at generation
time from the test case (`implementation_cases.py:42-273`). The long-format table needs no schema
introspection: a signal the run does not carry simply returns no rows, which
`_history` turns into `LookupError(f"run {run_id} carries none of {missing} in {table}")`
(`implementations.py:119-121`).

The pivot to a common raster happens in the module, not in SQL: `searchsorted` holds each CAN
signal at its last value at or before each grid instant (`implementations.py:111-132`), because
interpolating would invent a bus state that never existed. This is the reason the reduction is
numpy in a process and not a query — and it is why `numpy` must stay in the API image.

### 4.4 What the child returns to the runner

The child prints exactly the dict above as one JSON object on stdout. The runner maps it:

| From the module | To the verdict |
|---|---|
| `verdict: "PASS"` / `"FAIL"` | `outcome: "pass"` / `"fail"` — **lowercased**; the model is `Literal["pass","fail","error"]` (`api/api/models/results.py:94`) |
| `evidence: {...}` | `evidence` verbatim. The keys already match `battery-trace-gen/out/manifest.csv`'s `measured` column by construction (`implementation_cases.py:4-7`), so expected and achieved compare key for key with no mapping |
| `tc_id` | `provenance.tool`, and cross-checked against nothing — see §5.2 |
| `run_id` | ignored; the stored `run_id` is the path segment |
| a raise, a non-zero exit, a timeout, unparsable stdout | `outcome: "error"` (§5.3) |

---

## 5. The verdict written

### 5.1 It is the document `test-results-page/spec.md` §2.2 already defines

**No field is renamed, no collection is added and the `Verdict` model is not redesigned.** The
runner produces exactly what that spec's §2.2 describes: one `processed_results` document with
`result_key = "verdict/<definition_id>"` and a `verdict` block of
`definition_id` / `outcome` / `evidence` / `implementation_sha256`
(`api/api/models/results.py:84-98`). Read that section for the field-by-field table; this section
states only what **this** spec adds.

The body the runner POSTs through `_store_result`:

| Field | Value |
|---|---|
| `run_id` | the path segment |
| `result_key` | `f"verdict/{td_id}"` |
| `name` | `f"{td_id} verdict"` |
| `description` | `test_definitions.title` |
| `storage_ref` | `None` — the numbers ride in the block |
| `provenance.tool` | `td_id` |
| `provenance.tool_version` | `f"sha256:{sha[:12]}"` |
| `provenance.parameters` | `f"impl={blob_path}; table={table}; run_id={run_id}"` — the **inputs**, and nothing the run produced |
| `provenance.input_file_ids` | the run's registered file ids |
| `provenance.produced_by` | `"verdict-runner"` |
| `provenance.produced_at` | the moment `evaluate` returned |
| `verdict.definition_id` | `td_id` |
| `verdict.outcome` | §4.4 |
| `verdict.evidence` | §4.4 |
| `verdict.implementation_sha256` | `test_definitions.implementation.sha256` |

`provenance.input_file_ids` matters and is not decoration: `_store_result` marks a result
`provenance_status: "flagged"` when it names no input file at all (`results.py:479-482`), so a
verdict that skipped them would arrive permanently flagged. The runner lists the run's registered
files, which is what `_unresolved` checks against (`results.py:385-395`).

### 5.2 What this spec pins

**`implementation_sha256` is copied, never recomputed.** The upload route took the digest over
the very chunks it wrote to blob (`_read_digest_within_cap`, `test_definitions.py:809-831`, used
at `:868` and `:881`), so `implementation.sha256` and the object at `implementation.blob_path`
describe the same bytes by construction. The runner reads that path and stamps that digest. It
does not re-hash and it does not compare — a re-hash would be a check against a mismatch the
write path cannot produce.

**`definition_version` is written `None`.** `test-results-page/spec.md` §2.2 adds the field and
OQ2 there recommends shipping it now, written null, so that a verdict written before `BL-34`
lands is not permanently unpinnable. `test_definitions` carries no `item_version` today
(`requirements` does, `api/api/models/requirements.py:113`; the TC half of `BL-34` is not built),
so there is nothing true to write. The pin stays `implementation_sha256`, which is what the
shipped fold already reads (`queries_requirements.py:196-204`).

**`criterion` is written `None`.** That spec's §2.2 wants the `pass_criteria[].criterion_id`
(`C1`, `C2`, … — `battery-trace-gen/specs/battery-dc-test-specs.json:43`) that the outcome turned
on. **`evaluate()` does not return one.** `_passed(evidence)` collapses every criterion into one
boolean (`implementations.py:140-144`), so the information does not exist at the moment the
verdict is made, and nothing downstream can reconstruct it. Filling it means changing the
template — which changes ten digests and re-seeds ten definitions (§2.4's argument, again). **OQ2
recommends leaving it null until the generator changes for some other reason.**

**No duration field is added.** `provenance.produced_at` is the timing, exactly as
`test-results-page/spec.md` §2.2 states (*"the evaluated timestamp. No second field."*). The
browser timed its own request and shows the elapsed seconds beside the row; nothing downstream
asks how long a verdict took, and a stored duration would be a number with no reader.

### 5.3 Failure is a verdict, not an HTTP error

**Every failure inside the child produces `outcome: "error"` and a stored document.** A raise —
`LookupError(f"run {run_id} carries none of {missing} in {table}")` at `implementations.py:121`
is the one the ten modules can actually throw — a non-zero exit, a killed-at-the-deadline child,
or stdout that is not JSON: all four land on `error`. `evidence` then carries one key the runner
chooses, `{"error": "<ExceptionType>: <message>"}`, with the last line of the child's stderr as
the message. `evidence` is an open `dict` on the shipped model
(`api/api/models/results.py:95`), so this needs no model change.

Two consequences, both deliberate:

- **The button never answers 500 for anything the implementation does.** A person who presses Run
  always gets an answer and always gets a record of what happened.
- **`error` is not a failure and must never render as one** — the rule
  `test-results-page/spec.md` §6.3 already sets: amber, never red. A lake outage that produced ten
  amber rows is re-run when the lake is back, and version N+1 supersedes each.

The runner does **not** classify the failure. Telling a lake outage from a bad query means reading
the exception's message, and that is the diagnostic machinery this project's rules exist to
refuse. One rule: it did not decide, so it says it did not decide.

### 5.4 A re-run mints a new version — the shipped code already decides this

`_fingerprint` hashes the whole request body including `provenance.produced_at`
(`results.py:370-373`). Two evaluations therefore never fingerprint alike, so the replay branch
(`results.py:485-486`) is never taken and every Run mints **version N+1 with `supersedes` set to
the previous `result_id`** (`results.py:492-493`). The fold reads the highest version
(`db.py:165`). Nothing is overwritten, the history of a definition's verdicts is complete, and a
person who re-runs after a fix sees the new answer immediately.

This is the answer to *"new document, or supersede"*: **both, and it costs no new code.**

---

## 6. The UI

Two screens, one control, the same route behind it. **Nothing is removed**: `Download` stays on
the implementation panel and the whole QuixLab panel stays on the run.

### 6.1 The Test definition page

`frontend/components/screens/definitions/definition-detail-screen.tsx`.

The panel *"Test runs under this definition"* (`:256-316`) already lists every run that carries
this definition, with `run_id`, rig, arrival, files, signals and status. It gains:

- **one `Verdict` column**, and **one `Run` button per row**. The pair is the row; no picker and
  no dialog is needed, because the row already names both halves.
- **`Run all` in the `PanelHead` action** (beside the existing `N recorded · M planned` count),
  which walks the rows one at a time (§7).

The Verdict cell reads, by state: `—` (never run) · a spinner and `Running…` · a green `PASS` /
red `FAIL` / amber `ERROR` chip with the elapsed seconds and, on hover, the `evidence` as
`key: value` pairs · `Failed to start` for a 4xx/5xx from the route itself. Glyph plus tone plus
`aria-label`, never colour alone — the rule `requirements-page/spec.md` §5.4 sets.

The **Implementation panel** (`implementation-panel.tsx`) is not the place for the button: it
knows the `.py` but not which run to run it against. It gains one sentence under the meta grid —
*"Run this against a run from the table below, or open it in QuixLab from that run."* — and
nothing else.

### 6.2 The Test Run page

`frontend/components/screens/run-detail/definitions-panel.tsx` — *"Test definitions this run
covers"*, which already lists `td_id`, title and status for every id in `run.definition_ids`.
Same two additions: a `Verdict` column with a `Run` button per row, and `Run all` in the panel
head beside the `N covered` count.

Its empty state (`:96-101`) already says a run with no definitions has none to run, and stays.

### 6.3 Errors

- **A refusal from the route** (§3.2) renders in the row's Verdict cell, with `ApiError.detail`
  as the text — the idiom `implementation-panel.tsx:29-32` already uses. No toast, because the
  failure belongs to one row.
- **An `error` verdict** is not an error of the button. It renders as an amber `ERROR` chip whose
  hover text is `evidence.error`. The row is a successful trigger with an undecided outcome.
- `implementation_not_found` is the one refusal worth pre-empting: when
  `definition.implementation` is null the button renders **disabled** with the title *"No
  implementation is stored for this definition."* The panel already knows this
  (`implementation-panel.tsx:42-49` draws its own empty state from the same field).

### 6.4 Client plumbing

| File | What |
|---|---|
| `frontend/lib/api/testRuns.ts` (or `results.ts`) | `evaluateDefinition(runId, tdId)` → `api.post<ResultBody>(…)` |
| `frontend/lib/hooks/use-results.ts` | `useEvaluateDefinition(runId)` — a `useMutation` that, on success, invalidates `keys.results.all` and `keys.runs.detail(runId)`, exactly as `usePatchResult` does (`use-results.ts:53-62`) |
| `frontend/types` | no new response type: the answer is the existing `ResultBody` |

### 6.5 What replaces "go to QuixLab"

Nothing replaces it — it is **demoted from the only path to the second path**. The QuixLab panel
keeps its picker, its tab and its frame (`quixlab-panel.tsx`). The run page simply now answers
*"did it pass?"* without it, and QuixLab answers *"why?"* when it did not.

---

## 7. Running all ten

**Four clicks.** `Run all` on each of the four run pages, or equivalently `Run all` on each of
the ten definition pages — the same ten pairs either way, because our seed is one test case per
requirement and each trace carries its own definitions (`CLAUDE.md`'s test-case table).

**`Run all` is a browser loop over the single route, one call at a time.** No batch route, no
server-side fan-out, no job. Reasons, in order of weight:

1. Ten sequential calls means no request is ever longer than one evaluation, so the ingress
   never sees a long-running request (§3.1).
2. The person watches rows resolve one by one instead of waiting on a silent aggregate.
3. One failure stops nothing: the loop continues and that row carries its own state.
4. Two children at once would share the API's 1000 MB (§2.2). One at a time keeps the registry
   responsive while the set runs.

The button reads `Running 3 of 10…` while it walks, and each row settles as its call returns. A
second press while it is walking is ignored — the button is disabled for the duration, which is
the whole of the concurrency design.

**The demo, and its oracle.** Expected outcomes come from `battery-trace-gen/out/manifest.csv`
and the test-case table in `CLAUDE.md`. Nothing here is invented; the `measured` column of the
manifest is what `evidence` must reproduce key for key:

| Run | Definition | Expected | Evidence keys `evaluate` returns |
|---|---|---|---|
| TAS-1001 | BAT-SYS-TC-001 | **PASS** | `min_i_dc_a`, `limit_a`, `margin_a` |
| TAS-1001 | BAT-SYS-TC-002 | **PASS** | `max_law_error`, `max_limit_excess_a`, `min_derating_fct` |
| TAS-1001 | BAT-SYS-TC-003 | **FAIL** | `max_degc=61.2`, `limit_degc=60`, `dwell_above_limit_s=151.3` |
| TAS-1002 | BAT-SYS-TC-004 | **PASS** | `soc_drop_pct`, `integrated_drop_pct`, `error_pct` |
| TAS-1002 | BAT-SYS-TC-005 | **PASS** | `min_v`, `max_v`, `lower_limit_v`, `upper_limit_v` |
| TAS-1002 | BAT-SYS-TC-006 | **FAIL** | `max_abs_error_pct=7.15`, `at_soc_tech_pct=25`, `at_t_s=1380.3` |
| TAS-1003 | BAT-SYS-TC-007 | **PASS** | `delta_start_v`, `delta_end_v`, `end_over_start`, `max_increase_v`, `balancing_s` |
| TAS-1003 | BAT-SYS-TC-008 | **FAIL** | `t_sleep_entry_s=900`, `budget_s=600`, `error_v_at_budget=2.43` |
| TAS-1004 | BAT-SYS-TC-009 | **PASS** | `max_power_error_w`, `dwell_state_0_s`, `dwell_state_1_s`, `dwell_state_2_s` |
| TAS-1004 | BAT-SYS-TC-010 | **FAIL** | `min_degc=3`, `limit_degc=5`, `time_below_min_s=279.2`, `violation_s=272.5` |

**6 PASS, 4 FAIL, and each failure from its own declared mechanism.** The run ids are the ones
registered in jamaui (`CLAUDE.md` `BL-09`). This is the acceptance test of the whole feature: if
the ten verdicts do not match this table, either the runner or the lake contents are wrong, and
the `evidence` numbers say which.

**No estate-wide "Run everything" button is proposed.** The only screen that spans the estate is
the Test Results page, and `test-results-page/spec.md` §7 already ruled that a report screen must
not be the one place in the app where reading triggers work. OQ6 revisits it.

---

## 8. What this depends on

Ordered. Each line states what exists without it.

| # | Item | Status at `db88268` | Without it |
|---|---|---|---|
| 0 | `POST /test-definitions/{td}/implementation` and its download (`test_definitions.py:834-1000`) | **shipped** | — the prerequisite, and it is met |
| 0 | the ten `.py` modules in blob, one per definition | **shipped** (`BL-07`) | — |
| 0 | the `verdict` block and `_store_result` (`models/results.py:84-98`, `results.py:455-535`) | **shipped** | — |
| 0 | `numpy` in the API image (`pyproject.toml:63`, `Dockerfile:37`) | **shipped**, for the ingest fixtures | the child cannot import the module |
| 0 | the lake variables on the API deployment (`lake.py:32-43`, `quix.yaml:127`) | **shipped** | the child cannot reach the lake |
| 1 | **`requests>=2.34.2` in `api/pyproject.toml` + a re-lock** (§2.4) | **not there** | the child dies on `import requests`. **This is the first thing to do and it is one line.** |
| 2 | **`verdict_child.py` + `verdict_runner.py` + the route** (§3.4) | not built | nothing evaluates |
| 3 | **the two panels' Run buttons** (§6) | not built | the route works from `curl` and the demo is a shell loop |
| 4 | `BL-38` / the Test Results page (`dev-planning/test-results-page/spec.md`) | not built | the verdicts land and the rollup that renders them does not exist. **This spec's output is that page's input** — building them in either order is fine, and building this one first is what makes that page non-empty on the day it ships |
| 5 | `BL-34`'s TC half (`item_version` on `test_definitions`) | not built | `definition_version` writes null (§5.2) |
| 6 | `BL-47` — no UI assigns a definition to a run | not built | a run whose `definition_ids` is empty shows no rows to Run on its own page. All four of ours claimed theirs at upload, so the demo is unaffected; the definition page's run table is the other way in regardless |
| 7 | `BL-40` — `/runs/{id}/execute`, `/status`, `/summary`, `/series` | not built, and **not built here** | a server-side batch needs a job store, a status route and a poll loop — every part of the machinery §3.1 declines. If a customer later needs to evaluate thousands of pairs, that is the moment for `BL-40` and for §2.3's topic service, and the verdict document does not change |
| 8 | `BL-41` — rendered reports | not built | the CSV export on the Test Results page is the artefact |

**If this is split, ship rows 1 + 2 first.** The route alone, verified with `curl` against the
four real runs, reproduces the 6 PASS / 4 FAIL table and closes `BL-11`. The buttons (row 3) are
the user's actual request and follow immediately, but they are a second, disjoint change in a
different tree — which matters while four workstreams are live.

---

## 9. Open questions

1. **OQ1 — Synchronous, or a job id?**
   **Recommended: synchronous, one pair per call, no job id.** An evaluation is seconds and is
   bounded at 180 s; the whole set is ten short calls the browser makes in turn. A job store, a
   status route and a poll loop would be more code than the runner itself. Revisit only when a
   single evaluation genuinely outgrows a request — and the signal for that is a real customer
   trace, not our four.
2. **OQ2 — Does `criterion` get filled now?**
   **Recommended: no — write null.** `evaluate()` collapses the criteria into one boolean
   (`implementations.py:140-144`), so filling it means changing the template, which changes ten
   sha256 digests, ten blob keys and the pin every future verdict cites (§2.4). Fill it the next
   time the generator changes for another reason, and carry the null in the meantime exactly as
   `definition_version` does.
3. **OQ3 — Is 180 s the right deadline?**
   **Recommended: yes, and as one module constant with no environment override.** It is the
   module's own 120 s lake timeout (`implementations.py:64`) plus 60 s for process start and the
   numpy reduction. Anything at or below 120 s kills a query the module is still waiting on. An
   env var here would be a dial nobody turns.
4. **OQ4 — Does an infrastructure failure write an `error` verdict, or refuse?**
   **Recommended: write the verdict.** One rule for every failure inside the child (§5.3). The
   alternative — inspecting the exception to decide whether to store — is the classification
   machinery this project refuses, and it would make the same lake outage produce a stored record
   on one path and none on another. An `error` verdict is honest, renders amber, and is
   superseded by the re-run.
5. **OQ5 — `requests` in the API, or `httpx` in the generator?**
   **Recommended: `requests` in the API.** One line in `pyproject.toml` against re-generating,
   re-hashing, re-uploading and re-seeding ten modules whose digests are the pin of every verdict
   (§2.4). If the generator is ever rewritten for another reason, switching it to `httpx` then
   and dropping the dependency is the tidy end state.
6. **OQ6 — Is there an estate-wide "Run everything"?**
   **Recommended: no, not now.** `Run all` per run is four clicks for the whole battery set, and
   the only estate-spanning screen is a report that must not trigger work
   (`test-results-page/spec.md` §7). Revisit when a work order holds more runs than a person
   wants to click — and the natural home then is the work-order page, not the report.
7. **OQ7 — Should a `(run, definition)` pair the run does not claim be refused?**
   **Recommended: no refusal** (§3.2). The module really did run against that run's rows, so the
   verdict is real evidence and not a mistake to be prevented. The UI never offers such a pair.
   Reconsider only if `BL-47` lands a linking UI and a person starts producing these by accident.

---

## 10. Sanity print

### 10.1 The entry-point signature, quoted

`battery-trace-gen/seed/implementations.py:147` and its docstring at `:36`:

```python
def evaluate(run_id, table="battery_data_v1"):
    # -> {"tc_id": str, "run_id": str, "verdict": "PASS" | "FAIL", "evidence": {...}}
```

The name is read from `test_definitions.implementation.entrypoint`, whose default is
`"evaluate"` (`api/api/routers/test_definitions.py:802`).

### 10.2 Click to stored verdict, in order

```
 1. person presses Run on the (TAS-1001, BAT-SYS-TC-003) row
 2. POST /api/v1/test-runs/TAS-1001/definitions/BAT-SYS-TC-003/evaluate
 3. routers/verdicts.py   test_runs["TAS-1001"]                       404 run_not_found
 4.                       test_definitions["BAT-SYS-TC-003"]          404 td_not_found
 5.                       .implementation.blob_path / .sha256         404 implementation_not_found
 6.                       table = run.lake_table  ->  battery_data_v1
 7. verdict_runner        bytes_provider.open(blob_path)              503 storage_unreachable
 8.                       write the bytes to a temp dir
 9.                       subprocess.run([python, -m api.services.verdict_child,
                            <path>, "TAS-1001", "battery_data_v1"], timeout=180)
10. verdict_child         import the module by path
11.                       evaluate("TAS-1001", "battery_data_v1")
12.                         _history -> _series -> POST {lake}/query?union_by_name=true
                              SELECT ts_ms, signal, value FROM battery_data_v1
                               WHERE run_id = 'TAS-1001' AND signal IN ('BMS_T_Batt')
                               ORDER BY ts_ms
13.                         _measure -> {"max_degc": 61.2, "limit_degc": 60,
                                         "dwell_above_limit_s": 151.3}
14.                         _passed  -> False
15.                       print JSON {"tc_id": "...", "run_id": "...",
                                      "verdict": "FAIL", "evidence": {...}}
16. verdict_runner        parse stdout; "FAIL" -> "fail"; remove the temp dir
17.                       results._store_result(db, ResultCreateRequest(
                            run_id="TAS-1001",
                            result_key="verdict/BAT-SYS-TC-003",
                            name="BAT-SYS-TC-003 verdict",
                            provenance={tool, tool_version, parameters,
                                        input_file_ids, produced_by, produced_at},
                            verdict={definition_id, outcome, evidence,
                                     implementation_sha256}), identity)
18.                         -> processed_results document, version N+1, supersedes set
19.                         -> journal entry "run.result_written", context_run_id TAS-1001
20. 201 ResultBody         the row turns red: FAIL · max_degc 61.2 > limit_degc 60
```

Steps 3-5 are the only refusals; steps 10-15 failing in any way produce
`outcome: "error"` at step 16 and still reach step 20 as a 201.

---

## 11. References

- `dev-planning/test-results-page/spec.md` §2 — the verdict document this writes, field by field,
  and §2.3 which names this runner as the missing writer.
- `dev-planning/requirement-status-from-runs/spec.md` §6 — the verdict contract that shipped.
- `battery-trace-gen/seed/implementations.py:28-210` — the template, the entry point, the lake
  read; `seed/implementation_cases.py` — the ten cases, their signals, limits and pass rules.
- `battery-trace-gen/out/manifest.csv` — the 6 PASS / 4 FAIL oracle and every measured number in
  §7; `battery-trace-gen/specs/battery-dc-test-specs.json` — `pass_criteria[].criterion_id`.
- `api/api/routers/test_definitions.py:787-1000` — the implementation upload, its digest, its
  blob key and its download.
- `api/api/routers/results.py:355-535` — `_fingerprint`, `_unresolved`, `_store_result`; the
  version chain and the journal entry this reuses.
- `api/api/services/lake.py` — the `/query` interface the modules speak;
  `api/api/services/run_deletion.py:70-79, :201` — the ingress and worker-pool precedents.
- `api/pyproject.toml`, `api/uv.lock`, `api/Dockerfile` — what the runtime image does and does not
  hold.
- `quix.yaml:82-128` — the API deployment: its limits, its blob bind, its `TM_LAKE_TABLE`.
- `frontend/components/screens/definitions/definition-detail-screen.tsx`,
  `frontend/components/screens/run-detail/definitions-panel.tsx`,
  `frontend/components/screens/run-detail/quixlab-panel.tsx`,
  `frontend/components/screens/definitions/implementation-panel.tsx` — the four panels §6 touches.
- `CLAUDE.md` — the ten requirements, the ten test cases, the four traces and the run ids;
  `dev-planning/backlog.json` — `BL-11`, `BL-19`, `BL-24`, `BL-34`, `BL-37`, `BL-38`, `BL-40`,
  `BL-41`, `BL-47`.
