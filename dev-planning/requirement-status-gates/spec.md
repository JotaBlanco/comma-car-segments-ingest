# Requirement status gates — three bands: free, earned, derived

**Status:** Draft
**Project:** comma-car-segments-ingest
**Branch / HEAD:** `jama-ui-dev` @ `c70ab7b`
**Created:** 2026-09-25
**Planned with:** Buddy
**Backlog:** `BL-20` (this feature). Depends on nothing unbuilt. Constrains `BL-32`/`BL-36`
(review page) and is constrained by what `BL-22` already shipped.

---

## 1. Goal

The user's policy, verbatim:

> *"no tehre are some gatesd, but moving to rady for review, to draft, rejected or obsolete
> can be done freely, ready for rweview -> review must pass review -> implemented/tested must
> be by TRun coverage"*

Three bands:

| Band | Statuses | Who writes it |
|---|---|---|
| **A — free** | `Draft`, `Ready for Review`, `Rejected`, `Obsolete` | any person, from the Test Manager UI |
| **B — earned** | `In Review`, `Reviewed` | only the review flow, and `Reviewed` only by a second person |
| **C — derived** | `Implemented`, `Tested` | nobody. Test-run coverage decides, and it is computed on every read |

Today `PATCH /requirements/{req_id}` accepts **any string** in `status`, including `Tested`
(`api/api/models/requirements.py:199`, docstring `:180-182`). This spec closes that, and only
that.

---

## 2. What already exists — do not rebuild it

Verified against the tree at `c70ab7b`. Roughly two thirds of this feature is already on disk.

| Fact | Where | Consequence for this spec |
|---|---|---|
| `verification_state` = `not_covered\|covered\|exercised\|failed\|tested`, **computed at read time, never stored** | `api/api/models/requirements.py:18`, folded in `queries_requirements._project` | **Band C already exists.** §4.3 does not build it; it names the mapping onto the board's two boxes. |
| `evidence_stale` degrades a passing requirement from `tested` back to `exercised` when the requirement text moved under the verdict or the implementation digest changed | `dev-planning/requirement-status-from-runs/spec.md` §4.6; `docs/architecture-requirement-status-from-runs.md:52-65` | **The regression case of §4.3 is already handled**, with no sweep and no compensating write. |
| The grid already shows the two axes side by side and says so in the page header | `frontend/components/screens/requirements/requirements-screen.tsx:178-182`, `requirements-columns.tsx:67-70`, `verification-chip.tsx:16` | The presentation question (BL-22 OQ1) is **already answered: two columns.** This spec keeps it. |
| `status` is excluded from `content_sha256` **and** `normative_sha256` | `queries_requirements.py:33, :53`, `docs/architecture-requirement-status-from-runs.md:63-65` | A status move mints `item_version` and suspects **no** link. **Unchanged by this spec** — a hard constraint, not a decision. |
| A content edit on a requirement outside `AUTHORING_STATUSES = ("NEW", "Draft")` returns it to `Draft`, journalled separately | `queries_requirements.py:65, :658-674` (shipped `fd56ad0`, `BL-71`) | "Editing a Reviewed requirement reopens review" is **already built**. This spec only confirms `Reviewed → Draft` is legal so the demotion is never refused by the new check. |
| `POST /requirements/{req_id}/retire` sets `Obsolete`, keeps the row and the id forever, refuses `already_obsolete` | `queries_requirements.py:689-750`, `routers/requirements.py:138-152` | `→ Obsolete` has its own door. The new table names it, adds nothing. |
| `RequirementCreateRequest.status: Literal["NEW","Draft"] = "Draft"` | `models/requirements.py:162` | Creation is already gated. No change. |
| Every status write already goes through `set_field(..., Source.MANUAL, actor, field_label="requirement.status")` and journals | `queries_requirements.py:643-674, :709-722` | No new journal mechanism. |
| `manual` outranks `api:planning` in `provenance.blocks()` | `api/api/provenance.py`; `planning_sync._mirror_requirements` writes per field, `planning_sync.py:441-510` | A status a person set through a gate can never be overwritten by a later planning push. |
| The review door (`request` / `claim` / `accept` / `reject` / `request-changes`), the four-eyes checks, `self_review_refused`, `identity_unavailable`, and the name `illegal_transition` | `dev-planning/review-page/spec.md` §5.3, §7, §11 — **specced, not built** | **Band B is that spec's job.** This spec states the table it must obey and reuses its refusal code. |
| The shared form already has a status control with a select branch and a **free-text Input branch** | `requirement-form-fields.tsx:135-151, :319-339` | The free-text branch is dead today (`showStatus={false}` on edit, `edit-requirement-dialog.tsx:233`) and is **deleted** by this spec — free text cannot survive a transition table. |

### 2.1 Three comments on disk are factually wrong

Each claims `RequirementPatchRequest` carries no `status`. It has carried one since the round
described in `docs/architecture-requirement-status-from-runs.md:67-83`.

