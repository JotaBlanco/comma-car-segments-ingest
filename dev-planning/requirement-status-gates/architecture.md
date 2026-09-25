# Requirement status gates — architecture

**Spec:** `dev-planning/requirement-status-gates/spec.md`
**Branch:** `jama-ui-dev` · built on `567295f`
**Backlog:** `BL-20`

---

## What the code does

`PATCH /api/v1/requirements/{req_id}` used to accept any string in `status`, including
`Tested`. It now consults one table, `api/api/requirement_lifecycle.py`, and refuses a move the
table does not allow with 409 `illegal_transition`. The table splits the lifecycle into three
bands: the **free** band (`Draft`, `Ready for Review`, `Rejected`) any person reaches from the
requirement detail screen; the **earned** band (`In Review`, `Reviewed`) only the — not yet
built — review flow writes; and the **derived** band (`Implemented`, `Tested`) nobody writes,
because those two are projections of `verification_state`, which
`queries_requirements._project` already computes from run coverage on every read. `Obsolete`
keeps its own door, `POST /requirements/{req_id}/retire`, and is terminal. The planning mirror
gets the same rule: a push naming a derived status lands every other field and leaves the
stored status alone.

---

## Why this architecture

### The derived band is never stored (BP5)

`Implemented` and `Tested` are absent from both maps *by construction*, not by a check. There
is no code path anywhere that can put them in `requirements.status`: the PATCH gate refuses
them, the create model's `Literal["NEW","Draft"]` never offered them, the retire route writes
only `Obsolete`, and the mirror replaces them with the stored value. The alternative — a fold
writing `Tested` into `status` — needs a writer, a trigger, a provenance source that is neither
`manual` nor `api:planning`, and a regression rule for when the evidence goes stale. The
projection needs none of those: a deleted run, an edited `covers_req_ids`, a newer failing
verdict or a requirement-text edit each move the value on the next read, with no compensating
write. `evidence_stale` already degrades `tested → exercised`
(`docs/architecture-requirement-status-from-runs.md:52-65`).

This is also why `status` stays outside `content_sha256` and `normative_sha256`: a status move
is a person's act, so it mints `item_version` and suspects no link. A machine writing `status`
would make that exclusion incoherent. Membership of both hashes is unchanged by this work.

### One table, two maps, one refusal code

`AUTHOR_TARGETS` and `REVIEW_TARGETS` are plain dicts of frozensets keyed by the *current*
status. Two dicts and one `if` express the whole policy; a state-machine library would be more
machinery than statement. `REVIEW_TARGETS` has no caller yet — it is the contract
`dev-planning/review-page/spec.md` will be written against, so that spec cannot invent a second,
divergent table.

One refusal code, `illegal_transition` (409), already named by `review-page/spec.md` §11. Three
codes (one per band) would have forced the frontend to carry three sentences the server can
state more precisely, because the server knows both ends of the move. The **message** differs by
the target's band, and the status control renders the server's sentence verbatim for this code
instead of a canned one.

### A status the table does not name still moves

`planning_sync.py` stores `row.get("status") or ""` when a push omits the field, so rows with an
empty status exist. `check_transition` falls back to `_UNKNOWN` — the free band — for any
current status neither map names. Without it such a row could never move again. It is the only
tolerance in the design; the read model stays permissive too (`RequirementRow.status` is `str`,
not a `Literal`, so a legacy or mirrored value can never 500 a read).

### The control lives on the detail header, not in the edit dialog

A status move is not a content edit. It mints its own journal entry, needs no `second_actor`,
and must not tangle with the shipped demotion rule (a content edit on a frozen row returns it to
`Draft`) — a submit that both changed `text` and stated a status would have an unreadable
outcome. `IssueStateControl` (`frontend/components/screens/issues/issue-detail.tsx:85`) is the
shipped precedent for a lifecycle control on a detail screen.

The menu lists the two earned bands **disabled, with their reason**, rather than hiding them.
`Reviewed` is unreachable until the review page ships (BL-32/BL-36), and the copy says so in
words a person can act on — it names the Review page and states that the page is not built yet.
A greyed control with no reason would read as a bug; this reads as a phase boundary.

