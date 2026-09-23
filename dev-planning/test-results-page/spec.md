# Test Results page — coverage and outcomes across every run

**Status:** Draft
**Project:** comma-car-segments-ingest
**Branch / HEAD:** `jama-ui-dev` @ `d9dd5d4`
**Created:** 2026-09-23
**Planned with:** Buddy
**Backlog:** builds `BL-38` (coverage endpoint and matrix); reads what `BL-11` / `BL-24` /
`BL-37` write; renders `BL-19` (Covered ≠ Tested) as a screen; takes a position on `BL-50`;
degrades knowingly until `BL-33` / `BL-34` land.

The user's sentence:

> *"we will also need test result page, whitch coverage of requirements, how many apssed and
> ecetra"*

---

## 1. Purpose — the one question the page answers

**"Where does this campaign stand?"** — asked once, answered in one screen: how much of the
requirement set is covered by a test case at all, how much of it has actually been exercised
against a trace, how many of those exercises passed, how many failed, and which requirements
are still holding no evidence. Every other screen in the Test Manager answers about **one**
entity — one requirement, one run, one definition. This page is the only one that answers
about the **set**, and it is the artefact a person screenshots for a status meeting or an
ASPICE reviewer. It writes nothing: every number on it is a projection of records the
registry already holds, and the page is therefore correct by construction the moment those
records change.

---

## 2. The verdict record

### 2.1 What is already shipped — read this before designing anything

`BL-24` says *"no verdict concept: results carry no pass/fail and name no definition."* **That
is out of date at `d9dd5d4`.** The verdict contract designed in
`dev-planning/requirement-status-from-runs/spec.md` §6 was **built** and is on the branch:

| Fact | Where, at `d9dd5d4` |
|---|---|
| `Verdict` request block, `VerdictOut` response block | `api/api/models/results.py:84-109` |
| `ResultCreateRequest.verdict: Verdict \| None` | `api/api/models/results.py:158` |
| `ResultBody.verdict: VerdictOut \| None` | `api/api/models/results.py:142` |
| The route stores it | `api/api/routers/results.py:498` |
| `PATCH /results/{id}` **cannot** name it — `RequestModel` is `extra="forbid"` and `ResultPatchRequest` does not list `verdict` | `api/api/models/results.py:221-236` |
| The index the fold reads | `api/api/db.py:165` — `("verdict.definition_id", 1), ("version", -1)` |
| The fold that consumes it | `api/api/services/queries_requirements.py:126-137`, `:173-221`, `:404-435` |
| The ten evaluators that would produce it | `battery-trace-gen/out/impl/BAT-SYS-TC-0NN.py`, each exposing `evaluate(run_id, table)` |

So **no new collection is proposed and no field on the existing block is renamed.** What is
missing is a *writer*: `BL-11`'s runner. Nothing has ever POSTed a verdict, so
`processed_results` holds zero documents with a `verdict` key today.

### 2.2 The document, field by field

A verdict is **one `processed_results` document carrying a `verdict` block.** Collection:
`processed_results`. One version chain per `(run_id, result_key)`; `result_key =
"verdict/<definition_id>"` by convention, and the fold reads `verdict.definition_id`, never
the key (`api/api/models/results.py:89-90`).

**Stored — the envelope (unchanged, all of it already exists):**

| Field | Type | Note |
|---|---|---|
| `_id` | `str` | minted result id; the wire calls it `result_id` |
| `run_id` | `str` | the bench session; `TAS-1001`…`TAS-1004` for our four traces |
| `result_key` | `str` | `"verdict/BAT-SYS-TC-003"` |
| `version` | `int` | mints on re-POST of the same key; the fold reads the highest |
| `supersedes` | `str \| None` | the previous version's `result_id` |
| `name` | `str` | `"BAT-SYS-TC-003 verdict"` |
| `description` | `str \| None` | the test case title |
| `storage_ref` | `str \| None` | null on a verdict — the numbers ride in the block |
| `provenance.tool` | `str` | the `tc_id` |
| `provenance.tool_version` | `str` | `"sha256:<first 12 hex>"` display form |
| `provenance.parameters` | `str` | the blob URI of the `.py`, the lake table, the run id |
| `provenance.input_file_ids` | `list[str]` | the trace files the run registered |
| `provenance.produced_by` | `str` | `"verdict-runner"` |
| `provenance.produced_at` | `datetime` | **the evaluated timestamp.** No second field. |
| `provenance_status` | `str` | `verified` / `unverified` — the registry's own tag |
| `created_at` | `datetime` | when the registry stored it |

**Stored — the `verdict` block (shipped, `api/api/models/results.py:84-98`):**

| Field | Type | Note |
|---|---|---|
| `definition_id` | `str` | the test case, e.g. `BAT-SYS-TC-003` |
| `outcome` | `Literal["pass","fail","error"]` | `error` = the evaluator could not decide. **It is never a failure** and it must never render as one. |
| `evidence` | `dict` | the measured values, keyed exactly as `battery-trace-gen/out/manifest.csv`'s `measured` column keys them — e.g. `{"max_degc": 61.2, "limit_degc": 60, "dwell_above_limit_s": 151.3}` for TC-003 (`manifest.csv` line 4) |
| `implementation_sha256` | `str` | 64 hex, the full digest of the `.py` that decided |

**Stored — two fields this spec ADDS, both optional, both null today:**

