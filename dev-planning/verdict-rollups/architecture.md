# Verdict rollups — architecture

Two read-time folds that surface verdicts where they were missing: the runs
list says whether a run was evaluated and how it went, and a test definition
says what its latest verdict decided and which run produced it.

Inputs: the user's two complaints of 2026-09-25 ("test run overview doesn't
make sence, there is no status if it was run or not…", "test definition should
cahnge status from on plan to Passed or Failed and Id of last testrun"). The
verdict record itself is specified in `dev-planning/test-results-page/spec.md`
§2 and written by `api/api/services/definition_runs.py`; nothing here writes
one.

## What this is

`processed_results` documents carrying a `verdict` block existed and were read
by exactly one surface — the requirements projection. Two screens that should
have read them did not:

* **Runs list.** Its `Status` column is `RunStatus` — ingestion. Its
  `Definition` column printed `definition_id`, the legacy scalar, so a run
  fulfilling three definitions showed one of them and said nothing about the
  other two. That column is gone; a `Verdicts` column took its place and
  `Status` is now headed `Ingestion`.
* **Test definition.** Its `status` is plan adherence (`on_plan` /
  `awaiting_data`) and nothing on the row or the detail read a verdict. A
  derived `verdict_state` now sits beside `status`, with `latest_verdict`
  naming the run, the result and when it was produced.

Nothing is stored. No new route, no new collection, no writer, no index.

## Why this architecture

**`status` was not overwritten.** The user asked for the definition's status to
"change to Passed or Failed". Overwriting `status` would destroy plan
adherence — the fact that answers "have we run this as often as we planned" and
the fact `GET /test-definitions?status=` filters on — and it would give one
idea two meanings. The Requirements page had already solved the shape of this
problem and shipped at `e1fb084`: the authored **Status** and the derived state
sit in two columns, under a line saying they move independently. This build
copies that treatment.

**It does not copy the requirements *words*.** A requirement is
`not_covered | covered | exercised | failed | tested`; a definition is
`not_run | no_verdict | passed | failed | error`. They count different units —
one requirement can be covered by three definitions and one definition can
cover three requirements — and merging the two vocabularies is the defect
`dev-planning/test-results-page/spec.md` §3.1 exists to prevent. So the wire
field is `verdict_state`, the five words are that spec's §3.3 verbatim, and the
column is headed **Verdict**, not Verification.

> Deviation from the brief, flagged: the brief asked for a column headed
> "Verification" mirroring the requirements grid. That spec was rewritten while
> this was being built and now fixes `verdict_state` and its five words for
> `GET /test-definitions`. Shipping `verification`/`errored` here would have
> forced a wire rename on the next build. The two-column *treatment* the brief
> asked for is what was kept.

**Derived on read, never stored** — the rule `queries_requirements._project`
set. A stored rollup goes stale in five ways nothing would report: a run
flagged invalid, a definition added to or removed from a run, a re-POSTed
verdict minting a new version, a run deleted, an implementation re-uploaded.
The fold answers off the current graph, so there is nothing to invalidate and
no compensating write anywhere.

**Both folds live in one new module**, `api/api/services/verdict_rollups.py`.
`queries_runs.py` is already 2,000 lines, well past the 500-line soft ceiling,
and the folds are one subject with one access pattern into
`processed_results`. They share `newest_per_pair`, so the run rollup and the
definition rollup can never disagree about which verdict of a
`(run, definition)` pair is current.

**The module owns the reduction for the requirements fold too.**
`queries_requirements` imports `newest_per_pair` and `latest_verdict_of`
instead of ranking verdicts itself — see "What 'latest' means" below for the
rule and why it is `produced_at`.

## Data flow

