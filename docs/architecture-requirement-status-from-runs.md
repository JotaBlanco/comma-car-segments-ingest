# Requirement status from runs — architecture

Backend for `dev-planning/requirement-status-from-runs/spec.md` (BL-22) and
`dev-planning/authoring-controls/spec.md` (BL-35, requirements slice only).
Covers the API's read contract for `dev-planning/requirements-page/spec.md`
§10. The frontend screen at `/requirements` (a parallel build) is documented
separately in `docs/architecture-requirements-page.md`.

## What this is

A requirement becomes a first-class, versioned entity in the Test Manager: a
mirrored `requirements` Mongo collection fed by `POST /planning/sync`, a
manual authoring path (`POST /requirements`, `PATCH`, `retire`) for rows a
person creates directly, and a read-time projection that computes
`verification_state`, `verified_by`, `covering_run_ids` and `latest_run_id`
from the run/definition/result graph — none of it stored. Nothing here writes
a verdict; `BL-11`'s runner does that, through an optional `verdict` block
this build adds to `POST /results`.

## Why this architecture

**Everything requirement-side is derived, computed by one function.**
`queries_requirements._project` is the single fold that turns
`test_definitions.covers_req_ids` (authored) plus `test_runs` plus
`processed_results.verdict` into `verification_state`, `verified_by`,
`covering_run_ids`/`latest_run_id`/`covering_run_count`, `evidence_stale` and
`tested_at`. The list (`list_requirements`) and the detail
(`get_requirement_detail`) both call it, so the two screens can never
disagree, and nothing needs a compensating write when a run is deleted,
flagged invalid, or a definition's coverage changes — the answer just changes
on the next read. `dev-planning/requirement-status-from-runs/spec.md` §4.3
names three reasons this beats a stored reverse array: it would be defect D1
(an authored reverse link), it goes stale in four ways nothing would report,
and it would fork `_write_link`'s status as the one place a link is written.

**The mirror writes per field, not wholesale — the one deliberate
divergence from `_write_mirror`.** Every other planning mirror
(`_mirror_work_orders`, `_mirror_definitions`) replaces every field on every
pass: planning owns the row outright, and no local write competes with it. A
requirement is different from the moment `POST /requirements` exists: a
manual row and a planning push can name the same id, and `_write_mirror`'s
wholesale overwrite would let the next sync pass erase a person's edit
outright. `planning_sync._mirror_requirements` instead calls `set_field` once
per authored field, the same per-field, precedence-checked path
`_write_link` already uses for a run's `work_order_id`/`definition_ids`. Rank
is `manual` (2) over `api:planning` (1): a push naming a field a person
already edited skips that field only, silently, and lands every other field
of the same row — the same convention `embedded` vs `manual` run fields
already use in production. Nothing new was invented for this; the existing
`provenance.set_field`/`blocks()` rank table is the entire mechanism.

