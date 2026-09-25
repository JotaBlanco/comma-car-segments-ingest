# An upload opens the work order it claims

## ⚠ Deploy the API before the connector

`RunUpsertRequest` is `extra="forbid"` (`api/api/models/common.py`), so a `POST /test-runs`
body carrying a field the server has never heard of is a **422, not an ignored key**. This
change adds `platform` to that body. The connector's ordering rule
(`tm-connector/connector/connector.py:1-23`) registers the run before the file, and a failed
run upsert stops the file registering at all — the file is then **permanently quarantined**,
because the decoder dedups on the sha256 and a re-upload of identical bytes is skipped.

**Order: `api` first, `tm-connector` second.** Between the two deployments the estate is
correct — the API accepts `platform` from nobody and campaigns are not opened yet, which is
exactly today's behaviour. In the reverse order every trace uploaded in the window is lost
and must be re-generated with a new route timestamp to re-ingest.

The connector test suite pins the coupling: `tm-connector/tests/fake_registry.py:96`
validates the connector's own body against the real `RunUpsertRequest`, so a connector that
sends a field the model lacks is red locally before it is red in the cluster.

## What it does

A trace states its campaign in its own MF4 header (`test.work_order`) or in the field an
operator types on the import page. Until now, a claim naming a campaign the Test Manager had
never heard of linked nothing: `_resolve_claims` found no row, the id was remembered on the
run as `claimed_work_order_id`, the run went amber (`awaiting_work_order`), and nothing ever
resolved it — the outbound planning pass retired with the planning mock at `38ecd12`. On
2026-09-25 `WO-BAT-2026-001` had to be created with `curl` so four uploaded runs could find
their campaign.

`POST /test-runs` now **opens the campaign the operator stated**, at `embedded` provenance,
before it resolves the run's claims. The run links itself on its ordinary path in the same
request and is `complete` on arrival. The campaign's `project` states the declared
**platform**. Nothing is invented: an upload claiming no work order behaves exactly as it did
before.

## Why this shape

### The registry, inside `POST /test-runs` — not the connector, not the uploader

One statement in `upsert_run` opens the campaign ahead of the insert/merge branch, so
`_resolve_claims` finds the row on its normal path, `_write_claims` writes the link at
`Source.EMBEDDED`, the work order's `project` is copied onto the run, and `derive_status`
returns `complete`. Nothing is retained, so `_link_retained_claims` has nothing to do and was
not touched.

The connector calling `POST /work-orders` first was rejected: it puts a second HTTP call —
one that can 409, time out or poison — next to the ordering rule, for no gain; it duplicates
the policy (title, project, never-invent) in a second place; and the route it would call
writes `Source.MANUAL` and runs `_link_retained_claims`, so ingestion would either claim a
person's authority or force a new `source` parameter onto a public route. It would also only
cover the connector's own producers — the seed and any future bench would still land amber.

`mf4-to-blob` was dead as an option: it holds no Test Manager url and no token, its only
outbound edges are blob storage and Kafka, and by standing rule it never talks to the
registry. A dedicated `POST /work-orders/ensure` route is new public surface for something
the run upsert already does inside the call it makes anyway.

### Two defects of the deleted `_adopt_order`, and how this differs

The planning mock's `_adopt_order` (`api/mock_planning/demo_admin.py:152-196`, removed with
the mock at `38ecd12`) did this job and did it badly. Both of its defects are forbidden here
by construction:

| `_adopt_order` | Here |
|---|---|
| **Minted ids** (`WO-<year>-A<nnn>`) for runs claiming none | `_open_claimed_work_order` returns on an empty `work_order_id`. The id is only ever **echoed** from what an operator or a recording stated. A run claiming nothing stays amber and waits for a person, exactly as today. |
| **`project = run.project or run.rig_id or "unassigned"`** — the rig fallback that produced the live campaign reading `project = 0225`, which the user spotted as *"you somehow mixed up rig Id with project"* | `project` comes from the declared **platform** and from nowhere else. No platform stated → `project = ""`, the same empty value a projectless planning campaign coerces to. The rig id is never read by this path. |

