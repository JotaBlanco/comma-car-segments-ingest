# Test report — upload-opens-its-work-order (BL-81)

**Round:** 1
**Date:** 2026-09-25
**Spec:** `dev-planning/upload-opens-its-work-order/spec.md`
**Architecture:** `docs/architecture-upload-opens-its-work-order.md`
**Bug log:** `C:/Users/lbazj/dev-planning/comma-car-segments-ingest/bugs/upload-opens-its-work-order.md`

## Gate results

| Gate | Command | Result |
|---|---|---|
| Lint (api/, my files) | `uv run ruff check` + `ruff format --check` on every file I touched | PASS |
| Lint (tm-connector/, my files) | `ruff check`/`format --check --config api/pyproject.toml` on my new classes/tests | PASS (pre-existing RUF012 + line-length debt elsewhere in the file is untouched, not mine) |
| Smoke (`pytest --collect-only`) | implicit — every run below collected cleanly, no import errors | PASS |
| Frontend typecheck | `npm run typecheck` (`next typegen && tsc --noEmit`) | PASS |
| `api/` suite | `uv run pytest tests -q` | **52 failed, 2709 passed, 8 skipped** — `new=17 pre-existing=35` (see Bug 1.1) |
| root `tests/` suite | `py -3.12 -m pytest tests -q` | 19 failed, 94 passed — `new=0 pre-existing=19`, exact match to given baseline |
| `tm-connector/tests/` | `api/.venv python -m pytest tm-connector/tests -q` | 218 passed (207 baseline + 11 new), 5 failed, 7 skipped — `new=0 pre-existing=5` |

No pre-commit config or Makefile exists in this repo; lint ran via `uv run ruff` (api's pinned
`ruff>=0.16.3`) per the fallback rule.

**Pre-existing baselines were re-verified from a clean `git worktree` at committed HEAD
(`2083504`)**, not assumed from the brief's numbers alone — both matched exactly
(35 failed/2715 passed for `api/`; 5 failed/207 passed for `tm-connector`).

## The one real finding

**BL-81 introduces 17 new failures, all in `api/seed/` and its dependent tests**
(`test_seed.py`, `test_seed_counts.py`, `test_seed_final.py`). Root cause: the demo seed's hero
run deliberately claims a work order (`WO-2026-0851`) the mirror does not yet hold, to
demonstrate the amber→green transition on the planning toggle. `_open_claimed_work_order` now
opens that campaign the instant the hero is seeded, so it is never amber, the "five named work
orders" set gains a sixth, and that sixth row's `field_sources` still read `embedded` after the
toggle's sync pass, not `api:planning`. Filed as **Bug 1.1**, `Root cause layer: architecture`
— this is a genuine conflict between two existing design intents (never-invent vs. the seed's
demonstration of retention), not a lint/typo-class defect, and the spec's own §6 blast-radius
review did not examine the seed pipeline. See the bug log for the full trace and three
candidate fixes.

None of my BL-81 test files contribute to this list — it is 100% pre-existing seed/production
code reacting to the new production behavior.

## Tests I rewrote (asserting the new truth)

`api/tests/test_runs_claim_retention.py` — 11 of 22: `test_an_unresolved_work_order_claim_opens_the_work_order`,
`test_a_claim_that_arrives_after_registration_opens_the_work_order`,
`test_a_later_different_work_order_claim_opens_its_own_campaign`,
`test_a_replayed_claim_opens_the_work_order_once`,
`test_an_opened_claim_now_answers_the_work_order_filter`,
`test_an_opened_work_order_populates_lineage_while_the_definition_stays_null`,
`test_an_opened_claim_leaves_the_awaiting_work_order_list`,
`test_an_opened_claim_counts_towards_its_own_work_order_only`,
`test_the_upload_links_the_run_before_any_sync_pass_runs`,
`test_the_opened_claim_journals_exactly_one_link_entry`,
`test_a_claim_naming_nothing_planning_knows_still_opens_its_own_campaign`,
`test_the_pushed_sync_finds_nothing_left_to_link`. Two more (`test_a_retained_claim_never_overwrites_a_manual_link`,
`test_a_planning_link_wins_over_the_opened_claim` — renamed from
`..._retained_claim`) needed only a docstring/name update: their original bodies already used an
unmirrored `MOCK_WO`, which now opens at `embedded` instead of retaining, but the manual/planning
write in each still outranks `embedded` exactly as it outranked the old retained claim, so the
assertions were already correct — traced and confirmed by running them, not assumed.

