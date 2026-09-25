# Test report — requirement-status-gates

**Spec:** `dev-planning/requirement-status-gates/spec.md`
**Architecture:** `dev-planning/requirement-status-gates/architecture.md`
**Round:** 1
**Date:** 2026-09-25
**HEAD:** `2373ace` + uncommitted working tree (branch `jama-ui-dev`)

---

## Gate results

| Gate | Command | Result |
|---|---|---|
| ruff check (changed files) | `uv run ruff check api/requirement_lifecycle.py api/services/queries_requirements.py api/planning_sync.py api/models/requirements.py api/routers/requirements.py` (api/) | **PASS** |
| ruff format (changed files) | `uv run ruff format --check <same files>` | **PASS on touched lines.** Whole-repo `ruff format --check .` reports 142 pre-existing unformatted files, including 2 lines inside `planning_sync.py`/`queries_requirements.py` that are unchanged by this diff (confirmed against `git diff -U10`) — baseline, not new. |
| npm lint | `npm run lint` (frontend/) | **PASS for requirement files** (zero hits on `grep -i requirement`). 33 errors / 53 warnings pre-exist in `public/explore/measure-tree.js` and `measure-view.js`, untouched by this change. |
| tsc --noEmit | `npx tsc --noEmit` (frontend/) | **PASS.** Zero output — confirms `RequirementFormValues` losing `status` left no dangling reference. |
| pytest api | `uv run pytest tests -q` (api/) | **35 failed, 2691 passed, 8 skipped** — exactly the `dev-planning/planning-mock-removal/test-report.md` baseline count. Plus the new `test_requirement_status_gate.py`: **10/10 passed**. |
| pytest tests (root) | `pytest tests -q --ignore=tests/test_inventory.py --ignore=tests/test_marker_contract.py` | **18 failed, 61 passed** — matches BL-31 exactly (9 in `test_import_claim.py` + 3 in `test_sink_partitioning.py`) plus 6 in `test_architecture_law.py` (brief said 7; see note below). `test_inventory.py`/`test_marker_contract.py` fail to **collect**: `ModuleNotFoundError: No module named 'numpy'` in the root `.venv` — an environment gap, not a code regression (`mf4-decoder/` is off-limits per the brief). |
| fe unit | `npm run test:unit` | **2 failed, 956 passed, 2 expected fail** (`tests/unit/filters-pagination.test.ts`, `tests/unit/lake-partitions.test.ts`) — unrelated to requirements, not named in the brief's baseline list; flagged as a previously-undocumented pre-existing gap. |
| fe component | `npm run test:components` | **19 failed, 929 passed** (post my addition; 922 before) — exactly BL-48's stated count, same 19 test names both before and after my new file landed. |

**`new=0 pre-existing=74`** (35 api + 18 root + 2 fe-unit + 19 fe-component). Nothing this build touches shows a new failure anywhere.

### Note on the `test_architecture_law.py` count
Brief said 7; I counted 6 distinct failing tests (one parametrized test contributes 3 of them). Fewer, not more — not a regression, just a discrepancy in the brief's number worth flagging.

---

## The three behaviours that matter (executed)

### 1. `Tested` cannot be authored (`test_tested_cannot_be_authored`)

```
PATCH /api/v1/requirements/REQ-GATE-001 {"status": "Tested", "parent_version": 1, "actor": "T. Ester"}
```

Response body (verbatim):
```json
{
  "detail": "Tested is computed from test-run coverage and is never set by hand. It is shown in the Verification column.",
  "code": "illegal_transition",
  "errors": []
}
```
Status code: **409**. Stored row: `status` **Draft -> Draft** (unchanged), `item_version` **1 -> 1** (unchanged). Confirmed both the HTTP layer and the Mongo row.

### 2. `Ready for Review` move (`test_a_status_move_suspects_no_link`)

`content_sha256` before/after: `83df9d6abf9909d8cb4dc21e22160a3def84312797a6fd57496cb9afe992d6ab` -> **identical**
`normative_sha256` before/after: `292c37485b79efadf248355150eaa54490604bd0f60945731a9fad56fcdba707` -> **identical**
`item_version`: +1, as specified. One journal entry, `field_label="requirement.status"` (`test_the_free_band_moves`).

### 3. BL-71 demotion still works (`test_a_content_edit_still_demotes_a_frozen_row`)

A row forced to `status: "Reviewed"`, then `PATCH` with only a `text` change (no `status` in the body): response `status` reads **`Draft`**, 200. The gate does not intercept this path — confirmed by direct assertion, not just non-crash.

**Lead answer: the BL-71 demotion survives, and the `Tested` refusal leaves the row completely untouched. Both hold.**

---

## `second_actor` end to end (`test_the_second_actor_is_recorded`)

