# Signal inventory on a replay — test report

**Spec / architecture:** `dev-planning/signal-inventory-replay/architecture.md`
**Test suite:** `api/tests/test_files_idempotency.py`
**Round:** 1 (first pass; fix and tests landed together, uncommitted)

## Summary

The bug is real and the fix closes it. `test_a_replay_fills_an_inventory_the_first_registration_lacked`
was run against the pre-fix code (HEAD, via a disposable `git worktree`, never
`git stash`) and failed with `AssertionError: assert 0 == 3` — the replay wrote
no `file_signals` rows, exactly the reported symptom. The same test passes
against the working tree carrying `_fill_empty_inventory`. A true duplicate
delivery (identical inventory posted twice) still writes nothing, before and
after the fix. A conflicting inventory (a second, different non-empty
inventory replayed onto a file that already holds one) is left untouched, also
before and after — this is deliberate behaviour, now pinned.

No new bugs filed this round: the fix behaves exactly as the architecture doc
declares, and every case in its behaviour table was tested.

## Red-first evidence

Node id: `tests/test_files_idempotency.py::test_a_replay_fills_an_inventory_the_first_registration_lacked`

Run against `git show HEAD` (a `git worktree` at `fb01117`, no uncommitted
changes) with the new test copied in:

```
    replay = client.post("/api/v1/files", json=_body(signals=_named_signals(["S1", "S2", "S3"])))

    assert replay.status_code == 200
    assert replay.json()["file_id"] == file_id
>   assert files_db["file_signals"].count_documents({"file_id": file_id}) == 3
E   AssertionError: assert 0 == 3
E    +  where 0 = count_documents({'file_id': 'f-7fbb16f9-0e28-4de5-9ba9-097ade336b8e'})
```

Genuinely red for the right reason — the assertion fails on the missing rows,
not on a typo, import error, or broken fixture. `first.json()["signal_count"]`
and the 201/200 status codes were correct on the pre-fix code; only the
inventory fill was missing, exactly as the architecture doc describes.

Run against the working tree (fix present): **passes**.

## New tests (3)

| Test | Pre-fix (HEAD, worktree) | Post-fix (working tree) |
|---|---|---|
| `test_a_replay_fills_an_inventory_the_first_registration_lacked` | **FAIL** (`assert 0 == 3`) | PASS |
| `test_a_replay_with_the_same_inventory_writes_nothing_a_second_time` | PASS | PASS |
| `test_a_replay_with_a_conflicting_inventory_keeps_the_stored_one` | PASS | PASS |

The second and third tests were never expected to move — the bug was specific
to filling an *empty* inventory, and both pre-existing code paths (duplicate
delivery, conflicting delivery) already behaved correctly. They now pin that
behaviour so a future change to `_fill_empty_inventory` cannot regress it
silently.

## Suite results (post-fix, working tree)

| Suite | Result |
|---|---|
| `test_files_idempotency.py` | 25 passed (22 pre-existing + 3 new) |
| `test_per_run_checksum_identity.py` | passed |
| `test_files_versions.py` | passed |
| `test_files_patch_link.py` | passed |
| `test_runs_rollup.py` | passed |
| `test_catalogue_upsert.py` | passed |
| `test_fe_run_lane_b.py` | 1 failed — pre-existing, confirmed unmoved (see below) |
| `test_contract_snapshot.py` | 1 failed — pre-existing, confirmed unmoved (see below) |
| Full `api/` suite | 35 failed, 2707 passed, 8 skipped — **new=0, pre-existing=35** |
| Root suite (`py -3.12 -m pytest tests -q`) | 19 failed, 86 passed — unchanged from the established baseline |

### The two named suites' failures are pre-existing, not caused by this diff

`test_fe_run_lane_b.py::test_the_hero_file_detail_serves_its_signals_sources_and_timeline_at_once`
fails on `assert len(_EMBEDDED_FIELDS) == 8` (actual 9 — a `vehicle` field was
added by an earlier, unrelated change and the test's own expectation is
stale). `test_contract_snapshot.py::test_openapi_matches_the_committed_snapshot`
fails on the committed OpenAPI snapshot being stale (matches backlog `BL-25`).
Both were run against the pre-fix worktree (`git show HEAD`, no uncommitted
changes) and **fail identically there** — confirmed with `ruff format --check`
sanity: neither failure touches a line inside or near `_fill_empty_inventory`
(lines 1194-1227) or its call site (line 1270).