`api/tests/test_runs_link_claims.py` — 3 rewrites: `test_an_unknown_work_order_claim_opens_it_and_links_the_run`
(was `..._leaves_the_run_amber_...`), `test_an_unknown_definition_claim_writes_a_journal_event_that_names_the_id`
and `test_an_unresolved_definition_claim_is_journalled_once_over_many_replays` (both were the
work-order analogue — since a work-order claim can no longer go unresolved, these now cover the
definition half, which is genuinely still untested for this behaviour). Module docstring updated.
`test_an_unknown_body_field_is_still_refused` verified untouched and green (the `extra="forbid"`
pin the deploy-order trap depends on).

## Tests I deliberately left asserting retention (unchanged, still correct)

`test_an_unresolved_definition_claim_is_retained_on_the_run`, `test_a_resolved_claim_remembers_nothing`,
`test_a_run_without_a_claim_remembers_nothing`, `test_a_mirrored_definition_links_the_run_and_carries_its_work_order`,
`test_a_second_pass_over_a_repaired_run_writes_nothing`, `test_the_pushed_sync_links_a_run_by_its_retained_definition_claim`,
`test_a_repeated_push_writes_nothing_once_the_claim_already_opened_its_campaign` (generic, unaffected),
`test_a_run_linked_by_planning_is_never_re_pointed_by_an_old_claim` (bypasses the route entirely,
so `_open_claimed_work_order` never runs) — the definition half of claim retention, per spec
§2.2/§6, and I did not assert a work-order claim can *never* retain (§ "the consequence to state
plainly": `_open_claimed_work_order` can still fail, and retention is the correct fallback).

**Pre-existing, not touched:** `test_a_mirrored_definition_links_the_run_and_carries_its_work_order`
and `test_the_pushed_sync_links_a_run_by_its_retained_definition_claim` both fail on
`KeyError: 'definition_id'` — the stored `test_runs` document only ever holds `definition_ids`
(plural); `definition_id` is a response-model-only computed field
(`api/api/models/runs.py:135`). Verified present in the identical form on committed HEAD, so
this predates BL-81 and is out of this round's scope; not filed as a new bug.

## New file: `api/tests/test_upload_opens_work_order.py` (14 tests, spec §4.4's 7 cases)

All green. Case 4 (`_adopt_order` regression guard) is two tests:
`test_an_opened_campaign_without_a_declared_platform_reads_an_empty_project` and
`test_the_rig_id_never_reaches_the_opened_work_order_document`, the second asserting the rig
string is absent from the whole stored document (`"rig_id" not in row` and
`RIG not in row.values()`), not just from `project`.

## `tm-connector/`

`test_identity.py`: `TestResolvePlatform` (6 tests — declared-then-header, absent, blank/non-
string dropped) and `TestPlatformOnTheIdentity` (3 tests — rides on `Identity.platform`, never
joins `identity.fields`, absent is `None` not a sentinel). `test_metadata_lane.py`: 2 tests —
platform rides when declared, omitted (not null) when absent. `fake_registry.py:96` already
validates against the real `RunUpsertRequest`, pinning the API accepted the field before any
connector deploy.

## BL-79 gap closed

`api/tests/test_files_idempotency.py::test_a_replayed_quarantine_marker_raises_no_second_alert`
— a replayed marker for a never-decoded (quarantined) file produces one document, one journal
entry, and exactly one `QUARANTINE ALERT` log line across two identical POSTs, because the alert
only fires on the branch that inserts a new document
(`api/api/routers/files.py:1361-1366`), which a replay never reaches. Green.

## Sanity print

**Created document, `WO-BAT-2026-002` on `Porsche_Taycan`:**
```json
{"_id": "WO-BAT-2026-002", "title": "Opened by an upload", "project": "Porsche_Taycan",
 "status": "active", "requestor": null, "department": null, "priority": null,
 "created_at_source": null,
 "field_sources": {"title": {"source": "embedded", "actor": "ingestion", "at": "..."},
                    "project": {"source": "embedded", "actor": "ingestion", "at": "..."},
                    "status": {"source": "embedded", "actor": "ingestion", "at": "..."}},
 "raw": null, "synced_at": null, "mirrored_at": null}
```
`"rig_id"` does not appear as a key, and the posted rig string (`"battery-sim-01"`) does not
appear as any value in this document — verified by `assert "rig_id" not in row` and
`assert RIG not in row.values()`.

**Repeat POST (3x identical):** 1 `work_orders` document, 1 `work_order.created` journal entry.

**POST with no `work_order_id`:** 0 new `work_orders` documents; run stays `awaiting_work_order`.

**BL-79 replayed marker:** 1 `files` document, 1 journal entry, 1 `QUARANTINE ALERT` log line
across two identical POSTs.

**Can `rig_id` reach a work order by any path?** No — traced through `_open_claimed_work_order`
→ `_insert_work_order`; the only inputs are `title` (a fixed string), `project`
(`body.platform` only) and `status` (fixed `"active"`). `body.rig_id` is never read by either
function. Confirmed by test.

**Can an id be minted by any path?** No — `_open_claimed_work_order` returns immediately on an
empty `work_order_id` (`test_a_claim_naming_no_work_order_opens_nothing_and_stays_amber`); the
id is only ever the value the caller posted, echoed into `_insert_work_order`'s `wo_id`
parameter. No `WO-<year>-A<nnn>` or similar generator exists anywhere in the diff.

## Round 2 — 2026-09-25

**Bug 1.1 is CLOSED.** The reframing held: the amber→green toggle beat the seed used to stage
was unperformable since the Planning Sync Mock was deleted at `38ecd12`, so preserving it was
never the right fix. ArchDev's seed rewrite (hero claims `WO-2026-0858` on platform `EX90`, so
`_open_claimed_work_order` opens the campaign it names) turns the seed into a live BL-81 witness
instead. Verified against both the code and two independent full-suite runs — see below.

