# Review page — the reviewer's queue for requirements and test definitions

**Status:** Draft
**Project:** comma-car-segments-ingest
**Created:** 2026-09-22
**Planned with:** Buddy

## 1. Summary

`BL-32` + `BL-36`: a functional **Review page** — one queue where a reviewer sees every
requirement and every test definition waiting on a decision, claims one, and acts: accept,
reject, request changes. It is the first screen in this codebase where a person moves a
requirement's authored `status`, and the first place `four eyes` is enforced anywhere in the
registry. It also owns the one surface the Miro board insists on: **a suspect link must appear
in the reviewer's queue.**

## 2. Goals

- One queue, both kinds: requirements and test definitions, triaged together by age.
- Claim / accept / reject / request changes, each journalled, each attributable to a real person.
- A second, different person on every accept — and on re-deciding anything already Reviewed
  whose content moved under it.
- Surface a suspect link in the same queue (data model permitting — see §9).
- Nothing here invents a workflow engine, a signature scheme, or a permissions system this
  registry does not have.

## 3. Non-goals

- Requirements page columns, filters, authoring CRUD, nav placement — owned by
  `dev-planning/requirements-page/spec.md`.
- The requirement entity, `verification_state`, `covering_run_ids` — owned by
  `dev-planning/requirement-status-from-runs/spec.md`.
- Verdicts (`BL-11`), a diff viewer, a real DCM-backed policy fetch, cryptographic signing.
- The link entity itself (`link_id`, `item_version`, `content_sha256`) — that is `BL-33`/`BL-34`,
  decided by the user (§3b of the brief) but not yet built anywhere in `api/`. This spec designs
  against it and names the dependency; it does not build it.

## 4. Background

**The mirror is read-only.** `api/api/routers/test_definitions.py` bends the "planning owns
the row" rule for exactly three fields, each in its own store beside the planning
document: `manual_requirements_files`, `manual_custom_properties`, `implementation`. A sync
pass never touches any of the three (`api/api/provenance.py::set_field`, precedence
`manual > api:* > embedded`).

**Requirements carry an authored `status` already.** `requirement-status-from-runs/spec.md`
puts `requirements` in Mongo with `status: Draft` today, mirrored from planning, and states the
rule this spec must not break: *"the authored `status` is never written by a machine."* No route
anywhere writes it. This is the first one that does — through a person, journalled, exactly the
way `set_field(..., Source.MANUAL, ...)` already writes `manual_custom_properties`.

**Test definitions carry no such field.** `DefinitionStatus = Literal["on_plan","awaiting_data"]`
(`api/api/models/planning.py:11`) is a planning-owned scheduling flag, not a lifecycle, and
planning owns it — this router never writes it either.

**The board's rules, taken as given (§3c of the brief):** NEW → Draft → Ready for Review → In
Review → Reviewed → Implemented → *Tested* (computed); Rejected leaves review; a second person
is required on accept and on any edit of a Reviewed item; link confirmation is a third,
separate signature; a generator may not confirm its own output (LK8); a suspect link must be
visible in the reviewer's queue.

**The frontend pattern to match:** `frontend/components/screens/issues/issues-screen.tsx` — a
`useTableState`-driven queue with quick views, a filter panel, `TableScrollArea`, and a
detail-screen state control (`IssueStateControl` in `issue-detail.tsx`) that changes the row's
lifecycle from the detail page rather than from a separate route. This spec's review controls
copy that shape rather than inventing a second detail screen per kind.

## 5. Design decisions

### 5.1 One queue, two kinds

**Chosen: one route, `/review`, with a `kind` facet (`Requirement` / `Test definition`, later
`Link`). Shared columns: id, kind badge, title, review state, waiting-on, age.**

A reviewer's job is triage by age and urgency, not by kind — and the one thing the board insists
must be visible (a suspect link) belongs to neither kind alone. Two screens would duplicate the
toolbar, the columns and the actions for no benefit and would give the suspect link nowhere
kind-neutral to live.

*Rejected — `/review/requirements` and `/review/definitions` as separate screens.* Matches
neither the board's single-queue framing nor the four-eyes machinery, which is identical for
both kinds.

### 5.2 What review means for a mirrored test definition

**Chosen: review targets the definition's local artifact — the implementation — not the
mirrored planning row.**