A content edit on a `Reviewed` row with `second_actor: "A. Second"` produces journal entries (queried live from `journal_entries`) whose `note` field reads, verbatim:
```
Returned to Draft: the content of a frozen requirement changed. Second reviewer: A. Second.
```
Confirmed for **every** entry the edit produced (the `text` field entry and the demotion `status` entry alike) — not just one. The theatre described in spec §2.2 is fixed.

---

## The mirror guard

`test_planning_cannot_push_a_derived_status`: a row seeded through a first push (so its fields are `api:planning`-sourced, avoiding the unrelated `manual`-outranks-`api:planning` precedence block a manually-created row would trigger), then a second push naming `status: "Tested"` and a new `title`. Result: `title` lands, `status` stays at its prior value (`""`), `requirements_mirrored == 1`.

`test_planning_push_omitting_status_on_a_new_row_still_moves`: a brand-new row born of a push that states no `status` at all stores `""` (confirmed directly against Mongo, not just via the read model), reads without a 500, and a subsequent `PATCH {"status": "Draft"}` succeeds — the `_UNKNOWN` fallback covers exactly the case the architecture doc calls out as the hazard.

`test_an_unknown_status_can_still_reach_draft`: same `""` row, read through `GET` (no 500 — `RequirementRow.status: str` holds), `-> Draft` succeeds, a sibling row `-> Reviewed` is refused `illegal_transition`.

---

## Contract-snapshot prediction

ArchDev predicted the only new diff is the PATCH route description plus the `RequirementPatchRequest` model description, on top of the pre-existing BL-25 failure. Diffed `app.openapi()` against the committed snapshot key-by-key:

```
DIFF /paths//api/v1/requirements/{req_id}/patch/description       <- NEW, this change
DIFF /components/schemas/RequirementPatchRequest/description       <- NEW, this change
DIFF /paths//api/v1/requirements/facets                            <- pre-existing (BL-25)
DIFF /paths//api/v1/requirements/get/description                   <- pre-existing
DIFF /paths//api/v1/requirements/get/parameters (list)              <- pre-existing
DIFF /components/schemas/RequirementCreateRequest/properties/system <- pre-existing
DIFF /components/schemas/RequirementDetail/properties/system        <- pre-existing
DIFF /components/schemas/RequirementRow/properties/system           <- pre-existing
DIFF /components/schemas/RequirementPatchRequest/properties/system  <- pre-existing
DIFF /components/schemas/RequirementFacets                          <- pre-existing
```

**ArchDev's prediction confirmed exactly.**

---

## UI smoke

**Not run against a live instance.** The brief forbids touching the live jamaui environment (redeployed API/QuixLab under active user QA), and no other running deployment or local dev server with a seeded backend was in scope/time-budget to stand up safely. Instead, `tests/components/requirement-status-control.test.tsx` (new, 7 tests, all passing) drives the real `StatusControl` component, the real `usePatchRequirement`/`useActor` hooks and the real API client end to end with only `fetch` stubbed — covering every scripted UI smoke item except the actual pixels:

- Menu offers exactly the band-A targets per state (`Draft`, `Ready for Review`, `Reviewed`, `Obsolete` cases each asserted).
- The two derived rows (`Implemented`, `Tested`) render `aria-disabled="true"` with their reason text, from every state.
- A `409 illegal_transition` renders the server's own sentence via `sonner` toast, not a canned one.
- The PATCH request carries `{status, parent_version, actor}` with the Portal-resolved actor name.

The create dialog's `NEW`/`Draft`-only select and the edit dialog's absent status field were confirmed by code reading (`add-requirement-dialog.tsx`, `requirement-form-fields.tsx` diffs) but not driven through a browser. If real click-through QA in the Portal is wanted, that remains the user's per `CLAUDE.md`'s working agreement.

---

## New test files

- `api/tests/test_requirement_status_gate.py` — 10 tests, all traced to spec §6.1's red-first list (#1–#9) plus one extra (`test_planning_push_omitting_status_on_a_new_row_still_moves`, covering the §4.7 empty-string-on-a-new-row case explicitly). All pass against the shipped code.
- `frontend/tests/components/requirement-status-control.test.tsx` — 7 tests, satisfying spec §6.1 item #10 (the control offers exactly the legal targets per state; the derived band renders disabled with reasons; a 409 renders the server message), plus one covering the PATCH request shape.

Both are ruff/eslint/tsc-clean.

---

## Spec requirements not testable here

- **Band B (`In Review`/`Reviewed` via the review flow)** — `REVIEW_TARGETS` has no route yet (`review-page/spec.md`, not built). Cannot be exercised end to end; the table itself is unit-testable only through the free-band refusal (`test_reviewed_cannot_be_set_by_hand` proves `PATCH` cannot reach it, which is the whole of this spec's job).
- **Live-Portal UI click-through** — see "UI smoke" above.

## Findings for ArchDev

**None.** Every assertion in the brief's three load-bearing behaviours held, the mirror guard and the empty-string tolerance both hold, `second_actor` reaches the journal, and ArchDev's own contract-snapshot prediction was exact. No bug report round is needed this cycle.