```
GET /test-runs            GET /test-definitions(/{td})       GET /requirements(/{id})
      |                              |                                |
queries_runs.list_runs       _derived_definitions /         queries_requirements._project
   -> with_verdicts          get_test_definition_detail          -> _fold_inputs
      |                              |                                |
 run_verdicts                definition_verdicts              _newest_verdict_of_td
      |                              |                                |
      |   reduction 1 — the current verdict of one (run, definition):  |
      +---------------------- newest_per_pair -------------------------+
      |     processed_results.find(...).sort("version", DESCENDING)
      |     setdefault((run_id, verdict.definition_id))
      |                              |                                |
      |   reduction 2 — the current verdict of one definition:         |
    (n/a)                     latest_verdict_of <---------------------+
                          max(candidates, key=_latest_key)
```

`run_verdicts` uses reduction 1 only: it reports one run's definitions, so
there is nothing to reduce across runs.

### Fold A — a run's verdict counts

```python
def run_verdicts(db, definition_ids: dict[str, list[str]]) -> dict[str, dict]:
    run_ids = [run_id for run_id, td_ids in definition_ids.items() if td_ids]
    newest = newest_per_pair(db, {"run_id": {"$in": run_ids}, "verdict": {"$ne": None}}) if run_ids else {}
    counted = {}
    for run_id, td_ids in definition_ids.items():
        tally = {"pass": 0, "fail": 0, "error": 0, "none": 0}
        for td_id in td_ids:
            result = newest.get((run_id, td_id))
            tally["none" if result is None else _outcome(result)] += 1
        counted[run_id] = tally
    return counted
```

One Mongo query serves a whole page. **The unit is the run's definitions.** The
four counts partition the run's *current* definition set: `none` counts the
definitions nothing has judged, and a verdict for a definition the run no
longer carries is counted by nothing — the set on the run is what the screen
shows. So `pass + fail + error` is "how many of them were evaluated" and the
sum of all four is "how many there are", which is exactly the `2 of 3` the cell
prints.

### Fold B — a definition's latest verdict

```python
def definition_verdicts(db, actual_runs: dict[str, int]) -> dict[str, dict]:
    newest = newest_per_pair(db, {"verdict.definition_id": {"$in": list(actual_runs)}})
    # the surviving (run, definition) winners, grouped by definition
    for td_id, runs in actual_runs.items():
        latest = latest_verdict_of(by_definition.get(td_id) or [])
        if latest is None:
            -> {"verdict_state": "no_verdict" if runs else "not_run", "latest_verdict": None}
        -> {"verdict_state": STATE_WORDS[_outcome(latest)],
            "latest_verdict": {"run_id": …, "result_id": …, "outcome": …, "produced_at": …}}
```

`actual_runs` (how many runs carry each definition) is passed in because both
callers have already derived it, and because it is what tells `not_run` apart
from `no_verdict` — one rule, in one place, for both screens.

`latest_verdict` is an object and not two flat fields so that
`dev-planning/test-results-page/spec.md` §8.2's `DefinitionVerdictRef` can grow
into it — that spec adds `implementation_sha256`, `current` and `evidence`,
which are additions to this block rather than a rename of anything shipped
here.

### What "latest" means

Two reductions, in this order, and **both are shared with the requirements
fold** — one function each, two callers each:

1. **Within one `(run_id, definition_id)` pair**, the highest `version` wins
   (`newest_per_pair`). `POST /results` mints a version chain per
   `(run_id, result_key)`, so a re-posted verdict supersedes its predecessor
   and every earlier version is a historical record, never the current one.
2. **Across runs**, the newest `provenance.produced_at` wins
   (`latest_verdict_of`) — when the implementation returned. A definition
   re-run after a fix reads its newest attempt, never its first.

**Why `produced_at` and not the run's `first_data_at`.** A verdict states when
a test case was *evaluated*. Pressing Run today against a January bench
session produces today's answer about that session, so ranking the candidates
by when their *data* arrived ranks the wrong thing: it would let a September
evaluation lose to a June recording that was judged in February. Freshness of
the data is a real and separate fact, and it is already carried — the run's
`first_data_at` orders `covering_run_ids` and `latest_run_id`, and
`evidence_stale` says whether the requirement moved under its evidence
(`queries_requirements._state_fold`). Folding the two into one ordering would
hide both.