Planning owns `title`, `plan`, `covers_req_ids`; nothing here reviews those, because nothing
here may write them and there is no authored lifecycle field on them to move. The one thing a
person can and must judge is code someone wrote that decides pass/fail: `implementation`, the
fourth manual-adjacent field. Review pins the implementation's `sha256` at decision time
(`decided_at_implementation_sha256`), the same way link suspicion pins a hash — a later upload
with a different digest makes the decision stale (§5.3), and the stale item re-enters the queue.

*Rejected — reviewing `manual_custom_properties`.* It is metadata a person can edit any time;
nothing about it decides a verdict, so four-eyes on it protects nothing.
*Rejected — reviewing the requirements-file attachment.* It is source material for a human
reader, not an artifact that produces a result; treating it as reviewable content invents a
lifecycle the board never draws for it.

### 5.3 Where review state lives

**Chosen: a `review` sub-document on the owning row, shaped identically for both kinds, but the
lifecycle position lives in different fields per kind:**

```
requirements.review = {
  requested_by, requested_at, assigned_to, claimed_at,
  decided_by, decided_at, comment, policy_sha256,
  decided_at_normative_sha256,
}
test_definitions.review = {
  state,                      # AUTHORED here — no existing field to reuse
  requested_by, requested_at, assigned_to, claimed_at,
  decided_by, decided_at, comment, policy_sha256,
  decided_at_implementation_sha256,
}
```

For a **requirement**, the lifecycle position is `status` itself — it already exists, it is
already authored, and duplicating it into a second `review.state` would just be two fields a
person must keep in lockstep. `review` carries only what `status` cannot: who asked, who
claimed, who decided, and the hash the decision was pinned against.

For a **test definition**, no authored lifecycle field exists to reuse, so `review.state` is
the first one: `unreviewed | ready_for_review | in_review | reviewed | rejected |
changes_requested`.

**Staleness is derived, never stored as a state.** A Reviewed item whose pinned hash
(`decided_at_normative_sha256` / `decided_at_implementation_sha256`) no longer matches the row's
current hash (`normative_sha256` for a requirement, `implementation.sha256` for a definition) is
`reviewed, stale` at **read time** — the same pattern `verification_state` already uses for
evidence staleness (`requirement-status-from-runs §4.6`). `status`/`review.state` itself never
regresses on its own; only a person's next decision changes it. This is how *"a second person is
required … on any edit of a Reviewed item"* is honored without inventing a machine write to an
authored field.

**Transitions offered:**

| Action | Requirement (`status`) | Definition (`review.state`) | Needs a different person? |
|---|---|---|---|
| Request review | Draft → Ready for Review | unreviewed → ready_for_review | No |
| Claim | Ready for Review → In Review | ready_for_review → in_review | No |
| Accept | In Review → Reviewed | in_review → reviewed | **Yes** |
| Reject | In Review → Rejected (leaves review) | in_review → rejected | Yes, for symmetry |
| Request changes | In Review → Draft | in_review → changes_requested | No |
| Re-decide a stale Reviewed item | same as Accept/Reject, from the stale row | same | **Yes** |

*Departure from the board, named:* the board draws no "Changes requested" box. Requirements
route it back to the existing **Draft** value (no new status the enum/config does not carry);
definitions get a bespoke `changes_requested` state, since that field is this spec's own
invention and carries no customer-configuration constraint. See §10.

## 6. Review state model — the projection

`api/api/services/queries_review.py` folds both stores into one uniform read-time value,
`effective_state`, so the queue never branches on kind for display:

| `effective_state` | Requirement condition | Definition condition |
|---|---|---|
| `ready_for_review` | `status == "Ready for Review"` | `review.state == "ready_for_review"` |
| `in_review` | `status == "In Review"` | `review.state == "in_review"` |
| `reviewed` | `status == "Reviewed"` and hash matches | `review.state == "reviewed"` and hash matches |
| `reviewed_stale` | `status == "Reviewed"` and hash differs | `review.state == "reviewed"` and hash differs |
| `rejected` | `status == "Rejected"` | `review.state == "rejected"` |
| `changes_requested` | *(routes to Draft — not a distinct state)* | `review.state == "changes_requested"` |
| *(not in queue)* | every other `status` | `review.state == "unreviewed"` |

The **default queue view** shows `ready_for_review`, `in_review`, `reviewed_stale`, and (Phase 2)
suspect links. `reviewed`, `rejected`, `changes_requested` are one quick-view click away — a
history, not an inbox.

`age` = now − `state_entered_at`, a timestamp each transition writer sets on the `review`
sub-document alongside its other fields. `waiting_on` is derived text: "a reviewer to claim" /
`assigned_to`'s name / "re-confirmation — content changed since decided".