| File | Lines | The claim |
|---|---|---|
| `frontend/types/requirement.ts` | `268-274` | *"No `asil`, no `status`: neither exists on the committed `RequirementPatchRequest`"* |
| `frontend/components/screens/requirements/edit-requirement-dialog.tsx` | `81-88` | *"`status` is never diffed here: the committed `RequirementPatchRequest` carries no `status` field at all"* |
| `frontend/components/screens/requirements/requirement-form-fields.tsx` | `147-150` | *"the committed `RequirementPatchRequest` carries no `status` field, so there is nothing here for a status edit to send"* |

§4.6 replaces all three in the same change.

### 2.2 One shipped field is theatre

`RequirementPatchRequest.second_actor` (`models/requirements.py:202`) is accepted, then
**excluded from the model dump and dropped** (`queries_requirements.py:607-609`). It is never
stored, never journalled, never compared to `actor`. The frontend collects it and gates Save
on it (`edit-requirement-dialog.tsx:166-171, :185, :235-238`). Today a person types a second
reviewer's name into a field that goes nowhere. §4.4 fixes this.

---

## 3. Design in one paragraph

`status` stays one stored string, and its domain shrinks to the **seven** values a person or a
review can produce: `NEW`, `Draft`, `Ready for Review`, `In Review`, `Reviewed`, `Rejected`,
`Obsolete`. `Implemented` and `Tested` are **never stored, never accepted, never written by any
fold** — they are read off `verification_state`, which already exists and is already computed
from run coverage on every read. One new module, `api/api/requirement_lifecycle.py`, holds two
frozensets keyed by the current status — `AUTHOR_TARGETS` (band A) and `REVIEW_TARGETS` (band
B) — and one function that raises `illegal_transition` (409). `patch_requirement` consults
`AUTHOR_TARGETS`; the review routes of `review-page/spec.md` consult `REVIEW_TARGETS`; the
planning mirror skips a pushed `status` that names a derived value and lands every other field,
which is the silent-skip convention `set_field` already uses for a precedence block. The edit
dialog loses its dead free-text status Input; the requirement **detail header** gains a small
status control offering exactly the legal band-A targets, with `Implemented` and `Tested` shown
disabled underneath so a person who looks for them learns why they are not there.

---

## 4. Decisions

### 4.1 The transition table

**Chosen: an explicit from → to table, keyed by the current status, split into two maps by
door. An unrecognised current status permits every band-A target and nothing else.**

Legend: **A** = free (any person, band A) · **B** = earned (review flow only, band B) ·
**R** = the `retire` route, not `PATCH` · **·** = refused `illegal_transition` ·
**=** = same value, refused `no_op_mint` (already the behaviour, `queries_requirements.py:617-622`) ·
**D** = derived, never a target for any door.

| from ↓ / to → | NEW | Draft | Ready for Review | In Review | Reviewed | Rejected | Obsolete | Implemented | Tested |
|---|---|---|---|---|---|---|---|---|---|
| **NEW** | = | **A** | **A** | · | · | **A** | **R** | D | D |
| **Draft** | · | = | **A** | · | · | **A** | **R** | D | D |
| **Ready for Review** | · | **A** | = | **B** | · | **A** | **R** | D | D |
| **In Review** | · | **A**/B | · | = | **B** | **A**/B | **R** | D | D |
| **Reviewed** | · | **A** + auto | **A** | · | = | **A** | **R** | D | D |
| **Rejected** | · | **A** | **A** | · | · | = | **R** | D | D |
| **Obsolete** | · | · | · | · | · | · | = | D | D |
| *(unknown / empty)* | · | **A** | **A** | · | · | **A** | **R** | D | D |

The pairs the user did not name, each with its reason:

- **`NEW → Draft` free; `Draft → NEW` refused.** `NEW` is a birth state (`models/requirements.py:162`
  offers it only at create). Nothing is gained by walking backwards into it, and a row that can
  return to `NEW` makes "has this ever been worked on" unanswerable.
- **`Rejected → Draft` and `Rejected → Ready for Review` free.** A rejected requirement is
  reworked and resubmitted; that is the whole point of the state. Refusing it would make
  `Rejected` a second terminal state beside `Obsolete`.
- **`Obsolete → anything` refused.** Retirement is terminal and the id is never reused
  (`authoring-controls/spec.md` §5). A resurrection would silently revive a requirement an
  auditor was told was dead, and the `already_obsolete` refusal (`queries_requirements.py:704`)
  already says this system treats the state as final. **OQ2** offers the user an un-retire.
- **`In Review → Rejected` is both A and B.** The user put `Rejected` in the free band, and the
  reviewer's `reject` also lands there. Two doors, one value; the review door additionally
  applies its four-eyes checks (`review-page/spec.md` §7).
- **`In Review → Draft`** is the review flow's *request changes* (`review-page/spec.md` §5.3)
  and is also a free move — a person may withdraw their own submission.
