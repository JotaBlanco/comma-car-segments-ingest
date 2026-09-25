# Requirement status from runs — the requirement becomes an entity

**Status:** Draft
**Project:** comma-car-segments-ingest
**Branch / HEAD:** `jama-ui-dev` @ `8d7847e`
**Created:** 2026-09-22
**Planned with:** Buddy
**Backlog:** `BL-22` (this feature), decides `BL-23`; resolves `BL-17`, `BL-19`; defers `BL-18`, `BL-20`; defines the contract `BL-11` writes and `BL-24` names.

---

## 1. Goal

The user's sentence:

> *"When a test run covers requirements, their status in workflow must be automatically
> moved and id of test run must be added to its attribute columns."*

Two things must become true:

1. A requirement's workflow position advances **without a person moving it**, the moment
   the evidence for it arrives.
2. The **id of the run** that produced that evidence is visible on the requirement, in the
   columns a person reads it in.

This spec designs the mechanism. It writes no code.

---

## 2. Background — read this before designing anything

### 2.1 The structural fact that blocks the request

**A requirement is not an entity in this system.** In `api/` a requirement exists only as
`RequirementsFile` (`api/api/models/planning.py:128-163`) — a markdown or binary document
attached to a test definition, reached through five routes on
`api/api/routers/test_definitions.py` (`:189`, `:328`, `:418`, `:601`, `:690`), merged from
two stores by `queries_runs.requirements_files` (`api/api/services/queries_runs.py:1487-1510`).

There is therefore:

- **no requirement row**, so no `status` field for a mechanism to move;
- **no attribute columns**, so nothing for a run id to be added to;
- **no id namespace** — `BAT-SYS-SAF-002` appears only inside the *text* of a markdown
  document and inside `battery-trace-gen/`'s own JSON, never as a key the API knows.

So the first design decision is not "how does the status move" but **"what is a requirement,
here"**. §4.1 answers it. Everything else follows from that answer.

The ASPICE schemas the older project notes referenced (`backend-api/schemas/requirement-1.0.0.schema.json`)
are **not in this tree** — they were archived with the old `backend/` Test Manager
(`archive/dcm-source-on-old-backend`). Nothing in `api/` validates a requirement against a
schema today, and this spec does not add one: the mirror stores what planning states, exactly
as it does for a work order.

### 2.2 What already exists to build on (commit `8d7847e`)

| Fact | Where |
|---|---|
| A run carries a **set** of definitions, `test_runs.definition_ids: list[str]`, sorted; `definition_id` is projected as its first element | `api/api/models/runs.py:103-116`, `db.py:42, :49` |
| Planning links merge additively through **one** write path | `api/api/planning_sync.py:435-494` `_write_link` |
| Work orders and definitions are **mirrors**: planning owns every field, one upsert helper journals the change | `planning_sync.py:285-321` `_write_mirror`, `:323-370`, `:412-432` |
| The inbound push is the only door the catalog enters by | `planning_sync.py:600-693` `apply_planning_push`; `PlanningPushRequest` `models/planning.py:363-372` |
| Each definition points at one executable `.py` in blob **by sha256** | `DefinitionImplementation`, `models/planning.py:166-187` |
| The ten implementations exist and are rendered per test case | `battery-trace-gen/seed/implementation_cases.py`, `seed/implementations.py` |
| Nobody has run them yet | `BL-11`, to do |
| Our seed is one definition per test case per requirement: 10 / 10 / 10, four runs | `CLAUDE.md` tables, `battery-trace-gen/specs/battery-dc-test-specs.json` |
| A test case already names what it covers | `covers_req_ids` in `battery-dc-test-specs.json:19, :168, :462, …` |
| `derive_status` reads `work_order_id` only and never consults a definition | `api/api/provenance.py:289-295` |
| A run delete already removes that run's results | `api/api/services/run_deletion.py:287` |

**`definition_id ≡ tc_id ≡ one requirement` is true of our seed and of nothing else.** A
customer definition may cover several requirements, and a requirement may be covered by
several definitions. Every computation below is written many-to-many and is exercised
one-to-one by our data.

### 2.3 The verdict gap

`api/api/models/results.py` has **no pass/fail concept**. `ResultBody` (`:97-112`) carries
`result_id, run_id, name, result_key, version, supersedes, description, storage_ref,
provenance, provenance_status, created_at, edited`. It names no definition, no requirement
and no outcome.

So today *"a run covers a requirement"* is a **linkage** fact (run → definitions → test cases
→ requirements) and never an **outcome** fact. A mechanism built on linkage alone would move
every requirement of every uploaded trace to "Tested", including the four the user
deliberately rigged to fail. That is the exact error the board's *Covered ≠ Tested* rule
exists to prevent.

This spec therefore **defines the verdict contract** (§6) and leaves **writing** verdicts to
`BL-11`.

### 2.4 The governing workflow — the user's Miro board

Board `https://miro.com/app/board/uXjVHsQqWhY=/`, summarised in `CLAUDE.md:158-169`. The
rules that constrain this feature:

- **Lifecycle** NEW → Draft → Ready for Review → In Review → Reviewed → Implemented →
  **Tested**; Rejected leaves review; Obsolete never reuses an id. `Tested` is drawn
  **dashed = computed, never set by hand**. `Implemented` is set by the developer.
- **`status` is AUTHORED** — a person moves it — and is deliberately **excluded from
  `normative_sha256`**, so a status move suspects no link.
- **BP5**: `verified_by` is **derived** from the test cases' `covers_req_ids` and never
  authored. An authored value is discarded with a warning (defect **D1**). Reverse links are
  always derived.
- **Covered ≠ Tested.** TESTED = a *confirmed* `verifies` link at `(R@v, TC@w)` **and** a
  **pass** for that TC in a run whose manifest pinned TC at exactly version `w`. A *suspect*
  link blocks it. A pass against an older TC version does not count.
- A link goes **suspect** only on a `normative_sha256` change: `text`, `measurand`,
  `system_states`, `verification_method`, `verification_criteria`, attachment refs.
  `status`, `rationale` and `title` are excluded.
- The status enum and the legal transitions are **customer configuration**, pinned by
  `policy_sha256` into every change event.

**D1 has a direct consequence for the user's request.** A run id written *into* a requirement
attribute is a reverse link stored on the near side — the same shape `verified_by` is
forbidden to take. §4.3 decides accordingly.

---

## 3. Design in one paragraph

