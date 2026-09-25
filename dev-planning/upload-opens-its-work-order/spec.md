# An upload opens the work order it claims

**Status:** Draft
**Project:** comma-car-segments-ingest
**Created:** 2026-09-25
**Planned with:** Buddy
**Branch / env:** `jama-ui-dev` / `testrigorg-commacarsegmentsingest-jamaui`
**Backlog:** `BL-81` — "An upload cannot create the work order it claims"
**Scope:** the Test Manager registry (`api/`) and one wire field carried there by
`tm-connector`. No change to `mf4-to-blob`, `mf4-decoder`, `mf4-datalake-sink` or the
frontend.

---

## 0. Summary

A trace states its campaign in its own HD comment (`test.work_order`). When that campaign
has never been opened in the Test Manager, the run registers **amber**: the claim is
remembered on the run (`claimed_work_order_id`) and nothing ever resolves it, because the
outbound planning pass retired with the planning mock (`38ecd12`). On 2026-09-25
`WO-BAT-2026-001` had to be created with `curl` so four runs could find their campaign.
The user's answer, verbatim (2026-09-24): *"file upload will create new if not existing or
allow user to add to existing based on dropdown menu with serach"*, and on 2026-09-25:
*"all stuff I am complaining should be part of the service."*

This feature makes `POST /test-runs` **open the campaign the operator stated**, at
`embedded` provenance, before it resolves the run's claims — so the run links itself in
the same request and is green on arrival. The campaign's `project` comes from the declared
**platform**. Nothing is ever invented: an upload that claims no work order behaves
exactly as it does today.

---

## 1. What happens today — traced, not assumed

| Step | Where | What happens |
|---|---|---|
| The claim leaves the browser | `mf4-to-blob/static/claim-editor.js:26-32` | `work_order_id` prefilled from the recording's `test.work_order`; sent as `declared.work_order_id` only when typed |
| It rides the metadata message | `mf4-to-blob/metadata.py:252-269` | inside `declared`, and flat as `work_order` for the lake |
| The decoder forwards it | `mf4-decoder/identity.py:151-176`, `mf4-decoder/marker.py:51-71` | `declared` (with `run_id` settled) and the raw `header_properties` ride on the `file_complete` marker |
| The connector sends it | `tm-connector/connector/identity.py:109`, `bodies.py:74-106` | `work_order_id` is a **claim** on the `POST /test-runs` body; the connector never pre-validates it |
| The registry resolves it | `api/api/services/queries_runs.py:118-145` | `_resolve_claims` looks the id up in `work_orders`. **Unknown id → no link** |
| The claim is remembered | `queries_runs.py:99-102, 181-200` | `claimed_work_order_id`, no source tag, no authority |
| The run goes amber | `api/api/provenance.py:289-295` | `derive_status` → `awaiting_work_order` |
| …and waits for nobody | `api/api/planning_sync.py:640-689` | `_link_retained_claims` only ever runs from `POST /planning/sync` and from `create_work_order` |

Two doors create a work order today, and neither is on the ingest path:

1. `queries_runs.create_work_order` (`queries_runs.py:1857-1926`), `insert_one` at
   `queries_runs.py:1897`, reachable only from `POST /work-orders`
   (`api/api/routers/work_orders.py:89-103`), every field written `Source.MANUAL`.
2. `planning_sync._write_mirror` (`planning_sync.py:287-322`), an `upsert=True` at
   `planning_sync.py:307-317`, every field written `Source.API_PLANNING`.

`create_work_order` already calls `planning_sync._link_retained_claims`
(`queries_runs.py:1923-1925`, shipped `f86dd92`), so **the close is solved**: the moment a
campaign exists, the runs that claimed it attach themselves. This spec is only about who
opens it.

The user's first complaint — *"there is neither button to create workorder on that page"* —
is closed: the Work orders screen now carries a **New work order** button and dialog
(`frontend/components/screens/work-orders/work-orders-screen.tsx:173-176, 259`). What is
left is the upload path.

### 1.1 The cautionary precedent

The deleted planning mock's `_adopt_order` (`api/mock_planning/demo_admin.py:152-196`,
removed with the mock at `38ecd12`) did this job and did it badly. It **minted** ids
(`WO-<year>-A<nnn>`) for runs that claimed none, and it derived the project as:

```python
project = str(run.get("project") or run.get("rig_id") or "unassigned")
```