A typo'd id therefore opens a campaign nobody wants. That is accepted: it is the cost of the
user's instruction, the row is legible on sight (§"What a person sees"), and it is deletable
from the Work orders screen. The alternative — a validation layer guessing which stated ids
are real — is the defensive machinery this codebase refuses.

### `Source.EMBEDDED`, actor `ingestion`

`provenance._RANK` ranks `embedded` 0, `api:*` 1, `manual` 2, and `blocks()` skips a write
ranked below the stored value. Writing at rank 0 means **every later correction wins with no
new precedence rule**: a hand edit, a planning push, both outrank these fields for free.

`MANUAL` would be a lie — no person authored it in the Test Manager — and rank 2 would make a
later planning push *lose* to a machine write. `api:planning` would be a lie too: there is no
planning system since `38ecd12`, and `planning_sync.demo_reset` removes what a sync created.
The row here is an `insert_one` and carries no `mirrored_at`, so the demo reset leaves it
alone, exactly as it leaves a manually opened campaign alone.

`_check_actor` accepts `"ingestion"`: it is `RunUpsertRequest.actor`'s default and is not in
`_PLACEHOLDER_ACTORS`.

### `project` = the declared platform, and why platform *is* project here

`work_orders.project` is exactly what the lake reads as a platform:
`mf4-datalake-sink/main.py:332-347` joins the DCM `WorkOrder` configuration's `$.project`
into `_work_order_platform`, and `expand.py:171-173` uses it as the platform fallback.
Filling `project` from the platform makes that join truthful; filling it from the rig is the
defect above.

The platform is **not** stored on the run. The run's own `project` already comes from the
work order its claim resolved to, and a second copy would be a second answer to one question.
`RunUpsertRequest.platform` exists for exactly one purpose: stating the project of a campaign
this request opens.

That join is now **vestigial, not wrong**, and is deliberately left alone. `platform` became
an always-sent claim at `c70ab7b` and the decoder additionally falls back to `DBC_PLATFORM`,
so the fallback branch needs the form to send nothing *and* the header to state nothing *and*
`DBC_PLATFORM` to be unset. It also cannot fire for a campaign opened here:
`config_push.push_work_orders` runs only on the planning-mirror path, so neither
`POST /work-orders` nor this door publishes a DCM configuration. Adding one would be new
machinery serving a branch that cannot be reached.

### `title = "Opened by an upload"`

`create_work_order`'s model requires a title and the Work orders table renders a Title column.
An empty string reads as a broken row; the id or `f"Work order {wo_id}"` prints the id twice
in one row and says nothing. The placeholder is one sentence of truth in a column that
already exists, and it is self-erasing by precedence: any `manual` or `api:planning` write
replaces it and flips `origin` away from `embedded` at the same moment.

**Caveat to record:** no route edits a work order's title today —
`PATCH /work-orders/{wo_id}` takes `status` alone and 422s on anything else. Renaming waits
on the authoring controls (`BL-35`).

### What a person sees — no badge, no new column

1. The **Work orders list** shows `Opened by an upload` in the Title column it already
   renders, and the platform in Project.
2. **`origin` reads `embedded`** on the list row and the detail. `work_order_origin` derives
   it from the **title's** source tag, so an `embedded` title makes `origin` read `embedded`
   with no new field, and `GET /work-orders?source=embedded` filters to exactly these rows
   through the existing `source` parameter. `work_orders` is already in
   `provenance.TAGGED_COLLECTIONS`, so the filter and the TR-011 statistics work untouched.
3. The **work-order journal** carries one `work_order.created` event at `embedded` whose note
   names the run that opened it. The detail screen already renders that panel.

No provenance badge: badges left the working screens at `488a372` (`BL-83`), and this does
not bring them back. All three signals stop pointing at "an upload made this" the moment a
person edits the row, because each derives from the same rank-0 tag.