This corrects the divergence Tester pinned as Bug 1.1
(`dev-planning/verdict-rollups/test-report.md`):
`queries_requirements._newest_verdict_of_td` used to walk a definition's runs
newest-`first_data_at`-first and stop at the first one carrying any verdict,
so the two folds could name different winning runs and opposite outcomes for
one definition.

> **Spec deviation, flagged for Buddy.**
> `dev-planning/requirement-status-from-runs/spec.md` §5.3 still states
> `newest_verdict(td) = the highest-version verdict of the newest run of td
> that has one`, with "newest" defined there as the newest bench session. That
> line is what shipped and is now superseded by `latest_verdict_of`. The rest
> of §5.3 is unaffected: `covering_run_ids`, `covering_run_count` and
> `latest_run_id` keep their `first_data_at` DESC, `run_id` DESC ordering, and
> the five-value state table is untouched.

Ties on `produced_at` — what a batch runner stamping one clock reading across a
run's definitions produces — fall back to `created_at`, the registry's own
arrival order, and then to the result id. The full key is

```python
(provenance.produced_at or created_at, created_at, _id)
```

so the answer never depends on the order Mongo happened to return documents in,
and a document written before `produced_at` was mandatory still sorts.

`error` is never a failure. An outcome outside the three the `Verdict` model
allows reads as `error` and not as "unjudged": a document exists, so something
judged the definition, and a stored value from an older or newer build must not
turn a list read into a 500 — the rule `ProvenanceOut`
(`api/api/models/results.py:60-70`) already states for reads.

## Screens

**Runs list** — `Definition` column deleted. `Status` header is now
`Ingestion`; the underlying field is untouched. New `Verdicts` column:

| run | cell |
|---|---|
| no definitions | `No definitions` (muted) |
| definitions, none judged | `Not evaluated` (muted) |
| 3 definitions, 2 judged | `2 of 3` + `1 pass` (green) `1 fail` (red) |
| an API without the field | `—` |

Only non-zero chips render, so a clean run reads `3 of 3 · 3 pass` and nothing
else. The page sub-line carries the disambiguation: *"Ingestion says the data
arrived; Verdicts says what the run's test definitions decided."*

**Definitions list** — `Verdict` column after `Status`, and `Last run` carrying
`latest_verdict.run_id` as a link. Both are hideable like every other column
(`definitions-column-visibility.ts`). Sub-line: *"Status is plan adherence;
Verdict is what the runs decided, so 'On plan' beside 'Failed' is legal, not a
bug."*

**Definition detail** — the verdict chip joins the header badges, and the
metadata grid gains `Verdict` and `Last verdict` (run id + produced-at). No
history table: the latest verdict is what was asked for, and a per-run verdict
list on this screen is `dev-planning/test-results-page/spec.md` §3.2's
`verdict_counts`, which belongs to that build.

## File inventory

| File | Change |
|---|---|
| `api/api/services/verdict_rollups.py` | **new** — both folds, plus the two shared reductions `newest_per_pair` and `latest_verdict_of` (`_latest_key`, `_outcome`, `STATE_WORDS`) |
| `api/api/services/queries_requirements.py` | `_fold_inputs` and `_newest_verdict_of_td` call the shared reductions instead of their own; no other change |
| `api/api/services/queries_runs.py` | `with_verdicts` added; `list_runs` and `with_counts` call it; `_derived_definitions` and `get_test_definition_detail` overlay `definition_verdicts` |
| `api/api/models/runs.py` | `RunVerdicts` model; `RunListItem.verdicts`; `status` and `definition_id` comments corrected |
| `api/api/models/planning.py` | `DefinitionVerdictState`, `DefinitionVerdictRef`; two fields on `TestDefinitionRow` |
| `api/api/services/exports.py` | comment only — the CSV's `Definition` column no longer mirrors a screen column |
| `frontend/types/test-run.ts` | `RunVerdicts`; `TestRunListItem.verdicts?` |
| `frontend/types/work-order.ts` | `DefinitionVerdictState`, `DefinitionVerdictRef`; two optional fields on `TestDefinitionListItem` |
| `frontend/lib/mock/db.ts` | the FE mock lane emits both derived blocks, so the contract guard stays honest after the OpenAPI snapshot is refreshed (`BL-25`) |
| `frontend/components/screens/runs/run-verdicts-cell.tsx` | **new** — the three readings of the column |
| `frontend/components/screens/runs/runs-screen.tsx` | `Definition` column removed, `Verdicts` added, `Status` headed `Ingestion`, sub-line |
| `frontend/components/screens/definitions/definition-verdict-chip.tsx` | **new** — five states, `error` amber |
| `frontend/components/screens/definitions/definitions-columns.tsx` | `Verdict` and `Last run` columns |
| `frontend/components/screens/definitions/definitions-screen.tsx` | sub-line |
| `frontend/components/screens/definitions/definition-detail-screen.tsx` | header chip, two meta cells, corrected panel caption |