A **requirement becomes a mirrored entity** in `api/`, arriving through the one door the
catalog already uses — `POST /planning/sync` gains a `requirements: [...]` list beside
`work_orders` and `test_definitions` — and the test definition gains one planning-owned
field, `covers_req_ids`. Nothing else is stored. The requirement carries its **authored**
fields (including `status`, which no machine ever writes) plus one derived value computed at
mirror time, `normative_sha256`, and the moment it last changed. Everything the user asked
for is **derived at read time** by one new service: `verified_by` by inverting
`covers_req_ids` (BP5), `covering_run_ids` by walking `test_runs.definition_ids`, and a
five-value `verification_state` — `not_covered → covered → exercised → failed | tested` —
by folding the newest **verdict** of each covering test case. A verdict is a
`processed_results` document that gained one optional nested `verdict` block naming the
definition, the outcome, the evidence numbers and the sha256 of the `.py` that decided it;
`BL-11` writes those, this feature reads them. Because every requirement-side value is a
projection and none is stored, D1 holds by construction, a deleted or invalid-flagged run
drops out of the answer with no sweep, and there is no second write path to keep in step
with `_write_link`.

---

## 4. Design decisions

Each decision states what was chosen, what was rejected, and why.

### 4.1 Where a requirement lives

**Chosen: (b) a light mirrored requirement registry — a `requirements` collection fed by
`POST /planning/sync`, with the markdown staying as the human-readable render on the
definition.**

A requirement is stored the way a work order is stored: planning owns every field, the row
is read-only to the Test Manager, `_write_mirror` (`planning_sync.py:285-321`) upserts it
and journals the change, `raw` keeps planning's payload verbatim, `field_sources` tags it
`api:planning`. Requirement ids are free strings, exactly as `wo_id` and `td_id` are — no
regex, no enum, no schema. The id namespace question in `CLAUDE.md` is thereby answered at
*this* layer: the Test Manager does not own it, the seed does.

Why this shape and not the others:

**Rejected — (a) a full first-class versioned requirement item** with `content_sha256`, an
item/version split, a `verifies` link entity with confirmed/suspect state, and a
policy-configured transition table. This is the board's design and it is the right
destination. It is also four collections, a version-resolution rule on every read, and a
link state machine — a multi-week build that would stall the demo the user is running this
week. §4.6 takes the one piece of it that pays for itself now (`normative_sha256`) and names
the rest as the upgrade path. **What (b) forecloses: nothing.** A version collection can be
added under a row that already carries `normative_sha256`; the derived projection is
unaffected because it reads the current row.

**Rejected — (c) markdown only, status as a pure read-time view.** There is nowhere to put
the authored `status`, so the only status a requirement could ever have would be the derived
one — the board's authored lifecycle could never be represented at all. And computing
anything would mean parsing prose: `queries_runs.requirements_files` returns
`{name, content, source, …}` and a requirement id appears in the content only. A regex over
a person's markdown is a defect generator, and the first person who reformats a heading
breaks every requirement's status silently.

**Rejected — requirements as `custom_properties` on the definition.** That map is a person's
free text, capped at 50 keys and 512 characters (`models/runs.py:27-29`). A load-bearing
traceability node must not live where a typo breaks the chain and nothing reports it. This
is the same reason `implementation` is its own sub-document
(`dev-planning/tm-multi-definition-runs/spec.md` §6.7).

**Rejected — a `POST /requirements` write route.** The mirror is read-only for planning
fields by design (`routers/test_definitions.py:1-16`) and only three fields bend that rule,
each a *person's* work. A requirement is not a person's work in the Test Manager; it comes
from the requirement tool. One door, `POST /planning/sync`, keeps the provenance story
whole — and it is the door the future Jama integration will use.

### 4.2 Which status moves, and whether "automatic" means authored or derived

**Chosen: the authored `status` is never written by a machine. The automatic movement is a
second, derived field, `verification_state`, computed at read time.**

```
status               AUTHORED   Draft / Reviewed / Implemented / …   planning's value, mirrored
verification_state   DERIVED    not_covered / covered / exercised / failed / tested
```

The board is explicit and consistent: `status` is authored, `Tested` is the one lifecycle
position that is computed and is drawn dashed for exactly that reason. A machine that writes
an authored field destroys the distinction the board's `normative_sha256` exclusion rests on
— *"a status move suspects no links"* is only meaningful while a status move is a person's
act.

`verification_state` is that dashed box, made explicit and honestly labelled. It moves by
itself, which is what the user asked for, and it can never be out of step with the evidence
because it *is* the evidence, read.

**Rejected — writing `status = "Tested"` through `set_field`.** It would need a new `Source`
value (it is neither `manual`, nor `api:planning`, nor `embedded`), it would need the
customer's transition table and `policy_sha256` to know whether the move is legal — which is
configuration this system does not hold (BL-20) — and it would overwrite a value planning
owns, which the next sync pass would then fight over. Three new mechanisms to express one
boolean that can be computed.

**Rejected — a proposal queue** (the mechanism computes `Tested` and files a suggested
transition for a person to accept). It is defensible under ASPICE and it is a second
collection, a review screen and an expiry rule for a demo that has no reviewer. Named as the
upgrade path in §9, not built.

**The choice this leaves the user** is presentation only, and it is **OQ1**: does the grid's
Status column keep showing the authored value beside a Verification column (recommended), or
does it display `Tested` in place of the authored value when `verification_state == tested`?
The second is a one-line display override in the projection and still writes nothing. Both
are honest; the first never hides what a person wrote.

### 4.3 The run-id attribute

**Chosen: derived, not stored. `covering_run_ids: list[str]` on the requirement read, newest
first, with `latest_run_id` as the scalar the grid column shows.**

| Field | Type | Meaning |
|---|---|---|
| `covering_run_ids` | `list[str]` | every run that carries at least one definition whose `covers_req_ids` names this requirement, **excluding invalid-flagged runs**. Sorted by the run's `first_data_at` DESC, then `run_id` DESC. Capped at 20 on the list read; the detail read returns them all. |
| `covering_run_count` | `int` | the true total, so a capped list can say how many it holds back |
| `latest_run_id` | `str \| None` | `covering_run_ids[0]`, or null. **This is the "attribute column" the user asked for.** |
| `evidence` | `list[RequirementEvidence]` | detail read only: one row per `(run_id, definition_id)` with the verdict, its `produced_at`, its implementation digest and whether it is current |

`covering_run_ids` is ordered on `first_data_at` DESC, `run_id` DESC — the newest **bench
session** first, the same key the definition detail sorts its runs by (`queries_runs.py:1467`).

That ordering does **not** decide which verdict is current. This spec originally said it did,
and claimed the two screens could therefore never disagree; they did. Ranking a verdict by
when its data arrived ranks the wrong thing, because re-running an older trace today makes
that the current answer. **A verdict is ranked by `provenance.produced_at`** — one reduction,
`verdict_rollups.latest_verdict_of`, shared by this fold and the definition rollup. Freshness
of data stays a separate fact, carried by `evidence_stale`.

**Where it is computed: a read-time projection**, in a new service
`api/api/services/queries_requirements.py`. Three bounded queries per page (§5.3). No sweep,
no scheduler, no write on the ingestion event.

**Rejected — a stored array on the requirement, written when a run registers.** Three
reasons, in order of severity:

1. **It is D1.** A run id on a requirement is a reverse link. The board's rule is that
   reverse links are derived and an authored one is discarded with a warning. Storing this
   one is the same anti-pattern with a different field name.
2. **It goes stale in four ways nothing reports**: a run deleted
   (`run_deletion.py:287-291`), a run flagged invalid (`models/runs.py:96-100`), a
   definition's `covers_req_ids` edited by a planning push, a definition removed from a run
   by `PATCH /test-runs/{id}`. Each needs its own compensating write.
3. **It forks the link write path.** `_write_link` (`planning_sync.py:435-494`) is
   deliberately the ONE place a link is written, so the outbound backfill and the inbound
   push cannot drift. A requirement-side denormalisation would have to be maintained there
   *and* in `_resolve_claims`, `patch_run` and `demo_reset`.

**Rejected — a periodic recompute sweep.** Same staleness window, plus a scheduler the API
does not have and a "last computed at" a screen would have to explain.

### 4.4 The trigger

**Chosen: there is no trigger. The state is a projection, so it moves the instant the
underlying fact lands.**

Two independent facts move it, and neither writes to the requirement:

| Fact | Written by | Moves the state |
|---|---|---|
| A run carries a covering definition (`test_runs.definition_ids`) | `tm-connector` claim → `_resolve_claims`, or planning → `_write_link` | `covered → exercised`, and it is what puts a run id in `covering_run_ids` |
| A verdict exists for that (run, definition) | the `BL-11` runner, through `POST /results` | `exercised → tested` or `→ failed` |

This matters for sequencing: **the run-id half works the day this feature lands**, before any
evaluator exists. The outcome half switches on when `BL-11` starts writing verdicts, with no
further change here. A demo can therefore show requirements moving `covered → exercised` with
the four traces already uploaded.

**Rejected — moving the state on the `tm-connector`'s run registration.** Linkage is not
outcome. A registration-triggered move would mark all ten requirements Tested, four of them
falsely (§5.4 shows the correct negative). This is precisely `BL-19`.

### 4.5 Covered vs Tested

Defined in full in §5, with the worked example over the 10 requirements and 4 runs. The
short form:

- **Covered** = at least one test case names the requirement in `covers_req_ids`. It says
  nothing about runs, and coverage can read 100 % with nothing run — the board says this
  twice and it stays true here.
- **Tested** = covered, **and** every covering test case has a newest verdict of `pass`,
  **and** each of those passes is *current* (§4.6).

A covered-but-failed requirement reads `failed`, never `tested`. A covered requirement whose
test case ran but produced no verdict reads `exercised`, never `tested`.

### 4.6 Versions and staleness

**Chosen: `normative_sha256` on the requirement + a timestamp comparison. No version
collection.**

At mirror time the registry computes

```
normative_sha256 = sha256( canonical_json({
    text, measurand, system_states, verification_method,
    verification_criteria, attachment_refs
}) )
```

— the board's field list exactly; `status`, `title` and `rationale` are excluded, so
Draft → Reviewed changes nothing. When the hash differs from the stored one, and only then,
`normative_changed_at` is set to that moment. An edit that is reverted leaves the hash equal
and the stamp untouched, which is the right answer.

A passing verdict is **current** when both hold:

| # | Check | Reads |
|---|---|---|
| a | `verdict.implementation_sha256 == definition.implementation.sha256` | the TC has not been rewritten since the pass. This is the board's *"pinned at exactly version w"*, done with the artefact we already store (`models/planning.py:166-187`). A definition with no uploaded implementation skips this check — there is nothing to pin against. |
| b | `verdict.provenance.produced_at >= requirement.normative_changed_at` | the requirement has not moved under the evidence |

A pass that fails either check sets `evidence_stale: true` and the state degrades from
`tested` to `exercised`. The detail read names which check failed.

**Rejected — ignore staleness entirely and say so in the UI.** Cheapest, and it makes the
one number an auditor asks for ("is this evidence still valid?") unanswerable. The hash is
twenty lines in `_mirror_requirements` and the comparison is one line in the fold.

**Rejected — the full `(R@v, TC@w)` model** with a version collection, a `verifies` link
entity and confirmed/suspect states. The destination, not this phase. §9 names precisely what
it would add on top of what this spec builds, and nothing here has to be undone for it.

### 4.7 Surface

**Chosen: one new read pair, three additive fields on existing reads, one new frontend
screen.** Detail in §7.

**Rejected — surfacing requirements only inside the definition detail.** The user's words are
"attribute columns" on the branch `jama-ui-dev`: a requirements **grid** is the artefact
being asked for. A requirement that can only be reached by first knowing its test definition
inverts the traceability chain a person reads.

### 4.8 Seed impact

**Chosen: `verified_by` is deleted from the authored requirement data (BL-17), the test
specs' `covers_req_ids` becomes the single authored direction, and the seed pushes
requirements through the same catalog call.** Detail in §8.

**Rejected — keeping `verified_by` in `battery-dc-requirements.json` as documentation.** It
is the exact value D1 forbids authoring, sitting in the file an auditor would open first.
Two directions of one link, both authored, is how bidirectional traceability becomes a
finding.

---

## 5. Data model and the two computations

### 5.1 The requirement document (Mongo `requirements`)

```jsonc
{
  "_id": "BAT-SYS-SAF-002",
  "title": "Battery temperature ceiling",
  "text": "The battery system shall limit the battery temperature to not more than {T_batt_max}.",
  "status": "Draft",                       // AUTHORED. No route in this feature writes it.
  "chapter": "Safety-Fault-Handling",
  "ears_pattern": "Ubiquitous",
  "revision": "0.1",
  "measurand": [{"name": "t_batt", "unit": "degC"}],
  "system_states": [],
  "verification_method": "Test",
  "verification_criteria": null,           // BL-18: optional today, in the hash from day one
  "rationale": "T_batt_max is the onset of accelerated ageing…",
  "source": ["STAKEHOLDER:battery-dc-brief-2026-09-21", "PROJECT-CHOICE:systems-engineer"],
  "related_reqs": [],

  "normative_sha256": "c1f0…",             // DERIVED at mirror time, §4.6
  "normative_changed_at": "2026-09-23T08:00:00Z",

  "raw": { /* planning's payload, verbatim */ },
  "field_sources": { "text": {"source": "api:planning", "actor": "planning-sync", "at": "…"} },
  "synced_at": "…",
  "mirrored_at": "…"
}
```

**`verified_by` is not stored.** Not as a field, not as a null, not as an empty list. It is
computed on every read (BP5 / D1).

### 5.2 The definition gains one planning-owned field

`test_definitions.covers_req_ids: list[str]` — the authored direction of the link, stated by
the test case, mirrored by `_mirror_definitions` (`planning_sync.py:412-432`) and journalled,
because a change of coverage is a traceability change an auditor asks about.

An id naming a requirement the mirror does not hold contributes to nothing: the projection
starts from requirements and walks outward, so an unknown id is invisible rather than an
error. No validation branch.