That rig fallback is where the live campaign reading `project = 0225` came from — the user
spotted it as *"you somehow mixed up rig Id with project"*. §2.2 and §3.2 forbid both
behaviours by name.

---

## 2. Goals and non-goals

### 2.1 Goals

- A trace whose HD comment (or typed claim) names a work order that does not exist gets
  that campaign opened automatically, and the run is linked in the same request.
- The campaign is distinguishable from one a person opened deliberately, with no new UI.
- The campaign's `project` states the platform, so the one field the lake reads off a work
  order (`$.project`, §5.3) is true rather than a rig id.
- No change to the connector's ordering rule; no second HTTP call on the file path.

### 2.2 Non-goals

- **Never mint an id.** No `WO-<year>-A<nnn>`, no id derived from a filename, a route, a
  date or a run key. A work order is opened only when the operator **stated** its id.
- **Never invent a project.** The rig id is not a project (`_adopt_order`'s defect). An
  unstated platform leaves the field empty, exactly as a planning campaign with no project
  does (`planning_sync.py:353-356`).
- No test definitions are created. A definition is an authored test case; an unknown
  definition claim stays retained exactly as today (`CLAIM_RETAINED["definition_id"]`).
- No DCM `WorkOrder` configuration is pushed for a campaign opened here (§5.3).
- No change to `_link_retained_claims`, to `derive_status`, or to the precedence ranks.
- No work-order picker on the import page (§3.5).

---

## 3. The six decisions

### 3.1 Who creates it, and when — **the registry, inside `POST /test-runs`, before the claims are resolved**

`api/api/services/queries_runs.py::upsert_run` (`:222-238`) gains one statement ahead of
the insert/merge branch: if the body states a `work_order_id` that `work_orders` does not
hold, open it. `_resolve_claims` (`:118-145`) then finds the row on its normal path, writes
the link at `Source.EMBEDDED` through `_write_claims` (`:152-178`), copies the work order's
`project` onto the run (`:141-144`), and `derive_status` returns `complete`. Nothing is
retained, so `_link_retained_claims` has nothing to do and is not touched.

Why the others are worse:

- **`tm-connector` calling `POST /work-orders` before the run upsert.** It puts a second
  HTTP call next to the 🔴 ordering rule (`tm-connector/connector/connector.py:1-23`,
  `:187-205`) — a call that can 409, time out, or poison — for no gain, and it would have
  to hold the policy (title, project, "never invent") in a second place. Worse, the route
  it would call writes `Source.MANUAL` and calls `_link_retained_claims`
  (`queries_runs.py:1897-1925`), so ingestion would either claim a person's authority or
  force a new `source` parameter on a public route. It also only covers the connector's own
  producers; the seed and any future bench would still land amber.
- **The uploader (`mf4-to-blob`).** Dead. It holds no TM url and no token — its only
  outbound edges are blob storage and Kafka (verified: no `httpx`/`requests` import in the
  app), and by standing rule it never talks to the registry. It also cannot know whether
  the id exists.
- **A new route (`POST /work-orders/ensure`).** New public surface for something the run
  upsert can do inside the call it already makes. Refused by the light-code rule.

Both connector lanes benefit for free: `on_metadata` (`connector.py:67-111`) upserts the
run at upload time, so the campaign appears **before the decode**, and `_finalize`
(`connector.py:142-205`) re-sends the same claim with no second effect.

### 3.2 Never invent an id — **the rule, stated**

> A work order is created **only** when the incoming body states `work_order_id`. An upload
> that states none keeps today's behaviour exactly: no work order, no claim, the run stays
> `awaiting_work_order` and waits for a person.

`_adopt_order` is the named anti-pattern (§1.1). The registry has exactly one sanctioned
"bend" of the never-invent rule — `tm-connector/connector/dressing.py:1-19`, which fills an
UNKNOWN rig for the demo — and this feature does not add a second: it echoes an id a person
or a recording stated, and nothing else.

A typo'd id therefore opens a campaign nobody wants. That is accepted and is the cost of
the user's instruction; the row is deletable from the Work orders screen
(`DELETE /work-orders/{wo_id}`, refused 409 while a run names it), and §3.6 makes it
legible on sight.

### 3.3 Provenance — **`Source.EMBEDDED`, actor `ingestion`**

Verified against the real machinery, not assumed:

- `api/api/provenance.py:42-49` ranks `embedded` 0, `api:*` 1, `manual` 2; `blocks()`
  (`:103-107`) skips a write ranked **below** the stored value. So a later hand edit
  (rank 2) and a later planning push (rank 1) both outrank these fields with **no new
  precedence rule**.
- `set_field` (`provenance.py:211-272`) with `current_doc=None` performs no precedence
  check and writes `field_sources.<field> = {"source": "embedded", "actor": …, "at": …}` —
  the same shape `create_work_order` writes today.
- `_check_actor` (`provenance.py:63-68`) accepts `"ingestion"`: it is
  `RunUpsertRequest.actor`'s default (`api/api/models/runs.py:409`) and is not in
  `_PLACEHOLDER_ACTORS`.
- `work_orders` is in `TAGGED_COLLECTIONS` (`provenance.py:112`), so the row answers the
  `source` filter on `GET /work-orders` (`queries_runs.py:1774-1778`) and counts in the
  TR-011 source statistics — for free, with no model change.
- `WorkOrderDetail.origin` / `WorkOrderListItem.origin` are typed `Source`
  (`api/api/models/planning.py:303`), and `work_order_origin` (`queries_runs.py:1715-1723`)
  derives from the **title's** source tag — so an `embedded` title makes `origin` read
  `embedded` on both the list and the detail with no new field. This is §3.6's answer.
- `planning_sync._write_mirror` overwrites without a precedence check
  (`planning_sync.py:307-317`), so if a planning system ever states this campaign, its
  title and project simply replace the placeholder. Correct: planning's statement wins.
- The row carries no `mirrored_at` (it is an `insert_one`, not the mirror's upsert), so
  `planning_sync.demo_reset` — which removes what a sync created (`planning_sync.py:857`) —
  leaves it alone, exactly as it leaves a manually opened campaign alone.

`Source.MANUAL` is wrong: no person authored it in the Test Manager. `Source.API_PLANNING`
is a lie: there is no planning system since `38ecd12`. `EMBEDDED` is the truth — the claim
came off the recording — and it is the rank that makes every later correction win by
default.

### 3.4 Title and project

**`project` = the declared platform.** The exact hops, all but one of which already exist:

1. `mf4-to-blob/static/claim-editor.js:29` — `platform` is the one claim with
   `alwaysSend: true`, prefilled from the recording's own `platform` header key
   (`static/mdf-header.js:29-39`; no `test.` prefix — it is the recording's provenance key).
2. `mf4-to-blob/metadata.py:48-53` shape-checks it against `_TM_ID`;
   `build_metadata` (`:252-269`) puts it in `declared` **and** flat as `platform`.
3. `mf4-decoder` forwards `declared` verbatim and the raw `header_properties` (which holds
   `platform`, `mf4-decoder/provenance.py:42-48`) onto the marker (`marker.py:51-71`).
4. **NEW** `tm-connector/connector/identity.py` resolves it off the **raw** bags, exactly as
   `resolve_vehicle` does (`identity.py:132-133, 266-279`): declared key `platform`, then
   header key `platform`. `Identity` gains `platform: str | None = None`
   (`identity.py:295-310`).
5. **NEW** `bodies.run_body` (`bodies.py:74-106`) sends `platform` when it resolved, and
   omits the key otherwise — the same "an absent fact stays absent" rule `lake_table`
   follows.
6. **NEW** `RunUpsertRequest.platform: str | None = None` (`api/api/models/runs.py:372-409`).
7. The registry uses it for **one** purpose: the `project` of a work order it opens here.
   It is **not** stored on the run — the run's `project` already comes from the work order
   (`queries_runs.py:141-144`), and a second copy would be a second answer to one question.

Why platform *is* project in this estate: `work_orders.project` is exactly what the lake
reads as a platform (`mf4-datalake-sink/main.py:339-347` joins `$.project` into
`_work_order_platform`; `expand.py:171-173` uses it as the platform fallback). Filling it
from the platform makes that join true; filling it from the rig is the defect of §1.1.

No platform stated → `project = ""`. That is the same value `_mirror_work_orders` coerces a
projectless planning campaign to (`planning_sync.py:353-356`), and the run then reads
`project = ""` rather than null. Never `"unknown"`, never the rig.

**`title` = `"Opened by an upload"`**, written at `embedded`.

`create_work_order`'s model requires a title (`models/planning.py:309-322`) and the Work
orders table renders a Title column (`work-orders-screen.tsx:186, 228`). The three
candidates:

| Candidate | What the list shows | Verdict |
|---|---|---|
| `""` (empty) | a blank cell in the middle of the table | reads as a broken row |
| `wo_id` or `f"Work order {wo_id}"` | the id, twice in one row | noise, says nothing |
| `"Opened by an upload"` | one sentence of truth, in a column that already exists | **chosen** |

It is self-erasing by precedence: any `manual` or `api:planning` write replaces it and
flips `origin` away from `embedded` at the same moment (§3.3). **Caveat:** there is no
route today that edits a work order's title — `PATCH /work-orders/{wo_id}` takes `status`
alone and 422s on anything else (`models/planning.py:325-335`). Renaming therefore waits
on the authoring controls (`BL-35`, `dev-planning/authoring-controls/spec.md`). That is a
dependency to record, not a blocker: the placeholder is honest until then.

### 3.5 The user's second option — the searchable picker: **deferred, and not needed here**

*"or allow user to add to existing based on dropdown menu with serach"* — a live picker on
the MF4 Import page would require `mf4-to-blob` to call `GET /work-orders`: a TM url, a
token and an auth surface in the one app that is deliberately deaf to the registry (§3.1).
That is the whole reason it is deferred rather than built.

It is also mostly answered already: since the prefill shipped (`BL-73`), the work-order box
is filled from the recording's own `test.work_order`, so the common case needs no typing
and no list — and joining an **existing** campaign is exactly what happens today when the
claimed id resolves. What this spec adds is the other half: a stated id that resolves to
nothing now opens the campaign instead of stalling.

If the user still wants the picker after using this, the achievable shapes are, in order of
cost: (a) a `datalist` on the import page fed by a small read-only `GET /work-orders/ids`
proxy in `mf4-to-blob` — one route, one token, the rule bent deliberately; (b) move the
upload form into the Test Manager frontend, which already holds the token and the hooks
(`useWorkOrders`, `useWorkOrderFacets`). Neither is in scope here. **OQ2.**

### 3.6 What a person sees — **the title, the journal and `origin`; no badge, no new column**

1. **The Work orders list** shows `Opened by an upload` in the Title column it already
   renders (`work-orders-screen.tsx:228`) and the platform in Project. Nothing new is built.
2. **`origin` reads `embedded`** on the list row and the detail — derived, already on the
   wire, already typed (`models/planning.py:303`, `frontend/types/work-order.ts:43, 80`).
   `GET /work-orders?source=embedded` filters to exactly these rows through the existing
   `source` parameter (`queries_runs.py:1774-1778`). No badge: the provenance badges left
   the working screens at `488a372` (`BL-83`), and this answer does not bring them back.
3. **The work-order journal** carries one `work_order.created` event at `embedded` whose
   note names the run that opened it. The detail screen already renders that panel
   (`work-order-detail-screen.tsx:55-56, 318-323`), so the trail is visible with no UI work.

All three stop pointing at "an upload made this" the moment a person edits the row, because
each is derived from the same rank-0 tag.

---

## 4. Work breakdown

Owner for every code item: **ArchDev**. Verification: **Tester** (lint + smoke gate).

### 4.1 One work-order writer, two doors (`api/`)

Extract the document shape of `create_work_order` (`queries_runs.py:1857-1926`) into a
private writer both doors call, so the two can never drift on the stored keys:

```
_insert_work_order(db, wo_id, *, title, project, source, actor, note) -> None
```

It builds `title` / `project` / `status="active"` through `set_field`, inserts the document
with the same null-filled keys the current insert writes (`requestor`, `department`,
`priority`, `created_at_source`, `raw`, `synced_at`, `mirrored_at`), and writes the
`work_order.created` journal event at the caller's source.

- `create_work_order` keeps its 409 `wo_exists`, its `Source.MANUAL` and its
  `_link_retained_claims` call, and delegates the insert.
- The ingest path calls it with `Source.EMBEDDED`, `actor=body.actor`, and neither the 409
  nor `_link_retained_claims`.

### 4.2 Open the claimed campaign (`api/`)

```
_open_claimed_work_order(db, body) -> None
```

in `queries_runs.py`, called from `upsert_run` (`:222-238`) **before** the
`_insert_run` / `_merge_run` branch:

1. `wo_id = (body.work_order_id or "").strip()`; empty → return (§3.2).
2. `db["work_orders"].find_one({"_id": wo_id}, {"_id": 1})` is not None → return. This is
   the normal case and costs one indexed `_id` lookup per run upsert.
3. Otherwise `_insert_work_order(...)` with
   `title="Opened by an upload"`, `project=(body.platform or "").strip()`,
   `source=Source.EMBEDDED`, `actor=body.actor`,
   `note=f"Opened by the run {body.run_id}, which claimed it."`
4. `except DuplicateKeyError: return` — two markers for one new campaign can race. This is
   concurrency on a unique `_id`, the same reason `upsert_run` already catches it
   (`queries_runs.py:232-238`); the loser simply proceeds and its claim resolves against the
   winner's row. It is **not** a validation branch.

Dependencies: 4.1. Nothing else in `queries_runs.py` changes — `_resolve_claims`,
`_write_claims`, `_retained_claims` and `_unresolved_claim_events` are untouched and now
simply never see an unknown work order from this path.

### 4.3 Carry the platform to the registry (`tm-connector/`, `api/`)

- `connector/identity.py`: `DECLARED_PLATFORM = "platform"`, `HEADER_PLATFORM = "platform"`,
  `resolve_platform(declared, header)` modelled line-for-line on `resolve_vehicle`
  (`:266-279`), `Identity.platform` (`:295-310`), filled in `resolve_identity` (`:406-416`)
  off the **raw** bags. It does **not** join `DECLARED_FIELDS` (`:64-78`) or
  `LINKAGE_FIELDS` (`:109`): those feed the per-field precedence that builds
  `Identity.fields`, and the platform is a property of the recording, like the vehicle.
- `connector/bodies.py::run_body` (`:74-106`): `if identity.platform: body["platform"] = …`,
  set before `dressing.dress_run_body` (which touches only rig/cell/operator/bench_sw).
- `api/api/models/runs.py::RunUpsertRequest` (`:372-409`): `platform: str | None = None`,
  documented as a claim the registry uses to state a newly opened campaign's project and
  stores nowhere else. `RequestModel` is `extra="forbid"`, so this field must land in the
  model **before or with** the connector change — otherwise every run upsert 422s and, by
  the ordering rule, every file quarantines. **Ship the API first.**

Dependencies: none on 4.1/4.2; deployable independently.

### 4.4 Tests (Tester writes; see §6 for the red ones)

New `api/tests/test_upload_opens_work_order.py`:

1. a run claiming an unknown work order opens it, links the run, and the run reads
   `complete` — not `awaiting_work_order`;
2. the opened row reads `title = "Opened by an upload"`, `project` = the posted platform,
   `status = "active"`, `origin = "embedded"`;
3. a run claiming **no** work order opens nothing (`work_orders` count unchanged) and stays
   amber — the §3.2 rule as a test;
4. a run posting no `platform` opens the campaign with `project = ""` — never the `rig_id`
   (the `_adopt_order` regression test, and it must assert the rig id is absent from the
   document);
5. a claim naming an **existing** campaign writes no second document and journals no second
   `work_order.created`;
6. a replayed identical upsert opens nothing further;
7. a later `PATCH /work-orders/{wo_id}` (status) and a later planning push both outrank the
   `embedded` fields — precedence proved at the route, not asserted from the rank table.

`tm-connector/tests/test_identity.py` — platform resolves declared-then-header and is
absent when neither states one; `tm-connector/tests/test_metadata_lane.py` — the lane-1 body
carries it. `tests/test_marker_contract.py` (repo root) already feeds a real marker through
the connector's readers into the registry's models, so it covers the new field end to end.

---

## 5. Data and interface contracts

### 5.1 The wire

`POST /test-runs` gains one optional request field:

```jsonc
{ "run_id": "TAS-1005", "rig_id": "battery-sim-01",
  "work_order_id": "WO-BAT-2026-002",      // existing claim
  "platform": "Porsche_Taycan",            // NEW — used only to state a new campaign's project
  "source": "embedded", "actor": "ingestion" }
```

No response model changes. No new route. `api/docs/openapi.v1.json` must be regenerated
(`api/scripts/snapshot.sh`) — the contract-snapshot test is already red for `BL-25`, and
this adds one more model field to that refresh.

### 5.2 The created document

A trace claiming `WO-BAT-2026-002` on platform `Porsche_Taycan`, ingested by the connector:

```jsonc
// work_orders
{ "_id": "WO-BAT-2026-002",
  "title": "Opened by an upload",
  "project": "Porsche_Taycan",
  "status": "active",
  "requestor": null, "department": null, "priority": null,
  "created_at_source": null,
  "field_sources": {
    "title":   {"source": "embedded", "actor": "ingestion", "at": "<server utcnow>"},
    "project": {"source": "embedded", "actor": "ingestion", "at": "<server utcnow>"},
    "status":  {"source": "embedded", "actor": "ingestion", "at": "<server utcnow>"} },
  "raw": null, "synced_at": null, "mirrored_at": null }

// journal_entries
{ "entity_type": "work_order", "entity_id": "WO-BAT-2026-002",
  "field": "work_order.created", "kind": "event",
  "source": "embedded", "actor": "ingestion",
  "note": "Opened by the run TAS-1005, which claimed it." }
```

and the run, in the same request, through the ordinary claim path:
`work_order_id = "WO-BAT-2026-002"` (`embedded`), `project = "Porsche_Taycan"` (`embedded`),
`claimed_work_order_id = null`, `status = "complete"`.

Served: `GET /work-orders` → `origin: "embedded"`, `synced_at: null`, `definition_count: 0`,
`run_count: 1`.

### 5.3 The lake's work-order join — unchanged, and now vestigial

`mf4-datalake-sink/main.py:332-347` joins the DCM `WorkOrder` configuration's `$.project`
into `_work_order_platform`, and `expand.py:171-173` uses it **only** when the batch's own
`platform` is `unknown`. Since `platform` became an always-sent claim (`c70ab7b`) and the
decoder additionally falls back to `DBC_PLATFORM` (`mf4-decoder/main.py:1135-1136`), that
branch now needs the form to send nothing **and** the header to state nothing **and**
`DBC_PLATFORM` to be unset.

It also cannot fire for a campaign opened here: `config_push.push_work_orders` runs only on
the planning-mirror path (`planning_sync.py:368`), so neither `POST /work-orders` nor this
new door publishes a DCM configuration. **Decision: leave it alone.** Adding a DCM push for
a campaign whose platform the batch already carries would be new machinery serving a branch
that cannot be reached. Filling `project` from the platform (§3.4) keeps the join truthful
for the campaigns that do have a configuration.

---

## 6. Blast radius — what states the old truth

These are *expected* reds, not bugs; each must be rewritten in the same commit to state the
new behaviour:

- **`api/tests/test_runs_claim_retention.py`** — the work-order half. Cases posting
  `UNKNOWN_WO = "WO-2026-9999"` and asserting retention/amber now describe a campaign that
  gets opened: `test_an_unresolved_work_order_claim_is_retained_on_the_run` (`:74`),
  `test_a_claim_that_arrives_after_registration_is_retained` (`:89`),
  `test_a_later_claim_replaces_the_remembered_one` (`:114`),
  `test_a_replayed_claim_still_journals_once` (`:122`), and the four "retention is never a
  link" cases (`:136`, `:144`, `:155`, `:167`). The **definition** half stays green and
  unchanged, and it is what keeps `CLAIM_RETAINED` and `_link_retained_claims` alive.
- **Consequence to state plainly:** after this ships, `POST /test-runs` can no longer
  produce a *work-order* retention — a stated id always exists by the time `_resolve_claims`
  runs. The `claimed_work_order_id` field, the `run.work_order_claim_unresolved` event and
  the work-order branch of `_link_retained_claims` survive for documents written before
  this, and are **not** deleted here (the brief forbids touching `_link_retained_claims`,
  and a deletion needs its own migration decision). **OQ1.**
- `api/docs/openapi.v1.json` — one model field (§5.1), `BL-25`.
- `frontend/types/work-order.ts:38-43` — the `origin` doc comment says `api:planning` or
  `manual`; add `embedded`. `:165-167` — "the registry never creates a work order to repair
  a link" is now false and must be rewritten to state the rule of §3.2 (it repairs nothing;
  it opens what an operator stated).
- `api/api/models/planning.py:310-317` and `frontend/types/work-order.ts:86-97` —
  `POST /work-orders` is no longer the only door; the docstrings claim it is.
- `CLAUDE.md` (project) — the ingestion-pipeline section states a run claiming an unknown
  work order keeps a retained claim; regenerate the backlog table with `BL-81` moved and add
  one line to the pipeline notes.

---

## 7. Risks, constraints and open questions

**Risks**

- *A typo opens a campaign.* Accepted (§3.2). Mitigated by §3.6's three signals and by
  `DELETE /work-orders/{wo_id}`, which is refused 409 while a run names it — so the cleanup
  order is: re-link or delete the run first.
- *A run upsert now writes to a second collection.* One extra indexed `_id` read on every
  upsert, one insert on the rare miss. No transaction: if the insert lands and the run
  insert then fails, the redelivery finds the campaign and proceeds — the leftover is an
  empty campaign, not a broken link.
- *The connector sends `platform` before the API knows it.* `extra="forbid"` turns that into
  a 422 on `POST /test-runs`, which by the ordering rule quarantines the file permanently.
  **Deploy the API first** (§4.3), and the connector second.
- *Legacy runs.* Runs already holding a retained work-order claim are not swept by this
  change. They close the moment anyone opens that campaign, by the existing
  `_link_retained_claims` call in `create_work_order`. No migration.

**Constraints honoured**

- No new collection, no new route, no adoption heuristic, no minted id, no rig-as-project.
- `connector.py`'s ordering rule is untouched; the campaign is opened **inside** the run
  upsert, so nothing sits between the run upsert and the file register.
- `_link_retained_claims` is not modified.
- Everything the user must do is reachable from the import page (type nothing — the prefill
  states the campaign) or the Test Manager (New work order, Delete).

**Open questions**

- **OQ1 (user/architect).** Retire the work-order half of claim retention in a follow-up
  ticket, or keep it as dead-but-harmless machinery for pre-existing documents?
  Recommendation: keep now, file a backlog row.
- **OQ2 (user).** Is the searchable work-order picker on the import page still wanted once
  the prefill plus this auto-open are live (§3.5)? If yes, choose shape (a) or (b) there.
- **OQ3 (user).** Wording of the placeholder title. `"Opened by an upload"` is the
  recommendation; it is the string a person will see in the Title column until `BL-35`
  gives them an edit control.
- **OQ4 (architect).** Should the ingest path also fill `work_orders.status` from anything
  other than the fixed `"active"`? Recommendation: no — a campaign receiving traces is
  running by definition.

---

## 8. Alternatives considered

| Alternative | Why not |
|---|---|
| `tm-connector` calls `POST /work-orders` | second HTTP call beside the 🔴 ordering rule; policy duplicated; would write `MANUAL` or force a new route parameter (§3.1) |
| `mf4-to-blob` creates it | holds no TM url or token; standing rule forbids it talking to the registry (§3.1) |
| A dedicated `POST /work-orders/ensure` route | new public surface for what the run upsert already does inside one call |
| Create it in `_link_retained_claims`, on a sweep | delayed by definition, needs a trigger nothing fires, and the brief forbids touching that function |
| Mint an id when none is claimed (`_adopt_order`) | invents campaigns nobody asked for; the named anti-pattern (§1.1) |
| `project` from `rig_id` (`_adopt_order`) | the exact live defect the user spotted (`project = 0225`) |
| `project` left empty always | throws away the one fact the upload does carry, and keeps `work_orders.project` — which the lake reads as a platform — empty (§5.3) |
| Write the row at `MANUAL` | claims a person authored it; and rank 2 would make a later planning push lose to a machine write |
| Write it at `api:planning` | there is no planning system since `38ecd12`; it would also be swept by `demo_reset`'s mirror rule |
| Distinguish it with a provenance badge | badges left the working screens at `488a372` (`BL-83`); `origin` + the title + the journal need no new UI (§3.6) |

---

## 9. References

- Backlog `BL-81` (`dev-planning/backlog.json:570-576`); related `BL-35` (authoring
  controls, the title edit), `BL-25` (openapi snapshot), `BL-83` (provenance on screens),
  `BL-67` (work-order delete cascade).
- `dev-planning/import-prefill-from-trace/spec.md` — the prefill that makes the claim
  correct by default (`BL-73`).
- `dev-planning/authoring-controls/spec.md` — where the title edit belongs.
- `f86dd92` — `create_work_order` closes retained claims; `38ecd12` — the planning mock and
  `_adopt_order` removed; `c70ab7b` — `platform` became an always-sent claim; `488a372` —
  provenance left the working screens.
- Project `CLAUDE.md`, "Ingestion pipeline" and "Seeding the Test Manager".