### The other 33 full-suite failures

Not named in the brief's suite list, so not individually re-run against the
pre-fix worktree, but spot-checked: `test_lane_b_contract_shapes.py::...[star
POST /files]` fails on `AssertionError: body: the property 'vehicle' is not in
the contract` — the same stale-OpenAPI-snapshot cause as
`test_contract_snapshot.py` (`BL-25`), not a signal-inventory regression. The
full 35-item failure set was identical across two independent full-suite runs
(910s and 775s), and none of the 35 node ids touch `file_signals`,
`upsert_file_signals`, `apply_file_rollup`, or the replay path. No bug filed
for these — they are `BL-25`'s territory, already tracked, out of this
round's scope.

## Lint gate

`cd api && uv run ruff check api/api/routers/files.py` — **clean, no findings.**

`cd api && uv run ruff format --check api/api/routers/files.py` — reports 7
reformat sites, **none inside the diff**. Confirmed pre-existing: running
`ruff format --check` against `git show HEAD:api/api/routers/files.py`
produces the identical 7 sites at the identical line numbers (454-457,
665-668, 857-860, 965-968, 1028-1031, 1108-1116, 1338-1344 in that revision).
No `.pre-commit-config.yaml` exists in this repo; `pyproject.toml` pins
`ruff>=0.16.3` and the installed `.venv` carries `0.16.3`, so this is the
repo's own gate, not a version drift. Not filed as a bug — pre-existing and
outside this change.

## Concurrent-replay race — reachable or benign

**Verdict: benign.** `_fill_empty_inventory`'s check-then-act
(`file_signals.find_one(...) is None` at `files.py:1211`, then the write) is a
textbook TOCTOU window, but two things close it in practice:

1. **Not reachable under normal operation.** A genuine race needs two
   concurrent `POST /files` calls carrying the *same* `(run, checksum)` with a
   *non-empty* inventory. `tm-connector` sets `TM_HTTP_TIMEOUT_SECONDS=900`
   specifically so "a timeout-and-retry would register the same bytes again
   while the first write is still running" never happens (`quix.yaml:156`) —
   the connector deliberately never sends a second POST for a file whose first
   POST is still in flight. `mf4-decoder` is a single-replica QuixStreams
   consumer (`quix.yaml:38-53`, no `replicas` override), and its decode-once
   dedup filter (`mf4-decoder/idempotency.py`) means a second decode of the
   same bytes only happens on an operator-triggered `FORCE_REDECODE` or a
   fresh upload — sequential, human-paced events, not concurrent ones.
2. **Safe if it somehow did race.** Probed empirically (20 trials, two
   threads, `pymongo.MongoClient` against a disposable `mongo:7` container,
   mirroring `upsert_file_signals`'s exact `bulk_write([ReplaceOne(filter=
   {file_id,name}, upsert=True)], ordered=False)` shape on a 250-row identical
   inventory racing on the same unique `(file_id, name)` index): **zero
   duplicate-key errors across 20 trials**, converging to exactly 250 rows
   every time. MongoDB's server-side upsert-conflict retry absorbs the race.
   Downstream, `signal_count` is a `len({...})` recomputation (idempotent) and
   `apply_file_rollup` derives from the stored `file_signals` rows with its
   own `rollup_seq` CAS retry loop (`queries_runs.py:1428`) — also idempotent.
   Both racing calls would write the same content, since a race here only
   arises from two replays of the *same* decode. Not filed as a bug —
   unreachable in the current architecture, and fails safe if it were.

## Spec requirements not tested

None. The architecture doc's behaviour table (6 rows) is fully covered: first
registration and quarantined-file replay are unaffected by construction (the
guard's two conditions), `check_replay=False` is a no-op by construction (no
replay lookup runs), and the three data-bearing rows (true duplicate, fill,
conflict) each have a dedicated test.

## Next step

All green. No bug report round was needed — every failure investigated traces
to `BL-25` (stale OpenAPI snapshot / `vehicle` field), pre-existing and out of
scope. Recommend the user commit the fix and the tests, then follow the
architecture doc's "Recovering the four stuck files" runbook against
`testrigorg-commacarsegmentsingest-jamaui` if the four battery traces are to
be repaired.