### 5.3 The projection — `api/api/services/queries_requirements.py`

For a page of requirement ids `R`:

```
1. definitions = test_definitions.find({"covers_req_ids": {"$in": R}})
2. td_ids      = every _id from (1)
   runs        = test_runs.find({"definition_ids": {"$in": td_ids},
                                 "invalid.flagged": {"$ne": true}})
3. verdicts    = processed_results.find({"run_id":  {"$in": run_ids},
                                         "verdict.definition_id": {"$in": td_ids}})
                                   .sort("version", DESCENDING)
```

Three queries, each bounded by the page. Then one in-memory fold per requirement:

```python
verified_by(R)   = sorted(td._id for td in definitions if R in td.covers_req_ids)
runs_of(td)      = [run for run in runs if td in run.definition_ids]          # newest first
covering_runs(R) = the union over verified_by(R), newest first, deduplicated
newest_verdict(td) = highest-version verdict per (run, td), then the newest produced_at
```

`newest_verdict` is per definition, not per run: a test case re-run after a fix is judged on
its latest attempt. The version chain of `processed_results` (`db.py:152-156`,
`routers/results.py:416-421`) already provides "highest version of one `(run_id, result_key)`",
and `result_key = "verdict/<definition_id>"` gives one chain per (run, definition).

**The state fold, in order:**

| # | Condition | `verification_state` |
|---|---|---|
| 1 | `verified_by(R)` is empty | `not_covered` |
| 2 | no run carries any of `verified_by(R)` | `covered` |
| 3 | some covering td has no run, or a run but no verdict, or a verdict of `error` | `exercised` |
| 4 | some covering td's newest verdict is `fail` | `failed` |
| 5 | every covering td's newest verdict is `pass`, and every one is **current** (§4.6) | `tested` |
| 6 | every newest verdict is `pass` but one is not current | `exercised`, `evidence_stale: true` |

Rule 4 outranks rule 3 by design when both could apply to *different* test cases of one
requirement: a requirement with one failing test case and one unrun test case reads
`failed` — the known negative is louder than the unknown. (Implementation: evaluate 4 before
3, with 3 as the fallback.)

`tested_at` = the newest `produced_at` among the verdicts that satisfied rule 5; null
otherwise.

### 5.4 Worked example — the ten requirements, the four runs

Coverage and verdicts from `CLAUDE.md:60-71` and
`dev-planning/tm-multi-definition-runs/architecture.md:379-390`. This is the table §12
prints.

| Requirement | Covering TC | Run | Verdict | `covering_run_ids` | Covered | `verification_state` |
|---|---|---|---|---|---|---|
| `BAT-SYS-PRF-001` | TC-001 | TAS-1001 | pass | `[TAS-1001]` | yes | **tested** |
| `BAT-SYS-SAF-003` | TC-002 | TAS-1001 | pass | `[TAS-1001]` | yes | **tested** |
| `BAT-SYS-SAF-002` | TC-003 | TAS-1001 | **fail** | `[TAS-1001]` | yes | **failed** |
| `BAT-SYS-FUN-001` | TC-004 | TAS-1002 | pass | `[TAS-1002]` | yes | **tested** |
| `BAT-SYS-SAF-001` | TC-005 | TAS-1002 | pass | `[TAS-1002]` | yes | **tested** |
| `BAT-SYS-FUN-002` | TC-006 | TAS-1002 | **fail** | `[TAS-1002]` | yes | **failed** |
| `BAT-SYS-FUN-003` | TC-007 | TAS-1003 | pass | `[TAS-1003]` | yes | **tested** |
| `BAT-SYS-PRF-002` | TC-008 | TAS-1003 | **fail** | `[TAS-1003]` | yes | **failed** |
| `BAT-SYS-FUN-004` | TC-009 | TAS-1004 | pass | `[TAS-1004]` | yes | **tested** |
| `BAT-SYS-FUN-005` | TC-010 | TAS-1004 | **fail** | `[TAS-1004]` | yes | **failed** |

**10 covered, 6 tested, 4 failed.** The four rigged failures produce the correct negative:
each is covered, each names its run, and none reads Tested.

Three intermediate states the same data passes through, which are the acceptance criteria
for the phasing:

| Moment | Every requirement reads |
|---|---|
| After the catalog push, before any trace | `covered`, `covering_run_ids: []` |
| After the four traces upload, before `BL-11` | `exercised`, `latest_run_id` set — **this is what ships with this feature** |
| After `BL-11` writes the ten verdicts | the table above |

And the staleness case: edit `BAT-SYS-PRF-001`'s `text` after TAS-1001 passed it →
`normative_changed_at` moves past the verdict's `produced_at` → it drops from `tested` to
`exercised` with `evidence_stale: true`. Re-run TC-001 and it returns to `tested`.

---

## 6. The verdict contract (for `BL-11`)

Writing verdicts is **out of scope**. This is the shape `BL-11` writes and this feature
reads. It is deliberately concrete enough to implement against with no further design.

### 6.1 Where a verdict lives

**Chosen: one optional nested block on the existing `processed_results` document.**

`processed_results` already supplies, for free, everything a verdict store needs: a version
chain with `supersedes` per `(run_id, result_key)` (`routers/results.py:416-421, :484-491`),
a mandatory six-key provenance with a `flagged` state (`models/results.py:14-57`), the
journal, the lineage block (`models/runs.py:516-521`), the search index
(`queries_runs.py:976`), and deletion with its run (`run_deletion.py:287`). A separate
collection would reimplement all of it.

**Rejected — a new `verdicts` collection with its own routes.** Six mechanisms rebuilt to
avoid one optional field, plus a second thing a run delete must remember to clean.

**Rejected — flat fields (`definition_id`, `verdict`, `evidence`) on the result.** A flat
`verdict` without a `definition_id` is a document the projection silently ignores, and
enforcing the pair needs a hand-written validator and a machine code. A nested block makes
Pydantic enforce the pairing with no branch: state the block and its required fields come
with it, or state nothing.

### 6.2 The block

```jsonc
// POST /api/v1/results  — the existing route, api/api/routers/results.py:424
{
  "run_id": "TAS-1001",
  "result_key": "verdict/BAT-SYS-TC-003",   // one version chain per (run, definition)
  "name": "BAT-SYS-TC-003 verdict",
  "description": "Battery temperature held at or below T_batt_max",

  "verdict": {                              // NEW, optional. Absent on every other result.
    "definition_id": "BAT-SYS-TC-003",
    "outcome": "fail",                      // pass | fail | error
    "evidence": {"max_degc": 61.2, "limit_degc": 60.0, "dwell_above_s": 151.3},
    "implementation_sha256": "9f2b0a11…"    // 64 hex, the bytes that decided
  },

  "provenance": {                           // unchanged, all six keys still mandatory
    "tool": "BAT-SYS-TC-003",
    "tool_version": "sha256:9f2b0a11f3c4",
    "parameters": "blob://…/BAT-SYS-TC-003/9f2b0a11-BAT-SYS-TC-003.py table=battery_data_v1 run_id=TAS-1001",
    "input_file_ids": ["f-…"],
    "produced_by": "verdict-runner",
    "produced_at": "2026-09-23T10:12:00Z"
  }
}
```