## Data flow

```
import page                    mf4-to-blob              mf4-decoder
┌──────────────────┐          ┌─────────────┐          ┌──────────────────────┐
│ claim-editor.js  │  form    │ metadata.py │ mf4_meta │ declared rides whole │
│ platform is the  │────────► │ declared[   │────────► │ + header_properties  │
│ one alwaysSend   │          │  "platform"]│          │   (raw, key          │
│ claim, prefilled │          │             │          │    "platform", no    │
│ from the header  │          │             │          │    test. prefix)     │
└──────────────────┘          └─────────────┘          └──────────┬───────────┘
                                                                  │ file_complete
                                                                  ▼
                                              tm-connector/connector/identity.py
                                              resolve_platform(declared_raw, header_raw)
                                                declared wins, then header, else None
                                                → Identity.platform
                                                                  │
                                                                  ▼
                                              connector/bodies.py::run_body
                                                body["platform"] = …  (omitted when None)
                                                                  │ POST /test-runs
                                                                  ▼
  api/api/services/queries_runs.py::upsert_run
    │
    ├─► _open_claimed_work_order(db, body)          ◄── NEW, the whole feature
    │     body.work_order_id blank?  ──► return (never invent)
    │     work_orders holds the _id?  ──► return (the normal case, one indexed read)
    │     else _insert_work_order(title="Opened by an upload",
    │                             project=body.platform or "",
    │                             source=EMBEDDED, actor=body.actor)
    │           └─ DuplicateKeyError ──► return (two markers raced; the loser proceeds)
    │
    └─► _insert_run / _merge_run
          └─ _resolve_claims  → work_orders holds the row now
               └─ _write_claims  → run.work_order_id at EMBEDDED
                  run.project ← work_order.project
                  derive_status → "complete"   (no retention, no amber)
```

Both connector lanes benefit. `on_metadata` upserts the run at upload time, so the campaign
appears **before the decode** finishes; `_finalize` re-sends the same claim and the second
call finds the row and returns immediately.

## The created document

A trace claiming `WO-BAT-2026-002` on platform `Porsche_Taycan`:

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

// journal_entries — exactly one entry. `_insert_work_order` discards the change
// entries `set_field` returns, as `create_work_order` always has: a document that
// did not exist has no field history, only a birth.
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

No test definitions are created. A definition is an authored test case, so an unknown
definition claim is retained exactly as before.

## File inventory

| File | Change |
|---|---|
| `api/api/services/queries_runs.py` | `_insert_work_order` extracted from `create_work_order` — one writer, two doors outside planning, so the stored keys cannot drift. `_open_claimed_work_order` added. One call in `upsert_run`, ahead of the insert/merge branch. `OPENED_BY_UPLOAD` constant. Comments on `_CLAIM_MIRRORS`, `_resolve_claims` and `create_work_order` corrected — each described a work-order claim that only planning could ever answer. |
| `api/api/models/runs.py` | `RunUpsertRequest.platform: str \| None = None`, documented as stored on no run. Class docstring corrected: a claimed work order is now opened, not remembered. |
| `api/api/models/planning.py` | `WorkOrderCreateRequest` docstring: three doors open a campaign, not two. |
| `tm-connector/connector/identity.py` | `DECLARED_PLATFORM` / `HEADER_PLATFORM`, `resolve_platform` (modelled on `resolve_vehicle`), `Identity.platform`, filled in `resolve_identity` off the **raw** bags. Module docstring gained the platform bullet beside the car's. |
| `tm-connector/connector/bodies.py` | `run_body` sends `platform` when it resolved and omits the key otherwise. Docstring corrected on the work-order claim. |
| `frontend/types/work-order.ts` | Doc comments only: `origin` can read `embedded`; `POST /work-orders` is not the only door; "the registry never creates a work order to repair a link" replaced by the never-invent rule as it actually stands. |
| `api/seed/fixtures.py` | The hero run's claim: `HERO_CLAIMED_WORK_ORDER_ID` / `HERO_PLATFORM` replace the held-back pair. See "The demo seed's toggle beat" below. |
| `api/seed/seed_demo.py` | `register_run` sends `platform`; the work-order count in the report includes the campaign the registration opened; `self_verify` no longer walks the planning toggle. |
| `api/seed/filler.py` | Comment only: `DEMO_WORK_ORDER_COUNT` is shared with the stub cast. |

