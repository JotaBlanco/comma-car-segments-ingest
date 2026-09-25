# Bug Log: planning-mock-removal

**Spec:** Task brief (no standalone Buddy spec file for this change — verification-only task)
**Test suite:** `frontend/e2e/`, `api/tests/`, root `tests/`

## Round 1 — 2026-09-24

### Finding 1.1: git stash near-miss with the parallel agent (process note, not a bug)

While diagnosing whether frontend eslint findings were pre-existing, I ran `git stash -u`
to get a clean tree, which also stashed the parallel agent's in-flight edits to
`definition-detail-screen.tsx`, `requirement-detail-screen.tsx`, `work-order-detail-screen.tsx`,
`definitions-screen.tsx`, `edit-requirement-dialog.tsx`, `add-work-order-dialog.tsx` and
`docs/test-manager-integration.md`. Their concurrent edit to `definition-detail-screen.tsx`
made `git stash pop` conflict. The stash was never dropped (git kept it, "stash entry is kept
in case you need it again"), and a later `git status` showed the stash had been fully
reconciled — all 13 of my original files, all of the parallel agent's files (now expanded
to 7), and my own e2e edits were present simultaneously with an empty `git stash list`.
Verified via `git diff --stat` spot-checks that content was intact afterward. No data was
lost, but flagging the process risk: **do not run `git stash` in a shared working tree while
another agent is live-editing it.**

**Root cause layer:** unclear (tooling/process, not app code)

### Finding 1.2: `trace-history.spec.ts` step 1 now depends on unfinished parallel-agent work