**Two independent hashes, two independent purposes, one shared function
pair.** `normative_sha256` (over `text`, `measurand`, `system_states`,
`verification_method`, `verification_criteria` — the board's field list) is a
narrow "did the evidence's target move" signal: it degrades a `tested`
requirement to `exercised` + `evidence_stale` when the requirement changed
under a passing verdict. `content_sha256` (over every authored field except
`status`) is the general optimistic-concurrency token: `item_version` mints
whenever it changes, and `PATCH`/`retire` refuse a stale `parent_version`.
Both hash functions (`queries_requirements.normative_sha256`,
`content_sha256`) are computed the same way whichever side writes — a
planning push and an authored edit mint `item_version` by the identical rule,
so the two paths can never define "changed" differently. `status` is
excluded from both: a Draft → Reviewed move is a person's act and must never
look like a content change (`authoring-controls` §12 OQ5).

**Verdicts ride on the existing result, not a new collection.**
`processed_results` already supplies a version chain per `(run_id,
result_key)`, mandatory six-key provenance, the journal, lineage and
delete-with-run. A new optional `verdict` block (`Verdict`/`VerdictOut` in
`api/api/models/results.py`) gets all of that for free — a new `verdicts`
collection would have reimplemented every one of those mechanisms to avoid
one optional field. `POST /results` and `PATCH /results/{id}` are otherwise
untouched: `ResultPatchRequest`'s `extra="forbid"` already answers 422 for a
patch naming `verdict`, because correcting a verdict means producing a new
version, not editing one in place.

**The four refusals are the only guards.** `id_reuse` (create names an id
already in the collection, any status — a retired id is never reused),
`stale_parent` (the caller's `parent_version` doesn't match the stored
`item_version`), `no_op_mint` (the submitted bytes hash identical to what's
stored), `already_obsolete` (retire on a row already `Obsolete`). Nothing
else validates the seed's or a caller's own data — an id naming a requirement
the mirror doesn't hold is invisible to the projection rather than an error,
matching `dev-planning/requirement-status-from-runs/spec.md` §5.2's own rule.

## Data flow

```
POST /planning/sync                          POST /requirements
{requirements[], test_definitions[], ...}     (a manual row)
        |                                              |
        v                                              v
_mirror_requirements (per field, set_field)   create_requirement
        |                                              |
        +--------------------> requirements <----------+
                                (Mongo collection)
                                       |
        test_definitions.covers_req_ids (authored, mirrored by
        _mirror_definitions from PushedDefinition.covers_req_ids)
                                       |
                                       v
              queries_requirements._fold_inputs(db, requirement_ids)
              1. test_definitions.find({covers_req_ids: {$in: R}})
              2. test_runs.find({definition_ids: {$in: td_ids},
                                  invalid.flagged: {$ne: true}})
              3. processed_results.find({run_id: {$in: run_ids},
                                          verdict.definition_id: {$in: td_ids}})
                                       |
                                       v
                    _state_fold  ->  verification_state, evidence_stale, tested_at
                    _covering_runs -> covering_run_ids, latest_run_id
                    verified_by(R) -> inverted covers_req_ids
                                       |
                                       v
                    GET /requirements            GET /requirements/{id}
                    (paged, filtered in           (uncapped covering_run_ids,
                     Python over the whole         evidence[] — one row per
                     projected table)              (run, definition) pair)
```

`POST /results` gains the same shape one level down: a `verdict` block
(`definition_id`, `outcome`, `evidence`, `implementation_sha256`) rides beside
the mandatory `provenance` block. `BL-11`'s runner is the only writer; this
build only reads `processed_results.verdict` back out through step 3 above.

## The verification_state fold (`_state_fold`, spec §5.3)

Evaluated per requirement, over every test case its `verified_by` names:

1. `verified_by` empty → `not_covered`.
2. No covering test case carries a run → `covered`.
3. Some covering test case has no run, a run with no verdict, or an `error`
   verdict → `exercised`.
4. Some covering test case's newest verdict is `fail` → `failed` (outranks 3
   when both could apply to different test cases of one requirement — a known
   negative is louder than an unknown).
5. Every covering test case's newest verdict is `pass`, and every one is
   *current* (`implementation_sha256` matches the definition's uploaded
   implementation, and `provenance.produced_at >= normative_changed_at`) →
   `tested`, `tested_at` = the newest satisfying `produced_at`.
6. Every newest verdict is `pass` but at least one is not current →
   `exercised`, `evidence_stale: true`.

"Newest" is per test case, not per run: a re-run after a fix is judged on its
latest attempt (`processed_results.version` DESC).

## File inventory

**New**

| File | What |
|---|---|
| `api/api/models/requirements.py` | `RequirementRow`/`Detail`/`Page`/`ViewCounts`/`Evidence`, `VerificationState`, `EarsPattern`; `RequirementCreateRequest`/`PatchRequest`/`RetireRequest` |
| `api/api/services/queries_requirements.py` | `_project`/`_fold_inputs`/`_state_fold`/`_covering_runs` (the read fold); `list_requirements`/`get_requirement_detail`; `create_requirement`/`patch_requirement`/`retire_requirement`; `content_sha256`/`normative_sha256` (shared with the mirror) |
| `api/api/routers/requirements.py` | `GET /requirements`, `GET /requirements/{id}`, `POST /requirements`, `PATCH /requirements/{id}`, `POST /requirements/{id}/retire` |

**Modified**