## Integration

* **Requirements** (`queries_requirements._project`) stays the owner of
  `verification_state` and now calls this module for both reductions
  (`newest_per_pair` in `_fold_inputs`, `latest_verdict_of` in
  `_newest_verdict_of_td`). One definition therefore has one current verdict,
  whichever screen asks: a requirement reading `failed` and its covering
  definition reading `Failed` are the same verdict document seen from two
  ends. What is *not* yet shared is the candidate set — the requirements fold
  drops invalid-flagged runs and runs that no longer carry the definition,
  `definition_verdicts` does not (see the last half-truth below).
* **The verdict writer** (`definition_runs.record_verdict`, the Run button) is
  untouched. Press Run, and the next read of either screen shows the outcome.
* **`dev-planning/test-results-page/spec.md` (`BL-51`) — the next build.** Its
  §3.5 proposes a module `verdict_fold.py` lifted out of
  `queries_requirements`, and §8.2 widens `TestDefinitionRow` with
  `verdict_counts`, `runs_with_verdict`, a `verdict_state` filter param and
  `DefinitionViewCounts`. **None of that is built here.** What is built is the
  same `verdict_state` vocabulary and a `latest_verdict` block that block
  extends. That build should fold this module into its own rather than add a
  second fold beside it; `newest_per_pair` and `latest_verdict_of` are the
  seam, and `queries_requirements` already imports them, so §9's step 1 is
  half done — what is left to move is `runs_of_td` and the `is_pinned` test.
* **`BL-66`** (one definition across several work orders) touches neither fold:
  neither reads `work_order_id`.

## Known half-truths left standing

* The runs CSV keeps a `Definition` column holding the first of
  `definition_ids` — the same partial fact the screen column was removed for.
  Its header row is asserted verbatim by
  `frontend/tests/components/export-csv.test.tsx:214` and mirrored by
  `exports.RUN_COLUMNS`, so changing it is a three-file change and a test edit,
  not a one-line fix. The comments on both sides now say what the cell is.
* `DefinitionStatusBadge` paints plan adherence green ("On plan"), so a green
  `On plan` can sit beside a red `Failed`. The Requirements page reserves colour
  for the derived chip and paints authored status neutral; this badge is shared
  with the work-order detail and was left alone. Visual call for
  FrontEndEsthetic.
* **One reduction, two candidate sets.** `latest_verdict_of` now ranks the
  candidates for both screens, but the lists handed to it are still built
  differently: `definition_verdicts` takes every verdict naming the definition,
  whatever run produced it, while the requirements fold takes only verdicts
  from non-invalid runs that currently carry it (`_fold_inputs`'s `test_runs`
  query). A definition whose only verdict sits on an invalid-flagged run
  therefore reads `Failed` on the definitions screen while the requirement it
  covers reads `covered` — no disagreement about *which* verdict is current,
  but still one about whether it counts. `actual_runs` has the matching gap: it
  counts invalid-flagged runs, while `dev-planning/test-results-page/spec.md`
  §3.3 defines `not_run` as "no **non-invalid** run carries this definition",
  so a definition carried only by an invalid run reads `no_verdict` here and
  `not_run` there. Both gaps are in `_count_by` and in the unfiltered verdict
  query, both pre-date this build, and both are what the next build must decide
  rather than copy.