| Rule | Why |
|---|---|
| `result_key = "verdict/<definition_id>"` | one version chain per (run, definition); the `verdict/` prefix means a verdict can never join the chain of a plot or a CSV that happens to be keyed by a td id. **Convention only — the projection reads `verdict.definition_id`, never the key.** |
| `outcome` ∈ `pass \| fail \| error` | `error` = the implementation could not decide (a channel absent, the query empty). It must never read as `fail`: a failure indistinguishable from a bug is a bad failure. It leaves the requirement `exercised`. |
| `evidence` | free key/value numbers — the keys the module already returns, matching `battery-trace-gen/out/manifest.csv`'s `measured` column, so expected and achieved compare with no mapping |
| `implementation_sha256` | 64 hex. `provenance.tool_version` keeps the `sha256:<12 hex>` display form; the check in §4.6a needs the full digest |
| a re-run | POSTs again with the same `result_key`; the route mints version N+1 and sets `supersedes`. The projection reads the highest version. |
| `PATCH /results/{id}` | **unchanged.** `ResultPatchRequest` forbids unknown keys (`models/results.py:190-206`), so a patch naming `verdict` already answers 422. A verdict is a produced fact: correcting it means producing a new version. |

### 6.3 Who writes it

The `BL-11` runner: fetch the definition's `.py` from
`GET /test-definitions/{td}/implementation/download`, call `evaluate(run_id, table)`, POST
the result above. `BL-11` owns the runner, the scheduling and the lake query. This feature
owns the read.

---

## 7. API and frontend surface

### 7.1 New reads

```
GET /api/v1/requirements?page=&page_size=&state=&status=&q=
GET /api/v1/requirements/{req_id}
```

`RequirementRow` (the grid row — every derived field marked `D`):

```jsonc
{
  "req_id": "BAT-SYS-SAF-002",
  "title": "Battery temperature ceiling",
  "status": "Draft",                       // authored
  "chapter": "Safety-Fault-Handling",
  "ears_pattern": "Ubiquitous",
  "revision": "0.1",
  "verification_method": "Test",

  "verification_state": "failed",          // D
  "evidence_stale": false,                 // D
  "verified_by": ["BAT-SYS-TC-003"],       // D  — BP5, never authored
  "covering_run_ids": ["TAS-1001"],        // D  — capped at 20 here
  "covering_run_count": 1,                 // D
  "latest_run_id": "TAS-1001",             // D  — the column the user asked for
  "tested_at": null,                       // D

  "synced_at": "2026-09-23T08:00:00Z"
}
```

`RequirementPage` = `Page[RequirementRow]` + `view_counts: {all, tested, failed, exercised,
covered, not_covered}`, the pattern `WorkOrderPage` already uses (`models/planning.py:33-36`).

`RequirementDetail` extends the row with `text`, `measurand`, `system_states`, `rationale`,
`source`, `related_reqs`, `verification_criteria`, `normative_sha256`,
`normative_changed_at`, the **uncapped** `covering_run_ids`, and:

```jsonc
"evidence": [
  {"run_id": "TAS-1001", "definition_id": "BAT-SYS-TC-003", "definition_title": "…",
   "outcome": "fail", "produced_at": "…", "implementation_sha256": "9f2b0a11…",
   "current": true, "evidence_values": {"max_degc": 61.2, "limit_degc": 60.0}}
]
```

### 7.2 Additive fields on existing reads

| Read | Field | Note |
|---|---|---|
| `GET /test-definitions` and `/{td_id}` | `covers_req_ids: list[str]` | authored, mirrored. On `TestDefinitionRow` so both list and detail carry it. |
| `GET /test-runs/{run_id}` | `covers_req_ids: list[str]` | derived, **detail only**: the union over the run's definitions. One extra query on a detail read; the list stays untouched. |
| `GET /summary` | `counts.requirements: int` | feeds the sidebar count |

No existing field changes meaning. Nothing on `GET /test-runs` (the list) changes, so the
runs screen needs no work.

### 7.3 Frontend

| File | New/changed | What |
|---|---|---|
| `frontend/types/requirement.ts` | new | `RequirementRow`, `RequirementDetail`, `VerificationState` |
| `frontend/lib/api/requirements.ts` | new | `listRequirements`, `getRequirement` |
| `frontend/app/requirements/page.tsx` | new | the grid route |
| `frontend/app/requirements/[reqId]/page.tsx` | new | the detail route |
| `frontend/components/screens/requirements/requirements-screen.tsx` | new | columns: **Id · Title · Status · Verification · Verified by · Latest run · Runs**; the state filter reads `view_counts` |
| `frontend/components/screens/requirements/requirement-detail-screen.tsx` | new | the authored block, the derived block, the evidence table (run → verdict → numbers), links out to each run and definition |
| `frontend/components/screens/requirements/verification-chip.tsx` | new | five states + the stale marker |
| `frontend/components/shell/sidebar.tsx:209-219` | changed | a **Requirements** entry with `count: resolved.requirements`, placed **above** "Test definitions" — the nav teaches the chain requirement → definition → run, the comment at `:206-208` states the rule |
| `frontend/components/screens/definitions/definition-detail-screen.tsx` | changed | a "Verifies" row listing `covers_req_ids` as links |
| `frontend/types/work-order.ts` | changed | `TestDefinitionRow.covers_req_ids?: string[]` |
| `frontend/types/test-run.ts` | changed | `TestRunDetail.covers_req_ids?: string[]` |

Built with the existing `Panel` / `MetaGrid` primitives and nothing else.
**FrontEndEsthetic owns the look; ArchDev makes it correct.**

### 7.4 Push shape

```jsonc
// POST /api/v1/planning/sync
{
  "requirements": [                                  // NEW list, mirrored FIRST
    {
      "id": "BAT-SYS-SAF-002",
      "title": "Battery temperature ceiling",
      "text": "The battery system shall limit the battery temperature to not more than {T_batt_max}.",
      "status": "Draft",
      "chapter": "Safety-Fault-Handling",
      "ears_pattern": "Ubiquitous",
      "revision": "0.1",
      "measurand": [{"name": "t_batt", "unit": "degC"}],
      "system_states": [],
      "verification_method": "Test",
      "verification_criteria": null,
      "rationale": "…",
      "source": ["STAKEHOLDER:battery-dc-brief-2026-09-21"],
      "related_reqs": []
    }
  ],
  "test_definitions": [
    { "id": "BAT-SYS-TC-003", "work_order_id": "WO-BAT-2026-001", "title": "…",
      "planned_runs": 1, "covers_req_ids": ["BAT-SYS-SAF-002"],
      "requirements_files": [ { "name": "BAT-SYS-TC-003.md", "content": "…" } ] }
  ],
  "work_orders": [ /* unchanged */ ],
  "links": [ /* unchanged */ ]
}
```