- **`Reviewed → Draft`** is free **and** happens automatically on a content edit
  (`queries_requirements.py:658-674`). Listing it as legal is what keeps the shipped demotion
  from being refused by the new check.
- **`Ready for Review → Reviewed` refused.** Skipping `In Review` is exactly the gate the user's
  sentence asks for: *"ready for review -> review must pass review"*. `accept` is offered only
  from `In Review` (`review-page/spec.md` §5.3).
- **`→ In Review` from anything but `Ready for Review` refused.** A claim with nothing submitted
  to claim is a claim on nothing.
- **Self-transitions** stay `no_op_mint`, unchanged. Do not add a code for them.
- **An unrecognised or empty current status permits band A.** This is not defensive padding: the
  mirror writes `row.get("status") or ""` (`planning_sync.py:466`), so a planning push that omits
  the field stores an **empty string** today. Without this row a requirement in that state could
  never move again. The rule is one `.get(current, AUTHOR_TARGETS["Draft"])` default, and it is
  the only tolerance in the design.

**Rejected — a `Literal` status on the model.** `status: str` stays a free string on
`RequirementRow`/`RequirementDetail` (`models/requirements.py:47`). A `Literal` would 500 the
*read* of a legacy or mirrored row that holds anything else — including the empty string above —
and the enum is customer configuration this code does not own (`verification-chip.tsx:8`,
`requirement-form-fields.tsx:143-145`). The table gates the **write**; the read stays permissive.

**Rejected — a state-machine library.** Two dicts and one `if` express this completely.

### 4.2 How a refusal is expressed

**Chosen: one new code, `illegal_transition` (409), with the refusal message naming the band.
The dialog renders the server's message for this code rather than a canned sentence.**

`illegal_transition` is already named by `review-page/spec.md` §11 for exactly this check;
inventing a second name for the same fact would mean two codes for one condition the moment that
spec is built.

The message is the only thing that differs, and it differs by band:

| Target band | HTTP | Code | Message (the server sends it; the dialog renders it) |
|---|---|---|---|
| B (`In Review`, `Reviewed`) via `PATCH` | 409 | `illegal_transition` | `"Reviewed is earned by passing a review, not set here. Send the requirement for review and let a second person accept it."` |
| C (`Implemented`, `Tested`) via any door | 409 | `illegal_transition` | `"Tested is computed from test-run coverage and is never set by hand. It is shown in the Verification column."` |
| A, but not legal from this state | 409 | `illegal_transition` | `"A requirement cannot move from In Review to Ready for Review."` |

**Rejected — a code per band** (`derived_status`, `review_required`, `illegal_transition`).
Three codes for one check, and the frontend's `FAILURES` map pattern
(`edit-run-dialog.tsx:88-99`) would need three sentences that the server can already state more
precisely because it knows both endpoints. The dialog keeps its map for every other code and
falls through to the server message for this one.

**What an existing caller that sets `Tested` by hand gets after this lands:** `409
illegal_transition`. **Nothing in this repo does that today** — checked:

| Checked | Result |
|---|---|
| `battery-trace-gen/data/battery-dc-requirements.json` | `"status": "Draft"` ×10 (lines 37, 77, 109, 148, 189, 220, 251, 289, 326, 365) |
| `battery-trace-gen/seed/planning_payload.py:94` | passes `item["status"]` through — always `Draft` |
| `api/seed/`, `api/mock_planning/fixture.json` | no requirements, no status (the mock was retired, `BL-72`) |
| `api/tests/` | no test posts or patches a requirement status — only `test_requirements_files.py` and `test_definition_custom_properties.py` mention requirements at all, and neither writes `status` |
| `frontend/` | never sends `status` on a PATCH (`RequirementPatchBody` omits it, `types/requirement.ts:275-294`) |

So the behaviour change is a pure tightening with **zero** callers to migrate and **zero** red
tests. That is the cheapest moment this gate will ever be.

### 4.3 `status` vs `verification_state` — the load-bearing decision

**Chosen: (a) `Implemented` and `Tested` are projections of the already-derived
`verification_state`. They are never stored in `status`, and no fold writes them. `status`
stays a single stored string whose domain is the seven authorable/earnable values.**

The mapping onto the board's two dashed boxes:

| `verification_state` | Lifecycle box a person reads | Meaning |
|---|---|---|
| `not_covered` | — (the authored status stands alone) | no test case names this requirement |
| `covered` | — | a test case names it; no run has carried it |
| `exercised` | **Implemented** | a bench session carried a covering definition — the behaviour exists in the SUT and a trace proves it ran |
| `failed` | **Implemented** | it ran and did not meet its criterion. Implemented, not Tested |
| `tested` | **Tested** | every covering test case's newest verdict passes and every pass is current |

Why (a):

1. **It is already built and already correct.** `_project` computes the fold on every read; a
   run deleted, a run flagged invalid, a definition's `covers_req_ids` edited, a newer failing
   verdict, or a requirement text edit each move the value on the next read with **no
   compensating write anywhere**.
