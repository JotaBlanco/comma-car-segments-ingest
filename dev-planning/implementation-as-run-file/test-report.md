# Test report — implementation-as-run-file (BL-77)

**Spec:** `dev-planning/implementation-as-run-file/spec.md`
**Architecture / build notes:** `docs/architecture-implementation-as-run-file.md`
**Mode:** Validation. Round 1.
**Verdict: GREEN.** No production bug filed. Zero new test failures; every
failure below is pre-existing and confirmed unrelated to this change.

## Gates

| Gate | Command | Result |
|---|---|---|
| Lint (api, changed files) | `uv run ruff check <8 changed files>` | Clean |
| Format (api, changed files) | `uv run ruff format --check <8 changed files>` | Clean on every line this build touched; unrelated pre-existing drift elsewhere in the repo (confirmed against `git diff`, not this build's lines) |
| Typecheck (frontend) | `npm run typecheck` (`next typegen && tsc --noEmit`) | Clean — confirms the `accent` `BadgeTone` union widening is sound |
| Lint (frontend) | `npm run lint` | 33 errors / 53 warnings, all in `public/explore/measure-tree.js` and `measure-view.js` — vendored files untouched by this diff. No new issues. |
| No `.pre-commit-config.yaml` in the repo | — | confirmed absent (repeat of earlier rounds' finding) |

No import cycle: `api/api/services/definition_runs.py` imports `api.routers.files` and `api.routers.results`; neither imports `definition_runs` back (grepped, zero hits).

## Suites

| Suite | Result | Baseline | Delta |
|---|---|---|---|
| `api/` (`uv run pytest tests -q`, mongo:7 testcontainer) | **35 failed, 2715 passed, 8 skipped** | ~35 failed / ~2707 passed | **new=0, pre-existing=35** (2715 = 2707 + 8 tests this round adds) |
| root `tests/` (`py -3.12 -m pytest tests -q`) | **19 failed, 94 passed** | 19 failed / 86 passed | **new=0, pre-existing=19** (pass count grew — other in-flight agents' tests, not touched) |
| frontend unit (`test:unit`) | 2 failed / 956 passed / 2 expected-fail | 2 failed | new=0 |
| frontend component (`test:components`) | 19 failed / 928 passed (BL-48) | 19 failed | new=0 |
| frontend contract (`test:contract`) | 1 failed / 27 passed / 6 expected-fail (BL-25) | 1 failed | new=0 |

None of the 35 `api/` failures or 19 root failures name `role`, `evaluator`,
`definition_runs`, `place_implementation`, or any file this build touched.
Three of the 35 (`test_lane_b_contract_shapes.py::…[#12 GET /files]`,
`…[#13 GET /files/{file_id}]`, `…[star POST /files]`) were the ones most at
risk of a `role`-shaped regression, since they snapshot the file contract
shape. **Verified against a clean worktree at `488a372` (pre-this-change):
all three already fail there**, 3 failed / 7 passed in that file — proven not
a regression, not assumed. `test_source_filters.py::test_a_registered_file_tags_eight_fields`
asserts `len(_EMBEDDED_FIELDS) == 8`; the constant already holds 9 entries
(the `vehicle` field, added earlier), unrelated to `role` (`role` is
deliberately excluded from `_EMBEDDED_FIELDS` per spec §4.3, confirmed by
reading the constant — still 9 entries, no `role`). Pre-existing drift.

## New tests (8), all green

`api/tests/test_definition_runs.py`:
- `test_starting_files_the_implementation_under_the_run_as_an_evaluator` — the copy lands at `<ws>/jama_ui/<run_id>/<digest8>-<name>`, registers with `role="evaluator"`, `source_system="api"`, `format="PY"`. Spec §4.1, §4.2, §4.6.
- `test_missing_implementation_bytes_answer_503_and_register_nothing` — `place_implementation` propagates `FileBytesUnavailable` as 503 before any Job starts. Spec §4.6.
- `test_a_register_failure_after_the_copy_leaves_an_orphan_object_and_no_row` — **confirms ArchDev's finding #2**: the blob write precedes `register_file_document`; a non-`FileBytesUnavailable` failure on the register half leaves the bytes written (orphaned) and no file row, and the exception propagates uncaught. Reproduced directly by monkeypatching `register_file_document` to raise `RuntimeError`.
- `test_two_identical_run_clicks_file_the_implementation_once` — two POSTs: one file document, one journal entry (`file.registered`). Spec §4.5.
- `test_a_verdict_s_input_file_ids_excludes_evaluators_and_includes_unroled_files` — a verdict's `provenance.input_file_ids` names the trace only, even with an `evaluator`-role file also registered on the run. Spec §4.4.

`api/tests/test_files_role.py` (new file):
- `test_a_file_with_no_role_key_serves_as_a_recording` — **the no-backfill claim**: a raw document inserted with no `role` key at all serves `role: "recording"` through `GET /files/{file_id}` (the `FileBody` default). Node id: `tests/test_files_role.py::test_a_file_with_no_role_key_serves_as_a_recording`. **PASSED.**
- `test_a_file_registered_as_an_evaluator_serves_that_role` — control case, `role: "evaluator"` round-trips.
- `test_post_files_with_no_role_still_registers_and_defaults_to_recording` — every existing `POST /files` producer body (no `role` key) still 201s and stores `role: "recording"`.

## Test fixed, not new

`api/tests/test_definition_runs.py`'s `pair`/`_implementation` fixture encoded
the exact hazard `docs/architecture-implementation-as-run-file.md` names: the
definition's `blob_path` pointed at `<ws>/jama_ui/<RUN>/abababab-impl.py` —
the same key `place_implementation` computes as its *destination* — so
`provider.open` on that non-existent object 503'd on every POST. Fixed by
pointing `_implementation()["blob_path"]` at
`<ws>/jama_ui/unassigned/abababab-impl.py` (`IMPL_SOURCE_KEY`, new constant),
pre-seeding `store.objects[IMPL_SOURCE_KEY]` in the `pair` fixture, and
keeping `IMPL_KEY` as the asserted destination. This also corrected
`test_starting_seeds_the_notebook_and_creates_one_job`'s
`QUIXLAB_PARAMS.implementation_key` assertion: `run_params()` reads
`definition["implementation"]["blob_path"]` directly (the definition's own
copy), never the run-scoped copy — so the Job always loads from
`unassigned/`, and the run-scoped copy is evidence only, exactly as spec §4.6
"Why not the Job" implies but the old fixture accidentally obscured.

## Sanity print

- Lint (api, changed files): **PASS** — `ruff check` clean, `ruff format --check` clean
- Lint (frontend): **PASS** (pre-existing vendored-file noise only, 0 new)
- Typecheck (frontend): **PASS**
- api suite: **35 failed / 2715 passed / 8 skipped** — new=0, pre-existing=35
- root tests/: **19 failed / 94 passed** — new=0, pre-existing=19
- frontend unit: **2 failed / 956 passed** — new=0 (BL matches known baseline)
- frontend component: **19 failed / 928 passed** — new=0 (BL-48)
- frontend contract: **1 failed / 27 passed** — new=0 (BL-25)
- No-`role`-key test: `tests/test_files_role.py::test_a_file_with_no_role_key_serves_as_a_recording` — **PASSED**
- `input_file_ids` for a run holding one trace + two evaluators: `[trace_id]` only (verified with one trace + one evaluator; the exclusion is a `role != "evaluator"` filter with no count dependence, so a second evaluator changes nothing about the predicate — confirmed by reading `_input_file_ids`, not separately re-run with two)
- Two identical Run clicks: **1 blob object write** (same content-addressed key, idempotent overwrite), **1 file document**, **1 journal entry** (`file.registered`)
- ArchDev's finding #1 (POST/PATCH `/results` accept caller `input_file_ids`): **confirmed, and confirmed unreachable from the derived path** — `record_verdict` builds `ResultCreateRequest` with `provenance.input_file_ids` hardcoded to `_input_file_ids(db, run_id)`; no caller value ever reaches it. The two results routes remain a separate, authored path, out of this spec's scope as ArchDev said.
- ArchDev's finding #2 (orphan object on a non-`FileBytesUnavailable` register failure): **confirmed by a new red-then-green test** (`test_a_register_failure_after_the_copy_leaves_an_orphan_object_and_no_row`) that reproduces it directly: the write lands, the exception propagates uncaught, no row is created.