`PushedRequirement` is an `ApiModel` with `extra="allow"`, exactly like `PushedWorkOrder`
(`models/planning.py:294-309`) and `PushedDefinition` (`:326-344`): the mirror stores `raw`
verbatim and planning owns what else rides along. Only `id` is required — every other field
is optional, and an absent one reads as null or an empty list, the way an absent work-order
title already does.

`PlanningPushResponse` gains `requirements_mirrored: int`. `SyncResult` /
`PlanningSyncStatus` gain nothing: the fetch direction is unchanged (planning's outbound API
is not ours to extend).

**An empty `requirements` list is a legal pass**, exactly as today's empty body is. A
deployment that never pushes requirements sees this whole feature as an empty grid, and
nothing else changes.

---

## 8. Seed impact

| File | Change |
|---|---|
| `battery-trace-gen/data/battery-dc-requirements.json` | **delete `verified_by` from all ten items** (BL-17). Add a `notes` sentence: the reverse link is derived from `specs/battery-dc-test-specs.json`'s `covers_req_ids`. Leave `verification_criteria` absent until BL-18 decides; the hash covers it either way. `set_canonical_sha256` is recomputed by whatever wrote it. |
| `battery-trace-gen/specs/battery-dc-test-specs.json` | **unchanged.** `covers_req_ids` is already there on all ten and is already the authored direction. |
| `battery-trace-gen/seed/sources.py` | build the inverse index `req_id -> [tc_id]` once, from the test specs |
| `battery-trace-gen/seed/planning_payload.py` | emit the `requirements: [...]` list from `battery-dc-requirements.json`; add `covers_req_ids` to each pushed definition |
| `battery-trace-gen/seed/requirements_md.py` | the "Verified by" row is computed from the inverse index, never read from the requirement JSON |
| `battery-trace-gen/seed/__main__.py` | `catalog` pushes requirements + definitions in one call; the sanity print reports `requirements_mirrored` |
| `battery-trace-gen/tools/gen_claude_md.py` + `CLAUDE.md:27-38` | the requirements table gains a **Verified by (derived)** column; `CLAUDE.md:99-116` gains the `requirements[]` list in the seeding section. Both move together — the generator writes the file. |

**Requirement ids are declared to the Test Manager at seed time**, in the same
`POST /planning/sync` call as the work order and the definitions, and **mirrored before the
definitions** so a definition naming a requirement lands after its target exists. (Order
matters for the journal reading sensibly, not for correctness: the projection tolerates
either order.)

The ten rendered markdown documents stay exactly as they are. They are the human-readable
render a person opens on the definition screen; the requirement row is the machine-readable
truth. De-duplicating the two is out of scope (§11).

---

## 9. Departures from the Miro board, named

The board is the user's own design. Each departure below is deliberate, and each names what
it costs.

1. **No `verifies` link entity, and therefore no confirmed/suspect state machine.** The link
   is `covers_req_ids` on the definition, stated by planning. There is no confirm step in
   this system, so planning stating the link *is* the confirmation. **Cost:** the board's
   "suspect blocks Tested" is approximated by the timestamp rule of §4.6b — the same outcome
   for the case that matters (edit a tested requirement, it stops reading Tested), but it
   cannot express "this one link is suspect while that one is fine" when two requirements
   share a test case. **Upgrade:** a `verifies` collection holding
   `(req_id, req_sha_at_link, td_id, impl_sha_at_link, state)` slots under the same
   projection.

2. **No requirement versions.** `R@v` is `R@current`. `revision` is mirrored as authored
   text and nothing computes from it. **Cost:** evidence cannot be attributed to an
   historical revision — only "current, or stale". **Upgrade:** a `requirement_versions`
   collection; `normative_sha256` is already the version key it would use.

3. **A fifth state, `exercised`, which the board's lifecycle does not have.** Reason: it is
   the only state that can move before an evaluator exists, and without it the user's
   sentence ("when a test run covers requirements, their status moves") is unanswerable
   until `BL-11` ships. It sits strictly between Covered and Tested and never reads as
   either.

4. **`Tested` is rendered as a derived column, not written into the authored `status`.** The
   board draws it dashed *inside* the lifecycle; we draw it *beside* it. This is
   presentation, not semantics — the board's own rule is that it is computed and never set
   by hand, and that is exactly what happens. **OQ1** offers the user the in-line display.

5. **No status enum, no transition table, no `policy_sha256`.** Nothing in this feature
   performs a transition, so there is no policy to pin. The authored `status` is whatever
   planning states, free text on the wire. Adopting the enum is `BL-20`.

6. **`verification_criteria` is optional.** The board makes it a mandatory authored field.
   Our ten requirements do not carry one (pass criteria live on the test spec), so making it
   mandatory today would refuse the seed. It is mirrored when stated and it is inside
   `normative_sha256` from day one, so adopting `BL-18` later changes no hash logic.

7. **Refusal codes.** `identity_unavailable`, `no_op_mint`, `stale_parent` and `id_reuse`
   belong to a minting API this feature does not add — requirements arrive already minted
   from planning. Not implemented, not departed from: out of scope.

---

## 10. Build list for ArchDev

Ordered. Every path exact. Line numbers are of the tree at `8d7847e`.

**1. Models — the requirement.** New `api/api/models/requirements.py`:
`VerificationState` literal, `RequirementRow`, `RequirementPage`, `RequirementEvidence`,
`RequirementDetail`, `RequirementViewCounts`. It imports `ApiModel`, `Page`, `UtcDatetime`
from `api.models.common` like every sibling.

**2. Models — the push.** `api/api/models/planning.py`: `PushedRequirement` beside
`PushedWorkOrder` (`:294`); `PushedDefinition.covers_req_ids: list[str]` (`:326-344`);
`PlanningPushRequest.requirements` (`:363-372`); `PlanningPushResponse.requirements_mirrored`
(`:415-426`); `TestDefinitionRow.covers_req_ids` (`:57-73`).

**3. Models — the verdict.** `api/api/models/results.py`: `Verdict(RequestModel)` and
`VerdictOut(ApiModel)` — the strict-in/lenient-out pair the file already uses for
`Provenance`/`ProvenanceOut` (`:40-81`); `ResultCreateRequest.verdict: Verdict | None = None`
(`:115-128`); `ResultBody.verdict: VerdictOut | None = None` (`:97-112`).
`ResultPatchRequest` (`:190`) is **untouched**.

**4. Models — the two additive run/def fields.** `api/api/models/runs.py`:
`RunDetail.covers_req_ids: list[str] = Field(default_factory=list)` (`:220-237`);
`HomeCounts.requirements: int` (`:373-381`).