### `second_actor` was theatre; it is now evidence

`RequirementPatchRequest.second_actor` was accepted, excluded from the model dump, and dropped —
never stored, never compared, never journalled — while the edit dialog gated Save on a person
typing it. It now rides on the **note** of every journal entry the edit produces, as
`Second reviewer: <name>.`, including the demotion entry a frozen-row edit mints. It is
deliberately not a new stored field and not an approval workflow: `authoring-controls/spec.md`
§7 asks for a second name on a content edit, and a journalled claim is what makes that auditable.
Eligibility (is this person allowed to be the second pair of eyes?) is `review-page/spec.md`
§13 OQ3's question, not this one.

---

## Data flow

### A status move from the UI

```
RequirementDetailScreen
  └─ StatusControl (status-control.tsx)
       MOVES[detail.status]  ── the same free band the server's table allows,
                                so nothing this menu offers can come back 409
       └─ usePatchRequirement(req_id, actor)
            └─ PATCH /api/v1/requirements/{req_id}
                 { status, parent_version, actor }
                     │
                     ▼
            routers/requirements.patch_requirement
                 └─ queries_requirements.patch_requirement
                      1. stale_parent?    parent_version vs item_version
                      2. status_changed?  body.status != stored.status
                      3. check_transition(stored.status, body.status, AUTHOR_TARGETS)
                            └─ 409 illegal_transition, message by target band
                      4. no_op_mint?      no content change and no status change
                      5. set_field(... Source.MANUAL, actor, field_label="requirement.status")
                      6. item_version += 1;  content_sha256 / normative_sha256 unchanged
                                             (status is in neither field set)
                      7. get_requirement_detail → _project → verification_state (derived)
```

A 409 comes back to the control, which renders `error.detail` for `illegal_transition` — the
server's own sentence — and a canned line for `stale_parent` / `no_op_mint`.

### A planning push naming a derived status

```
POST /api/v1/planning/sync  { requirements: [ {... status: "Tested"} ] }
  └─ planning_sync._mirror_requirements
       values["status"] == "Tested"  ──▶  replaced by the stored status
                                          (or "" when the row is new)
       every other field lands through set_field with its normal
       manual > api:planning precedence
       requirements_mirrored still counts the row
```

Silent, deliberately: the mirror is not an authoring act, and silence is already what this
function means when precedence blocks a field. A new row cannot be left without a `status` key,
because `RequirementRow.status` is required — so a derived push on a brand-new row lands the
empty status a push omitting the field already writes, which the unknown-current row of the
table keeps movable.

### The transition table as the code encodes it

```
AUTHOR_TARGETS                 (band A — PATCH, any person)
  NEW              → Draft, Ready for Review, Rejected
  Draft            → Ready for Review, Rejected
  Ready for Review → Draft, Rejected
  In Review        → Draft, Rejected
  Reviewed         → Draft, Ready for Review, Rejected
  Rejected         → Draft, Ready for Review
  Obsolete         → (nothing — retirement is final, OQ2)
  (unnamed)        → Draft, Ready for Review, Rejected        [_UNKNOWN]

REVIEW_TARGETS                 (band B — the review flow, not built)
  Ready for Review → In Review
  In Review        → Reviewed, Rejected, Draft

DERIVED_STATUSES = {Implemented, Tested}   — no door, ever
```

A self-transition never reaches the gate: `patch_requirement` only calls `check_transition` when
`body.status != stored.status`, so `X → X` stays `no_op_mint`, unchanged.

---

## File inventory

### `api/`

| File | Change |
|---|---|
| `api/api/requirement_lifecycle.py` | **New.** `DERIVED_STATUSES`, `AUTHOR_TARGETS`, `REVIEW_TARGETS`, `_UNKNOWN`, and `check_transition`, which raises `illegal_transition` with a message chosen by the target's band. |
| `api/api/services/queries_requirements.py` | Imports the table; `patch_requirement` calls `check_transition` as soon as it knows a status moved. New `_note_with_second_actor` appends `Second reviewer: <name>.` to the note of every journal entry the edit produces, including the frozen-row demotion. Module docstring now names five refusals, not four. |
| `api/api/planning_sync.py` | `_mirror_requirements` replaces a pushed derived status with the stored one (or `""` on a new row) before the per-field write loop. |
| `api/api/models/requirements.py` | `RequirementPatchRequest` docstring: the sentence claiming `status` takes any value is replaced by the table, the bands and the doors; `second_actor`'s real destination stated. No model field added or removed. |
| `api/api/routers/requirements.py` | `PATCH` route docstring names the third refusal, so the OpenAPI description matches the behaviour. |