Not touched, deliberately: `_link_retained_claims`, `derive_status`, the precedence ranks,
`mf4-to-blob`, `mf4-decoder`, `mf4-datalake-sink`, and every React component.

`platform` does **not** join `DECLARED_FIELDS` or `LINKAGE_FIELDS` in the connector. Those
feed the per-field precedence that builds `Identity.fields` — assertions a run makes. The
platform is a property of the recording, like the vehicle, so it is read off the raw bags.

## Integration with neighbouring features

- **`import-prefill-from-trace` (`BL-73`)** is what makes this safe. The work-order box is
  prefilled from the recording's own `test.work_order`, so the common case needs no typing
  and the id that gets echoed is the one the trace states. Without the prefill this feature
  would open a campaign per typo far more often.
- **`upload-claims-platform` (`c70ab7b`)** put `platform` on the wire as the one always-sent
  claim. This feature is the first reader of it inside the Test Manager.
- **`architecture-work-order-lifecycle.md`** describes `POST /work-orders`, `PATCH` and
  `DELETE`. The delete is still refused 409 while a run names the campaign, so the cleanup
  order for an unwanted row is: re-link or delete the run, then delete the campaign.
- **`architecture-vehicle-on-a-trace.md`** is the pattern this copies: a fact resolved once
  per file off the raw declared/header bags, declared winning, no mint.
- **The searchable picker the user also asked for is deferred**, not dropped. A live picker
  on the MF4 Import page needs `mf4-to-blob` to call `GET /work-orders` — a url, a token and
  an auth surface in the one app deliberately deaf to the registry. The achievable shapes, in
  cost order: a `datalist` fed by a small read-only proxy route in `mf4-to-blob`, or moving
  the upload form into the Test Manager frontend, which already holds the token and the
  hooks. Spec §3.5, `OQ2`.

## The consequence to state plainly

After this ships, `POST /test-runs` can no longer produce a **work-order** retention on the
normal path: a stated id exists by the time `_resolve_claims` runs. The machinery survives
anyway, and that is deliberate — `_open_claimed_work_order` can still fail on a refused write
or a concurrent delete, and retention is the correct fallback. Asserting it can never happen
would encode a guarantee the code cannot make. `claimed_work_order_id`, the
`run.work_order_claim_unresolved` event and the work-order branch of `_link_retained_claims`
also still serve every document written before this change, and deleting them needs its own
migration decision (spec `OQ1`).

The **definition** half of claim retention is untouched and is what keeps `CLAIM_RETAINED`
and `_link_retained_claims` exercised.

## The demo seed's toggle beat, and why it is gone

The demo seed staged an amber-to-green beat: the hero run `TAS-88214` registered claiming
`WO-2026-0851`, a campaign the seed deliberately withheld from the mirror, so the run waited
amber until a presenter flipped the **planning-sync toggle** — the sync then mirrored the
pair and `_link_retained_claims` turned the hero green.

**That control was deleted at `38ecd12` (`BL-72`)**, hours before this feature. The
`planning-sync-toggle.tsx` component is gone, the `Planning Sync Mock` deployment is gone
from `quix.yaml`, and `PLANNING_API_URL` is blank, so an outbound sync pass reads
`_fetch` → `None` → `{"synced": False, "reason": "offline"}`. Nobody could perform the beat
any more; `_open_claimed_work_order` only made the staleness visible by changing what the
seed produces. The seed's own comment still described the toggle in confident detail, which
is the defect class this project treats as worse than no comment: a reader greps, finds it,
and goes looking for a control that does not exist.