2. **Regression is free, which is the whole failure mode the brief names.** Under (b) — a fold
   writing `Tested` into `status` — the question *"a Tested requirement whose evidence goes
   stale, does it fall back, and to what?"* needs an answer, a writer, a trigger and a `Source`
   value that is neither `manual` nor `api:planning` nor `embedded`. Under (a) the question
   dissolves: the requirement reads `exercised` + `evidence_stale: true` on the next read,
   which is exactly what `requirement-status-from-runs/spec.md` §4.6 and
   `docs/architecture-requirement-status-from-runs.md:52-65` already specify and ship.
3. **It keeps BP5 whole.** A derived value that becomes storable becomes authorable the moment
   someone finds the field. Never storing it is the only durable version of "never authored".
4. **`status` is excluded from both hashes because a status move is a person's act.** A machine
   writing `status` makes that exclusion incoherent — `requirement-status-from-runs/spec.md`
   §4.2 makes this argument in full and this spec does not reopen it.

**Rejected — (b) a fold writes `Implemented`/`Tested` into `status`.** It needs a writer, a
trigger, a new provenance source, a regression rule, and a fight with the planning mirror on
every sync pass. It also makes the `status` column lie for as long as the fold lags reality.

**Rejected — collapsing the two columns** (the Status column displays `Tested` when
`verification_state == tested`). It is one line in the projection and it was offered to the user
as BL-22 OQ1; the shipped answer is two columns, stated on the page itself
(`requirements-screen.tsx:178-182`). Collapsing now would make a person's `Draft` disappear
behind a machine's `Tested` — the exact confusion the header copy exists to prevent.

**Consequence to state plainly:** a requirement can read `Draft` in Status and `Tested` in
Verification at the same time, and that is legal. It means *the evidence passes, and nobody has
reviewed the text yet.* The page already says so.

### 4.4 What "must pass review" means concretely

**Chosen: the review flow of `dev-planning/review-page/spec.md` is the only writer of `In
Review` and `Reviewed`. This spec adds no second review concept; it states the table that flow
must obey and exports it.**

| Event | Route (review-page §11) | Writes | Second person? |
|---|---|---|---|
| a person submits | *free band — the detail screen's status control, not a review route* | `Draft → Ready for Review` | no |
| a reviewer claims | `POST /review/requirement/{id}/claim` | `Ready for Review → In Review`, sets `review.assigned_to` | no |
| a reviewer accepts | `POST /review/requirement/{id}/accept` | `In Review → Reviewed` | **yes** — `self_review_refused` (409) when the decider equals `review.requested_by`; `identity_unavailable` (401) when the caller is not a platform identity |
| a reviewer rejects | `POST /review/requirement/{id}/reject` | `In Review → Rejected` | yes |
| a reviewer asks for changes | `POST /review/requirement/{id}/request-changes` | `In Review → Draft` | no |

`In Review` means: a named person has claimed it and nobody else may decide it
(`not_claimed_by_you`, `already_claimed` — `review-page/spec.md` §7). Every one of those writes
goes through `set_field(..., Source.MANUAL, actor)` like every other status write, so the
journal shape is unchanged and `manual` precedence protects the result from a later planning
push.

**`second_actor` is NOT the four-eyes mechanism for a status move.** It is the second name
required to *edit the content of a row that already reads `Reviewed`*
(`authoring-controls/spec.md` §7), a different act with a different purpose. Its bug is that the
server discards it (§2.2). **Fix in this change, two lines:** `patch_requirement` stops
excluding it from the dump and writes it into the journal entry's note — `"Second reviewer:
<name>."` appended to the note of every entry that edit produces. No new field, no new
collection, no eligibility check (that is `review-page/spec.md` §13 OQ3's question, not this
one). A name that is collected and thrown away is worse than no field at all.

### 4.5 The UI

**Chosen: the status control lives on the requirement **detail header**, beside the existing
`ToneBadge` (`requirement-detail-screen.tsx:112`), not in the edit dialog. It offers exactly
the band-A targets legal from the current status, and lists the two derived boxes disabled
underneath.**

Why not the edit dialog: a status move is not a content edit. It mints its own journal entry,
needs no `second_actor`, and must not be tangled with the demotion rule — a submit that both
changes `text` (which demotes a frozen row to `Draft`) and states a status makes the outcome
unreadable. `IssueStateControl` in `issue-detail.tsx` is the shipped precedent for a lifecycle
control on a detail screen, and `review-page/spec.md` §12 already plans its `ReviewPanel` for
the same placement.

The control, from each state (exact copy):

| Current | Offered | Also on the screen |
|---|---|---|
| `NEW`, `Draft` | **Send for review** · **Reject** | **Retire…** (the existing `retire-requirement-dialog.tsx`) |
| `Ready for Review` | **Withdraw to Draft** · **Reject** | Retire… · a line: *"Waiting for a reviewer to claim it."* |
| `In Review` | **Withdraw to Draft** · **Reject** | Retire… · *"Claimed by {assigned_to}. Accepting is done on the Review page."* |
| `Reviewed` | **Reopen as Draft** · **Send for review** · **Reject** | Retire… |
| `Rejected` | **Reopen as Draft** · **Send for review** | Retire… |
| `Obsolete` | *(nothing)* | *"Retired. A retired requirement never returns and its id is never reused."* |