| Field | Type | Why it is not derivable |
|---|---|---|
| `definition_version` | `int \| None` | The board's `w` in *"a pass pinned to TC version `w`"* (`BL-19`). `requirements` carries `item_version` (`api/api/models/requirements.py:113`); **`test_definitions` carries none** — `BL-34`'s TC half is not built. The field is written null until it is, and the fold keeps pinning on `implementation_sha256`, which is what the shipped code already does (`queries_requirements.py:196-204`). Recording it at evaluation time is the only moment the truth is available; deriving it later is guesswork. |
| `criterion` | `str \| None` | The `pass_criteria[].criterion_id` (`C1`, `C2`, …) from `battery-trace-gen/specs/battery-dc-test-specs.json` that the outcome turned on. Null on a `pass` (every criterion held). The spec file is not in the registry, so nothing downstream can reconstruct which rule tripped. This is the *"why"* column of §6's matrix hover. |

**DERIVED — never stored on the verdict, computed on every read:**

| Value | Derived from |
|---|---|
| the requirement ids a verdict speaks to | `test_definitions.covers_req_ids` — BP5 / defect **D1**: the reverse link is never authored. A verdict that stored its own `req_ids` would go stale the next time planning re-pushes coverage, and it would fork the one link write path (`planning_sync._write_link`). |
| `work_order_id` | `test_runs.work_order_id` (and the definition's). A run's campaign can be corrected by `PATCH /test-runs/{id}`; a copy on the verdict could not follow it. |
| `current` — is this evidence still valid | `implementation_sha256` vs `test_definitions.implementation.sha256`, and `provenance.produced_at` vs `requirements.normative_changed_at` (`queries_requirements.py:196-204`, `:414-421`) |
| every count, percentage and cell on this page | §3 |

**Indexes: none are added.** `("verdict.definition_id", 1), ("version", -1)` (`db.py:165`),
`("run_id", 1), ("result_key", 1), ("version", 1)` unique (`db.py:157-160`),
`test_runs.definition_ids` (`db.py:42, :49`) and `test_definitions.covers_req_ids`
(`db.py:69`) are every access path §3's fold uses, and all four already exist.

### 2.3 Who writes it

**`BL-11`'s runner, and nothing else.** Per `(run_id, definition_id)` it downloads the `.py`
from `GET /test-definitions/{td}/implementation/download`, calls `evaluate(run_id, table)`
against the lake, and POSTs one `POST /api/v1/results`.

Two facts the runner must handle, both visible in the shipped artefacts:

1. **The case mismatch.** `evaluate()` returns `{"tc_id", "run_id", "verdict": "PASS"|"FAIL",
   "evidence": {...}}` (`battery-trace-gen/out/impl/BAT-SYS-TC-003.py:141-146`), while the
   `Verdict` model takes lowercase `pass | fail | error`. The runner lowercases. An evaluator
   that raises — `LookupError(f"run {run_id} carries none of {missing}")` at
   `BAT-SYS-TC-003.py:100` — becomes `outcome: "error"`, never `fail`.
2. **The lake read is QuixStreams-adjacent but not a stream.** The evaluators query QuixLake's
   SQL endpoint over HTTP (`BAT-SYS-TC-003.py:54-68`) — the same endpoint `api/api/services/
   lake.py` uses. There is no Kafka topic in this path, so no QuixStreams primitive applies and
   none is being avoided. **If `BL-11` instead makes the runner a streaming service** — a
   readiness trigger on run registration, the old `tm-evaluator` shape named in `BL-37` — then
   it is `Application` + `app.topic` + `sdf.group_by(test_run_id)` + `State`, never a
   hand-rolled consumer loop, and `join_lookup` for the definition/DBC enrichment. That choice
   belongs to `BL-11` and this page reads the same document either way.

---

## 3. The rollup contract

One route, one response, one round trip — the shape `home_summary` already uses
(*"Build the whole Home screen in one round trip"*, `queries_runs.py:891-896`).

### 3.1 The two units of counting, kept apart

This is the single most important line in the contract. **"How many passed" and "how many
requirements are tested" are counts of different things**, and they coincide only because our
seed is one test case per requirement, run once:

- a **requirement** is `tested` / `failed` / `exercised` / `covered` / `not_covered` — the
  five-value fold at `queries_requirements.py:173-221`;
- a **verdict** is `pass` / `fail` / `error` — one per `(run, definition)`.

A customer definition covering three requirements produces **one** fail and **three** failed
requirements. A requirement covered by three definitions is `failed` if *any* of them failed.
The response therefore carries three sibling count blocks, each labelled with its unit, and
the page prints the unit on every tile (§6.2). Merging them into one "passed" number is the
defect this section exists to prevent.

### 3.2 `GET /api/v1/coverage` — the literal response

```jsonc
{
  "summary": {
    "requirements": {            // unit: requirement
      "total": 10,               // int
      "not_covered": 0,          // int  — no test case names it
      "covered": 0,              // int  — a test case names it, nothing ran
      "exercised": 0,            // int  — a run carried it; no verdict, or an `error`
      "failed": 0,               // int  — some covering TC's newest verdict is `fail`
      "tested": 0,               // int  — every covering TC passed, and every pass is current
      "stale": 0,                // int  — rows carrying `evidence_stale: true`
      "coverage_pct": 100.0      // float, 1 dp — (total - not_covered) / total * 100; 0.0 when total == 0
    },
    "definitions": {             // unit: test definition (latest verdict of each)
      "total": 10,               // int  — every mirrored definition
      "linked": 10,              // int  — those naming at least one requirement in covers_req_ids
      "not_run": 0,              // int  — no run carries it
      "no_verdict": 10,          // int  — a run carries it, nothing judged it
      "passed": 0,               // int
      "failed": 0,               // int
      "errored": 0,              // int
      "stale_pass": 0            // int  — passed, but not `current`
    },
    "runs": {                    // unit: run (invalid-flagged runs excluded throughout)
      "total": 4,                // int
      "evaluated": 0,            // int  — at least one verdict exists for it
      "unevaluated": 4,          // int
      "verdicts": 0              // int  — newest-version verdict documents across every run
    }
  },

  "requirements": [ RequirementCoverageRow ],   // §3.3, one per requirement after filters
  "work_orders":  [ WorkOrderCoverageRow ],     // §3.4
  "runs":         [ RunCoverageRow ],           // §3.5
  "matrix":       Matrix,                       // §3.6
  "facets":       { "work_orders": ["WO-BAT-2026-001"],
                    "chapters":    ["Functional", "Performance", "Safety-Fault-Handling"],
                    "statuses":    ["Draft"],
                    "rigs":        ["..."] },   // list[str] each, whole-table, sorted ascending
  "generated_at": "2026-09-23T08:00:00Z"        // datetime — the read's own clock
}
```

**`summary` is whole-table and filter-independent**, exactly as `view_counts` is on
`GET /requirements` (`queries_requirements.py:345-352`): a filtered tile that disagrees with
what clearing the filter shows is the bug that rule already prevents. The four lists and the
matrix **are** narrowed by the filters.

**There is no pagination.** `GET /summary` is unpaginated for the same reason and states it
(`queries_runs.py:891-896`): the report is the whole answer or it is not an answer. At ten
requirements and four runs this is three bounded queries. §8 names the row count at which
`requirements[]` must start paging, and it is not near.

### 3.3 `RequirementCoverageRow`

Every field but the first four is derived; each is already computed by
`queries_requirements._project` (`:224-250`) and **this route calls that function** rather
than folding a second time.

| Field | Type | Origin |
|---|---|---|
| `req_id` | `str` | authored |
| `title` | `str` | authored |
| `chapter` | `str \| None` | authored |
| `status` | `str` | **authored** — a person's lifecycle value, never machine-written |
| `verification_state` | `"not_covered"\|"covered"\|"exercised"\|"failed"\|"tested"` | D |
| `evidence_stale` | `bool` | D |
| `verified_by` | `list[str]` | D — BP5, inverted from `covers_req_ids` |
| `covering_run_ids` | `list[str]` | D, newest bench session first, **uncapped here** |
| `latest_run_id` | `str \| None` | D |
| `tested_at` | `datetime \| None` | D |
| `work_order_ids` | `list[str]` | D — union of `work_order_id` over `verified_by`, sorted |
| `outcome_counts` | `{pass:int, fail:int, error:int, none:int}` | D — over the newest verdict of each covering definition; `none` counts definitions with no verdict at all |

### 3.4 `WorkOrderCoverageRow`

| Field | Type | Origin |
|---|---|---|
| `work_order_id` | `str` | mirror |
| `title` | `str` | mirror |
| `status` | `str` | mirror |
| `definition_count` | `int` | D — `_count_by(db, "test_definitions", "work_order_id", …)`, the helper `list_work_orders` already uses (`queries_runs.py:1589`) |
| `run_count` | `int` | D |
| `requirement_ids` | `list[str]` | D — union of `covers_req_ids` over this work order's definitions, sorted |
| `requirements` | `{in_scope:int, covered:int, exercised:int, failed:int, tested:int, stale:int}` | D |
| `definitions` | `{total:int, not_run:int, no_verdict:int, passed:int, failed:int, errored:int}` | D |
| `coverage_pct` | `float` | D — `tested / in_scope * 100`, 1 dp, `0.0` when `in_scope == 0` |

`requirements.in_scope` is **derived from the definitions today** — a requirement is in a work
order's scope because a definition of that work order covers it. `not_covered` is therefore
structurally impossible inside a work order and is absent from the block rather than shipped
as a permanent zero. **`BL-28` changes this**: once a work order carries an authored list of
requirements to be tested, `in_scope` becomes that list, `not_covered` becomes meaningful and
`coverage_pct` becomes a real campaign figure instead of a tautology. §8 sequences it.

### 3.5 `RunCoverageRow`

| Field | Type | Origin |
|---|---|---|
| `run_id` | `str` | stored |
| `work_order_id` | `str \| None` | stored |
| `rig_id` | `str` | stored |
| `first_data_at` | `datetime` | stored |
| `status` | `str` | stored |
| `definition_ids` | `list[str]` | stored |
| `covers_req_ids` | `list[str]` | D — `queries_runs.covered_requirement_ids` (`:770-783`), already shipped and already on the run detail |
| `verdicts` | `{pass:int, fail:int, error:int, none:int}` | D — over this run's definitions, newest version per `(run, definition)` |
| `evaluated` | `bool` | D — `verdicts.pass + fail + error > 0` |

Ordered newest bench session first — `first_data_at` DESC, `run_id` DESC, the key
`queries_requirements._covering_runs` (`:160-170`) and the definition detail
(`queries_runs.py:1485`) both already sort on, so no two screens can disagree about which run
is the latest. **Invalid-flagged runs are excluded from every list and count**, as the shipped
fold already excludes them (`queries_requirements.py:114`).

### 3.6 `Matrix` — requirements × test definitions

```jsonc
"matrix": {
  "definitions": [
    { "definition_id": "BAT-SYS-TC-003",       // str
      "title": "Battery temperature held at or below T_batt_max",  // str
      "work_order_id": "WO-BAT-2026-001",      // str | null
      "implementation_sha256": "9f2b0a11…" }   // str | null — null until one is uploaded
  ],
  "cells": [
    { "req_id": "BAT-SYS-SAF-002",             // str
      "definition_id": "BAT-SYS-TC-003",       // str
      "outcome": "fail",                       // "pass"|"fail"|"error"|null
      "run_id": "TAS-1001",                    // str | null
      "result_id": "res-…",                    // str | null — drill-down target
      "produced_at": "2026-09-23T10:12:00Z",   // datetime | null
      "current": true,                         // bool | null — null when there is no verdict
      "criterion": "C1",                       // str | null — §2.2
      "evidence_values": { "max_degc": 61.2, "limit_degc": 60, "dwell_above_limit_s": 151.3 } }
  ]
}
```

**The cell list is sparse: a cell exists only where a `verifies` link exists.** Ten
requirements × ten definitions is a hundred intersections of which ten are real; a dense array
would ship ninety nulls that each assert "this test case was considered for this requirement
and found not to apply", which is false — it was never linked. Four cell states, and they are
four different sentences:

| link | run carries the TC | verdict | `outcome` | `run_id` | renders |
|---|---|---|---|---|---|
| no | — | — | *no cell emitted* | — | blank |
| yes | no | — | `null` | `null` | hollow — **Not run** |
| yes | yes | no | `null` | set | hollow with a run id — **No verdict** |
| yes | yes | yes | `pass`/`fail`/`error` | set | the outcome chip, `stale` marker when `current == false` |

`current` is computed for **every** outcome, including a `fail` — the shipped detail read
already does this (`queries_requirements.py:414-421`), unlike the requirement-level state fold
which short-circuits on a failure and reports `evidence_stale: false` (`:211-212`). §5 names
the consequence and **OQ3** asks the user to confirm the rendering.

---

## 4. Routes

### 4.1 The one new route

```
GET /api/v1/coverage
      ?work_order=<repeated>    list[str]   — narrow to these campaigns
      &chapter=<repeated>       list[str]
      &status=<repeated>        list[str]   — the AUTHORED requirement status
      &state=<repeated>         list[str]   — verification_state, the five values
      &outcome=<repeated>       list[str]   — pass|fail|error|none, over a requirement's covering verdicts
      &run=<repeated>           list[str]
      &q=<str>                            — req_id, title, text
```

**Refusals: none.** There is no path parameter, so there is no 404; every query parameter
narrows a set, and a `work_order` the mirror does not hold narrows it to zero rows — which is
a true answer, not an error condition. No auth dependency, matching `GET /requirements`
(`api/api/routers/requirements.py:27-44`), which takes none; the token gate in this API sits on
writes and downloads. The entry this route adds to `api/api/main.py`'s refusal map
(`:240-314`) is therefore **empty**, and that is the whole entry.

The endpoint keeps `BL-38`'s name (`GET /coverage`); the page is at `/test-results` (§6)
because that is the artefact the user asked for. The asymmetry is deliberate: one is a
computation over the registry, the other is a screen.

### 4.2 Everything else is an existing route

No second route is added. The drill-downs use what ships:

| Drill-down | Route |
|---|---|
| one requirement, its authored fields and its evidence table | `GET /api/v1/requirements/{req_id}` |
| one definition, its runs, its implementation | `GET /api/v1/test-definitions/{td_id}` |
| one run | `GET /api/v1/test-runs/{run_id}` — already carries `covers_req_ids` (`queries_runs.py:766`) |
| one run's verdict documents | `GET /api/v1/results?run=TAS-1001&latest_only=true` (`routers/results.py:106-112`) |
| one verdict | `GET /api/v1/results/{result_id}` (`:220`) |

### 4.3 Computed on read, not stored

**Computed on read.** One sentence: the inputs move in six ways nothing would report — a run
deleted, a run flagged invalid, a definition's `covers_req_ids` re-pushed, a definition removed
from a run, a requirement's text edited, a new verdict version POSTed — and a stored rollup
would need a compensating write on each, which is exactly the argument
`requirement-status-from-runs/spec.md` §4.3 already made and won for `covering_run_ids`.

Cost, honestly: four `find()` calls per request — the whole `requirements` mirror, the
definitions naming any of them, the non-invalid runs carrying any of those, and the verdict
documents of those runs. All four are indexed (§2.2). At 10/10/4/10 this is milliseconds; §8
names the scale at which it stops being.

### 4.4 Where the code goes

`api/api/services/queries_coverage.py` — a new service that **calls
`queries_requirements._project`** for the requirement rows rather than reimplementing the
fold, then adds the definition-, work-order- and run-side aggregations around it. One fold,
one truth: a Test Results page that computed `verification_state` its own way would be the
second implementation of `queries_requirements.py:173-221` and the first to drift.
`api/api/routers/coverage.py` holds the single GET. `api/api/models/coverage.py` holds the
response models. Nothing in `queries_requirements.py`, `queries_runs.py` or `planning_sync.py`
is modified — the fold is imported, not edited, so this feature cannot break the Requirements
page that shipped at `360e458`/`d9dd5d4`.

---

## 5. Covered ≠ Tested, on the real battery set

Two requirements from the same trace, `T1` → run `TAS-1001` (`battery-trace-gen/README.md:104`,
`scenarios/T1_charge_thermal.json:8`), same work order `WO-BAT-2026-001`
(`seed/planning_payload.py:23`).

### 5.1 `BAT-SYS-PRF-001` — the pass

`BAT-SYS-TC-001` covers it; expected **PASS**; measured `min_i_dc_a=-300; limit_a=-300;
margin_a=0` (`manifest.csv` line 2).

| Moment | `verification_state` | matrix cell | tiles it moves |
|---|---|---|---|
| catalog pushed, no trace | `covered` | hollow, **Not run** | covered +1 |
| four traces registered, no verdict — **today** | `exercised` | hollow, run `TAS-1001` | exercised +1 |
| `BL-11` POSTs the pass | **`tested`**, `tested_at` set | green ✓ | tested +1, definitions.passed +1 |

### 5.2 `BAT-SYS-SAF-002` — the rigged failure

`BAT-SYS-TC-003` covers it; expected **FAIL**; mechanism *"derating law correct, temperature
input stale"*; measured `max_degc=61.2; limit_degc=60; dwell_above_limit_s=151.3`
(`manifest.csv` line 4).

| Moment | `verification_state` | matrix cell | tiles it moves |
|---|---|---|---|
| catalog pushed, no trace | `covered` | hollow, **Not run** | covered +1 |
| four traces registered — **today** | `exercised` | hollow, run `TAS-1001` | exercised +1 |
| `BL-11` POSTs the fail | **`failed`**, `tested_at` stays null | red ✗, hover `C1`, `max_degc 61.2 > limit_degc 60` | failed +1, definitions.failed +1 |

**Coverage reads 100 % at every one of those moments.** SAF-002 is covered throughout, names
its run throughout, and is `tested` at none of them. That is the board's *Covered ≠ Tested*
(`CLAUDE.md` § Requirements workflow), on screen, with the user's own rigged data producing the
correct negative.

### 5.3 What a suspect link does to each

A link goes suspect on a `normative_sha256` change only — `text`, `measurand`,
`system_states`, `verification_method`, `verification_criteria` (`queries_requirements.py:54-60`).
Today's approximation is the timestamp comparison `evidence_stale`; `BL-33`'s real per-link
`suspect` state is not built.

Edit `BAT-SYS-PRF-001`'s `text` after its pass landed:

- `normative_changed_at` moves past the verdict's `produced_at` → the pass stops being
  `current` → **`tested` → `exercised` + `evidence_stale: true`** (`:216`).
- Tiles: `tested` 6 → 5, `exercised` 0 → 1, `stale` 0 → 1. The matrix cell keeps its green ✓
  and gains a `stale` outline chip.
- Re-run TC-001 and it returns to `tested`.

Edit `BAT-SYS-SAF-002`'s `text` after its fail landed:

- The requirement-level fold **short-circuits on the failure** and returns
  `evidence_stale: false` (`:211-212`), so the row does not move at all: still `failed`, still
  no stale marker.
- The **cell**, computed by the detail path (`:414-421`), *does* know: `current: false`.

**These two disagree on purpose and the page must not hide it.** The requirement-level answer
is right — a known failure is louder than a stale one, and "your evidence aged" is not news
when the evidence says the thing is broken. The cell-level answer is also right — the numbers
in that cell were measured against a requirement that has since changed. **OQ3** asks the user
to confirm the rendering: the recommendation is to draw the stale marker on the cell and not
on the row, and to say so in the cell's tooltip.

### 5.4 The whole set, at the three moments

Coverage and verdicts from `CLAUDE.md`'s test-case table and `manifest.csv`. No number here is
invented.

| Requirement | TC | Run | Expected | Today | After `BL-11` |
|---|---|---|---|---|---|
| `BAT-SYS-PRF-001` | TC-001 | TAS-1001 | PASS | exercised | **tested** |
| `BAT-SYS-SAF-003` | TC-002 | TAS-1001 | PASS | exercised | **tested** |
| `BAT-SYS-SAF-002` | TC-003 | TAS-1001 | **FAIL** | exercised | **failed** |
| `BAT-SYS-FUN-001` | TC-004 | TAS-1002 | PASS | exercised | **tested** |
| `BAT-SYS-SAF-001` | TC-005 | TAS-1002 | PASS | exercised | **tested** |
| `BAT-SYS-FUN-002` | TC-006 | TAS-1002 | **FAIL** | exercised | **failed** |
| `BAT-SYS-FUN-003` | TC-007 | TAS-1003 | PASS | exercised | **tested** |
| `BAT-SYS-PRF-002` | TC-008 | TAS-1003 | **FAIL** | exercised | **failed** |
| `BAT-SYS-FUN-004` | TC-009 | TAS-1004 | PASS | exercised | **tested** |
| `BAT-SYS-FUN-005` | TC-010 | TAS-1004 | **FAIL** | exercised | **failed** |

---

## 6. The page

`frontend/app/test-results/page.tsx` → `frontend/components/screens/test-results/
test-results-screen.tsx`. Route `/test-results`.

**Sidebar**: a **Test results** entry at depth 0, after *Test definitions* and before *Files*,
**with no count** — the same treatment *Issues* and *Explore* get, and for the stated reason
(`frontend/components/shell/sidebar.tsx:249-251`): it is a view, not a list, so a badge would
be a number with no referent. It sits outside the indented planning chain (`:218-222`) because
it is a report *over* that chain, not a level of it.

### 6.1 Layout

```
PageHeader   "Test results"
             sub: [derived] Every number here is computed from runs and verdicts. A
                  requirement is tested; a verdict passes — the two are counted separately.

[ banner — only while summary.runs.verdicts == 0 ]

SummaryTiles   Coverage 10/10 · 100%   |   Tested 0 req   |   Failed 0 req   |   Not run 10 TC
               under them: 4 runs · 0 evaluated · 0 verdicts · 0 stale

Toolbar row  [ All | Failed | Not run | Stale ]  [ search ]  ...  [Work order▾] [Chapter▾]
             [Verification▾] [Outcome▾] [Run▾]   [Export]

ActiveFilterPills

Panel "Coverage matrix"          action: generated_at
  sticky-first-column grid, requirements × test definitions

Panel "By work order"            table, §3.4
Panel "By run"                   table, §3.5
```

### 6.2 The summary tiles

Four tiles. **Each prints its unit**, because §3.1's two count families are the thing a reader
gets wrong:

| Tile | Reads | Source |
|---|---|---|
| **Coverage** | `10 / 10` and `100%` | `summary.requirements.total - not_covered`, `coverage_pct` |
| **Tested** | `6 requirements` | `summary.requirements.tested` |
| **Failed** | `4 requirements` | `summary.requirements.failed` |
| **Not run** | `0 test cases` | `summary.definitions.not_run + no_verdict` |

Under the tiles, one line, not tiles — they are context, not headline:
`4 runs · 4 evaluated · 10 verdicts · 0 stale`.

Tones: Coverage neutral (a percentage is not good or bad), Tested green, Failed red, Not run
amber at > 0 and neutral at 0. `status` — the authored requirement lifecycle — is **never**
coloured anywhere on this page, for the reason the Requirements page already states: the enum
is customer configuration (`BL-20`), so this code cannot know which value is good.

### 6.3 The coverage matrix

Rows = requirements, `req_id` ascending. Columns = the test definitions in `matrix.definitions`,
`definition_id` ascending. First column sticky (`req_id` + title), the grid inside the existing
`TableScrollArea`, which already scrolls horizontally.

| Cell | Glyph | Tone |
|---|---|---|
| `pass`, current | ✓ | green |
| `pass`, `current: false` | ✓ with a dashed outline | green + `stale` |
| `fail` | ✗ | red |
| `error` | ! | amber — **never red**; an evaluator that could not decide is not a failure (`api/api/models/results.py:94`) |
| linked, run, no verdict | ○ | neutral |
| linked, no run | ○ hollow, dimmed | neutral |
| not linked | *empty* | — |

A cell is a link to `/runs/{run_id}?tab=results` (the run detail's Results tab,
`run-detail-screen.tsx:53`); its title attribute carries the outcome, the `criterion` and the
`evidence_values` as `key: value` pairs. Colour is never the only carrier: glyph + tone +
`aria-label`, the rule `requirements-page/spec.md` §5.4 already sets.

**Row and column headers are links** — `req_id` → `/requirements/{id}`, `definition_id` →
`/definitions/{td}` — so the matrix is the navigation surface for the whole traceability chain.

### 6.4 Filters

One `TableStateConfig`, the idiom `requirements-table-config.ts` already holds:

```ts
export const TEST_RESULTS_TABLE_CONFIG: TableStateConfig = {
  multiKeys: ["work_order", "chapter", "status", "state", "outcome", "run"],
  singleKeys: [],
  sortKeys: [],                // GET /coverage whitelists none — req_id ascending, server-side
  defaultSort: null,
  defaultPageSize: 20,         // unused: the report does not page. Kept so the hook's shape holds.
  pageSizeOptions: [20],
  quickViews: [
    { id: "all",     params: {} },
    { id: "failed",  params: { state: ["failed"] } },
    { id: "not-run", params: { state: ["covered", "not_covered"] } },
    { id: "stale",   params: { outcome: ["stale"] } },
  ],
};
```

**Filter options come from `facets` inside the coverage response, not from a `/facets` route.**
Two reasons, and the second is load-bearing: the fold already reads every requirement, so the
distinct values are free; and **`GET /requirements/facets` does not exist** — `frontend/lib/api/
requirements.ts:19` calls it and `api/api/routers/requirements.py` declares no such route, so
`/requirements/{req_id}` catches it and answers 404 `requirement_not_found`. This page must not
add a second caller to a route that is not there. (That gap is the Requirements page's to fix;
it is named in §8 and belongs to whoever owns that tree.)

Everything else is the shipped components with a new config: `QuickViewSegment`,
`MultiSelectFilter`, `ActiveFilterPills`, `TableSearchInput`, `ExportButton`. No new shared
primitive is introduced except the matrix cell.

### 6.5 The empty state — today's state, and it must not look broken

**Today `summary.runs.verdicts == 0`.** The page is not empty and must not be drawn as if it
were: the coverage half is real, complete and worth showing.

- The tiles render **Coverage 10/10 · 100 %**, **Tested 0 requirements**, **Failed 0
  requirements**, **Not run 10 test cases**, and the context line `4 runs · 0 evaluated · 0
  verdicts · 0 stale`.
- The matrix renders all ten link cells as hollow **Not run** circles, each carrying its run id
  — the traceability chain is visible and correct with no outcome in it.
- One banner sits between the header and the tiles, and it goes away by itself when the first
  verdict lands:

  > **No test case has been evaluated yet.** Coverage below is real — every requirement is
  > linked to a test case and four runs carry them. Outcomes appear when the evaluator writes
  > its first verdict (`BL-11`).

- **No spinner, no error state, no "no data" illustration.** Three distinct empties, as
  `work-orders-screen.tsx:129-135, :205-220` distinguishes them: *loading* (skeleton rows),
  *filtered-empty* (`TableEmptyState` + Clear all), *baseline-empty* (only when the
  `requirements` mirror itself is empty: *"No requirements mirrored yet — planning pushes them
  through `POST /planning/sync`."*). **Zero verdicts is none of the three** — it is a populated
  page in a known phase, and conflating it with "no data" is exactly how a correct screen gets
  reported as a bug.

### 6.6 Export

`ExportButton` with client-side paging over the response (no `serverExport`; no
`/coverage/export` route is proposed). One CSV, one row per matrix **cell**, so the file is the
traceability matrix an ASPICE reader asks for: `req_id, requirement_title, chapter, status,
verification_state, definition_id, definition_title, work_order_id, run_id, outcome, current,
criterion, produced_at, evidence`. Blank cells are omitted — a row per non-link would be 90 %
noise at our shape.

---

## 7. Authoring controls

**None. This page writes nothing, and no control on it opens a dialog.**

- **A verdict is a produced fact, not an opinion.** Correcting one means producing a new
  version through `POST /results` with the same `result_key`; the route mints version N+1 and
  sets `supersedes`, and the fold reads the newest. The shipped API already forbids the other
  path: `ResultPatchRequest` is `extra="forbid"` and does not name `verdict`
  (`api/api/models/results.py:221-236`), so a patch naming it answers 422. **Do not add an
  edit-verdict control, and do not add `verdict` to that patch body.**
- **Every rollup number is derived**, so there is nothing on this page a person *could* edit
  that would survive the next read.
- **Re-run is not this page's control.** "Evaluate this run again" is `BL-40`'s
  `POST /runs/{id}/execute` driven by `BL-11`'s runner. When it exists, its natural home is the
  run detail, where the run's own actions already live — not a report screen that would then be
  the one place in the app where reading triggers work.
- **Editing a requirement is the Requirements page's job** and it is a click away: every
  `req_id` on this page links there.

### 7.1 Position on `BL-50`

`BL-50` records that `requirements-page/spec.md` §10 says *"No write route… Nothing on this page
is editable"* while `authoring-controls/spec.md` gives full CRUD, and the user asked for
add/edit/remove.

**Resolved in favour of authoring-controls, and the requirements-page line is stale.** The
code already settled it: `POST /requirements`, `PATCH /requirements/{req_id}` and
`POST /requirements/{req_id}/retire` are shipped (`api/api/routers/requirements.py:87-136`) with
four named refusals, and the screen carries Add / Edit / Retire
(`requirements-screen.tsx:207-211, :386-412`). The reconciliation to write down is: **a
requirement is an authored entity a person may create and edit here; a mirrored row's planning
fields stay planning's; a verdict and every rollup are derived and are editable nowhere.** That
last clause is what this page needs from the resolution, and it is unaffected by whichever way
the first two settle. `BL-50` should be closed with the requirements-page §10/§14 lines struck,
by whoever owns that spec — **not by this feature**, which touches neither file.

---

## 8. What this depends on

Ordered. Each line states what the page shows before it lands.

| # | Item | Status at `d9dd5d4` | Until it lands, the page shows |
|---|---|---|---|
| 0 | the requirement mirror + `_project` fold (`BL-22`) | **shipped** (`3b3910a`) | — it is the prerequisite, and it is met |
| 0 | the `verdict` block on `processed_results` (`BL-24`'s contract half) | **shipped** | — |
| 1 | **this spec** = `BL-38` (`GET /coverage` + matrix) | not built | nothing; there is no page |
| 2 | **`BL-11`** — run the ten implementations, POST the verdicts (with `BL-37` for the runner shape) | not built | coverage, run linkage and the four empty-state behaviours of §6.5. **Everything on the page except outcomes is already true today.** |
| 3 | `BL-19` — Covered ≠ Tested | **encoded in the shipped fold** (`queries_requirements.py:173-221`) | — nothing to do; §5 is its screen |
| 4 | `BL-34` on **test definitions** (`item_version`) | requirements half shipped; **TC half not built** | `definition_version` writes null and the pin stays `implementation_sha256`. The board's *"pinned at exactly version `w`"* is approximated, not implemented, and §9 OQ2 names it |
| 5 | `BL-33` — the versioned `verifies` link entity | in progress (spec only) | `evidence_stale` stands in for `suspect`, under a different word on purpose (`requirements-page/spec.md` §8). When it lands, the matrix cell gains a per-link suspect marker and the word changes |
| 6 | `BL-28` — work order carries its requirement scope | not built | §3.4's `in_scope` is derived from definitions, so `coverage_pct` per work order is tautologically 100 % whenever every definition is linked. **This is the weakest number on the page** and it is labelled as derived-from-definitions in the column header |
| 7 | `BL-47` — no UI assigns a definition to a run | not built | a run whose definitions were never claimed contributes no cells. All four of ours claimed theirs at upload, so the demo is unaffected |
| 8 | `BL-40` / `BL-41` — execute and report | not built | no re-run button, no rendered report; the CSV export is the artefact |

**Independent of this page, and it should be fixed by whoever owns `api/`:**
`GET /requirements/facets` is called by the frontend (`frontend/lib/api/requirements.ts:19`)
and does not exist in `api/api/routers/requirements.py` — `/requirements/{req_id}` shadows it
and answers 404 `requirement_not_found`, so the Requirements page's four filter dropdowns are
empty today. This page deliberately does not depend on it (§6.4). Worth a backlog line.

**Scale**: the report is unpaginated by design (§3.2). The number to watch is the
`requirements` mirror: past roughly 500 rows the response and the matrix both stop being one
screen, and the upgrade is to page `requirements[]` and `matrix.cells` together while keeping
`summary` whole-table — the same split `GET /requirements` already implements.

---

## 9. Open questions

1. **OQ1 — Is the summary the campaign's or the estate's?** Today `GET /coverage` with no
   filter covers every requirement the mirror holds, and the work-order tiles sit in a panel
   below. **Recommended: estate-wide by default, one work order one click away** via the Work
   order filter, because there is exactly one work order (`WO-BAT-2026-001`) and an
   estate-wide default is the honest shape for a customer with forty. If the user wants the
   page to open *on* a campaign, the change is a default filter value and nothing else.
2. **OQ2 — Does `definition_version` ship now, written null, or wait for `BL-34`'s TC half?**
   **Recommended: ship it now, written null.** It is one optional int on the `Verdict` model;
   adding it later means every verdict written in between can never be pinned, because the
   version at evaluation time is not recoverable afterwards. Costs one field, buys the board's
   `(R@v, TC@w)` the day `BL-34` lands.
3. **OQ3 — Where does `stale` render on a failing requirement?** The row-level fold says a
   failure outranks staleness (`evidence_stale: false`); the cell-level computation knows the
   evidence is stale (§5.3). **Recommended: the marker draws on the cell only, never on the
   row, and the cell's tooltip says "the requirement changed after this run".** The alternative
   — propagating stale onto failed rows — would add a second amber marker to a red row and
   make "Failed 4" ambiguous.
4. **OQ4 — Do `error` verdicts get their own tile?** They are counted in
   `summary.definitions.errored` and rendered amber in the matrix, but no tile. **Recommended:
   no tile while the count is structurally zero** (our ten evaluators either decide or raise,
   and a raise is the runner's to translate). Promote to a tile — or to a Home "needs
   attention" line — the first time a real estate produces one, because a requirement sitting
   at `exercised` forever because its evaluator is broken reads exactly like "not run yet", and
   that is the one failure mode of this page that is silent.
5. **OQ5 — Should the matrix ship a work-order-scoped variant?** At ten definitions the matrix
   is one screen. At a customer's two hundred it is not, and the natural cut is one matrix per
   work order. **Recommended: not now** — the Work order filter already produces exactly that
   view, and a second layout would be a second thing to keep in step with the first.
6. **OQ6 — Does the page need a trend, "coverage over time"?** It is the second question every
   status meeting asks. It needs a time series nothing stores — `generated_at` is the read's own
   clock and nothing snapshots it. **Recommended: no.** It is `BL-39` (baselines) wearing a
   chart: seal a named set of requirement versions, compute coverage at seal, and the trend is
   the diff between two seals. Building a snapshot table for it first would be the thing
   baselines then have to replace.

---

## 10. Sanity print

### 10.1 The verdict document, field by field with types

**Stored on `processed_results` (envelope, unchanged):** `_id: str` · `run_id: str` ·
`result_key: str` · `version: int` · `supersedes: str|None` · `name: str` ·
`description: str|None` · `storage_ref: str|None` · `provenance.tool: str` ·
`provenance.tool_version: str` · `provenance.parameters: str` ·
`provenance.input_file_ids: list[str]` · `provenance.produced_by: str` ·
`provenance.produced_at: datetime` · `provenance_status: str` · `created_at: datetime`

**Stored in the `verdict` block (shipped):** `definition_id: str` ·
`outcome: Literal["pass","fail","error"]` · `evidence: dict` · `implementation_sha256: str`

**Stored, added by this spec:** `definition_version: int|None` · `criterion: str|None`

**Derived, never stored:** the requirement ids (from `test_definitions.covers_req_ids`) ·
`work_order_id` (from `test_runs`) · `current` (digest pin + timestamp freshness) · every
count, percentage and matrix cell on the page.

### 10.2 The tiles, today versus after `BL-11`

**Today — four traces registered, zero verdicts written:**

```
Coverage  10 / 10 · 100%     Tested  0 requirements     Failed  0 requirements     Not run  10 test cases
4 runs · 0 evaluated · 0 verdicts · 0 stale

summary.requirements  {total 10, not_covered 0, covered 0, exercised 10, failed 0, tested 0, stale 0, coverage_pct 100.0}
summary.definitions   {total 10, linked 10, not_run 0, no_verdict 10, passed 0, failed 0, errored 0, stale_pass 0}
summary.runs          {total 4, evaluated 0, unevaluated 4, verdicts 0}
```

**After `BL-11` runs the ten implementations against the known 6 PASS / 4 FAIL set:**

```
Coverage  10 / 10 · 100%     Tested  6 requirements     Failed  4 requirements     Not run  0 test cases
4 runs · 4 evaluated · 10 verdicts · 0 stale

summary.requirements  {total 10, not_covered 0, covered 0, exercised 0, failed 4, tested 6, stale 0, coverage_pct 100.0}
summary.definitions   {total 10, linked 10, not_run 0, no_verdict 0, passed 6, failed 4, errored 0, stale_pass 0}
summary.runs          {total 4, evaluated 4, unevaluated 0, verdicts 10}
```

**Coverage is 100 % in both columns and Tested moves 0 → 6.** That is the whole point of the
page in two lines: coverage says a test case exists, and only a verdict says it worked.

---

## 11. References

- `CLAUDE.md` — the 10 requirements, 11 parameters, 10 test cases, the 6 PASS / 4 FAIL table,
  the ingestion pipeline, and the SYS.2 rules (`verified_by` derived; Covered ≠ Tested; what
  makes a link suspect).
- `battery-trace-gen/out/manifest.csv` — every measured number quoted in §2.2 and §5.
- `battery-trace-gen/specs/battery-dc-test-specs.json` — `covers_req_ids` and
  `pass_criteria[].criterion_id`, the source of §2.2's `criterion`.
- `battery-trace-gen/out/impl/BAT-SYS-TC-003.py` — `evaluate(run_id, table)`, its `PASS`/`FAIL`
  casing and its `LookupError` path.
- `dev-planning/requirement-status-from-runs/spec.md` §4.3, §4.6, §5.3, §6 — the fold, the
  staleness rule and the verdict contract this page reads.
- `dev-planning/requirements-page/spec.md` §5 (dashed = computed), §8 (absent, not blank),
  §11 (filters, facets, quick views) — the conventions this page mirrors.
- `dev-planning/authoring-controls/spec.md` — the CRUD that shipped, and §7.1's `BL-50`
  position.
- `api/api/models/results.py:84-109, :221-236` · `api/api/services/queries_requirements.py` ·
  `api/api/services/queries_runs.py:766-783, :891-970, :1588-1602` · `api/api/db.py:42-69,
  :156-165` — the shipped surfaces §2-§4 build on.
- `frontend/components/screens/requirements/` — the screen this page is shaped on.
- `dev-planning/backlog.json` — `BL-11`, `BL-19`, `BL-24`, `BL-28`, `BL-33`, `BL-34`, `BL-37`,
  `BL-38`, `BL-40`, `BL-47`, `BL-50`.
