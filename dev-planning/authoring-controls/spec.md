# Authoring controls — add / edit / remove, every page

**Status:** Draft
**Project:** comma-car-segments-ingest
**Branch / HEAD:** `jama-ui-dev`
**Created:** 2026-09-22
**Planned with:** Buddy
**Backlog:** `BL-35`. Depends on `BL-34` (item_version/content_sha256, scoped down — §9.1). Leaves `BL-33`, the review transition policy and `verifies` link states to `dev-planning/review-page/spec.md`.

---

## 1. Goal

The user's sentence: *"all pages should have UI control system. add req, edit req, remove req.
needs to be on all pages Review, reqs, test definitions, work orders, test runs."* One
consistent add/edit/remove control system across five pages — not five different ones, and
not a generic CRUD layer bolted over entities that do not all own their own data.

---

## 2. Background — two collisions this spec resolves

**Collision 1 — planning ownership.** Work orders and test definitions are mirrored from
planning (`api/api/planning_sync.py`, `POST /planning/sync`). The only local writes today:
`PATCH /test-definitions/{td_id}/custom-properties`, the requirements-files routes, an
`implementation` upload. `api/api/provenance.py`'s `set_field`/`add_event`/`Source` exist
precisely so a mirrored write never overwrites a `manual` one. "Add a work order" or "edit a
mirrored title" cannot mean create-a-row/change-a-row — planning would either refuse the
concept or silently clobber it on the next sync. §3 decides what each verb means per entity.