Below the menu, always, two **disabled** rows — visible, never absent, because a person who
cannot find `Tested` must learn why rather than conclude the list is broken:

```
Implemented   (disabled)  Earned when a test run exercises a covering test case.
Tested        (disabled)  Earned when every covering test case passes. Shown in Verification.
```

and one helper line under the control:

> **Status is what people decide. Verification is what the runs prove.**

`Accept` / `Claim` are **not** offered here — they belong to the Review page, and offering them
on the detail screen would be the second review concept §4.4 refuses to invent. Until that page
exists, `Ready for Review → In Review → Reviewed` is unreachable from the UI; that is stated in
§7 as a phase boundary, not hidden.

**Deleted:** the free-text status `Input` at `requirement-form-fields.tsx:327-339` and its
`showStatus` prop. The branch is unreachable today (`showStatus={false}` at
`edit-requirement-dialog.tsx:233`; the only other caller passes `statusOptions`) and under a
transition table a free-text status is a guaranteed 409. The select branch stays for create
(`add-requirement-dialog.tsx:159`, `NEW`/`Draft`).

### 4.6 The three false comments

Corrected in the same change as the gate (comments die with the code they describe).

`frontend/types/requirement.ts:268-274` → `RequirementPatchBody` **gains** `status?: string`, and
the docstring becomes:

```ts
/**
 * `PATCH /requirements/{req_id}` — a requirement's authored fields, a subset,
 * `item_version`-guarded (authoring-controls §6, §9). `status` rides along and is
 * gated server-side by the transition table (requirement-status-gates §4.1): only
 * the free band — Draft, Ready for Review, Rejected — is reachable from here, and
 * only from a state the table allows. `In Review`/`Reviewed` are written by the
 * review flow; `Implemented`/`Tested` are never stored at all, they are read off
 * `verification_state`. Anything else answers 409 `illegal_transition`.
 * No `asil`: it was proposed by `requirements-page/spec.md` and never built.
 */
```

`edit-requirement-dialog.tsx:81-88` → the `diff()` docstring becomes:

```ts
/**
 * Only the fields whose form value differs from the loaded detail — a person edits
 * one or two fields, and the route journals one entry per field that actually moved.
 * `status` is deliberately not diffed here: it moves through the detail screen's
 * status control, not through a content edit (requirement-status-gates §4.5).
 */
```

…and line `69` (`status: detail.status`) is deleted along with the `status` member of
`RequirementFormValues` (`requirement-form-fields.tsx:38, :56`) if the create dialog's select is
re-wired to its own local state; if it keeps using the shared values bag, line 69 goes and the
member stays. ArchDev picks whichever is smaller — the rule is only that no dead value survives.

`requirement-form-fields.tsx:147-150` → deleted with the `showStatus` prop (§4.5).

### 4.7 Migration

**Nothing to backfill.** All ten requirements are `Draft`
(`battery-dc-requirements.json`, ten occurrences), which is band A and legal from and to. The
seed pushes the same value, so a re-seed is a no-op against the new table.

**One pre-deploy check, one line:** `db.requirements.distinct("status")` in the `jamaui` Mongo.
Expected `["Draft"]`, possibly plus `"Obsolete"` if a row was retired during QA. Both are legal.

**The only value that could be present and is not in the table is the empty string**, which
`planning_sync.py:466` writes when a push omits `status`. The unknown-current row of §4.1 covers
it: such a row can still move to any band-A target. No migration, no repair script.

**The mirror keeps mirroring.** `_mirror_requirements` (`planning_sync.py:441-510`) is unchanged
except for one guard: a pushed `status` naming `Implemented` or `Tested` is **skipped for that
field only**, and every other field of the same push lands. This is the convention `set_field`
already follows when precedence blocks a field — the skip is silent because that is what silence
already means in this function. It is the one line that keeps band C underivable from the
planning door too; without it, BP5 has a back door. **OQ1** asks the user whether the mirror
should instead pass such a value through.

---

## 5. Data & interface contracts

### 5.1 The transition table as code (the whole new module)

`api/api/requirement_lifecycle.py` — new, and this is its entire content shape:

```python
"""The requirement status gate: who may write which status.

`dev-planning/requirement-status-gates/spec.md` §4.1 is the table. `Implemented`
and `Tested` are absent by construction: they are read off `verification_state`
and are never stored.
"""

DERIVED_STATUSES = frozenset({"Implemented", "Tested"})

# Band A — any person, through PATCH /requirements/{req_id}. `Obsolete` is
# reached by POST /requirements/{req_id}/retire and is not a PATCH target.
AUTHOR_TARGETS: dict[str, frozenset[str]] = {
    "NEW": frozenset({"Draft", "Ready for Review", "Rejected"}),
    "Draft": frozenset({"Ready for Review", "Rejected"}),
    "Ready for Review": frozenset({"Draft", "Rejected"}),
    "In Review": frozenset({"Draft", "Rejected"}),
    "Reviewed": frozenset({"Draft", "Ready for Review", "Rejected"}),
    "Rejected": frozenset({"Draft", "Ready for Review"}),
    "Obsolete": frozenset(),
}

# Band B — the review flow only (dev-planning/review-page/spec.md §5.3).
REVIEW_TARGETS: dict[str, frozenset[str]] = {
    "Ready for Review": frozenset({"In Review"}),
    "In Review": frozenset({"Reviewed", "Rejected", "Draft"}),
}

_UNKNOWN = AUTHOR_TARGETS["Draft"] | {"Draft"}


def check_transition(current: str | None, target: str, table: dict[str, frozenset[str]]) -> None:
    """Raise `illegal_transition` (409) unless `table` allows current -> target."""
```

