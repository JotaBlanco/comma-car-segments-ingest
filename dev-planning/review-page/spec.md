# Review page — a review is an object, and requirements are assigned to it

**Status:** Draft (revision 3 — all four open questions answered)
**Project:** comma-car-segments-ingest
**Created:** 2026-09-22 · **Revised:** 2026-09-25
**Planned with:** Buddy
**Backlog:** `BL-32`, `BL-36` (and `BL-33` named, not built)

---

## 0. Revision history — what changed and why

### Revision 3 (2026-09-25) — the user answered all four open questions

| Q | Answer | Effect |
|---|---|---|
| 1. Who is barred from accepting | **The requirement's content author.** Confirmed as specced. | Nothing changes. §5.5 stands. |
| 2. Where a rejection lands | **A new `Changes requested` status, not `Rejected`.** | **Overrules rev 2.** Both statuses now exist and both are reachable from a review — §5.2b, §5.3. A **named departure from the Miro board**, see §9. |
| 3. One comment per bulk rejection | **One box, one reason, applied to every member.** Confirmed as specced. | Each member still gets its own journal entry carrying the text. §5.4 stands, widened to cover `changes_requested`. |
| 4. Assignee | **A review carries an assignee. Still no due date.** | **Overrules rev 2's "no assignee".** The Portal's `GET /users` is the source — 14 real users for this org, verified by the coordinator. §5.8 is new. |

Rev 3 therefore adds: one status, one `AUTHOR_TARGETS` row, two `REVIEW_TARGETS` targets,
one decision value, one stored assignee block, two routes (`PATCH /reviews/{id}`,
`GET /users`) and one list filter. It removes nothing from rev 2.

### Revision 2 (2026-09-25) — the queue became an entity

Revision 1 was written on 2026-09-22, before the status gate shipped
(`e1fb084`, `api/api/requirement_lifecycle.py`) and before the user stated what a review
is. The user's sentence was:

> "try to create review page, tehre will be assigned requiremtnts to unique ID review
> and you can accpet them or reject all or one by one, rejection will ask for comment"

That names an **entity with an id** holding **assigned requirements**, decided **in bulk
or one at a time**, with a **mandatory comment on rejection**. Revision 1 designed a
*queue* with no entity at all. The queue is gone.