**Collision 2 — the requirements page is currently spec'd read-only.** Two Draft sibling
specs — `dev-planning/requirement-status-from-runs/spec.md` (§4.1: *"Rejected — a `POST
/requirements` write route"*) and `dev-planning/requirements-page/spec.md` (§2: *"Nothing on
this page is editable. The screen carries the same read-only-mirror header the work-order and
definition screens carry"*) — model **every** requirement as a planning-mirrored row, exactly
like a work order. That is a deliberate, named simplification in both documents ("the full
model is weeks... the demo the user is running this week"), and both name the authored,
versioned model as the upgrade path they left undone. **This spec is that upgrade, scoped to
what BL-35 needs**: it does not touch `requirements-page`'s nine columns or its read-time
projection (excluded per brief), but it does add the write path that page's own §9 anticipates.
§9.2 states the resulting one-line collision with that page's "nothing is editable" sentence.

Everything below assumes both sibling specs' data model (`requirements` collection,
`normative_sha256`, `verification_state`, `verified_by` derived) as given and additive.

---

## 3. Verb matrix — per entity, with the rejected alternative

**Work order.** Truth: planning. *Add* — never offered; a locally-created work order links no
run planning will ever claim, so it would be a phantom row forever stuck `awaiting_work_order`
in nobody's catalog. *Edit* — the six mirrored fields (`title`, `project`, `status`,
`requestor`, `department`, `priority`, `created_at_source`) stay **absent from every form,
always**: `_write_mirror` overwrites them wholesale every pass with no precedence check, so a
local edit would be silently erased at the next sync, worse than not offering it. New:
`custom_properties`, the same manual overlay `test_definitions` already has, extended here for
consistency (§8). *Remove* — never; the row disappears only when a sync stops sending it or
`demo_reset` runs, never by a person's click.

**Test definition.** Truth: planning, three existing local overlays. *Add* — never (same
reason as work order). *Edit* — the three fields already writable
(`custom_properties`, `requirements_files`, `implementation`) stay exactly as they are; `title`,
`work_order_id`, `planned_runs`, `covers_req_ids` stay absent from every form, same reasoning
as the work order's mirrored fields. *Remove* — never offered; "removing" a mirrored definition
locally would simply reappear on the next sync, so the honest answer is no control, not a
control that silently un-does itself.

**Requirement.** Truth: split by origin, from this spec onward. A row born from
`POST /planning/sync` carries `source: "api:planning"`; a row born from this spec's new
`POST /requirements` carries `source: "manual"`. *Add* — offered, manual only (§7). *Edit* —
offered for a **manual** row's authored fields; a **planning** row's authored fields stay
absent from the edit form (same mirrored-field rule as above — a planning requirement is
edited in planning, not here). Both origins get the derived block rendered, never editable,
per `requirements-page`'s existing rule. *Remove* — offered as **retire**, never delete, on
either origin (§5): retiring a planning-sourced requirement records the decision locally
without asking planning's permission, exactly as flagging a run invalid does not ask ingestion.

**Test run.** Truth: ingestion (`source: embedded`), five fields writable today. *Add* — never;
a run is created by the ingestion pipeline (`POST /test-runs`), never typed by a person. *Edit*
— unchanged: `PATCH /test-runs/{run_id}`, the five fields `edit-run-dialog.tsx` already offers.
*Remove* — unchanged: `DELETE /test-runs/{run_id}`, the existing **hard** delete
(`delete-runs-dialog.tsx`, `run_deletion.py`) — files, signal rows, results, lake partitions,
gone. This is the one place "remove" does **not** mean retire; §5 states why.

**Review decision.** Out of scope — `dev-planning/review-page/spec.md` owns accept/reject/the
four-eyes policy. Noted only so the matrix is complete (final table).

---

## 4. The one control system

One rule, stated once: **a control renders if and only if some source can legally own the
write right now; otherwise it is absent, never disabled.** A greyed-out button invites "why
can't I click this"; an absent one doesn't. This generalises the pattern
`requirements-page/spec.md` already uses for read-only columns (dashed badge, no edit
affordance) to every write surface.

Placement, uniform across the five pages:

| Verb | Where it lives |
|---|---|
| **Add** | one primary button, top-right of the list screen's toolbar — `+ New requirement`. Rendered only on the Requirements list; every other list shows none. |
| **Edit** | the **same dialog**, opened from two places: a row-level icon button on the list (new — today only `run-detail-screen.tsx` opens `EditRunDialog`, the runs *list* has no row affordance, a gap this spec closes) and the entity's detail-screen header button (`Edit metadata`, existing pattern, `run-detail-screen.tsx:295-298`). |
| **Remove/Retire** | row-level icon button (list) + detail-header button + a batch bar when rows are checkbox-selected — the exact shape `runs-batch-bar.tsx` + `delete-runs-dialog.tsx` already set. One dialog, opened from all three places, never a second set of words. |

No new primitive. `CustomPropertiesEditor`, `SourceBadge`, `useActor`/`NO_ACTOR_MESSAGE`, the
`FAILURES: Record<string,string>` map, the typed-word confirm for destructive actions — every
new dialog in §10 reuses these exactly as `edit-run-dialog.tsx` / `delete-runs-dialog.tsx` do.

---

## 5. Remove means retire — and the one place it still means delete

**Requirement retire, not delete.** `POST /requirements/{req_id}/retire`. Effects: `status`
set to `"Obsolete"` via `set_field(..., Source.MANUAL, ...)` — this is a person's act, not a
machine deriving `Tested`, so it does not touch the rule `requirement-status-from-runs §4.2`
protects; `related_reqs[0]` gets the successor id prepended when one is given; the document
row is never deleted, `_id` is never freed. Uniqueness checks on `POST /requirements` scan the
**whole** collection regardless of status, so a retired id can never be reclaimed
(`id_reuse`, §6). `requirements-page`'s `view_counts.all`/coverage denominator excludes
`status: "Obsolete"` rows (one line in that spec's `_project`, named as a dependency in §10,
not redesigned here) — an obsolete row leaves the coverage denominator exactly as the board
states, while staying individually reachable by id for the audit trail.

**Test run delete stays a hard delete.** Unchanged, not touched by this spec. Stated
explicitly because the board's "retirement is not deletion" language is about traceability
items with a protected id namespace; a test run is raw evidence with no successor concept, and
`run_deletion.py` already ships, is reviewed, and predates BL-35.

**Work order / test definition:** no remove control exists to retire *or* delete — §3.

---

## 6. Concurrency and refusals — visible, never swallowed

Every add/edit/retire form for a **manual** requirement row carries the `item_version` it was
opened against (a hidden field, populated from the GET response). Submit sends
`parent_version`. New fields on the requirement row (additive to
`requirement-status-from-runs §5.1`):

```jsonc
"item_version": 1,                 // mints on content_sha256 change, starts at 1 on create
"content_sha256": "…",             // hash over every authored field except status (§9.4)
"source": "manual"                 // or "api:planning"
```

| Refusal | When | HTTP | What the dialog shows |
|---|---|---|---|
| `stale_parent` | `parent_version` ≠ stored `item_version` | 409 | "This requirement changed since you opened it. Reload and reapply your edit." Never silently merged. |
| `no_op_mint` | submitted bytes hash identical to stored `content_sha256` | 409 | "Nothing changed, so the registry stored nothing." No version bump, no journal entry — matches the existing `no_fields_to_update` convention in `edit-run-dialog.tsx`. |
| `id_reuse` | `POST /requirements` names an id already in the collection, any status | 409 | "That id is already used — retired ids are never reused. Pick a different id." |
| `identity_unavailable` | caller carries no verified Portal identity | 401 | reuses `NO_ACTOR_MESSAGE` verbatim — same banner `edit-run-dialog.tsx` already renders when `useActor()` is null. |
| `already_obsolete` | retire called on a row already `Obsolete` | 409 | "This requirement is already retired." Explicit refusal, not a silent no-op success. |

Every code lands in a `FAILURES` map exactly like `edit-run-dialog.tsx:88-99` — one sentence
per code, rendered in the dialog's alert box, never a console log or a generic toast.

---

## 7. The four-eyes edit surface (surface only)

When the row's authored `status == "Reviewed"`, the edit dialog renders a second, required
field — `second_actor` — before Save enables. Shape: an actor picker identical to the primary
actor display already in `edit-run-dialog.tsx`, wired to a new optional
`second_actor: str | None` on `RequirementPatchRequest`. When `status` is anything else, the
field does not render at all (absent, not disabled — §4's rule). **Everything past "who is
this second name and is it eligible" — the actual policy, confirmation flow, what a fake
second actor means — belongs to `dev-planning/review-page/spec.md`.** This spec wires the gate
and stops.

---

## 8. Add-a-requirement form

**Authored at creation** (mirrors `battery-dc-requirements.json`'s shape, CLAUDE.md's EARS
table): `id` (free text, typed, required — the uniqueness/`id_reuse` check, §6), `title`,
`text`, `chapter`, `ears_pattern` (closed-enum select), `system_states` (rendered/required only
when `ears_pattern` is `StateDriven` or `Complex` — the schema rule CLAUDE.md states, replicated
as form logic), `rationale`, `source[]`, `verification_method` (select),
`measurand[{name,unit}]` (rendered/required only when `verification_method == Test`),
`revision` (default `"0.1"`, pattern `^[0-9]+\.[0-9]+$`), `figure_refs[]` (each `^F[1-6]$`),
`related_reqs[]`, `verification_criteria` (**offered, optional** — BL-18 hasn't decided
mandatory, but offering it costs nothing now and turns BL-18's future decision into a
`required` flip on this same field, not a new one). `status` is restricted to `NEW`/`Draft` at
create time — moving it further is the review flow, out of scope here.

**System-assigned, not on the form:** `item_version` (starts 1), `content_sha256`,
`normative_sha256`, `normative_changed_at`, `field_sources`, `source: "manual"`, `mirrored_at`.

**Derived, never on the form (D1):** `verified_by`, `verification_state`, `covering_run_ids`,
`covering_run_count`, `latest_run_id`, `tested_at`, `evidence_stale`. An authored value posted
under any of these keys is a 422 — `RequestModel`'s `extra="forbid"` already gives this for
free, no bespoke check needed.

**The id.** Typed by the author, claimed at `POST` time, checked against the full collection
(any status) server-side. No generator, no sequence — free text, same as `wo_id`/`td_id`
elsewhere. §12 OQ1 raises whether a namespace generator is wanted later.

---

## 9. Authored vs seeded — the same row, two origins

Planning-pushed fields carry `Source.API_PLANNING`; person-authored fields carry
`Source.MANUAL`; every field write, from either direction, goes through
`api/api/provenance.set_field`, and `blocks()`'s existing rank table (`manual`=2 beats
`api:planning`=1) is the **entire** collision rule — no new mechanism. A planning push naming a
field a person already edited on that id is skipped for that field only, silently, exactly the
way an `embedded` run field is skipped today when a person has edited it — this is a
repo-wide convention already in production, not a new invention. Every *other* field the same
push carries still lands. A push naming a brand-new id mirrors normally, `source: "api:planning"`.

### 9.1 The one required departure from `requirement-status-from-runs`

That spec's build list (§10.5) has `_mirror_requirements` call the existing `_write_mirror`
helper — the same wholesale-overwrite-plus-mirror_tags path `_mirror_work_orders` and
`_mirror_definitions` use. **That is wrong the moment a manual edit can coexist with a planning
push on the same row.** `_write_mirror` has no precedence check; it would let a planning pass
clobber a person's edit outright. `_mirror_requirements` must instead write **per field**
through `set_field`, the same shape `_write_link` (`planning_sync.py:435-492`) already uses for
run fields — precedence-checked, one journal entry per field that actually moved. This is a
one-function change to a spec not yet built by ArchDev; flagged here rather than silently
diverging later.

---

## 10. API contract

```
POST   /api/v1/requirements                         201 -> RequirementDetail
PATCH  /api/v1/requirements/{req_id}                 200 -> RequirementDetail
POST   /api/v1/requirements/{req_id}/retire          200 -> RequirementDetail
PATCH  /api/v1/work-orders/{wo_id}/custom-properties 200 -> WorkOrderDetail   (new, mirrors below)
PATCH  /api/v1/test-definitions/{td_id}/custom-properties                    (existing, unchanged)
PATCH  /api/v1/test-runs/{run_id}                                            (existing, unchanged)
DELETE /api/v1/test-runs/{run_id}                                            (existing, unchanged)
GET    /api/v1/requirements ; /{req_id}                                      (existing, unchanged)
```

Every write above builds its `$set` through `set_field` and its journal rows through
`add_event`/`set_field`'s own entries — no route writes a journal entry by hand
(`provenance.py`'s own rule). `api/api/routers/journal.py`'s entity map (`:68`) gains
`"requirement": ("requirements", "Requirement", "requirement_not_found")` — a dependency
`requirement-status-from-runs §10.10` already named; this spec is what actually starts writing
to it, so the tuple is restated here for ArchDev.

`RequirementCreateRequest`, `RequirementPatchRequest`, `RequirementRetireRequest`: all
`RequestModel` (`extra="forbid"`), all carry `actor`; patch and retire carry `parent_version`;
patch carries optional `second_actor`, retire carries optional `successor_id` + `note`.

---

## 11. Phase 1 scope

**Ships:** requirement add/edit/retire with `item_version`/`content_sha256`/`id_reuse`/
`stale_parent`/`no_op_mint`/`identity_unavailable`; the four-eyes gate as a surface (§7); work
order + test definition `custom-properties` parity; the placement rule of §4 applied
everywhere a verb is offered — including closing the existing runs-list row-edit gap and
adding the runs-list row-delete affordance where only the batch bar exists today.

**Waits:** `BL-33`'s `verifies` link entity, confirmed/suspect states, the status transition
table and `policy_sha256` — all `review-page`. Extending `item_version`/`content_sha256` to
`test_definitions` — dead code while definitions stay mirror-only (§9.1 covers requirements
only). A requirement id namespace generator (§12 OQ1).

**Unchanged:** every mirrored field of a work order or test definition stays absent from every
form, permanently, in every phase — that is not a Phase-1 restriction, it is the shape of
planning ownership (§3).

---

## 12. Open questions

1. **Id claim.** Free typed text + uniqueness check (recommended, Phase 1) vs. a generator
   enforcing a namespace regex (`CLAUDE.md`'s unresolved `ACC-SYS-(FUN|PRF|SAF)-NNN` question).
   Revisit when a second project's namespace actually shows up.
2. **Second-actor gate eligibility.** §7 accepts any verified Portal identity. If the org wants
   an actual reviewer allowlist, that is `review-page`'s policy to define — confirm the
   interim gate is acceptable to ship ahead of it.
3. **`requirements-page`'s "nothing is editable" sentence** needs a one-line amendment once
   this spec ships (mirrored rows stay read-only; manual rows do not). Should Buddy patch that
   spec now, or is it deferred until `review-page` lands and both amend together?
4. **Work order / definition custom-properties parity** — build now (~20 lines, mirrors an
   existing route) or defer until someone asks for it on those two screens specifically?
5. **Does `content_sha256` exclude `status`?** Recommended yes, mirroring `normative_sha256`'s
   exclusion list, so a Draft→Reviewed move alone does not mint a version. `BL-34`'s note
   doesn't say either way — flagging so ArchDev doesn't have to guess.

---

## 13. Build list for ArchDev

1. `api/api/models/requirements.py` — add `item_version`, `content_sha256`, `source` to
   `RequirementRow`/`RequirementDetail` (both specs additive); new `RequirementCreateRequest`,
   `RequirementPatchRequest`, `RequirementRetireRequest`.
2. `api/api/planning_sync.py` — implement `_mirror_requirements` per §9.1 (per-field
   `set_field`, not `_write_mirror`); this supersedes `requirement-status-from-runs §10.5`'s
   line for that one function.
3. New `api/api/services/queries_requirements.py` additions: `create_requirement`,
   `patch_requirement`, `retire_requirement` — each computes `content_sha256` over the
   authored field set (excluding `status`, §12 OQ5), checks `id_reuse`/`stale_parent`/
   `no_op_mint` before calling `set_field`.
4. `api/api/routers/requirements.py` — add the three new routes beside the two existing GETs.
5. `api/api/routers/work_orders.py` — new `set_custom_properties`, mirroring
   `test_definitions.py:486-…` exactly (same size/key caps, same response shape).
6. `api/api/routers/journal.py` — entity map gains the `"requirement"` tuple, §10.
7. `frontend/components/screens/requirements/add-requirement-dialog.tsx`,
   `edit-requirement-dialog.tsx`, `retire-requirement-dialog.tsx` — built on
   `edit-run-dialog.tsx` / `delete-runs-dialog.tsx`'s idiom: `SourceBadge`, `useActor`/
   `NO_ACTOR_MESSAGE`, the `FAILURES` map, a note field, the typed-word confirm for retire.
8. `frontend/components/screens/requirements/requirements-screen.tsx` — add the `+ New
   requirement` toolbar button and row-level edit/retire icons. Additive; no column change.
9. `frontend/components/screens/runs/runs-screen.tsx` — row-level edit + delete icons wired to
   the existing `EditRunDialog`/`DeleteRunsDialog` (closes the §4 placement gap).
10. `frontend/components/screens/work-orders/*`, `frontend/components/screens/definitions/*` —
    row-level "Custom properties" affordance via the existing `CustomPropertiesEditor`.
11. `frontend/lib/api/requirements.ts` — add `create`, `patch`, `retire`.
12. `frontend/lib/api/workOrders.ts` — add `patchCustomProperties`.

**Verification checklist for Tester:** `pre-commit run --all-files`; red-first tests for
`id_reuse`, `stale_parent`, `no_op_mint`, the manual-edit-survives-a-planning-push case (§9),
retire leaving the row queryable but out of the coverage denominator; the four-eyes gate
rendering/hiding correctly on `status` transitions; contract snapshot regenerated.

---

## Verb matrix

| Entity | Add | Edit | Remove | What the next planning sync does |
|---|---|---|---|---|
| Work order | never | `custom_properties` only (new) | never | overwrites the six mirrored fields wholesale, as today; leaves `custom_properties` untouched |
| Test definition | never | `custom_properties`, `requirements_files`, `implementation` (existing) | never | overwrites `title`/`work_order_id`/`planned_runs`/`covers_req_ids` wholesale, as today |
| Requirement (manual row) | yes, `POST /requirements` | yes, authored fields, `item_version`-guarded | retire (`status: Obsolete`, row kept) | a push naming this id skips any field the person already edited (precedence), lands the rest |
| Requirement (planning row) | n/a | no local edit of authored fields | retire (works on either origin) | mirrors normally, per field, through the new `_mirror_requirements` |
| Test run | never (ingestion-created) | 5 fields (existing) | **hard delete** (existing, unchanged) | n/a — runs are not planning-owned |
| Review decision | out of scope | out of scope | out of scope | see `dev-planning/review-page/spec.md` |

## Decisions

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Work order / definition add | never offered | a local-only "add", clearly marked non-authoritative | a row planning will never adopt is a phantom that misleads every screen that counts it |
| Work order / definition edit of mirrored fields | absent from every form, permanently | a disabled input with a tooltip | `_write_mirror` has no precedence check — a "successful" local edit would vanish at the next sync with no warning; absence is the honest state |
| Requirement write path | manual rows through a new `POST/PATCH/retire`, precedence-guarded against planning | a generic `PATCH /requirements` with no origin distinction | `requirement-status-from-runs` and `requirements-page` both explicitly modelled requirements as mirror-only; a bare PATCH would silently violate that and fight the next sync pass field-by-field with no rule governing who wins |
| Same-id collision (planning vs. manual) | reuse `provenance.blocks()`'s existing rank table, per field, silently | a new "conflict" state requiring a person to resolve it | this is the exact mechanism `embedded` vs `manual` run fields already use in production; a second mechanism for one more source pair is unjustified |
| Remove, requirement | **retire**: `status: Obsolete`, row and id kept forever, successor named | hard delete | the board is explicit: "retirement is not deletion... id never reused... leaves the coverage denominator" |
| Remove, test run | **unchanged hard delete** | retire, to match requirements | a run is evidence with no id-namespace or successor concept; the existing delete predates and is out of scope for this spec |
| `_mirror_requirements` write shape | per-field `set_field`, like `_write_link` | wholesale `_write_mirror`, as `requirement-status-from-runs §10.5` names it | wholesale overwrite has no precedence check and would let a planning pass erase a manual edit outright — the one required departure, §9.1 |
| Four-eyes | a required second-actor field, gated on `status == Reviewed`, no eligibility policy | building the full review policy here | out of scope per the brief; `review-page` owns the policy, this spec only wires the gate so the surface exists when that policy lands |

---

## References

- `dev-planning/requirement-status-from-runs/spec.md` — the requirement data model, mirror
  mechanics, `verification_state` fold, `normative_sha256`, D1/BP5.
- `dev-planning/requirements-page/spec.md` — the read-only grid this spec's collision names;
  its §9/§12 already anticipate an authoring layer.
- `dev-planning/backlog.json` — `BL-18`, `BL-33`, `BL-34`, `BL-35`, `BL-36`.
- `api/api/provenance.py`, `api/api/planning_sync.py` — the write/precedence/journal mechanism
  this spec reuses without modification (§9).
- `frontend/components/screens/run-detail/edit-run-dialog.tsx`,
  `frontend/components/screens/runs/delete-runs-dialog.tsx` — the dialog idiom every new
  dialog in §13 is built on.
- CLAUDE.md — EARS pattern table, schema rules (`StateDriven` needs `system_states`,
  `verification_method: Test` needs `measurand`, `revision`/`figure_refs` regexes), the Miro
  board rules, the unresolved id-namespace question.