The refusal messages are the three of §4.2. `_UNKNOWN` is the default for a current status the
table does not name (§4.1's last row).

### 5.2 API surface

| Route | Change |
|---|---|
| `PATCH /api/v1/requirements/{req_id}` | a stated `status` is checked against `AUTHOR_TARGETS`; new refusal `illegal_transition` (409). Everything else — `stale_parent`, `no_op_mint`, the `item_version` mint, the hashes — unchanged. |
| `POST /api/v1/requirements` | unchanged (`Literal["NEW","Draft"]` already gates it). |
| `POST /api/v1/requirements/{req_id}/retire` | unchanged. It is the `→ Obsolete` door and `already_obsolete` already refuses a repeat. |
| `POST /api/v1/planning/sync` | a pushed `status` in `DERIVED_STATUSES` is skipped for that field; `requirements_mirrored` still counts the row. |
| `POST /api/v1/review/requirement/{id}/*` | **not built here.** `review-page/spec.md` builds them against `REVIEW_TARGETS`. |

No model field is added or removed anywhere. `RequirementRow.status` stays `str` (§4.1).

### 5.3 Frontend contract

`RequirementPatchBody` (`frontend/types/requirement.ts:275-294`) gains `status?: string`. The
detail screen's status control is the only caller that sets it. `FAILURES` in the control gains
`illegal_transition` → *render the server's message*.

---

## 6. Work breakdown

| # | Sub-feature | Touchpoints | Depends on | Owner |
|---|---|---|---|---|
| 1 | The table module | `api/api/requirement_lifecycle.py` (new, ~40 lines) | — | ArchDev |
| 2 | The PATCH gate | `api/api/services/queries_requirements.py:616` (check before the write at `:643-657`); the demotion at `:658-674` is exempt — it writes `Draft`, legal from every state the table names | 1 | ArchDev |
| 3 | `second_actor` recorded, not dropped | `queries_requirements.py:607-609` (stop excluding), the note of each journal entry | — | ArchDev |
| 4 | Mirror guard | `api/api/planning_sync.py:462-479` | 1 | ArchDev |
| 5 | Docstring truth | `api/api/models/requirements.py:174-183` — the sentence *"A stated `status` takes any value the collection accepts — no transition table, no four-eyes gate"* is now false and must state the table instead | 2 | ArchDev |
| 6 | Status control | new `frontend/components/screens/requirements/status-control.tsx`; mounted in `requirement-detail-screen.tsx:112` (badge) and `:147` (meta cell) | 2 | ArchDev, then FrontEndEsthetic |
| 7 | Dead control removed | `requirement-form-fields.tsx:135-151, :319-339`; `edit-requirement-dialog.tsx:69, :233` | 6 | ArchDev |
| 8 | The three comments | §4.6 | 6, 7 | ArchDev |
| 9 | Contract snapshot | `api/scripts/snapshot.sh` → `api/docs/openapi.v1.json` (`BL-25` is already red; this adds one refusal and one docstring) | 2 | ArchDev |
| 10 | Backlog + CLAUDE.md | `dev-planning/backlog.json` `BL-20` → **in progress** with this spec's path, then `battery-trace-gen/tools/gen_claude_md.py` | — | DocuGuy |

**Not in this change:** the review routes (`review-page/spec.md`), any change to
`verification_state`, any change to either hash, any seed change.

### 6.1 Red-first tests (Tester, after ArchDev)

Each must be RED on the unfixed code.

| # | Test | Asserts |
|---|---|---|
| 1 | `api/tests/test_requirement_status_gate.py::test_tested_cannot_be_authored` | `PATCH` with `status: "Tested"` on a `Draft` row → 409 `illegal_transition`; the stored status is still `Draft`; `item_version` did not mint |
| 2 | `…::test_reviewed_cannot_be_set_by_hand` | `PATCH` `Ready for Review → Reviewed` → 409; `Ready for Review → Draft` → 200 |
| 3 | `…::test_the_free_band_moves` | `Draft → Ready for Review`, `→ Rejected`, `Rejected → Draft` each 200, each one journal entry with `field_label="requirement.status"` |
| 4 | `…::test_a_retired_requirement_never_moves` | `PATCH` any status on `Obsolete` → 409 `illegal_transition`; `retire` again → 409 `already_obsolete` |
| 5 | `…::test_an_unknown_status_can_still_reach_draft` | a row stored with `status: ""` (the mirror's default) accepts `→ Draft`, refuses `→ Reviewed` |
| 6 | `…::test_a_content_edit_still_demotes_a_frozen_row` | the `BL-71` path (`:658-674`) is not refused by the new check — a `text` edit on a `Reviewed` row returns it to `Draft` |
| 7 | `…::test_a_status_move_suspects_no_link` | `normative_sha256` is unchanged across a legal status move; `content_sha256` unchanged; `item_version` +1 |
| 8 | `…::test_planning_cannot_push_a_derived_status` | a push with `status: "Tested"` leaves `status` untouched and lands `title` from the same push |
| 9 | `…::test_the_second_actor_is_recorded` | a content edit on a `Reviewed` row with `second_actor` names it in the journal note |
| 10 | `frontend/tests/components/requirement-status-control.test.tsx` | the control offers exactly the §4.5 targets per state; `Implemented`/`Tested` render disabled with their reason strings; a 409 renders the server message |

---

## 7. Phase boundary

**Ships now:** the table, the PATCH gate, the mirror guard, the `second_actor` fix, the detail
control for band A, the comment corrections.

**Unreachable until `review-page` (BL-32/BL-36) is built:** `Ready for Review → In Review →
Reviewed`. A requirement can be sent for review today and nothing will claim it. The control
says so (§4.5's "Waiting for a reviewer to claim it."). This is honest and visible, not a
silent dead end — and it is the same phase boundary `review-page/spec.md` §13 already declares.

---

## 8. Risks and open questions

### Risks

| Risk | Mitigation |
|---|---|
| **A gate that ships before the review page leaves `Reviewed` unreachable.** Today `Reviewed` is reachable by anyone through a hand-rolled PATCH; after this lands nobody can reach it at all. | Named in §7 and stated in the UI copy. The states that matter for the demo — Draft, Ready for Review, Rejected, Obsolete — are all reachable. If the user needs `Reviewed` before the review page exists, that is **OQ3**. |
| **`status` remains a free string on the read model**, so a legacy or mirrored row can display a value the table does not name. | Deliberate (§4.1): the read must never 500 on data it did not write. The gate is on the write. |
| **The mirror guard is a silent skip.** A planning push stating `Tested` looks accepted and is not. | The same silence `set_field` already uses for a precedence block, in the same function. **OQ1** puts the alternative to the user. |
| **Two columns still confuse.** `Draft` beside `Tested` reads like a contradiction to a first-time viewer. | The page header already explains it (`requirements-screen.tsx:178-182`); §4.5 adds the one-line rule under the control. |

### Open questions

1. **OQ1 — the planning door.** A push stating `status: "Implemented"`/`"Tested"`: skip that
   field silently (recommended, §4.7) or mirror it verbatim because the upstream requirement tool
   owns its own lifecycle? Recommended **skip** — mirroring it would put an authored `Tested` on
   a requirement no run has covered, which is the one thing BP5 forbids. Today only our own seed
   pushes, and it pushes `Draft`, so the question is about the future Jama integration.
2. **OQ2 — un-retire.** `Obsolete → Draft` is refused (§4.1). Confirm retirement is final. If a
   mistaken retirement must be recoverable, the honest form is a new id with
   `related_reqs: [old_id]`, not a resurrection.
3. **OQ3 — `Reviewed` before the review page.** Until BL-32 ships, `Reviewed` is unreachable.
   Acceptable (recommended — the demo lives in the free band), or does Phase 1 need a temporary
   `accept` on the detail screen? A temporary one would be the second review concept §4.4
   refuses, so the recommendation is to wait.

---

## 9. Alternatives considered

| Alternative | Why not |
|---|---|
| A fold writes `Implemented`/`Tested` into `status` (§4.3 (b)) | needs a writer, a trigger, a new provenance source and a regression rule, and makes the hash-exclusion argument incoherent. (a) already ships and regresses for free. |
| Collapse Status and Verification into one column | the two-column answer shipped and is stated on the page; collapsing hides a person's value behind a machine's. |
| Three refusal codes, one per band | one condition, one code; the server states the precise reason in the message because it knows both endpoints. |
| `status: Literal[...]` on the read model | 500s the read of a legacy or empty-string row; the enum is customer configuration this code does not own. |
| The status control inside the edit dialog | tangles a status move with the content-edit demotion and with `second_actor`; `IssueStateControl` is the shipped precedent for a detail-screen lifecycle control. |
| Hide `Implemented`/`Tested` from the control entirely | a person who cannot find them concludes the list is broken. Disabled with a reason teaches the model in one glance. |
| A state-machine library / policy engine with `policy_sha256` | two dicts express this; the DCM-backed policy is `review-page/spec.md` §7's deferred item, not a prerequisite. |

---

## 10. Sanity print

### The transition grid

```
                    to:  NEW  Draft  RfR  InRev  Reviewed  Rejected  Obsolete  Implemented  Tested
from NEW                   =    A     A     ·       ·         A         R          D          D
from Draft                 ·    =     A     ·       ·         A         R          D          D
from Ready for Review      ·    A     =     B       ·         A         R          D          D
from In Review             ·   A/B    ·     =       B        A/B        R          D          D
from Reviewed              ·    A     A     ·       =         A         R          D          D
from Rejected              ·    A     A     ·       ·         =         R          D          D
from Obsolete              ·    ·     ·     ·       ·         ·         =          D          D
from (unknown / "")        ·    A     A     ·       ·         A         R          D          D

A = free, any person, PATCH        B = review flow only          R = the retire route
D = derived, never stored          · = 409 illegal_transition    = = 409 no_op_mint
```

### One line per decision

- **§4.1 Table** — explicit from→to, two maps (`AUTHOR_TARGETS`, `REVIEW_TARGETS`); `Obsolete` is
  terminal, `Rejected` is reworkable, `NEW` is birth-only, an unknown current status still
  reaches band A.
- **§4.2 Refusal** — one new code, `illegal_transition` (409), reusing `review-page`'s name, with
  the message naming the band; **nothing in the repo or the seed sets a gated status today**, so
  no caller and no test migrates.
- **§4.3 status vs verification_state** — **(a) projection.** `Implemented` ≙ `exercised|failed`,
  `Tested` ≙ `tested`; never stored, so a regression needs no fallback rule — `evidence_stale`
  already degrades `tested → exercised` on the next read. **This half is already built.**
- **§4.4 Review** — `review-page/spec.md` is the only writer of `In Review`/`Reviewed`; `accept`
  requires a different platform identity. `second_actor` is *not* that mechanism — it guards a
  content edit on a `Reviewed` row, and today the server silently drops it; this change records
  it in the journal.
- **§4.5 UI** — the control lives on the detail header, offers only the legal band-A targets, and
  lists `Implemented`/`Tested` **disabled with their reasons**; the dead free-text status Input is
  deleted; helper line *"Status is what people decide. Verification is what the runs prove."*
- **§4.6 Comments** — three, not two: `types/requirement.ts:268-274`,
  `edit-requirement-dialog.tsx:81-88`, `requirement-form-fields.tsx:147-150`, all corrected in
  the same change, with `status?: string` added to `RequirementPatchBody`.
- **§4.7 Migration** — nothing to backfill; all ten rows are `Draft`; one `distinct("status")`
  check before deploy; the mirror's empty-string default is covered by the unknown-status row.

### Files an implementation touches, by service

**`api/`**
- `api/api/requirement_lifecycle.py` *(new)*
- `api/api/services/queries_requirements.py` — `:607-609`, `:616`, `:643-674`
- `api/api/planning_sync.py` — `:462-479`
- `api/api/models/requirements.py` — `:174-183` (docstring)
- `api/docs/openapi.v1.json` — regenerated by `api/scripts/snapshot.sh`
- `api/tests/test_requirement_status_gate.py` *(new, Tester)*

**`frontend/`**
- `components/screens/requirements/status-control.tsx` *(new)*
- `components/screens/requirements/requirement-detail-screen.tsx` — `:112`, `:147`
- `components/screens/requirements/requirement-form-fields.tsx` — `:38`, `:56`, `:135-151`, `:319-339`
- `components/screens/requirements/edit-requirement-dialog.tsx` — `:69`, `:81-88`, `:233`
- `types/requirement.ts` — `:268-294`
- `tests/components/requirement-status-control.test.tsx` *(new, Tester)*

**`battery-trace-gen/`** — none.

**`dev-planning/`** — `backlog.json` (`BL-20` → in progress), then regenerate `CLAUDE.md`.

---

## 11. References

- `dev-planning/requirement-status-from-runs/spec.md` §4.2, §4.6, §5.3 — the derived axis, the
  staleness rule, the fold. Band C is that spec's, already built.
- `dev-planning/review-page/spec.md` §5.3, §7, §11 — the review door, four-eyes, and the
  `illegal_transition` name this spec reuses. Band B is that spec's, not yet built.
- `dev-planning/authoring-controls/spec.md` §6, §7, §9 — `parent_version`, the refusal set, the
  `second_actor` surface, `manual > api:planning` precedence.
- `docs/architecture-requirement-status-from-runs.md:52-83` — why `status` sits outside both
  hashes, and the round that added `status` to the PATCH body with no table.
- `CLAUDE.md` — the Miro board's lifecycle, *Covered ≠ Tested*, BP5, and `BL-19`/`BL-20`/`BL-22`.
- Board: `https://miro.com/app/board/uXjVHsQqWhY=/`.