### `frontend/`

| File | Change |
|---|---|
| `components/screens/requirements/status-control.tsx` | **New.** `StatusControl` (the dropdown on the detail header) and `statusHint(status)` (the line under the Status cell). Holds `MOVES`, `UNKNOWN_MOVES`, the two disabled bands with their reasons, and the failure map that falls through to the server message for `illegal_transition`. |
| `components/screens/requirements/requirement-detail-screen.tsx` | The header's neutral `ToneBadge` becomes `StatusControl`; the Status cell of the Authored-attributes grid gains the hint line. `ToneBadge` import dropped — the badge now lives inside the control. |
| `components/screens/requirements/requirement-form-fields.tsx` | The dead free-text status `Input`, the `showStatus` prop and the `statusOptions` prop are gone, and `status` leaves `RequirementFormValues`. A free-text status could not survive a transition table. |
| `components/screens/requirements/add-requirement-dialog.tsx` | Keeps the create-time `NEW`/`Draft` select, now as its own local state and its own `SingleSelect`, since the shared bag no longer carries `status`. |
| `components/screens/requirements/edit-requirement-dialog.tsx` | `valuesOf` no longer copies `detail.status` (it had nowhere to go); `showStatus={false}` removed; the `diff()` docstring corrected. The second-reviewer label now says the name joins the journal entry, which is newly true. |
| `types/requirement.ts` | `RequirementPatchBody` gains `status?: string`; the docstring claiming the server model carries no `status` is replaced by the gate's contract. |

### Not touched

`verification_state` and its fold, `CONTENT_FIELDS`, `NORMATIVE_FIELDS`, both hash functions,
`create_requirement`, `retire_requirement`, the seed, the traces, the lake.

---

## Integration with neighbouring features

- **`requirement-status-from-runs` (BL-22, shipped).** This work is the other half of the same
  two-axis model: that spec built the derived axis, this one closes the authored axis so nothing
  can write a derived value into it. The two-column presentation on
  `requirements-screen.tsx:178-182` is unchanged, and the page header's sentence — `Draft` beside
  `Tested` is legal — is now enforced rather than merely explained.
- **`review-page` (BL-32/BL-36, specced, not built).** `REVIEW_TARGETS` is the contract those
  routes obey; they reuse `illegal_transition` and add their own `self_review_refused`,
  `not_claimed_by_you`, `already_claimed`. Until they exist, `Ready for Review → In Review →
  Reviewed` is unreachable, and the control says so.
- **`authoring-controls` (BL-35, partly shipped).** `parent_version`/`stale_parent`,
  `no_op_mint`, retire-never-delete and the `manual > api:planning` precedence all continue to
  hold; `second_actor` becomes real here.
- **`versions-and-links` (BL-69, not built).** A status move mints `item_version` and changes
  neither hash, so it can never make a link suspect. That stays true after this change.

---

## Known gaps

1. **`Reviewed` is unreachable** until the review page ships. Accepted (OQ3), and visible: the
   menu's disabled rows and the Status-cell hint both name the Review page and state that it is
   not built yet.
2. **Retirement is final** (OQ2). `Obsolete → anything` is refused. A mistaken retirement is
   recovered by a new id with `related_reqs: [old_id]`, not by resurrection.
3. **`api/docs/openapi.v1.json` is not regenerated.** `BL-25` already has it red for other
   reasons; this change adds one refusal to a route description. Run `api/scripts/snapshot.sh`
   when BL-25 is cleared.
4. **A pre-deploy check, one line:** `db.requirements.distinct("status")` in `jamaui`. Expected
   `["Draft"]`, possibly plus `"Obsolete"`. Both are legal from and to; nothing to backfill.