## 7. Four-eyes policy

**No signature scheme.** This proves two distinct authenticated identities each wrote a
journalled decision on the same object — segregation of duties, auditable after the fact. It
does **not** prove either person read or understood the content, does not cryptographically bind
a decision to a byte-for-byte version (a sha256 comparison is not an attestation chain), and does
not survive a direct database edit. Say this once, here, rather than implying more anywhere else
in the spec.

**Policy record.** A `ReviewPolicy` — `api/api/review_policy.py` (new) — is a small constant
today, not a DCM fetch: `{policy_id, version, self_approval: "refused",
states_requiring_second_signature: ["accept", "reject"]}`. `policy_sha256` is `sha256` of its
canonical JSON, computed once at import and stamped on every decision. **Departure from the
board, named:** 3c frames this as customer configuration pinned from DCM; this codebase has no
DCM policy-fetch mechanism today (checked — none exists), so Phase 1 hard-codes the policy and
only its *hash* rides the wire, in the shape a future DCM-backed value would take. Swapping the
source later changes nothing downstream; every consumer already reads `policy_sha256` as an
opaque string.

**Identity, not a claim.** Every write route in this router requires `identity.source ==
"platform"` (`api/quix_identity.py`), not merely a valid bearer. The static/demo token proves
"holds the shared secret," never a person — LK8 says a service account may not stand in for the
second person, so this router refuses the static path outright for every write, even though
`require_token` accepts it everywhere else. Refusal: **401 `identity_unavailable`** — "the token
does not resolve to a person." This is a real limitation of the local/demo stack: exercising
review end-to-end needs `Quix__Portal__Api` set, the way `journal_actor` already documents for
per-person provenance. Flagged as an open question (§13) rather than solved here.

**Self-review refusal.** Every `accept`/`reject` compares the caller's `actor_id` (falling back
to the actor name when no id — the demo-path caveat above) against:
- the row's `requested_by` (ordinary four-eyes: decider ≠ submitter), and
- for a definition, `implementation.uploaded_by` (LK8: decider ≠ generator).

A match refuses **409 `self_review_refused`** — a new code, not one of the four named in the
brief, added because "compare two actors and refuse a match" is the one mechanism four-eyes
actually needs and none of `identity_unavailable` / `no_op_mint` / `stale_parent` / `id_reuse`
says it.

**Claim gate.** `accept`/`reject`/`request_changes` all require the caller to already be
`review.assigned_to` — refusal **409 `not_claimed_by_you`**. A second `claim` by the same person
is a no-op 200; by a different person while already assigned is **409 `already_claimed`**.

## 8. Queue contents and ordering

**In the default view:** every requirement or definition at `ready_for_review`, `in_review`, or
`reviewed_stale`, plus (Phase 2) every link with `suspect: true`.

**Not in the default view, one click away:** `reviewed`, `rejected`, `changes_requested` — a
person's history of decisions, not work waiting on one.

**Order:** `state_entered_at` ascending (oldest first — nothing rots unseen), kind as the
tiebreak (Requirement, then Test definition, then Link) for a deterministic page across
refreshes. Quick views: **All / Requirements / Definitions / Links / Mine** (`assigned_to ==
caller`).

## 9. Link confirmation — its own act, named as a dependency

Per §3b, a link is `link_id = link_type|from_id|to_id`, records the version pair it was last
**confirmed** at (`R@v, TC@w`), and goes suspect when either end's `normative_sha256` /
`content_sha256` moves since that pair. **None of this — the `links` collection, `item_version`
minting, `no_op_mint` — exists in `api/` today** (checked: no `link_id`, `item_version`,
`content_sha256` anywhere in the codebase). This spec designs the confirmation act against that
model and cannot ship it until `BL-33`/`BL-34` lands the model itself. See §11.

**When it exists**, `POST /review/links/{link_id}/confirm` is its own single-signature act, not
folded into accept/reject: the reviewer reads the pair the link was last confirmed at, the pair
it would be confirmed at now, and which side moved (requirement text edit vs. a new
implementation) — not a text diff (§10). LK8 applies here too: the confirming actor must differ
from whichever side's `uploaded_by`/mirror-actor caused the change that made it suspect, checked
the same way §7's self-review refusal is. Confirming writes the new pair and clears `suspect`.
It does **not** require the row to be Reviewed first — a link can go suspect against an
Implemented or even a Draft item, and the board is explicit that link confirmation is a signature
of its own, independent of the item's own review state.

## 10. The diff a reviewer reads