| Cut from revision 1 | Why |
|---|---|
| The unified queue over two kinds (rev-1 §5.1, §6, §8) and the `effective_state` fold | A review is now an object with members. The queue was a view over rows that had no owner; a review owns its members, and the page lists reviews. |
| The `review` sub-document on `requirements` / `test_definitions` (rev-1 §5.3) | Replaced by the `reviews` collection (§5.1). A sub-document cannot carry an id a person says out loud, and it cannot hold two requirements in one decision. |
| `ReviewPolicy`, `policy_sha256`, `api/api/review_policy.py` (rev-1 §7) | A hard-coded constant, hashed, and stamped on every decision, to stand in for a fetch that does not exist. That is machinery defending a contract nobody stated — the PR1110 construct the golden rules forbid. Deleted outright. |
| `claim` / `assigned_to` / `already_claimed` / `not_claimed_by_you` (rev-1 §7) | **Opening a review over a requirement is the claim.** A second claim step, three refusal codes and a stored claimant bought nothing the review document does not already say. (Rev 3's `assignee` is a *label*, not a claim — §5.8.) |
| `POST /review/{kind}/{item_id}/request` (rev-1 §11) | **Already shipped**: `frontend/components/screens/requirements/status-control.tsx:41-46` offers "Send for review" and `AUTHOR_TARGETS` allows `Draft → Ready for Review`. The route would be a second door onto one act. |
| `reviewed_stale` for requirements (rev-1 §5.3, §6) | **Already shipped, differently and better.** `queries_requirements.patch_requirement` lines 682-701 (BL-71) returns a frozen requirement to `Draft` the moment its content changes. A `Reviewed` requirement whose text moved therefore cannot exist, so nothing needs to detect it. The pinned-hash idea survives — as what the *reviewer reads* (§5.6), not as a state. |
| The hard `identity.source == "platform"` bar on every write (rev-1 §7) | It makes the whole feature unreachable on the local/static stack and buys nothing the deployed environment does not already give: `Quix__Portal__Api` is injected into every deployment (`api/api/quix_identity.py:12-14`). See §5.5. |
| Test definitions as a reviewable kind (rev-1 §5.2) | Not what the user asked for. The reasoning survives verbatim in §11 as the next phase, because it is still the right answer when that phase comes. |

**Survived unchanged from revision 1:** the "no signature scheme" honesty paragraph
(now §5.5); "there is no version history, so no diff viewer" (now §5.6); link
confirmation as a separate signature, designed and not built (now §5.7 / §11); and the
"build from the primitives already here, no new dependency" rule (now §7).

Rev 1's `changes_requested` idea was cut in rev 2 and is **back in rev 3** — by the
user's decision, not by reverting rev 2's reasoning. Rev 2 cut it because `Rejected` plus
band A's way back covered the round trip; the user wants the two acts told apart in the
data, which that argument does not answer.

---

## 1. Summary

A **review** is a document with a minted id (`REV-004`), a title a person types, an
optional **assignee** picked from the Quix org, and a list of **assigned requirements**.
Assigning a requirement moves it `Ready for Review → In Review`; a reviewer then
**accepts**, **requests changes on**, or **rejects** it — in bulk or one at a time — and
every outcome but acceptance carries a comment. Accepting writes the `Reviewed` status
that the status gate reserved for this flow and that nothing can reach today.

This is the page the shipped UI already points at. `status-control.tsx:81-92` lists
`In Review` and `Reviewed` as disabled with the copy *"…on the Review page. That page is
not built yet."* §8 makes those sentences true.

## 2. Goals

- A review is an object with its own id, opened over a named set of requirements.
- Accept, request changes, and reject — each in bulk and per requirement, from one screen.
- A rejection and a change request always carry a comment; an acceptance does not have to.
- `Ready for Review → In Review → Reviewed | Changes requested | Rejected` becomes
  reachable, through `REVIEW_TARGETS` and nothing else.
- The person who last wrote a requirement's normative text cannot be the person who
  accepts it.
- A review names who should look at it, picked from the real Quix org.
- Every decision is journalled and attributable, with the real Portal identity where the
  platform proves one.

## 3. Non-goals

- **Reviewing test definitions.** Named in §11 as the next phase; not built here.
- **Link confirmation** (`BL-33`/`BL-69`). Reviewed and *link confirmed at (R@v, TC@w)*
  are different facts and the board keeps them apart — §5.7.
- **A due date, an overdue derivation, or any notification.** The assignee is a label; it
  reminds nobody and escalates nothing.
- A diff viewer, a version-history store, an approvals policy engine, a signature scheme,
  a permissions system.
- **A user collection of our own.** The Quix Portal is the only source of people (§5.8).
- Requirements-page columns, filters and authoring CRUD — owned by
  `dev-planning/requirements-page/spec.md` and `dev-planning/authoring-controls/spec.md`.
- Anything that changes `content_sha256` / `normative_sha256` membership.
- Anything that makes a derived value authorable. `Implemented` and `Tested` stay
  projections of `verification_state` and are absent from every table here.

## 4. What already exists (read this before writing anything)

| Thing | Where | What it gives this feature |
|---|---|---|
| `REVIEW_TARGETS` — band B, review-flow only | `api/api/requirement_lifecycle.py:27-30` | `Ready for Review → In Review`, `In Review → {Reviewed, Rejected, Draft}`. §5.2b adds two targets. |
| `AUTHOR_TARGETS` — band A | `api/api/requirement_lifecycle.py:15-23` | `Rejected → Draft / Ready for Review`, the author's way back. §5.2b adds one row modelled on it. |
| `check_transition(current, target, table)` | `api/api/requirement_lifecycle.py:49-70` | Raises `illegal_transition` (409) with a sentence that names the owning band. Every "that requirement is not in review" refusal comes free from calling it with `REVIEW_TARGETS`. |
| Demote-on-edit (BL-71) | `api/api/services/queries_requirements.py:682-701` | A content edit on a requirement outside `NEW`/`Draft` returns it to `Draft`. Makes a mid-review edit visible (§5.2) **and** gives `Changes requested` its natural exit for free. |
| `AUTHORING_STATUSES = ("NEW", "Draft")` | `queries_requirements.py:66-68` | Unchanged by rev 3, and that is the point: editing a `Changes requested` requirement returns it to `Draft` with no new code. |
| `NORMATIVE_FIELDS` | `queries_requirements.py:58-64` | The five fields a link goes suspect on — and, here, the fields whose last author is "the author" (§5.5). |
| `set_field(...)` / `add_event(...)` | `api/api/provenance.py:211-272`, `:298-336` | One `$set` entry + one journal row per field write, with the `manual > api:planning > embedded` precedence check and the actor id stamp. No route writes a journal row by hand. |
| `field_sources.<field>.{source,actor,actor_id,at}` | `provenance.py:246-250`, `:86-95` | Per-field authorship, stamped with the Portal user id where one exists. Where "who wrote this text" is stored. |
| `journal_actor(identity, claimed)` | `api/api/auth.py:149-193` | Platform path: a `VerifiedActor` carrying `identity.user_id`. Demo path: the claimed body actor, no id. |
| `item_version` / `parent_version` / `stale_parent` | `queries_requirements.py:621-626` | The concurrency guard every authored write already uses. |
| `GET /requirements/{req_id}/journal` | `api/api/routers/journal.py:212` | The per-requirement audit trail a reviewer reads. Already shipped. |
| Bulk with a per-row failure report | `frontend/.../retire-requirement-dialog.tsx:103-140`, `:226-244` | The shipped bulk idiom: N writes, refused rows listed by id with a reason, refused rows stay picked. §5.3 copies it. |
| Row selection + batch bar on the Requirements page | `requirements-screen.tsx:73,227`, `requirements-batch-bar.tsx` | "Open a review over the picked rows" needs one button, not a new selection system. |
| `find_one_and_update` | `api/api/routers/searches.py:133` | The atomic-update idiom the id counter uses (§5.1). |
| **`quix_identity.portal_get`** (public alias of `_get`) | `api/api/quix_identity.py:266-299` | One Portal GET with the refusal/outage split already decided: 401/403 → `PlatformRefused`, anything else ≥400 or a transport error → `PlatformUnreachable`. §5.8's user list is one call through it. |
| **The `x-portal-token` route pattern** | `api/api/routers/integrations.py:185-238` | A route that reads the viewer's Portal token from the header, maps a refusal to an empty list with a log line, and maps an outage to **503 `platform_unavailable`** — *"an outage must not read as 'there are none'"*. §5.8's picker route is this route with a different path. |
| Display-name rule | `quix_identity.py:349-353` | `"first last"` or the email or the user id. §5.8 reuses it verbatim so one person reads the same in the picker, the journal and the account menu. |
| `usePortalUser(token).data.userId` | `frontend/lib/portal/client.ts:255,305` | The viewer's own Portal user id, already in the browser. This is what "Assigned to me" sends. |
| Live data | jamaui | 10 requirements, all `Draft`; their `field_sources.*.actor` is `"planning-sync"` (`api/api/planning_sync.py:59`), which is nobody's Portal name — so §5.5 never blocks a solo demo. |

---

## 5. Design decisions

### 5.1 The review entity — a new collection, a minted readable id

**Chosen: a new Mongo collection `reviews`, beside `requirements`, `test_definitions`,
`work_orders`, `test_runs`, `files`, `processed_results`, `journal_entries`.**
`_id` is minted by the server as `REV-001`, `REV-002`, … from a counter document.

```jsonc
// reviews
{
  "_id": "REV-004",
  "title": "SYS.2 battery set — thermal and SOC",   // typed by the opener
  "note": "Ahead of the OEM gate review.",          // optional, typed
  "opened_by": "Ludvík Bazják",
  "opened_by_actor_id": "u-9f31…",                  // absent on the demo path
  "opened_at": "2026-09-25T09:14:02Z",

  // §5.8 — a snapshot of one Portal user, or null. Never a lookup at read time.
  "assignee": {
    "user_id": "a41c…",                             // the stable Portal userId — the key
    "display_name": "Tomas Neubauer",               // snapshot, taken at assignment
    "email": "tomas@quix.io"                        // snapshot
  },

  "members": [
    {
      "req_id": "BAT-SYS-SAF-002",
      "added_at": "2026-09-25T09:14:02Z",
      "pinned_version": 3,                          // item_version at assignment
      "pinned_normative_sha256": "9f2b…",           // normative_sha256 at assignment
      "decision": null,                             // null | accepted | changes_requested | rejected
      "comment": null,
      "decided_by": null,
      "decided_by_actor_id": null,
      "decided_at": null,
      "decided_version": null                       // item_version the decision landed on
    }
  ]
}

// counters  (one document, new collection)
{ "_id": "reviews", "seq": 4 }
```

**Why a minted id and not a typed one.** A person typing a requirement id is stating a
fact that exists outside the registry (`BAT-SYS-SAF-002` is in the customer's spec);
typing a review id states nothing, invites `id_reuse`, and is a chore on the one screen
whose whole job is deciding. The id is minted; the **title** is what a person recognises.

**Why `REV-{n}` and not a uuid.** The user says the id out loud and puts it in a URL
(`/reviews/REV-004`). `rev-<uuid4>` — the one id-minting idiom in this codebase, at
`provenance.py:254` — is right for journal rows nobody names and wrong here. The counter
is one atomic call, the idiom already in `searches.py:133`:

```python
seq = db["counters"].find_one_and_update(
    {"_id": "reviews"}, {"$inc": {"seq": 1}}, upsert=True, return_document=ReturnDocument.AFTER
)["seq"]
review_id = f"REV-{seq:03d}"
```

**The review's own lifecycle is derived, never stored.** A review is `open` while any
member is `pending`, and `closed` otherwise (§5.2 defines `pending`). Storing a `state`
field alongside the members is a second source of truth a writer must keep in lockstep —
the same reasoning that keeps `verification_state` unstored. `closed_at` is
`max(member.decided_at)`; `pending_count` and friends are counted at read time.

A review opened by mistake is emptied (remove every member) and then reads `closed` with
no members. There is no `abandoned` state and no delete route: a review is an audit record
of who decided what, and it is kept.

*Rejected — a `reviews` array on the requirement document.* The decision is about a set,
the comment is about a set, and the id belongs to the set. Fanning that out across N
requirement documents means N writes per decision and no object to open.

### 5.2 Assignment of requirements — the review is the claim

**Chosen: a requirement joins a review only from `Ready for Review`, and joining moves it
to `In Review`. One requirement sits in at most one open review.**

Three routes do it, all going through `check_transition(status, "In Review",
REVIEW_TARGETS)`:

- `POST /reviews` with `req_ids[]` — open a review over a picked set.
- `POST /reviews/{review_id}/requirements` with `req_ids[]` — add later.
- `DELETE /reviews/{review_id}/requirements/{req_id}` — hand one back.

**Why only from `Ready for Review`.** `REVIEW_TARGETS` as shipped says exactly this, and
it was written for this feature. Widening it to accept `Draft → In Review` would make
`Ready for Review` a state nothing has to pass through and would give the review page a
second door onto "send for review", which the Requirements page already owns
(`status-control.tsx:41-46`). A requirement in `Draft` is refused with
`check_transition`'s own sentence — *"A requirement cannot move from Draft to In
Review."* — and the UI greys it out before anyone clicks (§7.3).

**Why at most one open review.** `status` is one value. Two open reviews both holding
`BAT-SYS-SAF-002`, one accepting and one rejecting, leave a status that depends on click
order and a page that cannot explain it. Refusal: **409 `already_in_review`**, naming the
other review — *"BAT-SYS-SAF-002 is already in REV-002."* The check is one query:

```python
db["reviews"].find_one({"members": {"$elemMatch": {"req_id": req_id, "decision": None}}})
```

**A member's state is derived from the requirement's status plus its own decision:**

| Member state | Condition |
|---|---|
| `pending` | `decision is None` and the requirement's `status == "In Review"` |
| `accepted` | `decision == "accepted"` |
| `changes_requested` | `decision == "changes_requested"` |
| `rejected` | `decision == "rejected"` |
| `withdrawn` | `decision is None` and `status != "In Review"` |

**What happens when someone edits a requirement mid-review.** Nothing in this feature.
`patch_requirement` lines 682-701 already returns a frozen requirement to `Draft` on a
content change, and `AUTHOR_TARGETS["In Review"]` already lets an author pull it to
`Draft` outright. Either way the status leaves `In Review`, so the member reads
`withdrawn` on the next read — with no cross-collection write from the requirements
router, and no listener. A decision on a withdrawn member is refused by
`check_transition` for free (`Draft → Reviewed` is not in `REVIEW_TARGETS`), so this
costs zero new code. The review page shows the row struck through with *"Pulled out of
review — its content changed."* and a link to the requirement's journal.

*Rejected — ejecting the member automatically on edit.* It would need the requirements
PATCH to reach into `reviews`, and it would erase the reviewer's evidence that the
requirement was pulled from under them. `withdrawn` is the more truthful record.

### 5.2b The transition table — the final shape

**Chosen (user decision, Q2): `Changes requested` is a real status, distinct from
`Rejected`. Both are reachable from a review; neither is reachable from the author door.**

- **`Changes requested`** — the reviewer read it and wants rework. The normal outcome of
  a review that does not accept.
- **`Rejected`** — refused outright; this requirement will not be implemented. Rarer, and
  harsher.

Telling the two apart in the data is the whole point: a requirement that will come back
and a requirement that will not are different facts, and one status cannot carry both.

```python
# api/api/requirement_lifecycle.py — the two rows that change, marked

AUTHOR_TARGETS: dict[str, frozenset[str]] = {
    "NEW":               frozenset({"Draft", "Ready for Review", "Rejected"}),
    "Draft":             frozenset({"Ready for Review", "Rejected"}),
    "Ready for Review":  frozenset({"Draft", "Rejected"}),
    "In Review":         frozenset({"Draft", "Rejected"}),
    "Reviewed":          frozenset({"Draft", "Ready for Review", "Rejected"}),
    "Rejected":          frozenset({"Draft", "Ready for Review"}),
    "Changes requested": frozenset({"Draft", "Ready for Review"}),   # ← NEW ROW (rev 3)
    "Obsolete":          frozenset(),
}

REVIEW_TARGETS: dict[str, frozenset[str]] = {
    "Ready for Review": frozenset({"In Review"}),
    "In Review": frozenset(                                          # ← +2 targets
        {"Reviewed", "Rejected", "Changes requested", "Draft", "Ready for Review"}
    ),
}
```

**`Changes requested → {Draft, Ready for Review}` in band A, mirroring `Rejected`.**
Decided, not open. The author reworks (an edit lands it in `Draft` for free through
`AUTHORING_STATUSES`) and sends it for review again, or sends it back unchanged to argue
the point. No new mechanism, and the same two moves the author already knows.

**`In Review → Ready for Review` in band B** is the removal path of §5.2: the reviewer
hands a requirement back unjudged. `AUTHOR_TARGETS` does not carry it, so only the review
flow can do it.

**`Changes requested` is band B only.** No row in `AUTHOR_TARGETS` names it as a *target*,
so `check_transition` refuses it through the author door with a sentence from
`_REVIEW_ONLY`, exactly as it does for `In Review` and `Reviewed`:

```python
_REVIEW_ONLY = {
    "In Review": "In Review is set when a reviewer opens a review over it, not here. …",
    "Reviewed":  "Reviewed is earned by passing a review, not set here. …",
    "Changes requested": (                                           # ← NEW (rev 3)
        "Changes requested is what a reviewer writes when they want rework, not a status "
        "set here. Send the requirement for review and let a reviewer ask."
    ),
}
```

`AUTHORING_STATUSES` is **unchanged**, `DERIVED_STATUSES` is **unchanged**,
`RequirementFacets.statuses` picks the new value up on its own (it is an `$addToSet` over
the stored data, `queries_requirements.py:428-452`), and `content_sha256` /
`normative_sha256` still exclude `status`, so none of this suspects a link.

**This is a named departure from the Miro board — see §9.** The board's lifecycle names
neither `Changes requested` nor a path back from it. The user chose it on 2026-09-25
knowing that. Do not "fix" it back to the board's enum.

### 5.3 Accept, request changes, reject — one route, partial apply, always reported

**Chosen: one route for every outcome and for both bulk and single —
`POST /reviews/{review_id}/decisions` — taking a `decision` value and a list of
`req_ids`. A single decision is a list of one. The call applies what it can and answers
both what landed and what was refused, per requirement.**

| `decision` | Status written | Comment |
|---|---|---|
| `accepted` | `Reviewed` | optional |
| `changes_requested` | `Changes requested` | **required** |
| `rejected` | `Rejected` | **required** |

```jsonc
// request
{ "decision": "changes_requested",
  "req_ids": ["BAT-SYS-SAF-002", "BAT-SYS-FUN-005"],
  "comment": "Both reference the retired 20 % calibration anchor.",
  "actor": "Ludvík Bazják" }

// 200 response
{ "review": { "…ReviewDetail…": null },
  "applied": ["BAT-SYS-SAF-002"],
  "refused": [{ "req_id": "BAT-SYS-FUN-005", "code": "stale_parent",
                "detail": "This requirement changed since the review opened." }] }
```

**Why one route and not `/accept` + `/reject` + `/request-changes`.** Three routes with
identical bodies, identical guards and one differing constant drift apart at the first
change. One route, one `decision` value, one status lookup.

**Why one route and not `/{req_id}/accept` for the single case.** A single is a list of
one. Two routes with different bodies for the same act is the same drift.

**Why partial apply, and not all-or-nothing.** Three reasons, in order of weight:

1. **The registry has no transaction anywhere.** Nothing in `api/` opens a Mongo session;
   an atomic bulk would mean either a two-phase pre-check (validate all ten, then write
   all ten — a validation layer, and still not atomic) or a hand-rolled rollback across
   `requirements`, `reviews` and `journal_entries`. Both are more machinery than the act
   deserves.
2. **The failure to design against is a *visibility* defect, not an atomicity one.** "A
   half-applied bulk the user cannot see" is cured by `refused[]`, rendered exactly like
   `retire-requirement-dialog.tsx:226-244` renders it today — *"7 of 8 accepted"*, each
   refused row with its id, its reason, and the row still picked so the reviewer can
   retry it.
3. **It matches the one bulk idiom this app already ships.** The bulk retire loops, keeps
   a `failed[]`, and reports. A reviewer who has used the Requirements page knows this
   shape already.

**Per-requirement guards, in the order the writer runs them:**

| Order | Check | Refusal |
|---|---|---|
| 1 | the review holds this `req_id` | `404 review_member_not_found` |
| 2 | the member is `pending` (no prior decision) | `409 already_decided` |
| 3 | `requirement.item_version == member.pinned_version` | `409 stale_parent` |
| 4 | the deciding actor is not the requirement's content author (§5.5) | `409 self_review_refused` |
| 5 | `check_transition(status, target, REVIEW_TARGETS)` | `409 illegal_transition` |

Guard 3 is the concurrency guard the whole registry uses, moved to the fact a reviewer
cares about: **the pinned version is the parent, so the client sends no `parent_version`
at all.** A review states "I am judging BAT-SYS-SAF-002 at v3"; if the stored version is
no longer 3, the requirement moved under the review and the decision is refused with the
existing code. Strictly better than a browser-cached `parent_version`, which only guards
against "changed since the page loaded".

**What each applied decision writes**, in one `$set` per requirement plus one `$set` on
the review:

- `requirements.status` ← the target of the table above, through `set_field(...,
  Source.MANUAL, actor, note=<the comment>, entity_type="requirement",
  field_label="requirement.status")` — so it carries the manual source tag, the
  precedence check, the actor id and one journal row, exactly like every other authored
  status move.
- `requirements.item_version` ← `+1`, the same mint `patch_requirement` does for a
  status-only change, so both doors onto `status` mint by one rule. `content_sha256` and
  `normative_sha256` are **untouched**.
- `reviews.members.$.{decision, comment, decided_by, decided_by_actor_id, decided_at,
  decided_version}`.
- One `add_event("review", review_id, "review.decided", Source.MANUAL, actor, note=…)`
  naming the requirement and the outcome.

**Write order: the requirement first, the member second.** The requirement's `status` and
its journal row are the statement of record; the member is the review's copy of it. If the
second write fails, the member is left `pending` over an already-decided requirement, and
the retry refuses cleanly with `illegal_transition` — visible, and no double write. The
reverse order would leave a member marked decided over a requirement that never moved,
which reads to a person as a completed decision that is not one.

**Both status doors go through one helper.** Factor the status write out of
`patch_requirement` into `queries_requirements.set_status(db, stored, target, table,
actor, note)`, which calls `check_transition(current, target, table)` and returns the
`set_field` entry. `patch_requirement` passes `AUTHOR_TARGETS`; the review writer passes
`REVIEW_TARGETS`. **Extend the table, do not replace it** — this is how.

### 5.4 The comment — one per call, stored twice, refused before any write

**Chosen: `comment` is required when `decision` is `rejected` or `changes_requested`, and
optional when it is `accepted`. One comment covers the whole call. It is stored on each
decided member and carried as the journal note of that member's status write.**

`changes_requested` requires it for the same reason `rejected` does, and more so: *"needs
rework"* with no statement of what to rework is the one record that helps nobody. The
user's sentence — *"rejection will ask for comment"* — is about the act of not accepting,
and both values are that act.

**Why one comment per call and not one per requirement** (user decision, Q3). A bulk
rejection is one reviewer stating one reason over a set — *"these three all reference the
retired calibration anchor"*. Eight text boxes to fill with the same sentence is a chore
that produces worse records, not better ones. A reviewer with eight different reasons
decides them one at a time, through the same route with a one-element list. The route
makes the second case free; nothing needs to be added for it.

**Why stored in both places.** The member's `comment` is what the page renders beside the
row without reading a second collection. The journal note is what makes the audit trail
complete on its own — a person reading `GET /requirements/{req_id}/journal` sees the
status move *and why*, without knowing a `reviews` collection exists. Each member of a
batch gets **its own** journal entry carrying the same text, so a per-requirement timeline
is never missing the reason. `set_field` already takes `note=`, so this is a parameter,
not a mechanism.

**The refusal.** A missing, empty or whitespace-only comment refuses the **whole call
before any write**: **409 `comment_required`**, `applied` empty.

> *"A rejection has to say why. Write a sentence the author can act on."*

- **409, not 422.** The body is well-formed; the *act* is refused. That is what every
  named refusal in this registry is (`stale_parent`, `no_op_mint`, `id_reuse`,
  `already_obsolete`). A conditional-required field expressed as a pydantic validator
  would answer 422 `validation_error` with a message the UI cannot improve on.
- **Before any write, not per requirement.** The comment is a property of the call, not of
  a member; refusing per-member would half-apply a call that was never valid.
- Blank is `comment.strip() == ""`. That one `strip` is the whole check — no minimum
  length, no content inspection, nothing else.
- The UI disables the submit button until the textarea has text, so this refusal is the
  keyboard/race path only — the same relationship `requireActor`
  (`frontend/lib/hooks/use-actor.ts:49-52`) has with its disabled buttons.

An **acceptance** takes an optional `comment`, stored and journalled the same way when
given. Requiring one would make the common act the expensive one.

### 5.5 Who may accept — the content author may not

**Chosen (user decision, Q1): the deciding actor must differ from the requirement's own
content author — the actor on the newest `field_sources` entry among `NORMATIVE_FIELDS`.
Compared per member, refused per member with `409 self_review_refused`.**

```python
# the person who last wrote what this review is judging
entries = [(doc.get("field_sources") or {}).get(f) for f in NORMATIVE_FIELDS]
latest = max((e for e in entries if e), key=lambda e: e["at"], default=None)
```

Compare `actor_id` when both sides carry one; fall back to the trimmed display name when
either does not. A match refuses that member and lands the rest.

**Why the content author and not the review opener.** Rev-1 compared against
`requested_by` because that was the only person it stored. The rule the board actually
states is that the person who *wrote* a requirement does not *approve* it — and that
person is stored, per field, in `field_sources`, with a Portal user id where one exists.
Comparing against the opener would also be arbitrary in practice: a test lead who
assembles a batch of ten requirements she did not write has nothing to be excluded from,
and excluding her blocks a one-person demo outright. The per-member rule degrades
correctly: a reviewer who wrote one of the ten accepts nine and is refused on the tenth,
by name, in `refused[]`.

**One rule, not two.** No second check against the review opener, and **none against the
assignee** (§5.8). Each additional "reasonable" guard is how the PR1110 construct
accretes; this one comparison is what four eyes means operationally here.

**What identity the system actually has.** `require_token` returns an `Identity`
(`api/api/quix_identity.py`) with `user_id`, `display_name`, `email`, `source`:

- **Deployed (jamaui):** `Quix__Portal__Api` is injected into every deployment
  (`quix_identity.py:12-14`), the frontend forwards the viewer's own Portal token, and
  `journal_actor` (`auth.py:184-193`) returns a `VerifiedActor` carrying the stable Portal
  `user_id`. `set_field` stamps it into `field_sources.<field>.actor_id` and into the
  journal row. **On this path the comparison is between two proven person ids.**
- **Local / static token:** `identity` is `STATIC_IDENTITY` (`auth.py:56-61`,
  `source="static"`, `user_id="static-token"`) and the actor is whatever the body claims.
  **The comparison still runs, on names.** It is weaker, and the page says so once:
  *"This registry names the reviewer from the signed-in Quix profile. Without one it
  records the name typed in the request."*

**No signature scheme.** This proves two distinct authenticated identities each wrote a
journalled decision on the same object — segregation of duties, auditable after the fact.
It does not prove either person read or understood the content, does not cryptographically
bind a decision to a byte-for-byte version, and does not survive a direct database edit.
Said once, here.

**No platform-only bar.** Rev-1 refused every write unless `identity.source ==
"platform"`; §0 cuts that. A shared-token caller writing under a typed name is an existing
property of every write route in this API, and closing it on one router closes nothing.

**`second_actor` is left alone.** `RequirementPatchRequest.second_actor`
(`api/api/models/requirements.py:211`, journalled by `_note_with_second_actor` at
`queries_requirements.py:588-594`) means *"the second person who co-signed this content
edit"*. A review's `decided_by` means *"the person who accepted this requirement"*. Those
are different facts about different acts; folding one into the other would make the
journal ambiguous. The review flow does not read, write or send `second_actor`.

**Today, on the live data, nobody is blocked.** All ten requirements were written by
`planning-sync` (`api/api/planning_sync.py:59`), which is no person's Portal name.

### 5.6 What the reviewer reads — a pin, not a diff

**Chosen: the member pins `item_version` and `normative_sha256` at assignment, and the row
shows the pin against the current values. No diff viewer.**

There is no stored prior text in this registry — no version-history collection, and none
proposed here. What a reviewer gets on each member row:

| Shown | From |
|---|---|
| the requirement's current `text_rendered`, measurands, states, criteria | `GET /requirements/{req_id}` |
| `v3` and, when it moved, `v3 → v4 · normative text changed since this review opened` | `pinned_version` / `item_version`, `pinned_normative_sha256` / `normative_sha256` |
| who last wrote the normative text, and when | `field_sources` (the §5.5 fold) |
| the full change history | `GET /requirements/{req_id}/journal`, already shipped |

In practice a normative change also demotes the requirement to `Draft` (§5.2), so the pin
mismatch and the `withdrawn` badge arrive together — the pin is what explains it.

### 5.7 What acceptance does beyond the status — nothing

**Chosen: accepting writes `status: "Reviewed"` and mints `item_version`. It confirms no
link, touches no hash, and asserts nothing about coverage.**

The board keeps *Reviewed* and *a confirmed link at (R@v, TC@w)* apart on purpose, and so
does this spec. Concretely, the link half cannot be built here even if it were wanted:

- The link store `traceability_links` does not exist — specced in
  `dev-planning/versions-and-links/spec.md`, open as `BL-69`.
- Test definitions carry no `item_version` and no `content_sha256` — the requirement half
  of `BL-34` shipped, the definition half did not, so there is no `w` to pin.
- `verified_by` stays derived from `covers_req_ids` (BP5 / D1,
  `queries_requirements._fold_inputs:109-117`). Nothing here authors coverage.

**When the link store lands**, confirmation belongs on the review member row as its own
act with its own signature — *"confirm the verifies link to BAT-SYS-TC-003 at (R@4,
TC@9f2b)"* — and never folded into accept. A single Accept button that silently confirmed
links would be a second statement of coverage, the defect `BL-69` calls D1.

`Implemented` and `Tested` remain projections of `verification_state` computed by
`_state_fold` (`queries_requirements.py:181-229`). They appear in no table in this spec.

### 5.8 The assignee — a label, from the Portal, snapshotted

**Chosen (user decision, Q4): a review carries an optional `assignee`, picked from the
Quix org. It is stored as a Portal `user_id` plus a display-name and email **snapshot**.
It gates nothing. There is no due date.**

#### The stored shape, and why

```jsonc
"assignee": { "user_id": "a41c…", "display_name": "Tomas Neubauer", "email": "tomas@quix.io" }
```

**The `user_id` is the key; the name and email are a snapshot taken at assignment.** This
is the pairing the registry already uses everywhere: `provenance.py:15-33` explains at
length why a journal row stores `actor` *and* `actor_id` — *"a name is not a person. A
person renames a Portal profile, and two people can share one display name."* The same two
facts, stored the same way, for the same reason.

**What happens when a person leaves the org and the id no longer resolves.** Nothing
breaks, and nothing is looked up. The review page renders the snapshot —
*"Tomas Neubauer"* — because it renders the stored fields and never calls the Portal to
resolve them. The row stays truthful about who the review was assigned to *at the time*,
which is what an audit record of a 2026 review has to say in 2028. Only two things change:
the person no longer appears in the picker (the Portal stops listing them), and the
"Assigned to me" filter never matches their id again. No backfill, no tombstone, no
`assignee_valid` flag.

*Rejected — storing the email as the key.* An email is re-assignable inside an org and is
not what the Portal keys on; `userId` is (`quix_identity.py:343-347`, and
`QuixTokenAuthHandler.cs:141` rejects an empty one for the same reason).
*Rejected — storing only the id and resolving names at read time.* Every review list page
would then need a Portal call, and a Portal outage would empty the Assignee column on a
page that has nothing to do with the Portal.

#### The picker — the API proxies `GET /users`

**Chosen: a new route `GET /api/v1/users`, reading the viewer's Portal token from the
`x-portal-token` header and calling the Portal's `/users` through
`quix_identity.portal_get`.** This is `routers/integrations.py:185-238` with a different
path, and it inherits that route's decisions verbatim:

```python
USERS_PATH = "/users"   # api/api/quix_identity.py, beside PROFILE_PATH (:124)

# api/api/routers/users.py
token = (request.headers.get("x-portal-token") or "").strip()
try:
    rows = quix_identity.list_users(token)
except quix_identity.PlatformRefused:
    logger.info("the Quix platform refused the user list for this viewer")
    rows = []
except quix_identity.PlatformUnreachable as error:
    raise ApiError(503, str(error), "platform_unavailable") from error
```

Each row maps to `{user_id, display_name, email}` using the **same display-name rule as
`_read_profile`** (`quix_identity.py:349-353`): `"first last"`, else the email, else the
id. One person then reads the same in the picker, in the journal and in the account menu.

**Why the API proxies instead of the browser calling the Portal directly.** The browser
*does* already call the Portal directly, but only for the viewer's own `/profile`
(`frontend/lib/portal/client.ts:267`), against a base URL derived from the iframe origin
and checked against `TRUSTED_PORTAL_SUFFIX` (`:115`, `:191`). An org-wide user list is a
different kind of read, and the API is where this codebase has already decided how a
Portal call fails: 401/403 is a decision about the caller (→ empty list, logged), anything
else is an outage (→ **503 `platform_unavailable`**, never an empty list). Reimplementing
that split in the browser would be a second credential path and a second set of failure
semantics for one dropdown.

**What the picker shows when the Portal is unreachable.** The 503 surfaces in the dialog
as one line beside a disabled Assignee field:

> *"The Quix platform did not answer, so the reviewer list is unavailable. Open the
> review without an assignee and set it later."*

The dialog's other fields stay live and the review still opens. A Portal outage must never
block opening a review — the assignee is a label, and the whole feature works without one.
(This is why `list_quixlabs` answers 503 rather than an empty list: an empty dropdown would
read as "there is nobody", which is a different and false statement.)

#### The assignee gates nothing

**Confirmed: it is a label saying who should look. The only bar on deciding is §5.5's
content-author rule.** A second gate would compete with the first: a reviewer who *may*
accept (not the author) but is *not* the assignee would be refused by one rule and allowed
by the other, and a person reading the refusal could not tell which applied. Worse, it
would make an unassigned review undecidable and turn a convenience field into a lock.
Anyone may decide any open review; the review records who did.

#### Reassignment

`PATCH /api/v1/reviews/{review_id}` with `{title?, note?, assignee?, actor}`. Sending
`assignee: null` unassigns. It is journalled as one `add_event("review", review_id,
"review.assigned" | "review.unassigned", Source.MANUAL, actor, note="Assigned to Tomas
Neubauer.")`. Cheap: one route, one event, no history array — the journal *is* the
history.

**The client sends the snapshot it picked.** The server stores `{user_id, display_name,
email}` as given rather than re-calling the Portal on every write. The display name is a
*label*, not an audit claim — the audit claim on this write is `actor`, which
`journal_actor` still overrides with the verified identity. Re-resolving would put a
Portal call (and a Portal outage) in the path of a write that does not need one.

#### "Assigned to me" — the API filters

`GET /reviews?assignee=<user_id>`, and the quick view sends the viewer's own
`usePortalUser(token).data.userId` (`frontend/lib/portal/client.ts:255,305`).

**Server-side, not browser-side**, because `view_counts` is whole-table and computed
server-side for every other list in this app: a browser-side filter would disagree with
its own badge and would break pagination the moment there is more than one page. When no
Portal identity resolves (the demo path), the quick view is hidden — the same thing
`useActor()` returning `null` already does to every write button.

---

## 6. API contract

Every route lives in **`api/api/routers/reviews.py`** (new) except `GET /users`, which
lives in **`api/api/routers/users.py`** (new). All take `Depends(require_token)`. The
mutating POSTs and the PATCH carry `actor: Actor` in the body, the way the requirements
routes do (`routers/requirements.py:103-157`), so the demo path can still name a person;
`journal_actor(identity, body.actor)` overrides it with the verified identity on the
platform path. The DELETE carries no body and takes the actor from the identity via
`journal_actor_or_id(identity, identity.display_name)`, the shipped idiom at
`routers/test_runs.py:401-406`.

```
GET    /api/v1/reviews?state=&assignee=&opened_by=&q=&page=&page_size=   -> ReviewPage
POST   /api/v1/reviews            { title, req_ids[], assignee?, actor, note? }
                                                                         -> ReviewWriteResult (201)
GET    /api/v1/reviews/{review_id}                                       -> ReviewDetail
PATCH  /api/v1/reviews/{review_id}   { title?, note?, assignee?, actor }  -> ReviewDetail
POST   /api/v1/reviews/{review_id}/requirements   { req_ids[], actor }   -> ReviewWriteResult
DELETE /api/v1/reviews/{review_id}/requirements/{req_id}   (no body)     -> ReviewWriteResult
POST   /api/v1/reviews/{review_id}/decisions
         { decision: "accepted"|"changes_requested"|"rejected",
           req_ids[], comment?, actor, note? }                           -> ReviewWriteResult
GET    /api/v1/reviews/{review_id}/journal?page=&page_size=&kind=        -> Page[JournalEntry]

GET    /api/v1/users                                                     -> UserList
```

`state` ∈ `open | closed`. `assignee` takes a Portal `user_id`. `q` matches `_id` and
`title`. `ReviewPage` carries `view_counts {all, open, closed}`, the shape
`RequirementPage` already uses.

### 6.1 Models — `api/api/models/reviews.py` (new)

```python
MemberState = Literal["pending", "accepted", "changes_requested", "rejected", "withdrawn"]
ReviewState = Literal["open", "closed"]
Decision    = Literal["accepted", "changes_requested", "rejected"]

class PortalUser(ApiModel):
    """One Quix person. `user_id` is the key; the other two are a snapshot (§5.8)."""
    user_id: str
    display_name: str
    email: str

class UserList(ApiModel):
    items: list[PortalUser]

class ReviewRow(ApiModel):
    review_id: str = Field(validation_alias="_id")
    title: str
    state: ReviewState                 # derived
    assignee: PortalUser | None
    opened_by: str
    opened_at: UtcDatetime
    member_count: int
    pending_count: int
    accepted_count: int
    changes_requested_count: int
    rejected_count: int
    withdrawn_count: int
    last_decided_at: UtcDatetime | None

class ReviewMember(ApiModel):
    req_id: str
    title: str                         # joined from requirements
    status: str                        # the requirement's current status
    member_state: MemberState          # derived, §5.2
    pinned_version: int
    item_version: int                  # current
    content_changed: bool              # pinned_normative_sha256 != normative_sha256
    author: str | None                 # §5.5 fold — the UI greys out Accept on own rows
    author_actor_id: str | None
    added_at: UtcDatetime
    decision: Decision | None
    comment: str | None
    decided_by: str | None
    decided_at: UtcDatetime | None

class ReviewDetail(ReviewRow):
    note: str | None
    members: list[ReviewMember]

class ReviewRefusal(ApiModel):
    req_id: str
    code: str
    detail: str

class ReviewWriteResult(ApiModel):
    review: ReviewDetail
    applied: list[str]
    refused: list[ReviewRefusal]

class ReviewCreateRequest(RequestModel):
    title: str
    req_ids: list[str]
    assignee: PortalUser | None = None
    actor: Actor
    note: str | None = None

class ReviewPatchRequest(RequestModel):
    """Every field optional; `assignee: null` unassigns (§5.8)."""
    title: str | None = None
    note: str | None = None
    assignee: PortalUser | None = None
    actor: Actor

class ReviewMembersRequest(RequestModel):
    req_ids: list[str]
    actor: Actor

class ReviewDecisionRequest(RequestModel):
    decision: Decision
    req_ids: list[str]
    comment: str | None = None
    actor: Actor
    note: str | None = None
```

`ReviewPatchRequest` cannot express "leave the assignee alone" and "clear it" with one
nullable field. The route distinguishes them with `body.model_fields_set` — the key being
present at all is the instruction — which is one attribute read, not a sentinel type.

### 6.2 Refusals

| Code | Status | Where | New? |
|---|---|---|---|
| `review_not_found` | 404 | every review route | **new** |
| `review_member_not_found` | 404 | in `refused[]` | **new** |
| `requirement_not_found` | 404 | in `refused[]`, on assignment | existing |
| `already_in_review` | 409 | in `refused[]`, on assignment | **new** (§5.2) |
| `already_decided` | 409 | in `refused[]` | **new** |
| `comment_required` | 409 | whole call, before any write | **new** (§5.4) |
| `self_review_refused` | 409 | in `refused[]` | **new** (§5.5) |
| `stale_parent` | 409 | in `refused[]` | existing, reused as-is |
| `illegal_transition` | 409 | in `refused[]` | existing, message from `check_transition` |
| `platform_unavailable` | 503 | `GET /users` only | existing (`integrations.py:228`) |

Six new codes, each naming a fact none of the existing ones states. `no_op_mint` and
`id_reuse` are deliberately **not** reused: a re-decided member is `already_decided`, and
the review id is minted so it cannot be reused. **No new refusal for the assignee** — it
gates nothing, and an unknown `user_id` is stored as given (§5.8).

`api/api/main.py:336-348` gains a block for each new route. The contract snapshot
(`api/docs/openapi.v1.json`, `api/scripts/snapshot.sh`) must be regenerated — already red
per `BL-25`, and this makes it redder.

### 6.3 Journal

`"review"` joins `WritableEntityType` (`api/api/models/journal.py:30-33`) and `_ENTITIES`
(`api/api/routers/journal.py:67-75`) gains
`"review": ("reviews", "Review", "review_not_found")`.

| `field` | When | Note |
|---|---|---|
| `review.opened` | `POST /reviews` | the title and the member ids |
| `review.assigned` / `review.unassigned` | `PATCH` with an `assignee` key | *"Assigned to Tomas Neubauer."* |
| `review.member_added` | assignment | the `req_id` |
| `review.member_removed` | removal | the `req_id` |
| `review.decided` | each applied decision | *"Changes requested on BAT-SYS-SAF-002. \<comment\>"* |

Each applied decision *also* writes the `requirement.status` change row through
`set_field`, carrying the comment as its note — so the requirement's own timeline is
complete without the review.

### 6.4 Requirement model widening (deliberate, per `BL-70`)

`RequirementRow` gains **`open_review_id: str | None`**, computed in
`queries_requirements._project` from one extra bounded query in `_fold_inputs`
(`db["reviews"].find({"members.decision": None})`, folded into a `req_id → review_id`
map). `RequirementDetail` inherits it.

Not decoration: it is what lets the Requirements page grey out a row already in a review
and lets the requirement detail say *"In review REV-004"* with a link. Without it
`already_in_review` is a refusal a person can only discover by hitting it.

### 6.5 Indexes — `api/api/db.py::ensure_indexes` (line 30)

```python
reviews = db["reviews"]
reviews.create_index([("members.req_id", ASCENDING)])
reviews.create_index([("assignee.user_id", ASCENDING)])
reviews.create_index([("opened_at", DESCENDING)])
```

---

## 7. The page

**Sidebar:** a **Reviews** entry immediately after **Requirements**
(`frontend/components/shell/sidebar.tsx:180-195`), so the first group reads Home /
Requirements / Reviews / Test definitions / Work orders / Test runs. A review is about
requirements and belongs beside them.

**Two screens, not one.** A list, because there are many reviews over time and the user
asked for a unique id that has to be findable; and a detail, because deciding is the work.

### 7.1 `/reviews` — the list

Columns: **Review** (`REV-004`, monospace) · **Title** · **State** (`ToneBadge`: open /
closed) · **Assigned to** · **Opened by** · **Opened** · **Progress** (`6 pending ·
3 accepted · 2 changes requested · 1 rejected`). Sorted `opened_at` descending.

Quick views **All / Open / Closed / Assigned to me**. The first three come from
`view_counts`; **Assigned to me** sends `?assignee=<viewer userId>` (§5.8) and is hidden
when no Portal identity resolves. Built on `useTableState` + `TableScrollArea` like every
other list.

### 7.2 `/reviews/[reviewId]` — the working screen

- **Header:** id, title, state badge, **assignee** (with an inline picker to reassign),
  opened by / at, and the progress counts.
- **Member table**, one row per assigned requirement, with a checkbox:
  Requirement id · Title · Member state (`ToneBadge`) · Version (`v3`, or `v3 → v4` with
  the *changed since this review opened* tone when `content_changed`) · Author ·
  Decision (comment shown inline under a decided row).
- **Per-row actions** on `pending` rows: **Accept** and **Request changes** as buttons,
  **Reject** in the row's overflow menu. Reject is the rarer, harsher act and reads wrong
  as a primary control beside Accept. Each fires the route with a one-element list.
- **Batch bar**, the shape of `requirements-batch-bar.tsx`: *"3 requirements picked"* →
  **Accept** · **Request changes** · **Reject** · **Remove from review** · **Clear**.
- **Decide dialog** (`decide-requirements-dialog.tsx`, one component, three modes): the
  picked ids listed and one `Textarea` — required for reject and request-changes
  (*"What has to change? The author reads this."*), optional for accept. Submit disabled
  while a required box is blank or while no actor resolves (`NO_ACTOR_MESSAGE`,
  `use-actor.ts:23-24`). No typed-word confirm: every outcome is reversible through band A
  (§5.2b), unlike retiring.
- **The `refused[]` renderer** is one shared component, and it is the load-bearing piece
  of §5.3: *"7 of 8 accepted."* then one line per refused row — id, reason — and the rows
  stay picked. Modelled on `retire-requirement-dialog.tsx:226-244`.
- **Accept is disabled on a row the viewer authored**, with the reason in the tooltip, so
  `self_review_refused` is something a person reads rather than hits.

### 7.3 Opening a review

From the **Requirements page** batch bar: pick rows → **Open a review** → a dialog taking
a title, an optional note, and an optional **assignee** (a combobox fed by
`GET /api/v1/users`), listing the picked ids and marking the ineligible ones (*"not Ready
for Review"* / *"already in REV-002"*, from `status` and `open_review_id`). A 503 from the
user list disables only the assignee field and shows §5.8's sentence. On success it routes
to `/reviews/REV-005`.

### 7.4 Files

| File | New / changed | What |
|---|---|---|
| `frontend/types/reviews.ts` | new | `ReviewRow`, `ReviewDetail`, `ReviewMember`, `ReviewWriteResult`, `ReviewRefusal`, `PortalUser` |
| `frontend/lib/api/reviews.ts` | new | `list`, `get`, `create`, `patch`, `addRequirements`, `removeRequirement`, `decide` |
| `frontend/lib/api/users.ts` | new | `list` — `GET /users` |
| `frontend/lib/hooks/use-reviews.ts` | new | the queries and the five mutations |
| `frontend/lib/hooks/use-portal-users.ts` | new | the picker query, 503 surfaced as a flag the dialog reads |
| `frontend/lib/hooks/keys.ts` | changed | `reviews` and `portalUsers` key blocks beside `requirements` (line 114) |
| `frontend/lib/hooks/index.ts` | changed | re-export |
| `frontend/app/reviews/page.tsx` | new | the list route |
| `frontend/app/reviews/[reviewId]/page.tsx` | new | the detail route |
| `frontend/components/screens/reviews/reviews-screen.tsx` | new | the list, with the four quick views |
| `frontend/components/screens/reviews/review-detail-screen.tsx` | new | header + member table |
| `frontend/components/screens/reviews/review-members-batch-bar.tsx` | new | shaped on `requirements-batch-bar.tsx` |
| `frontend/components/screens/reviews/decide-requirements-dialog.tsx` | new | one component, three modes, comment required for two of them |
| `frontend/components/screens/reviews/review-refusals.tsx` | new | the `refused[]` renderer, shared by every dialog |
| `frontend/components/screens/reviews/member-state-badge.tsx` | new | `ToneBadge` per `member_state` |
| `frontend/components/screens/reviews/assignee-picker.tsx` | new | combobox over `GET /users`, used by the header and §7.3 |
| `frontend/components/screens/requirements/open-review-dialog.tsx` | new | §7.3 |
| `frontend/components/screens/requirements/requirements-batch-bar.tsx` | changed | an **Open a review** button |
| `frontend/components/screens/requirements/status-control.tsx` | changed | the copy of §8, plus the `Changes requested` rows |
| `frontend/components/screens/requirements/requirement-detail-screen.tsx` | changed | an *In review REV-004* link when `open_review_id` is set |
| `frontend/components/shell/sidebar.tsx` | changed | the **Reviews** entry |

Built from the primitives already here — `Panel`, `ToneBadge`, `Dialog`, `Textarea`,
`Command`/`Popover` for the combobox, `useTableState`, `TableScrollArea`,
`QuickViewSegment`. No new dependency.

---

## 8. The shipped sentences this feature must make true

`status-control.tsx` currently promises a page that does not exist, and rev 3 adds a
status it has never heard of. Both land in the same commit as the routes.

| Where | Today | After |
|---|---|---|
| `:83-86` (`In Review` reason) | "Earned when a reviewer claims this requirement on the Review page. That page is not built yet, so nothing can claim it today." | "Earned when a reviewer opens a review over this requirement, on the Reviews page." |
| `:88-91` (`Reviewed` reason) | "Earned when a second person accepts the review on the Review page. That page is not built yet, so this status cannot be reached today." | "Earned when a reviewer accepts it in a review. The person who last wrote its normative text cannot be the one who accepts." |
| `REVIEW_BAND` (`:81-92`) | two entries | **three** — `Changes requested` joins them: "Written by a reviewer who wants rework. Edit the requirement and send it for review again." |
| `MOVES` (`:38-65`) | no `Changes requested` row | **new row**, mirroring `Rejected`: `{Draft: "Reopen as Draft", "Ready for Review": "Send for review"}` |
| `:123-126` (`statusHint`, `Ready for Review`) | "Waiting for a reviewer to claim it. Claiming and accepting happen on the Review page, which is not built yet." | "Waiting for a reviewer. Open a review over it from the Requirements list." |
| `:127-129` (`statusHint`, `In Review`) | "Claimed for review. Accepting it, rejecting it or asking for changes happens on the Review page, which is not built yet." | "In review. Accepting, requesting changes and rejecting happen on the review that holds it." — with the review id linked when `open_review_id` is set, so `statusHint` widens to `statusHint(status, openReviewId?)`. |
| `statusHint` | no `Changes requested` case | **new**: "A reviewer asked for changes. Edit it — an edit returns it to Draft — then send it for review again." |

**One wording change is named, not silent:** the copy says *claims*, and this design has
no claim step. Opening a review over a requirement **is** the claim (§5.2), so the sentence
changes to say so. `requirement_lifecycle.py:38-41`'s refusal message — *"In Review is set
when a reviewer claims the requirement on the Review page, not here"* — changes in the
same way: *"…when a reviewer opens a review over it, not here."*

Also `frontend/components/screens/requirements/*.test.tsx` and any e2e asserting the old
strings move in the same commit — the `BL-72` leftovers are the precedent for what happens
when a string and its assertion move separately.

---

## 9. Risks and constraints

- **`Changes requested` is a named departure from the Miro board.** The board's lifecycle
  is `NEW → Draft → Ready for Review → In Review → Reviewed → Implemented → Tested`, with
  `Rejected` from review and `Obsolete` terminal. It names neither `Changes requested` nor
  a path back from it. **The user chose it on 2026-09-25**, knowing it adds a status to
  the lifecycle, the gate table and the status control, because a requirement that will
  come back and one that will not are different facts. `AUTHOR_TARGETS["Changes
  requested"] = {Draft, Ready for Review}` mirrors `Rejected` and is likewise ours, not
  the board's. Recorded here so the next reader does not "fix" it back — and so that the
  board, if it is ever the arbiter again, is updated rather than silently disobeyed.
- **The status gate is the contract, not a suggestion.** Everything this feature writes to
  `status` goes through `check_transition(..., REVIEW_TARGETS)`. §5.2b adds two targets
  and one row; nothing is removed, and `DERIVED_STATUSES` is untouched.
- **No transaction.** §5.3 accepts partial application by design, and fixes the write
  order (requirement first, member second) so the only interrupted state is one a retry
  refuses cleanly.
- **`content_sha256` / `normative_sha256` membership is untouched**, so no decision ever
  suspects a link. This is the property that lets `Draft → Reviewed` be free.
- **A Portal outage must not block the feature.** `GET /users` answering 503 disables one
  field in one dialog (§5.8); every other route in this spec is Portal-free.
- **`BL-25`**: the OpenAPI snapshot is already stale; this adds eight routes, six refusal
  codes, one entity type, one status value and one field on `RequirementRow`. Regenerate
  in the same commit.
- **Frontend tests that mock `@/lib/hooks` wholesale** (`BL-48`) will throw on the new
  review hooks the moment the requirements screens import them. Expect to touch those six
  files.
- **The demo path names a token holder, not a person** (§5.5). Acceptable and stated on
  the page; the deployed environment proves the person.

## 10. Decisions taken — no open questions

All four of revision 2's open questions were answered by the user on 2026-09-25 and are
recorded in §0. Nothing in this spec is waiting on an answer.

Two decisions were taken by the coordinator rather than the user, and are stated as
decided:

- **`AUTHOR_TARGETS["Changes requested"] = {"Draft", "Ready for Review"}`** — the path
  back, mirroring `Rejected` (§5.2b).
- **The assignee gates nothing** (§5.8) — a second gate would compete with §5.5's
  content-author rule and would make an unassigned review undecidable.

## 11. Later, named and not built

- **Reviewing test definitions.** Revision 1's answer stands and is worth keeping: review
  targets the definition's **implementation**, pinned by `implementation.sha256` — the one
  artifact on a definition that decides a verdict — not the planning-mirrored row (which
  nothing here may write), not `manual_custom_properties` (metadata that decides nothing),
  not the requirements-file attachment (source material, not an artifact). Blocked on the
  test-definition half of `BL-34` for a version to pin against.
- **Link confirmation on the member row** (§5.7). Blocked on `BL-69`'s
  `traceability_links` and `BL-34`'s definition versions.
- **Suspect links surfaced to a reviewer.** Blocked on the same.
- **A real content diff** (§5.6). Blocked on a version-history store nothing proposes.
- **Notifications, due dates, overdue views.** Explicitly out (§3), and the assignee is
  deliberately inert so that adding them later changes only the review document.

## 12. Build list for ArchDev

**Backend (`api/`)**
1. `api/api/requirement_lifecycle.py` — the `AUTHOR_TARGETS["Changes requested"]` row, the
   two added `REVIEW_TARGETS["In Review"]` targets, the `_REVIEW_ONLY["Changes requested"]`
   message, and the reworded `_REVIEW_ONLY["In Review"]` (§5.2b, §8).
2. `api/api/quix_identity.py` — `USERS_PATH` and `list_users(token)`, built on the
   existing `portal_get` and the `_read_profile` display-name rule.
3. `api/api/routers/users.py` — new, `GET /users`, the `integrations.py:185-238` pattern.
4. `api/api/models/reviews.py` — new, §6.1.
5. `api/api/services/queries_reviews.py` — new: mint the id, open, patch, add, remove,
   decide, the derived folds (`state`, `member_state`, the counts, the §5.5 author fold),
   the `applied` / `refused` shape.
6. `api/api/services/queries_requirements.py` — extract `set_status(db, stored, target,
   table, actor, note)` from `patch_requirement` (§5.3) and call it from both doors; add
   the `open_review_id` query to `_fold_inputs` and the field to `_project` (§6.4).
7. `api/api/models/requirements.py` — `open_review_id` on `RequirementRow`.
8. `api/api/routers/reviews.py` — new, the eight review routes of §6.
9. `api/api/models/journal.py` + `api/api/routers/journal.py` — `"review"` in
   `WritableEntityType` and `_ENTITIES`.
10. `api/api/main.py` — register both routers; add the refusal blocks of §6.2.
11. `api/api/db.py` — the three indexes of §6.5.
12. `api/docs/openapi.v1.json` — regenerate (`api/scripts/snapshot.sh`).

**Frontend (`frontend/`)** — the twenty-one files of §7.4.

**Seed** — none required. The ten `Draft` requirements are one "Send for review" click
each away from being reviewable, and that control already ships.

### Red-first tests (Tester, after ArchDev)
- a bulk of three where one is stale: `applied` has 2, `refused` names the third with
  `stale_parent`, and the two that landed carry the new status.
- `decision: "changes_requested"` with `comment: "   "`: 409 `comment_required`, and **no**
  requirement moved. Same for `"rejected"`.
- `decision: "accepted"` with no comment: 200, and the status is `Reviewed`.
- a `Changes requested` requirement moved to `Ready for Review` through `PATCH
  /requirements/{id}`: allowed (band A). The same move to `Reviewed`: `illegal_transition`
  with the `_REVIEW_ONLY` sentence.
- setting `Changes requested` through `PATCH /requirements/{id}`: `illegal_transition`.
- editing a `Changes requested` requirement's text: its status is `Draft`.
- assigning a `Draft` requirement to a review: `illegal_transition`, and the review holds
  no member for it.
- assigning a requirement already in an open review: `already_in_review` naming the other
  review id.
- a decision by the actor on the newest `NORMATIVE_FIELDS` `field_sources` entry:
  `self_review_refused`, and the other members of the same call still land.
- a decision by someone who is **not** the assignee: it lands. The assignee gates nothing.
- editing a requirement's text while `In Review`: its status is `Draft`, its member reads
  `withdrawn`, and a decision on it refuses `illegal_transition`.
- removing a pending member: the requirement is back at `Ready for Review`.
- `GET /users` when the Portal is unreachable: 503 `platform_unavailable`, never `{"items":
  []}`.
- `PATCH /reviews/{id}` with `assignee: null`: the field is cleared and one
  `review.unassigned` journal entry exists.
- an accepted requirement's `normative_sha256` and `content_sha256` are byte-identical to
  what they were before the acceptance.

## 13. References

- `api/api/requirement_lifecycle.py` — the gate table this extends (`e1fb084`, `BL-20`).
- `api/api/routers/integrations.py:185-238` — the Portal-proxy route pattern §5.8 copies.
- `api/api/quix_identity.py:266-299, 330-353` — `portal_get` and the display-name rule.
- `dev-planning/requirement-status-gates/spec.md` + `architecture.md` — §4.1's bands.
- `dev-planning/authoring-controls/spec.md` — `parent_version`, `second_actor`,
  `id_reuse`, retire-never-delete.
- `dev-planning/requirement-status-from-runs/spec.md` — `verification_state`,
  `normative_sha256`, the derived-not-authored rule.
- `dev-planning/versions-and-links/spec.md` — `BL-69`'s link store, the D1 defect §5.7
  avoids.
- `dev-planning/requirements-page/spec.md` — the list/detail screens §7.3 and §8 touch.
- Miro board `https://miro.com/app/board/uXjVHsQqWhY=/` — the lifecycle and BP5. §9
  records where this spec departs from it and why.