**5. Mirror.** `api/api/planning_sync.py`:
- `_JOURNALLED_FIELDS` (`:66-69`) gains `"requirements": ("title", "text", "status", "verification_method")`
  and `test_definitions` gains `"covers_req_ids"`.
- new `_normative_sha256(values) -> str` and `_mirror_requirements(db, rows, now)` beside
  `_mirror_definitions` (`:412`), writing through the existing `_write_mirror` (`:285`).
  `normative_changed_at` moves only when the hash differs from the stored one.
- `_mirror_definitions` (`:426-431`) adds `"covers_req_ids": row.get("covers_req_ids") or []`
  to `values`.
- `apply_planning_push` (`:600-630`) takes `requirements` and mirrors them **before**
  definitions; the response counts them.
- `demo_reset` (`:731-732`) deletes `requirements` by the same `created_by_sync` clause.
- `PLANNING_FIELDS` (`:45`), `_write_link` (`:435`) and `_mirror_work_orders` (`:323`):
  **do not touch.**

**6. The projection.** New `api/api/services/queries_requirements.py`:
`list_requirements(db, pagination, state, status, q)`, `get_requirement_detail(db, req_id)`,
and the shared `_project(db, requirement_rows)` implementing §5.3. It is the only place the
fold exists, so the list and the detail can never disagree.

**7. Router.** New `api/api/routers/requirements.py` with the two GETs; registered in
`api/api/main.py` beside the other routers, and its two paths added to the route tables at
`main.py:177-204` / `:315` if they list every route (check — those maps are upload/download
specific).

**8. Existing reads.** `api/api/services/queries_runs.py`:
`get_test_definition_detail` (`:1450`) and `list_test_definitions` (`:1406`) pass
`covers_req_ids` through; the run detail (`~:750`) adds the derived union;
`home_summary` adds the requirements count.

**9. Indexes.** `api/api/db.py`: `test_definitions.covers_req_ids` (multikey) beside `:63`;
`processed_results` compound `("verdict.definition_id", ASCENDING), ("version", DESCENDING)`
beside `:152-156`; `requirements` needs none beyond `_id` at demo scale — add
`("status", ASCENDING)` only when the status filter has a caller.

**10. Enumerations that must learn the new collection.** Each is a place a missed line leaves
a row invisible or undeletable:
`api/api/models/common.py:129-137` `SearchGroup`;
`api/api/services/queries_runs.py:976, :985, :1053` the search field maps;
`api/api/routers/journal.py:72` the entity-type map (`"requirement": ("requirements", "Requirement", "requirement_not_found")`);
`api/api/planning_sync.py:66` and `:731`.

**11. Seed.** The eight rows of §8.

**12. Frontend.** The eleven rows of §7.3.

**13. Contract snapshot.** `api/scripts/snapshot.sh` — `api/docs/openapi.v1.json` is already
stale (`BL-25`) and this feature adds two routes and six model changes. Regenerate in the
same PR or `test_contract_snapshot.py` stays red for a second reason.

**Verification checklist for Tester:** `pre-commit run --all-files` (pinned versions, never
local ruff/mypy); the tests of §10a red then green; the contract snapshot regenerated; a
local `docker-compose.local.yml` round trip showing a requirement move
`covered → exercised` when a trace uploads, and `→ tested` when a verdict is POSTed by hand.

### 10a. Red-first tests

Each must be RED before its fix.

| # | Test | Asserts |
|---|---|---|
| 1 | `api/tests/test_requirements_mirror.py::test_a_push_mirrors_a_requirement` | `requirements` holds the row, tagged `api:planning`, `raw` verbatim, one journal entry |
| 2 | `…::test_verified_by_is_derived_and_never_stored` | the stored document has no `verified_by` key; the read computes `["BAT-SYS-TC-003"]` from the definition's `covers_req_ids`; a pushed `verified_by` is ignored |
| 3 | `api/tests/test_requirement_state.py::test_covered_is_not_tested` | a requirement with a covering TC and no run reads `covered`; with a run and no verdict reads `exercised`; coverage reads 100 % throughout |
| 4 | `…::test_a_failing_verdict_never_reads_tested` | the four rigged cases read `failed`, carry their run id, and `tested_at` is null |
| 5 | `…::test_a_passing_verdict_reads_tested` | the six pass cases read `tested` with `tested_at` set |
| 6 | `…::test_an_error_verdict_is_not_a_failure` | `outcome: "error"` reads `exercised`, never `failed` |
| 7 | `…::test_editing_the_requirement_stales_the_evidence` | a `text` edit moves `normative_changed_at` past the verdict → `exercised` + `evidence_stale`; a `status` or `title` edit does **not** |
| 8 | `…::test_an_invalid_run_supplies_no_evidence` | flagging TAS-1001 invalid drops it from `covering_run_ids` and from the fold |
| 9 | `…::test_the_newest_verdict_wins` | a re-run POSTing version 2 with `fail` moves a `tested` requirement to `failed` |
| 10 | `api/tests/test_result_verdict.py::test_a_result_carries_a_verdict_block` | `POST /results` with the block stores it; a result without one is unchanged in every field; `PATCH` naming `verdict` answers 422 |
| 11 | `…::test_a_run_delete_removes_its_verdicts` | deleting TAS-1001 drops its verdicts and the requirement falls back to `covered` |

---

## 11. Out of scope

- **Writing verdicts.** `BL-11` owns the runner. This spec defines only the contract it
  writes to (§6).
- **Authoring anything in the Test Manager.** No `POST /requirements`, no status PATCH, no
  transition table. Requirements arrive from planning.
- **Requirement versions, the `verifies` link entity, suspect/confirmed states.** §9.1, §9.2.
- **The status enum and `policy_sha256`** (`BL-20`).
- **Making `verification_criteria` mandatory** (`BL-18`).
- **De-duplicating the rendered markdown against the requirement row.** Both stay; the
  markdown is what a person reads on the definition screen.
- **A coverage report or an ASPICE export.** The projection makes one cheap; nobody asked
  for one yet.
- **Any change to `_write_link`, `_mirror_work_orders`, `config_push.py`, `derive_status`,
  the lake partitions or the sink's `join_lookup`.**
- **`join_lookup` in FastAPI code.** Never.

---

## 12. Sanity print