**Honest answer: there is no version history to diff against, so this does not build a diff
viewer that cannot be fed.** What exists today:

| Kind | Before | After | What the reviewer actually sees |
|---|---|---|---|
| Requirement | — (no stored prior text) | current `text`/`measurand`/etc. | `normative_sha256` before (pinned at last decision) vs. now, plus `normative_changed_at` and a link to the current detail page for the full current text |
| Definition | previous implementation's bytes **are still retrievable** (a re-upload keeps the old object under its own digest — `test_definitions.py:846`) | current implementation | `implementation.sha256`/`filename`/`uploaded_by`/`uploaded_at` before vs. now; a **download** link for the current bytes only in Phase 1 |

**Named upgrade, not built:** `GET /test-definitions/{td_id}/implementation/{sha256}/download`
would let a reviewer fetch the *old* bytes by digest, since the object already survives a
re-upload — the missing piece is a route, not missing data. Out of scope here.

## 11. API contract

All routes below live in `api/api/routers/review.py` (new), require `require_token`, and the
five write routes additionally require `identity.source == "platform"` (§7). Every write goes
through `set_field`/`add_event` (`api/api/provenance.py`) exactly as `test_definitions.py`
already does for `manual_custom_properties` and `implementation`: one `set_field` per changed
field (carrying `Source.MANUAL`, the real actor, the precedence check) plus one `add_event`
summary line per action, in the same order (`add_event` before the row update, journalled even
when the row write later fails — a decision must never be recoverable without a trace).

```
GET  /api/v1/review?kind=&state=&assignee=&page=&page_size=
POST /api/v1/review/{kind}/{item_id}/request
POST /api/v1/review/{kind}/{item_id}/claim
POST /api/v1/review/{kind}/{item_id}/accept        { comment? }
POST /api/v1/review/{kind}/{item_id}/reject         { comment }
POST /api/v1/review/{kind}/{item_id}/request-changes { comment }
POST /api/v1/review/links/{link_id}/confirm          { comment? }   # Phase 2, §9
```

`kind` = `requirement` | `test-definition`. `item_id` = `req_id` / `td_id`.

`ReviewQueueRow`:

```jsonc
{
  "kind": "requirement",
  "item_id": "BAT-SYS-SAF-002",
  "title": "Battery temperature ceiling",
  "effective_state": "ready_for_review",
  "waiting_on": "a reviewer to claim",
  "requested_by": "j.smith", "requested_at": "…",
  "assigned_to": null,
  "state_entered_at": "…",
  "age_seconds": 132
}
```

`GET /review` reuses `Page[...]` (`api/api/models/common.py`) and adds `view_counts` by
`effective_state`, the pattern `RequirementPage`/`WorkOrderPage` already use.

**New refusals, on top of §7's `identity_unavailable` / `self_review_refused` /
`not_claimed_by_you` / `already_claimed`:** `404 review_item_not_found`; `409
illegal_transition` (the requested move is not legal from the row's current state — checked
against the transition table in §5.3, not a customer-configurable transition matrix in Phase 1,
see §13 OQ2).

**Journal.** `_ENTITIES` in `api/api/routers/journal.py` needs a `"requirement"` row — already
planned by `requirement-status-from-runs` (§10 of that spec, line 820) — and this router adds no
new entity type of its own for Phase 1; `test_definition` already exists. Phase 2 adds `"link"`
once the links collection exists.

## 12. Frontend surface

| File | New/changed | What |
|---|---|---|
| `frontend/types/review.ts` | new | `ReviewKind`, `ReviewEffectiveState`, `ReviewQueueRow` |
| `frontend/lib/api/review.ts` | new | `listReviewQueue`, `requestReview`, `claim`, `accept`, `reject`, `requestChanges` |
| `frontend/app/review/page.tsx` | new | the queue route |
| `frontend/components/screens/review/review-screen.tsx` | new | modeled on `issues-screen.tsx`: `useTableState`, quick views (All/Requirements/Definitions/Links/Mine), `TableScrollArea`, columns Kind · Item · State · Waiting on · Age |
| `frontend/components/screens/review/review-state-badge.tsx` | new | one `ToneBadge`-based chip per `effective_state`, `reviewed_stale` gets the same dashed treatment `SourceBadge`'s `derived` variant uses (visual reuse, not the same component — this badge carries *health*, `SourceBadge` never does, per requirements-page §5.1) |
| `frontend/components/screens/requirements/requirement-detail-screen.tsx` | changed | one new `ReviewPanel` (claim/accept/reject/request-changes), same placement pattern as `IssueStateControl` in `issue-detail.tsx` — does not touch the columns/fields that spec owns |
| `frontend/components/screens/definitions/definition-detail-screen.tsx` | changed | the same `ReviewPanel`, reused |
| `frontend/components/screens/review/review-panel.tsx` | new | the shared control both detail screens mount; one component, two kinds, matching §5.1's "one component, one tag" instinct from the requirements-page spec |
| `frontend/components/shell/sidebar.tsx` | changed | a **Review** entry, count = the default queue's row count |