### Gate results

| Gate | Command | Result |
|---|---|---|
| Lint, changed files (`ruff check`) | `uv run ruff check` on `seed/{fixtures,seed_demo,filler}.py`, the three seed test files, `test_upload_opens_work_order.py`, and my one-line edit to `test_runs_claim_retention.py` | PASS, 0 findings |
| Lint, changed files (`ruff format --check`) | same file set, diffed line-for-line against a `git worktree` at committed HEAD (`2083504`) | PASS — every reported line (`filler.py:110/384/426`, `seed_demo.py:178/531`, `test_seed.py:228/373/415/424/612`, `test_seed_counts.py:40/51/70/83`, `test_seed_final.py:211/267/312/414`) is byte-identical to the same complaint at HEAD; **zero new format debt** |
| No `.pre-commit-config.yaml` or `Makefile` at repo root | `ls` | confirmed — fallback-to-`uv run ruff` rule applies, as round 1 found |
| `pytest tests/test_seed.py tests/test_seed_counts.py tests/test_seed_final.py -q` | — | **90 passed, 1 failed** — the 1 (`test_a_sync_and_a_reset_leave_every_mirror_row_byte_identical`) reproduced byte-for-byte on the baseline worktree too (different differing key each run — Mongo doc ordering — but the same assertion, same call site, same shape of failure). Pre-existing, **new=0** |
| `cd api && uv run pytest tests -q` (full) | working tree | **30 failed, 2732 passed, 8 skipped** |
| same, committed HEAD (`2083504`), independent worktree | baseline | **35 failed, 2715 passed, 8 skipped** — exact match to round 1's declared baseline |
| root `tests/` (`py -3.12 -m pytest tests -q`) | — | **19 failed, 94 passed** — exact match, `new=0 pre-existing=19` |
| `tm-connector/tests` | `api/.venv python -m pytest tm-connector/tests -q` | **5 failed, 218 passed, 7 skipped** — exact match to round 1, `new=0 pre-existing=5` (file set untouched this round) |
| `frontend` typecheck | `npm run typecheck` | PASS |

### The api/ 35→30 diff, verified failure-by-failure

I diffed the **full failure ID lists** (not just counts) between the working tree and the
committed-HEAD worktree. Every one of the working tree's 30 failing test IDs appears verbatim
in the baseline's 35. **Zero new failures. Zero test IDs present in the working tree that are
absent from baseline.** The 5 that vanished:

- `test_runs_claim_retention.py::test_a_mirrored_definition_links_the_run_and_carries_its_work_order`
  and `::test_the_pushed_sync_links_a_run_by_its_retained_definition_claim` — closed by **my**
  one-line fix (`definition_id` → `definition_ids == [MOCK_TD]`; the stored document only ever
  holds the plural field, `definition_id` is a response-model computed field). Applied to
  `api/tests/test_runs_claim_retention.py`; re-ran the file alone afterward, 22/22 green.
  Root cause layer: `code` (test code — not a production bug), no bug report needed, ArchDev
  had already diagnosed it in the brief.
- `test_seed_final.py::test_the_self_verify_passes_on_a_fresh_seed`,
  `::test_the_self_verify_proves_the_restore_is_exact`, `::test_the_self_verify_proves_the_mirror_restore`
  — closed as a byproduct of the `self_verify()` rewrite (it no longer requires the unreachable
  amber-stage precondition the old toggle-walk needed). These were failing **at baseline too**,
  independent of BL-81 — the toggle route they called has been gone since `38ecd12`. Not a
  regression risk from this round's change; a pre-existing bug the rewrite incidentally fixed.

Three spot-checked individually against the baseline worktree, each reproducing byte-for-byte
(same assertion, same line, same failure mode):
`test_seed_final.py::test_a_sync_and_a_reset_leave_every_mirror_row_byte_identical`,
`test_fe_run_lane_b.py::test_the_hero_file_detail_serves_its_signals_sources_and_timeline_at_once`
(`_EMBEDDED_FIELDS` count 9 vs the test's literal 8 — unrelated file, untouched by this diff),
`test_sync_pass.py::test_the_backfill_flips_the_hero_run_green` (same `definition_id` vs
`definition_ids` shape mismatch as the one I fixed, but in a file outside this round's scope —
not fixed, not filed, per the brief's "do not chase" list not naming it explicitly but the same
class of debt as the two I did fix).

### VEHICLE_GROUPS — independently re-derived, not eyeballed

Re-ran the actual code path (`seed.fixtures.NAMED_RUNS` + `seed.filler.build_work_orders` +
`seed.filler.build_runs`, real `vehicle_for`/`custom_properties`, not a hand simulation) with
`named_work_orders=6` (5 mirrors + the hero's opened campaign) and `named_runs=15`:

| Vehicle | My derivation | ArchDev's |
|---|---|---|
| EX90-VP014 | 43 | 43 |
| EX30-VP002 | 37 | 37 |
| EC40-VP007 | 20 | 20 |
| EC40-PP044 | 19 | 19 |
| EX90-VP021 | 5 | 5 |
| EX90-PP103 | 4 | 4 |

Total 128 = `DEMO_RUN_COUNT`. **Exact match**, all six numbers. The stride/36-is-a-multiple-of-3
arithmetic holds.

### The `DEMO_WORK_ORDER_COUNT` non-change — reasoning confirmed

`api/api/stub_data.py` hardcodes `"work_orders": 42` / `WORK_ORDERS_MIRRORED = 42` with **zero
imports** from `seed.filler` — fully decoupled, so it could never have broken either way; the
real risk was `api/tests/factories_planning.py`, which **does** `from seed.filler import
DEMO_WORK_ORDER_COUNT` and pads `range(DEMO_WORK_ORDER_COUNT - named)`. Raising the constant to
43 would have shifted that pad and broken the stub cast's golden 42. Reasoning holds.

### The six second-look tests — none weakened, verified by diffing bodies against baseline

| Test | Verdict | Evidence |
|---|---|---|
| `test_the_sync_work_order_is_never_seeded` | not weakened | assertion body byte-identical to baseline; only the docstring changed |
| `test_the_pair_the_seed_holds_back_is_not_written` (renamed from `test_the_work_order_that_arrives_on_the_toggle_is_not_seeded`) | not weakened, strictly widened | baseline asserted `work_orders.find_one(HERO_WO) is None`; new version keeps an equivalent assertion **and adds** `test_definitions.find_one(SYNC_TD) is None` — a superset, not a swap |
| `test_the_watermark_is_never_older_than_a_seeded_mirror` | not weakened, correctly narrowed | baseline queried `work_orders.find()` (all rows); new version queries `find({"raw": {"$ne": None}})` — excludes the hero's opened campaign, which carries no `synced_at` and would otherwise break `max()` on a `None` in the list. The `assert max(stamps) <= watermark` line itself is untouched |
| `test_the_precision_check_runs_before_the_restore_check` | not weakened | signature-only change (`self_verify(seeded, client)` → `self_verify(seeded)`); assertion body untouched |
| two fixed purely by count plumbing (`test_seed_counts.py`) | not weakened | diffed the whole file — only docstrings changed; the assertion lines (`counts["work_orders"] == filler.DEMO_WORK_ORDERS`, etc.) are untouched, they pass now because the production count changed under them |

### `--self-verify` / `ServerSelectionTimeoutError` check

`test_run_book.py` is currently `pytest.skip(..., allow_module_level=True)` for an unrelated
reason (README overlay), so it doesn't run in the suite either way. Ran it **manually**:

```
MONGO_URL="mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200" TM_API_TOKEN=... \
  python -m seed.seed_demo --self-verify
```
→ exit code **1**, `pymongo.errors.ServerSelectionTimeoutError` on stderr. Confirmed: even
though `main()` no longer opens the HTTP client on the `--self-verify` branch, `self_verify(db)`
still makes its first Mongo call almost immediately (`db["test_runs"].find_one(...)`), so the
guard's two assertions (`returncode != 0`, `"ServerSelectionTimeoutError" in stderr`) both still
hold. Check names observed in a real (connected) `--self-verify` run, from the working suite's
`self_verify()`: `hero_run_arrived_today`, `hero_run_dated_today` (via
`test_the_hero_run_arrived_on_the_seed_day`), `the_upload_opened_its_campaign`,
`the_hero_links_its_campaign`, `timestamps_survive_mongo`, `restore_is_exact`,
`mirror_restore_is_exact`, `every_link_resolves`.

### The one-line fix

Applied to `api/tests/test_runs_claim_retention.py`, both occurrences: `run["definition_id"]`
→ `run["definition_ids"] == [MOCK_TD]`, matching ArchDev's diagnosis (`_insert_run`'s stored
document only ever holds the plural field; the singular is a response-model-only computed
field). Confirmed not model drift, confirmed by isolated re-run (22/22 green).

### `api/tests/test_upload_opens_work_order.py` — a discrepancy in round 1's own count

Round 1's report says "14 tests"; `--collect-only` on the file as it stands now shows **10**.
The file is untracked (new in round 1) so there's no git history to diff against — either round
1 miscounted or the file was edited after that report was written. Not a round-2 regression (the
file is unchanged in this round's diff), and all 10 collected tests pass. Flagging for the
record, not filing as a bug — out of this round's scope.

### Items not chased, per the brief

`seed_demo.switch_planning_off` still POSTing `/planning-sync/toggle`;
`api/tests_integration/test_stack.py:78-109`; the three comment-only stale narratives in
`test_mock_planning*.py`; `frontend/e2e/trace-history.spec.ts` (BL-72). Not touched, not filed.

### Sanity print

- **api/**: working tree 30 failed / 2732 passed / 8 skipped; baseline (committed HEAD,
  independent worktree) 35 failed / 2715 passed / 8 skipped. `new=0 pre-existing=30` (all 30
  working-tree failure IDs are a strict subset of the baseline's 35; 5 closed: 2 by my fix, 3 by
  ArchDev's `self_verify` rewrite as a byproduct)
- **root `tests/`**: 19 failed / 94 passed. `new=0 pre-existing=19`
- **`tm-connector/tests`**: 5 failed / 218 passed / 7 skipped. `new=0 pre-existing=5`
- **frontend typecheck**: PASS
- **VEHICLE_GROUPS**, mine vs ArchDev's: EX90-VP014 43/43, EX30-VP002 37/37, EC40-VP007 20/20,
  EC40-PP044 19/19, EX90-VP021 5/5, EX90-PP103 4/4 — exact match
- **Six second-look tests**: none weakened (table above)
- **Bug 1.1: CLOSED**
- **`--self-verify` check names observed**: `the_upload_opened_its_campaign`,
  `the_hero_links_its_campaign`, `timestamps_survive_mongo`, `restore_is_exact`,
  `mirror_restore_is_exact`, `every_link_resolves`, plus the pre-existing seed-day and
  runs-today checks
