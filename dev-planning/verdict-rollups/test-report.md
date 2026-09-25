# Bug Log: verdict-rollups

**Spec:** `dev-planning/verdict-rollups/architecture.md`
**Test suite:** `api/tests/test_verdict_rollups.py`

## Round 1 — 2026-09-25

### Gate summary

| Gate | Command | Result |
|---|---|---|
| ruff check (touched files) | `cd api && uv run ruff check api/services/verdict_rollups.py api/services/queries_runs.py api/models/runs.py api/models/planning.py api/services/exports.py` | PASS — 0 errors |
| ruff format --check (touched files) | same file set, `--check` | 2 files (`runs.py`, `queries_runs.py`) flag lines, but every flagged line is **untouched, pre-existing code** — confirmed by diffing each flag's line number against the actual `git diff` hunks; none sit inside an added/changed line. A whole-repo `ruff format --check .` flags 142 files, so this is baseline formatting debt unrelated to this diff, not a build defect. |
| npm run lint (eslint, whole repo) | `cd frontend && npm run lint` | 33 errors / 53 warnings, all in `public/explore/measure-*.js` — untouched by this diff. Touched files (`run-verdicts-cell.tsx`, `definition-verdict-chip.tsx`, `runs-screen.tsx`, `definitions-columns.tsx`, `definitions-screen.tsx`, `definition-detail-screen.tsx`, `lib/mock/db.ts`) checked directly: **0 errors**, 7 pre-existing warnings in `lib/mock/db.ts` (unused `_`-prefixed params, untouched lines). |
| tsc --noEmit | `cd frontend && npx tsc --noEmit` | PASS — 0 errors. The deleted `definition-verification-chip.tsx` left no stale import. |
| pytest api | `cd api && uv run pytest tests -q` (Docker mongo:7) | **36 failed, 2703 passed, 8 skipped.** `new=1 pre-existing=35` — the +1 is `test_the_definition_verdict_and_the_requirement_it_covers_can_disagree`, an intentional red characterization test for Bug 1.1 below, not a regression. See "The tie-break" / "The sum invariant" / "The five definition states" sections for the other 12 new tests, all green. |
| pytest tests (root) | `python -m pytest tests -q` | **Could not run.** `tests/test_inventory.py` and `tests/test_marker_contract.py` fail collection: `ModuleNotFoundError: No module named 'numpy'` via `mf4-decoder/inventory.py`. Neither the root `.venv` (no `pip`) nor `api/.venv` carries `mf4-decoder/requirements.txt`'s deps (numpy, asammdf, canmatrix, cantools, quixstreams, quixportal). This is an environment-setup gap, not a code defect from this diff — flagging per §8, not chasing per the brief's "known-red baseline — confirm, do not chase" for BL-31, which this predates (collection fails before BL-31's 5 named tests would even run). |
| fe unit | `cd frontend && npm run test:unit` | 2 failed / 956 passed (93 files). Both match the brief's documented baseline exactly: `filters-pagination.test.ts` (sort direction) and `lake-partitions.test.ts` (missing `test_definition` column) — unrelated files, untouched by this diff. `new=0 pre-existing=2`. |
| fe component | `cd frontend && npm run test:components` | 19 failed / 929 passed (117 files, 8 failing files). Every failure traced to a pre-existing cause (detail below). `new=0 pre-existing=19`. |
| fe contract | `cd frontend && npm run test:contract` | 1 failed / 33 passed. `01 home summary` — the committed `api/docs/openapi.v1.json` is missing `counts.requirements`, unrelated to `HomeCounts`/verdict fields touched here. This is BL-25's staleness (`api/docs/openapi.v1.json` not regenerated) surfacing on the frontend side. `new=0 pre-existing=1`. |

**`new=1 (intentional, Bug 1.1) pre-existing=57`** across every suite that ran (35 + 2 + 19 + 1), plus the root `tests/` suite that could not run at all. No unintentional regression in any suite.

### The tie-break — executed, both directions

- `api/tests/test_verdict_rollups.py::test_a_tie_on_produced_at_falls_back_to_created_at_every_read` — **PASS**. Two verdicts on one definition, identical `provenance.produced_at`, different `created_at`; `definition_verdicts` read 5 times, same winner (`created_at`-newer run) every time.
- `api/tests/test_verdict_rollups.py::test_a_full_tie_falls_back_to_the_result_id_every_read` — **PASS**. Same `produced_at` AND same `created_at`, only the result id differs; the lexicographically greater id (`res-bbb`) wins every one of 5 reads. Confirms `_latest_key`'s `(produced_at or created_at, created_at, _id)` tuple is order-independent by construction — the `_id` component is always unique, so `max()` can never depend on the order Mongo's cursor returns documents in.
- `api/tests/test_verdict_rollups.py::test_a_document_with_no_produced_at_falls_back_to_created_at_for_the_key` — **PASS** (bonus). A document with no `produced_at` at all still sorts correctly by `created_at`.

**Verdict: the tie-break is correctly implemented, not order-dependent.** No bug here.

### The sum invariant — executed across three fixture shapes

`api/tests/test_verdict_rollups.py::test_run_verdicts_tally_partitions_the_run_s_definition_set` — **PASS**. `pass + fail + error + none == len(definition_ids)` holds for:

| Shape | `definition_ids` | Tally |
|---|---|---|
| Zero definitions | `[]` | `{pass:0, fail:0, error:0, none:0}` — sum 0 |
| Definitions, none judged | `["TD-9", "TD-10"]` | `{pass:0, fail:0, error:0, none:2}` — sum 2 |
| Partly judged | `["TD-1", "TD-2", "TD-3"]` (1 pass, 1 fail, 1 unjudged) | `{pass:1, fail:1, error:0, none:1}` — sum 3 |

A companion test (`test_a_verdict_for_a_definition_the_run_no_longer_carries_counts_nothing`) confirms a verdict for a definition the run's current `definition_ids` no longer lists counts as nothing extra, not a phantom fifth entry.

### The five definition states — all rendered correctly

`api/tests/test_verdict_rollups.py::test_definition_verdicts_covers_the_five_states` — **PASS**.

| Input | `verdict_state` | `latest_verdict` |
|---|---|---|
| `actual_runs=0` | `not_run` | `None` |
| `actual_runs=1`, no verdict document | `no_verdict` | `None` |
| newest verdict outcome `pass` | `passed` | `{run_id, result_id, outcome: "pass", produced_at}` |
| newest verdict outcome `fail` | `failed` | as above, `outcome: "fail"` |
| newest verdict outcome `error` | `error` | as above, `outcome: "error"` |

Also verified: a higher `version` supersedes within one `(run, definition)` pair regardless of `produced_at` (`test_a_higher_version_supersedes_within_one_run_definition_pair`); a re-run after a fix reads the newest `produced_at` across runs (`test_a_definition_re_run_after_a_fix_reads_its_newest_attempt`); `_outcome` reads any stored value outside `{pass, fail, error}` as `error`, never as unjudged (`test_outcome_reads_an_unrecognised_stored_value_as_error`).

### Wiring — confirmed, both screens

- `test_with_verdicts_overlays_the_run_list` — `queries_runs.with_verdicts` overlays `RunVerdicts` onto a run doc correctly.
- `test_derived_definitions_overlay_verdict_state_beside_status` — `_derived_definitions` carries `verdict_state`/`latest_verdict` beside an unmoved `status` (`"on_plan"` stays `"on_plan"` regardless of the verdict).
- `test_get_test_definition_detail_carries_the_same_verdict_state` — the detail route's overlay agrees with the list's.

### Bug 1.1: the two verdict folds can name opposite outcomes for the same definition, contradicting the architecture doc's own consistency claim

**Test:** `test_the_definition_verdict_and_the_requirement_it_covers_can_disagree` in `api/tests/test_verdict_rollups.py` — **RED** (confirmed real, not a broken test)
**Spec reference:** `dev-planning/verdict-rollups/architecture.md`, "Integration" section: "It reads the same `(run, definition)` winners by the same version rule, so a requirement reading `failed` and its covering definition reading `Failed` are the same evidence seen from two ends."
**Expected:** Per that claim, if `verdict_rollups.definition_verdicts` reads a definition as `passed`, the requirement it covers should read `tested` (§3.3's mapping for a passing outcome) — the same evidence, seen from two ends.
**Actual:** `verdict_rollups.definition_verdicts` picks the newest verdict by `provenance.produced_at` **across every run that currently carries the definition**. `queries_requirements._fold_inputs`/`_newest_verdict_of_td` picks a different run: it walks the covering definition's runs newest-`first_data_at`-first and stops at **the first run that carries any verdict at all** — which is not necessarily the run with the newest `produced_at`. When a definition is re-evaluated on an *older* bench session (earlier `first_data_at`, but a *later* `produced_at` — e.g. a person re-ran the same session's implementation after a fix) while a *newer* session's original attempt still stands, the two folds can pick opposite winning runs and report opposite outcomes: the definitions screen reads **Passed**, the requirement it covers reads **failed**, on the identical underlying data.
**Reproduction:** Seed two runs on one definition — `R-early` (`first_data_at` Jan 2026, verdict `pass`, `produced_at` Sep 2026) and `R-late` (`first_data_at` Jun 2026, verdict `fail`, `produced_at` Feb 2026). `verdict_rollups.definition_verdicts` reads `R-early`/`passed` (newest `produced_at` wins). `queries_requirements._project` reads `R-late`/`failed` (newest `first_data_at` with any verdict wins, and `R-late` sorts before `R-early` in that ordering). Run: `cd api && uv run pytest tests/test_verdict_rollups.py::test_the_definition_verdict_and_the_requirement_it_covers_can_disagree -q`.
**Root cause layer:** architecture
**Suspected root cause:** Two independently-written folds implementing two different reductions of "the current verdict of a definition" — `verdict_rollups`'s explicit newest-`produced_at` rule (this build) versus `queries_requirements`'s pre-existing newest-`first_data_at`-with-any-verdict rule (unchanged by this build). The architecture doc's Integration section asserts parity that was never verified against the pre-existing module.
**Suggested fix:** ArchDev decides. Candidates: (a) make `queries_requirements` use `verdict_rollups._latest_key`'s reduction instead of its own, since the "re-run after a fix" reading is what `dev-planning/verdict-rollups/architecture.md` and `test-results-page/spec.md` §3.3 both describe as intended; (b) if `queries_requirements`'s newest-*session* rule is intentional for a different reason, correct the Integration section's claim and document why the two answers may differ. Either way, `dev-planning/test-results-page/spec.md` §3.5 (BL-51) already proposes folding `verdict_rollups` and `queries_requirements`'s fold into one shared module — this is the concrete argument for doing that folding now rather than later, since the two are observably inconsistent today.

**Not this diff's fault, filed for completeness rather than left silent:** this divergence exists because `queries_requirements`'s reduction rule predates this build and was never changed by it (confirmed via `git diff` — the module is untouched in this change). The bug is that the new architecture doc's Integration section makes a parity claim about the *existing* module without verifying it.

## Round 1 summary

Everything besides Bug 1.1 is green or traced to an already-documented, unrelated baseline gap (BL-25, BL-48, BL-31-adjacent numpy environment gap, and the two named frontend unit failures). No regression from this diff in any suite that could be run. `test_the_definition_verdict_and_the_requirement_it_covers_can_disagree` is intentionally left RED in the committed suite — it is a characterization test proving the inconsistency is real, not a broken assertion; ArchDev's fix (whichever side it changes) should turn it green as a side effect.

## Round 2 — 2026-09-25

### The RED test, now green

`api/tests/test_verdict_rollups.py::test_the_definition_verdict_and_the_requirement_it_covers_can_disagree` — **PASS**. `cd api && uv run pytest tests/test_verdict_rollups.py -q` → `13 passed`.

The test file is **untracked** (new file, never committed), so there is no `git diff` to compare against my Round 1 authoring. Two independent checks stand in: (1) `grep -c "^def test_"` on the file returns 13 — the same count Round 1 reported (1 red + 12 green); (2) the file's mtime (`2026-09-25 12:43:23`) predates `verdict_rollups.py`'s mtime (`2026-09-25 13:01:12`), i.e. the test file was last written *before* ArchDev's fix landed, consistent with nobody having touched it since I wrote it. I did not edit this file this round. Treating it as unmoved.

This test is also the both-paths-agree test the brief's item 3 asks for: it seeds `TD-1` on two runs — `R-early-session-late-verdict` (`first_data_at` Jan 2026, verdict `pass`, `produced_at` Sep 20) and `R-late-session-early-verdict` (`first_data_at` Jun 2026, verdict `fail`, `produced_at` Feb 1) — the exact shape Bug 1.1 lived in (newer `produced_at` sitting on the older `first_data_at` session). Both `verdict_rollups.definition_verdicts` and `queries_requirements._project` now read the Sep-20 `pass` as current: `definition_side["TD-1"]["verdict_state"] == "passed"` and `requirement_side["verification_state"] == "tested"`. A test with only one candidate run per definition could not have caught the original bug and would not prove this; this one has two, on purpose.

### `view_counts` — measured, not reasoned

Built a fixture matching the live production shape ArchDev described: 10 requirements, 10 definitions (1:1, each `covers_req_ids` one requirement), 10 runs (1:1, each carrying one definition, none invalid-flagged, none re-run), 5 of the 10 definitions carrying exactly one verdict document each (2 `fail`, 3 `pass`), the other 5 runs carrying no verdict yet. Ran `queries_requirements._project` + `_view_counts` over this fixture twice: once against the current (post-fix) module, once against `git show HEAD:api/api/services/queries_requirements.py` (the committed pre-fix module, dynamically loaded via `importlib`, executed against the same seeded Mongo database and the same requirement docs).

```
BEFORE: {'all': 10, 'not_covered': 0, 'covered': 0, 'exercised': 5, 'failed': 2, 'tested': 3}
AFTER:  {'all': 10, 'not_covered': 0, 'covered': 0, 'exercised': 5, 'failed': 2, 'tested': 3}
```

**Identical.** No definition's winner moved. This is expected, not a coincidence: in the live shape each definition has verdicts on at most one run, so both reductions (`newest-produced_at-across-every-run` vs the old `newest-first_data_at-run-with-any-verdict`) have exactly one candidate and `max()` over a single-element set can't disagree with itself. ArchDev's "unchanged" claim was correct; it just hadn't been executed before now. This script and its harness were scratch (`api/tests/zz_scratch_view_counts_test.py`, run and deleted — not committed, since it hardcodes a temp-file path to the extracted pre-fix source and has no standing value as a permanent regression test).

### The documented candidate-set gap — confirmed present, confirmed not new

Reproduced the divergence the architecture doc's module docstring names (invalid-flagged run kept by `definition_verdicts`, dropped by `queries_requirements`): one definition, one run, `invalid.flagged=True`, one `pass` verdict on it.

```
definition_side:   passed   (verdict_rollups.definition_verdicts — no invalid filter)
requirement_side:  covered  (queries_requirements._project — invalid runs excluded, so "no run has judged it yet")
```

Matches the docstring's own description exactly (`api/api/services/verdict_rollups.py:9-11`). This is the pre-existing, already-assigned BL-51 gap — present before this round's fix, present after it, unchanged by the shared-reduction work. No new divergence found beyond it.

### Your 12 other rollup tests

Unmoved — full file run is `13 passed` (see above), and no test in the file was edited this round.

### Gates, Round 2

| Gate | Command | Result |
|---|---|---|
| ruff check (touched files) | `cd api && uv run ruff check api/services/verdict_rollups.py api/services/queries_requirements.py` | PASS — 0 errors |
| ruff format --check (touched files) | same, `--check` | 1 file flags 2 spots (`queries_requirements.py` lines 333, 597-628) — both outside every diff hunk (`git diff` hunks are only lines 32-168); confirmed pre-existing debt, not introduced this round |
| pytest api | `cd api && uv run pytest tests -q` | **35 failed, 2704 passed, 8 skipped.** Round 1 was 36 failed / 2703 passed (35 pre-existing + 1 intentional red). The intentional red is now the +1 passed; the 35 pre-existing failures are unchanged in count. `new=0 pre-existing=35`. |
| tsc --noEmit | `cd frontend && npx tsc --noEmit` | PASS — 0 errors |
| fe unit | `cd frontend && npm run test:unit` | 2 failed / 956 passed. Same two named failures as Round 1 (`filters-pagination.test.ts`, `lake-partitions.test.ts`). `new=0 pre-existing=2`. |
| fe component | `cd frontend && npm run test:components` | First run: 20 failed / 928 passed — one extra failure, `single-select.test.tsx`'s `aria-expanded` assertion, in a file untouched since 2026-09-22 (well before this round and before Round 1). Re-ran that file alone 3× and it passed 3/3; re-ran the full suite once more and got 19 failed / 929 passed, matching Round 1 exactly. Treated as a one-off timing flake unrelated to this diff, not a regression. `new=0 pre-existing=19`. |
| fe contract | `cd frontend && npm run test:contract` | 1 failed / 27 passed / 6 expected-fail — same `01 home summary` (BL-25 staleness). `new=0 pre-existing=1`. |

**`new=0 pre-existing=57`** (35+2+19+1), matching Round 1's total exactly. No regression anywhere.

### Root `tests/` — now collects and runs

Fixed for this session (not a code change — an interpreter choice): `py -3.12` (`C:\Users\lbazj\AppData\Local\Programs\Python\Python312\python.exe`, the same one the main thread used to regenerate the traces) already carries `numpy 2.2.6`, `asammdf 8.8.9`, `cantools 42.0.3`, `canmatrix 1.2`, `quixstreams 3.23.4+williams.qcs.metadata.bootstrap.filter`, `quixportal 2.0.1` and `pytest`. Neither the root `.venv` nor `api/.venv` carries these; `py -3.12 -m pytest tests --collect-only -q` collects all 105 tests cleanly, no `pymongo` needed anywhere in this suite.

`py -3.12 -m pytest tests -q` → **19 failed, 86 passed** (1 warning, unrelated numpy RuntimeWarning in a variance calc on degenerate input). Of the 19: 10 match BL-31's named list exactly (5× `test_a_path_unsafe_id_is_refused[*-definition_id]`, `test_a_claim_in_the_filename_is_read`, `test_a_typed_claim_beats_the_filename`, `test_the_claim_rides_in_both_spellings`, `test_the_declared_bag_survives_the_connector_s_filter`, `test_the_declared_tree_is_the_traceability_chain`). The other 9 are **not** in BL-31's list and are new information — this suite has never run before this session: all 7 of `test_architecture_law.py`'s failures, plus `test_sink_partitioning.py::test_the_traceability_columns_reach_every_row` and `::test_an_unclaimed_batch_partitions_as_unassigned`. None of this touches `api/` — the module this round's diff changed — so nothing here is a regression from the verdict-rollups fix; it is simply the first real measurement of a suite that predates this round's scope entirely. Flagging for the backlog rather than chasing: out of this round's checklist (verdict-rollups only).

**Environment fix, precisely stated:** neither `.venv` needs to gain these packages — `py -3.12` already has them system-wide. The gap was never "missing package," it was "wrong interpreter selected by `python -m pytest`." Whoever owns CI should either point the root suite's runner at `py -3.12` (or an equivalent venv built from `mf4-decoder/requirements.txt`) or document that this suite is meant to run under a decoder-flavoured environment, not the API's.

### Round 2 summary

Bug 1.1 is fixed and proven fixed by measurement, not just by the fix compiling. `view_counts` is bit-for-bit unchanged before/after, measured (not reasoned) against a production-shaped fixture. The documented candidate-set gap (BL-51) is confirmed real and confirmed unchanged. All previously-green gates stay green at the same counts as Round 1; the one apparent new frontend-component failure was a reproducible-only-once flake in an untouched file, ruled out by re-running. Root `tests/` now collects and runs for the first time this session, surfacing 9 failures outside BL-31's scope — new baseline information, not a regression, and out of this round's remit.

**Exit condition: (a) all tests green** for the verdict-rollups scope this round covers. No open bug against this diff.