| File | Change |
|---|---|
| `api/api/models/planning.py` | `PushedRequirement`; `PushedDefinition.covers_req_ids`; `PlanningPushRequest.requirements`; `PlanningPushResponse.requirements_mirrored`; `TestDefinitionRow.covers_req_ids` |
| `api/api/models/results.py` | `Verdict` (request)/`VerdictOut` (response); `ResultCreateRequest.verdict`, `ResultBody.verdict` |
| `api/api/models/runs.py` | `RunDetail.covers_req_ids` (derived, detail-only); `HomeCounts.requirements` |
| `api/api/models/journal.py` | `WritableEntityType` gains `"requirement"` |
| `api/api/planning_sync.py` | `_mirror_requirements` (per-field mirror, §9.1 divergence); `_mirror_definitions` carries `covers_req_ids`; `apply_planning_push` mirrors requirements first and returns `requirements_mirrored`; `demo_reset` deletes sync-created requirement rows |
| `api/api/routers/planning_sync.py` | passes `body.requirements` into `apply_planning_push` |
| `api/api/routers/results.py` | `_store_result` persists `body.verdict` |
| `api/api/routers/journal.py` | `_ENTITIES` gains `"requirement"`; `GET /requirements/{id}/journal` |
| `api/api/services/queries_runs.py` | `with_counts` adds `covers_req_ids` (derived union, run detail only); `home_summary` adds the `requirements` count |
| `api/api/db.py` | `test_definitions.covers_req_ids` (multikey); `processed_results` compound `(verdict.definition_id, version DESC)` |
| `api/api/main.py` | registers the `requirements` router; `ROUTE_ERRORS` for the five new routes |
| `battery-trace-gen/data/battery-dc-requirements.json` | `verified_by` deleted from all ten items (BL-17); `notes` states the reverse link is derived |
| `battery-trace-gen/seed/sources.py` | `covers_index()` — the inverted `req_id -> [tc_id]` map, built from the test specs |
| `battery-trace-gen/seed/requirements_md.py` | `resolve_display()` (plain-text `name (value unit)` token render, for `text_rendered`); the "Verified by" row now reads `covers_index()`, never the requirement JSON |
| `battery-trace-gen/seed/planning_payload.py` | `requirements()` — the pushed catalog; `test_definitions()` carries `covers_req_ids`; `catalog_body()` sends `requirements` first |
| `battery-trace-gen/seed/__main__.py` | `_render()`'s sanity print reports the requirements count |

## Integration points

- **`test_definitions`**: gains one planning-owned field, `covers_req_ids`,
  written wholesale by the existing `_mirror_definitions` (unchanged write
  path). It is the sole authored direction of the requirement↔definition
  link; `verified_by` inverts it and is never stored.
- **`test_runs`**: `RunDetail.covers_req_ids` is a derived, detail-only union
  computed by `queries_runs.covered_requirement_ids` — one extra query on the
  run detail read; the runs list is untouched.
- **`processed_results`**: gains the optional `verdict` sub-document. The
  existing version chain, provenance, journal and run-delete-cascade all
  apply to it unmodified; `BL-11` is the only intended writer.
- **`planning_sync` / `POST /planning/sync`**: `requirements` mirrors first,
  `work_orders` and `test_definitions` second — order matters for the journal
  reading sensibly (a definition naming a requirement lands after its
  target), not for correctness, since the projection tolerates either order.
- **`journal_entries`**: `"requirement"` is now a first-class entity type
  (`_ENTITIES`), so `GET /requirements/{id}/journal`, the cross-entity
  `GET /journal?entity_type=requirement` and `POST /access-requests` against
  a requirement id all resolve.
- **`demo_reset`**: requirement rows the sync created (`mirrored_at` newer
  than the watermark) are removed on reseed, exactly like a work order or a
  definition; a manually authored row (`mirrored_at: null`) is never touched
  by this clause.

## Known deviations from the specs (flag for the frontend agent / Buddy)

1. **`GET /requirements/facets` is not built.** `requirements-page/spec.md`
   §10.2 names it; this build instead accepts `chapter`/`status`/`state`/
   `method` as repeated query params directly on `GET /requirements` and
   filters server-side in Python over the whole (small) projected table. A
   facets route is a cheap follow-up if the frontend wants a distinct-values
   endpoint instead of deriving options from the page's own rows.
2. **`asil`, `no_evidence` view count and the `verification_criteria`-vs-
   `pass_criteria` sweep are not built** — out of this build's explicit scope
   (`requirements-page/spec.md` §8's phase-2 list).
3. **A planning-origin row's authored fields are not blocked from
   `PATCH /requirements/{id}`.** `authoring-controls/spec.md` §3's verb
   matrix says a planning row gets "no local edit of authored fields." The
   backend enforces this today only through the frontend's control-rendering
   rule (§4: a control renders only where a source can legally own the
   write); `set_field`'s `manual` > `api:planning` precedence still protects
   any such edit from a later sync, but nothing in the API refuses the PATCH
   itself pre-write. Flagged rather than silently built to the looser
   contract — confirm with Buddy whether a backend-side origin check belongs
   in this feature or the next round.
4. **The four-eyes `second_actor` field is accepted and stored nowhere.**
   `RequirementPatchRequest.second_actor` exists so the wire contract
   doesn't 422 when the frontend renders the gate (`authoring-controls`
   §7), but no policy logic reads it — `dev-planning/review-page/spec.md`
   owns that.
5. **No omni-search integration.** `requirements` is not in
   `queries_runs._SEARCH_FIELDS`/`_SEARCH_GROUPS` or `SearchGroup`'s Literal.
   The one-search-box (`GET /search`) does not surface requirements yet.