Built from existing primitives only (`Panel`, `ToneBadge`, `useTableState`, `QuickViewSegment`).
No new component library, no drag-and-drop, no kanban board — a sortable table, exactly like
Issues.

## 13. Phase 1 vs later

**Phase 1 — ships now:**
- The requirements review lifecycle (request/claim/accept/reject/request-changes) against the
  real `status` field, once `requirement-status-from-runs` lands the `requirements` collection.
- The definition review lifecycle against a new `review` sub-document, pinned to
  `implementation.sha256`.
- The unified queue, quick views, age ordering, the four-eyes and LK8 self-review checks, the
  platform-identity requirement.
- Stale-reviewed surfacing for both kinds (a hash mismatch is enough; no link entity needed).

**Phase 2 — blocked on other backlog items, not on anything in this spec:**
- Suspect links in the queue and `confirm` (§9) — blocked on `BL-33`/`BL-34` (the `links`
  collection, `item_version`, `content_sha256`).
- A real content diff (§10) — blocked on a version-history store nothing here proposes building.
- A DCM-backed `ReviewPolicy` fetch (§7) — blocked on a DCM policy-fetch mechanism this codebase
  does not have yet.
- `BL-11` verdicts do not gate anything here — a reviewer's queue does not need a pass/fail
  outcome to decide whether text or code is *reviewable*; `verification_state` already renders
  correctly (as `not_covered`/`covered`/`exercised`) with zero verdicts.

## 14. Open questions

- **OQ1.** §11's `illegal_transition` check is hard-coded in Phase 1 (§5.3's table). 3c frames
  the enum *and* legal transitions as customer configuration pinned by `policy_sha256`. Confirm
  Phase 1 may hard-code the transition table the way it hard-codes the policy body (§7), or
  whether the transition table needs its own DCM shape from day one.
- **OQ2.** Should `request_changes` on a requirement really route to **Draft**, discarding the
  comment's context from the Status column (§5.3), or does it need its own status value added to
  the requirement schema/config — which is scope this spec was told not to redesign
  (`requirements-page` owns columns; `requirement-status-from-runs` owns the schema)?
  Recommend: Draft, for Phase 1 — the comment survives in `review.comment` and the journal either
  way.
- **OQ3.** §7's platform-identity requirement means review actions cannot be exercised on the
  static-token demo stack without `Quix__Portal__Api` set. Confirm this is acceptable for the
  functional-review demo, or whether Phase 1 needs a narrower identity bar (e.g., accepting a
  distinct *claimed* actor name on the demo path, weaker than a proven person) — this would be a
  real departure from LK8's "no service-account fallback," so it needs an explicit yes.

## 15. Decisions and rejections

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Queue shape | One `/review` route, kind facet | Two screens per kind | Suspect links belong to neither kind; triage is by age, not kind |
| Definition review target | The implementation artifact, pinned by sha256 | The mirrored planning row; custom properties; requirements files | Planning owns the row; properties decide nothing; only the implementation produces a verdict |
| Review state storage | `review` sub-doc; requirements reuse `status`, definitions get `review.state` | A parallel `status`-shaped field for both kinds | Requirements already have an authored lifecycle field — duplicating it invents a second source of truth |
| Staleness | Derived at read time from a pinned hash | A machine-written status regression | Matches `verification_state`'s existing derived-not-authored rule; a machine may never move `status` |
| Second-person proof | Compare `actor_id`/actor name across two writes, journalled | A crypto signature scheme | The brief says no signature scheme; a compared, journalled identity is what "four eyes" means operationally here |
| Policy source | A hard-coded `ReviewPolicy` constant, hashed | A DCM fetch | No DCM policy-fetch mechanism exists in this codebase yet; the hash shape survives the swap later |
| Identity bar on writes | `identity.source == "platform"` required | Accept the static/demo token like every other route | LK8: no service-account fallback for the second signature |
| Link confirmation | Designed now, not built | Skipping §9 entirely | The brief asks the confirmation act be designed against the decided model, even though the model itself is someone else's ticket |