After repairing the toggle dependency (see below), running the spec against a live build
gets past setup and step 1's navigation, then fails on:
```
Expected: visible
getByText(/Read-only mirror — owned by the planning system/)
```
`work-order-detail-screen.tsx` (parallel agent's file, mid-edit) no longer contains the
string "Read-only mirror" or "mirrored" at all — grep confirms zero matches. This is not
caused by the toggle removal; it's a side effect of the parallel agent's own in-progress
change to that screen. I did not edit the assertion or the file, per the constraint not to
touch parallel-agent-owned files. This will need re-verification once their work lands.

**Test:** `frontend/e2e/trace-history.spec.ts` — `browser e2e`
**Spec reference:** N/A — collision with a concurrent, unrelated, unfinished change
**Root cause layer:** unclear (depends on parallel agent's still-in-progress work)
**Suggested fix:** Re-run `npx playwright test e2e/trace-history.spec.ts` once the parallel
agent's four files are finalized; if the mirror banner was deliberately removed, the
assertions at trace-history.spec.ts:60-65 need updating to match the new wording (my
mandate this round was only the deleted-toggle dependency, not this).

### Finding 1.3: api/tests/ has 35 pre-existing failures unrelated to this diff — undisclosed baseline gap

`uv run pytest tests -q` in `api/` (pinned ruff/pytest via uv, mongo:7 testcontainer) gives
**35 failed, 2645 passed, 8 skipped**, reproduced identically across two independent clean
runs (test names and counts match run-to-run). None of the failing tests exercise
`ready()`/`planning_api` or any file this diff touches — `test_ready_endpoint.py` (6/6,
including a new test I added) and `test_auth.py` are fully green, as the brief predicted.
Root-caused one representative failure (`test_lineage.py::test_the_chain_appears_after_the_backfill`):
```
pymongo.errors.ServerSelectionTimeoutError: localhost:27017: ... actively refused it
  File "api\metrics.py", line 135, in refresh_storage_bytes
    rows = list(database["files"].aggregate(_STORAGE_PIPELINE))
```
`metrics.storage_worker()` (a background asyncio task started in `main.py`'s lifespan,
alongside `retention.purge_worker()`) connects to the **production default**
`mongodb://localhost:27017` instead of the test harness's `TM_TEST_MONGO_URL`-backed
container, because nothing in the test's `MONGO_URL` fallback wiring gets picked up by
whatever client this worker holds. No real Mongo listens on host port 27017 in this
environment, so the worker throws repeatedly in the background during every test run. This
is unrelated to `api/api/main.py`'s `ready()` edit (different function, different client) and
unrelated to every other file this diff touches. It is NOT on the brief's known-red baseline
(BL-48/BL-25/BL-31) — those only account for the root `tests/` suite and the openapi
snapshot. One of the 35 (`test_contract_snapshot.py::test_openapi_matches_the_committed_snapshot`)
IS the known BL-25 drift. The other 34 are a previously-undocumented pre-existing gap.

**Test:** `pytest api/` (35 of 35 failures traced to be pre-existing; representative:
`test_lineage.py::test_the_chain_appears_after_the_backfill`)
**Expected:** api/tests/ green modulo the documented BL-25/BL-48/BL-31 baseline
**Actual:** 35 failures, only 1 of which matches a documented baseline item
**Reproduction:** `cd api && uv run pytest tests -q` (needs Docker Desktop running)
**Root cause layer:** architecture (background worker's Mongo client does not honor the
test harness's Mongo URL override)
**Suggested fix:** ArchDev — worth a backlog item; recommend confirming whether
`metrics.storage_worker()`/`retention.purge_worker()` should read `get_client()`
(request-scoped/test-overridable) instead of building or defaulting their own connection.

### Round 1 summary — all other gates

Everything else is either PASS or traced to the already-known baseline; no new
regressions from the planning-mock-removal diff itself. See the sanity print in the
handback message for the full PASS/FAIL table and exact counts.

## Round 2 — 2026-09-25 (TDD, red-first regression proof for BL-72's aftermath)

### Bug 2.1: `create_work_order` never closes a retained claim — the loop it promises does not close on its own

**Test:** `test_opening_a_work_order_by_hand_closes_a_run_s_retained_claim` in
`api/tests/test_work_order_closes_claims.py`
**Spec reference:** `create_work_order`'s own docstring, `api/api/services/queries_runs.py:1862-1864`:
"A run that claimed this id before it existed is NOT linked here.
`planning_sync._write_link` is the one write path for a run's work-order link, and
`_link_retained_claims` closes the claim on the next sync pass."
**Expected:** Per that docstring, the claim closes on "the next sync pass." A run that
claimed a work order id before it existed should end up linked once that work order is
opened and a sync pass runs.
**Actual:** No sync pass runs on its own any more. `run_sync_pass`'s only caller was the
Planning Sync Mock's push worker, removed at `38ecd12`; `_link_retained_claims`'s other
caller sits inside the inbound `POST /planning/sync` receive path, which only fires when
something posts to it. `create_work_order` (the handler behind `POST /work-orders`, the
door a person uses to open a campaign by hand) calls neither. The run's `work_order_id`
stays `None` forever.
**Reproduction:** Seed a run with `status="awaiting_work_order"`,
`claimed_work_order_id="WO-2026-0910"`, `work_order_id=None` (the shape
`_link_retained_claims` waits on). `POST /api/v1/work-orders` with
`{"wo_id": "WO-2026-0910", "title": "...", "project": "EX90"}`. Re-read the run: assert
`run["work_order_id"] == "WO-2026-0910"`.
**Root cause layer:** architecture
**Suspected root cause:** `create_work_order` (`api/api/services/queries_runs.py:1852`) is
the only `work_orders` insert reachable from `POST /work-orders`, and it never calls
`planning_sync._link_retained_claims` (or any equivalent) after inserting the row.
**Suggested fix:** ArchDev decides, but the shape that already exists is
`_link_retained_claims(db)` — a call to it (or a narrower per-work-order variant) right
after the `insert_one` in `create_work_order` would close every run waiting on this id, the
same way a sync pass does.

**Verbatim RED output:**
```
AssertionError: the run's retained claim was never closed by create_work_order; work_order_id is still None
assert None == 'WO-2026-0910'
tests\test_work_order_closes_claims.py:55: AssertionError
```

A second test in the same file, `test_planning_sync_still_closes_the_same_claim`, proves
the surviving route (`POST /planning/sync` → `apply_planning_push` →
`_link_retained_claims`, `planning_sync.py:784`) still closes the identical claim shape
today — **PASS**. This documents the one route that must not regress when `create_work_order`
is fixed.

**Full suite, `cd api && uv run pytest tests -q`:** `36 failed, 2646 passed, 8 skipped` —
`new=1 pre-existing=35` against the Round-1 baseline (35 failed, 2645 passed, 8 skipped). The
`FAILED` list was diffed by name: every failure besides
`test_work_order_closes_claims.py::test_opening_a_work_order_by_hand_closes_a_run_s_retained_claim`
matches a file already named in Round 1's 35-failure baseline (background-worker Mongo
connectivity gap, `test_contract_snapshot.py` = BL-25). No other regression.