### Decisions

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Where a requirement lives | a light **mirrored `requirements` collection**, fed by `POST /planning/sync` | a full versioned item + link entity (the board's model); markdown-only derived view | the mirror is the door the catalog already uses; the full model is weeks and forecloses nothing; markdown-only has nowhere to hold the authored status and would parse prose |
| What moves automatically | a derived **`verification_state`**; the authored `status` is never machine-written | writing `status = "Tested"`; a proposal queue | the board makes `status` authored and `Tested` computed — a machine write destroys that split and needs a transition policy this system does not hold |
| The run id on a requirement | **derived** `covering_run_ids` + `latest_run_id`, computed at read time | a stored array written on run registration; a periodic sweep | D1 (reverse links are derived); a stored array goes stale on delete / invalid-flag / re-link and forks the one link write path |
| The trigger | **none** — a projection moves when its inputs do | moving the state on run registration | linkage is not outcome: registration alone would mark all ten Tested, four of them falsely (`BL-19`) |
| Where a verdict lives | an optional nested **`verdict` block on `processed_results`** | a new `verdicts` collection; flat fields on the result | the result already gives versioning, provenance, journal, lineage, search and delete-with-run; a nested block makes Pydantic enforce the field pairing with no validator |
| Staleness | **`normative_sha256` + `normative_changed_at`**, compared with the verdict's `produced_at`, plus the implementation digest pin | ignore it; the full `(R@v, TC@w)` version model | twenty lines buys the one question an auditor asks; the full model is the upgrade and nothing here has to be undone for it |
| Seed | **delete authored `verified_by`**; `covers_req_ids` is the single authored direction | keep `verified_by` as documentation | it is the exact value D1 forbids, in the file an auditor opens first (`BL-17`) |

### The ten requirements, after `BL-11`

| Requirement | Definition | Run | Verdict | Covered | Tested |
|---|---|---|---|---|---|
| `BAT-SYS-PRF-001` | `BAT-SYS-TC-001` | `TAS-1001` | pass | yes | **yes** |
| `BAT-SYS-SAF-003` | `BAT-SYS-TC-002` | `TAS-1001` | pass | yes | **yes** |
| `BAT-SYS-SAF-002` | `BAT-SYS-TC-003` | `TAS-1001` | **fail** | yes | no — `failed` |
| `BAT-SYS-FUN-001` | `BAT-SYS-TC-004` | `TAS-1002` | pass | yes | **yes** |
| `BAT-SYS-SAF-001` | `BAT-SYS-TC-005` | `TAS-1002` | pass | yes | **yes** |
| `BAT-SYS-FUN-002` | `BAT-SYS-TC-006` | `TAS-1002` | **fail** | yes | no — `failed` |
| `BAT-SYS-FUN-003` | `BAT-SYS-TC-007` | `TAS-1003` | pass | yes | **yes** |
| `BAT-SYS-PRF-002` | `BAT-SYS-TC-008` | `TAS-1003` | **fail** | yes | no — `failed` |
| `BAT-SYS-FUN-004` | `BAT-SYS-TC-009` | `TAS-1004` | pass | yes | **yes** |
| `BAT-SYS-FUN-005` | `BAT-SYS-TC-010` | `TAS-1004` | **fail** | yes | no — `failed` |

**10 covered · 6 tested · 4 failed.** Every requirement names its run; the four rigged
failures produce the correct negative.

---

## 13. Risks and open questions

### Risks

| Risk | Mitigation |
|---|---|
| **A third planning-owned collection must be learned by six enumerations.** `_JOURNALLED_FIELDS`, `demo_reset`, `SearchGroup`, the two search maps in `queries_runs`, the journal entity map. A missed one leaves a row the reset cannot remove or the audit cannot show. | §10.10 lists every site with its line. Test 1 covers the journal, a reset test covers the delete. |
| **The riskiest decision: everything requirement-side is derived.** There is no stored answer to compare against, so a wrong fold is wrong everywhere at once and nothing contradicts it. | The fold lives in exactly one function (`_project`), the list and the detail both call it, and tests 3-9 pin every branch of §5.3's table against the known 6/4 split. |
| **`verification_state` looks like a status and is not one.** A person will read the chip as the lifecycle. | Two columns, two labels, and the detail screen states which is authored and which is computed. This is what **OQ1** asks the user to confirm. |
| **`error` verdicts could quietly hide a broken evaluator** — a requirement sits at `exercised` forever and reads like "not run yet". | The detail's evidence table shows the `error` row and its produced_at. A Home "needs attention" line is the obvious follow-up and is not built here. |
| **Read cost grows with coverage breadth**, not with the estate: a requirement covered by 500 runs builds a 500-long array. | The list caps `covering_run_ids` at 20 and reports `covering_run_count`; the detail is uncapped and is one requirement. |
| **`covers_req_ids` is planning's to erase.** A push that omits it empties the field, exactly as it empties `requirements_files` — and every requirement it named falls to `not_covered`. | This is the mirror's stated rule (`planning_sync.py:420-423`) and it is correct. The seed always sends the full catalog. Named so nobody calls it a bug. |
| **`BL-11` may not exist for weeks.** | The run-id half ships without it: after the four traces upload, all ten requirements read `exercised` with `latest_run_id` set. The verdict half switches on with no further change. |

### Open questions for the user

1. **OQ1 — one status column or two?** Recommended: **two** — the authored `Status` beside a
   derived `Verification` chip, so a machine never appears to have moved a person's value.
   The alternative is a display-only override: the Status column shows `Tested` when
   `verification_state == tested` and the authored value otherwise. Still writes nothing;
   one line in the projection. **This is the question the user's sentence actually turns on
   — please answer it before ArchDev starts.**
2. **OQ2 — is a light registry enough, or do you want the board's versioned model now?**
   Recommended: the light registry (§4.1). It forecloses nothing, and §9 names the exact
   upgrade path. Say so now if the ASPICE audit story needs `R@v` in this round.
3. **OQ3 — `BL-17`: delete `verified_by` from `battery-dc-requirements.json`?** Recommended:
   yes, delete it. It is the authored reverse link D1 forbids, and `covers_req_ids` already
   carries the same information in the direction the board wants.
4. **OQ4 — does a requirement belong to a work order?** Today it does not: the chain is
   requirement ← definition → work order. A requirements grid filtered by campaign would
   need a `work_order_id` on the requirement or a derived one through its definitions.
   Recommended: derive it if asked, never store it. Not built.
5. **OQ5 — `BL-18`: should `verification_criteria` be mandatory now?** Recommended: no.
   It is mirrored and hashed when stated, so adopting it later costs one line in the seed.

---

## 14. References

- `CLAUDE.md:158-169` — the Miro board's rules, as this repo records them.
- Board: `https://miro.com/app/board/uXjVHsQqWhY=/` (ASPICE SYS.2) and its linked design spec.
- `dev-planning/tm-multi-definition-runs/spec.md` — `definition_ids`, the implementation `.py`
  and its sha256, the seed's order of operations.
- `dev-planning/tm-multi-definition-runs/architecture.md:379-390` — the ten `passes`
  expressions and the 6/4 split this spec's tables reproduce.
- `dev-planning/backlog.json` — `BL-11`, `BL-17` … `BL-25`.
- `api/api/planning_sync.py` module docstring — "the arrow is being turned around".
- `api/api/routers/test_definitions.py:1-16` — the mirror rule and the three fields that bend it.
- `battery-trace-gen/specs/battery-dc-test-specs.json` — `covers_req_ids`, already authored.
- Global golden rules: light functional code, no PR1110 construct; ArchDev writes, Tester
  verifies; lint through pinned pre-commit.
