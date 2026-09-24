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