So the beat was not preserved. The hero now claims `WO-2026-0858`, which **no** planning row
holds, and states `platform: EX90`. `_open_claimed_work_order` opens it at `embedded` and the
claim resolves in the same request, so the demo opens on:

- one campaign whose every field reads `embedded`/`ingestion`, beside five that read
  `api:planning` — the provenance contrast this whole registry is built to show;
- a hero that is `complete` on arrival, with `field_sources.work_order_id.source == "embedded"`;
- a `work_order.created` journal entry noting *"Opened by the run TAS-88214, which claimed
  it."*

It is a beat anyone can repeat on stage by uploading a trace, which the old one was not.

Consequences, each of which moved a pinned number:

| What moved | From | To | Why |
|---|---|---|---|
| `needs_attention.awaiting_work_order` (contract §B #1) | 1 | 0 | The hero was the cast's only amber run. Under this feature a claimed campaign always links, so the only way left to be amber is to claim nothing — and no seeded record does. Whether the demo still wants an amber row is a **cast decision for Buddy**, not a defect. |
| Work orders the seed *writes* | 5 mirrors | 5 mirrors + 1 opened | The registration writes the sixth, so the seed's printed report counts it (`seed()` diffs the collection across `write_runs`). |
| Filler campaigns | 37 | 36 | `DEMO_WORK_ORDER_COUNT` stays 42 and the cast now accounts for 6, so the filler pads with one fewer. |
| `VEHICLE_GROUPS` in `test_seed_final.py` | 36/21/19/18/17/17 | 43/37/20/19/5/4 | Fallout of the line above. `build_runs` derives a run's project from its campaign index with a stride of 7; 36 is a multiple of the three-member project pool, so every EX90 filler run lands on the first car of that fleet. Lopsided but not wrong. |

`DEMO_WORK_ORDER_COUNT` was **not** raised to 43, which would have kept the filler at 37 and
left the vehicle spread alone: `tests/factories_planning.py` and `api/api/stub_data.py`
(`VANITY_COUNTS`, `WORK_ORDERS_MIRRORED`) pad the *stub* cast to the same constant, and the
stub cast has no upload-opened campaign. Bumping it would have put the golden-contract cast
at 43 against a contract that says 42.

`SYNC_WORK_ORDER_ID` / `SYNC_DEFINITION_ID` survive with a new job: they are the one pair the
seed holds back from the mock's cast, so a sync pass in a test still has a row that visibly
arrives and the demo reset still has one to remove. `self_verify` no longer toggles anything
— it checks the opened campaign and the hero's link, then runs `demo_reset` and proves it
moved nothing, which is the scope guard that still matters because every top-up seed calls
that reset.

## Known follow-ups

- `api/docs/openapi.v1.json` needs regenerating (`api/scripts/snapshot.sh`) — one new model
  field. The contract-snapshot test is already red for `BL-25`; this adds to that refresh.
- Project `CLAUDE.md`'s ingestion-pipeline section still states that a run claiming an
  unknown work order keeps a retained claim. One line, plus the backlog regeneration for
  `BL-81`.
- The placeholder title cannot be renamed until `BL-35` ships an edit control.
- `api/tests_integration/test_stack.py` still stages the toggle beat
  (`test_the_toggle_beat_flips_and_restores_over_http`, `HERO_TOGGLE_WO`) and its
  `CONTRACT_NEEDS_ATTENTION` was already missing `orphaned_definitions` before this change.
  It needs a compose stack to run and is outside the `api/tests` gate, so it was left alone
  rather than rewritten blind.
- `frontend/e2e/trace-history.spec.ts` drives the same dead toggle (already noted under
  `BL-72`).
- The EX90 fleet spread in the demo cast is now carried by one car. Fixing it means changing
  how `filler.build_runs` picks a run's project, which moves every filler run's campaign — a
  cast decision, not a bug fix.