## 16. Build list for ArchDev

**Backend (`api/`):**
1. `api/api/models/review.py` — `ReviewKind`, `ReviewEffectiveState`, `ReviewQueueRow`,
   `ReviewQueuePage`, `ReviewDecisionRequest`.
2. `api/api/review_policy.py` — the Phase-1 `ReviewPolicy` constant and `policy_sha256()`.
3. `api/api/auth.py` — `require_person` dependency: wraps `require_token`, refuses non-platform
   identities with `identity_unavailable` (401).
4. `api/api/services/queries_review.py` — the projection: two bounded queries (requirements,
   test_definitions) folded into one sorted, paginated queue; the `effective_state` fold of §6.
5. `api/api/routers/review.py` — the six routes of §11, self-review and claim-gate checks of §7,
   `set_field`/`add_event` writes per action.
6. `api/api/models/planning.py` — add `TestDefinitionReview` and a `review` field on
   `TestDefinitionDetail`/`TestDefinitionRow`.
7. Wherever `requirement-status-from-runs` lands `RequirementDetail` — add a `review` field
   there, same shape minus `state`.
8. `api/api/routers/journal.py` — confirm the `"requirement"` `_ENTITIES` row lands (owned by the
   other spec's build list); add nothing else in Phase 1.

**Frontend (`frontend/`):** the nine files of §12.

**Seed:** no seed change required for Phase 1 — the queue is legitimately empty against today's
ten Draft requirements and ten `unreviewed` definitions (§3e). A demo script (not seed data)
calls `request` on one requirement and re-uploads one implementation to produce the two non-empty
rows in §17.

### Red-first tests (Tester, after ArchDev)
- self-review refused when `decided_by == requested_by`
- LK8 refused when `decided_by == implementation.uploaded_by`
- `identity_unavailable` on the static-token path for every write route
- `already_claimed` / `not_claimed_by_you` on a second claimant
- `reviewed_stale` appears the read *after* a re-upload changes `implementation.sha256`, with no
  new write to `review.state`
- an `accept` never writes `status`/`review.state` when precedence blocks it (mirrors the
  existing `set_field` precedence test suite)

## 17. Sanity print — the queue as text, for our data

**Today (§3e's baseline — ten Draft requirements, ten `unreviewed` definitions, no links):**

```
(no rows)
The queue is empty. Nothing has been sent for review yet.
```

**After one demo action — `POST /review/requirement/BAT-SYS-SAF-002/request`:**

```
Kind          Item                Title                          State             Waiting on              Age
Requirement   BAT-SYS-SAF-002     Battery temperature ceiling     Ready for Review  a reviewer to claim      2m
```

**After a second demo action — a new implementation uploaded for a previously Reviewed
`BAT-SYS-TC-003`:**

```
Kind             Item              Title            State              Waiting on                                    Age
Requirement      BAT-SYS-SAF-002   Battery ceiling  Ready for Review    a reviewer to claim                          14m
Test definition  BAT-SYS-TC-003    (implementation) Reviewed, stale     re-confirmation — implementation changed      1m
                                                                          since decided
```

**Phase 2 illustration only — a suspect link, shown for completeness though the model does not
exist yet (§9):**

```
Kind             Item              Title            State              Waiting on                                    Age
Requirement      BAT-SYS-SAF-002   Battery ceiling  Ready for Review    a reviewer to claim                          14m
Test definition  BAT-SYS-TC-003    (implementation) Reviewed, stale     re-confirmation — implementation changed      1m
                                                                          since decided
Link             verifies|BAT-SYS- —                Suspect            confirmation — requirement text changed      —
                 SAF-002|BAT-SYS-                                       since last confirmed at (R@0.1, TC@sha9f2b)
                 TC-003
```

## 18. References

- `dev-planning/requirement-status-from-runs/spec.md` — the requirement entity, `status`,
  `normative_sha256`, `verification_state`.
- `dev-planning/requirements-page/spec.md` — the list/detail screens this spec adds a panel to;
  the `SourceBadge`/`derived` visual rule this spec's stale badge echoes without reusing.
- `api/api/provenance.py`, `api/api/auth.py`, `api/api/routers/test_definitions.py`,
  `api/api/routers/journal.py` — the write, identity and journal machinery this spec reuses.
- Miro board `https://miro.com/app/board/uXjVHsQqWhY=/` — the lifecycle, four-eyes, and LK8
  rules taken as given (§3c of the brief).
