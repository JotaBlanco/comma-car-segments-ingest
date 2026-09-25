# Work-order lifecycle: open, close, delete

## What this is

Until now a work order could only arrive through `POST /api/v1/planning/sync`. There was no
route to create one, none to change its status, and the delete route (`5534127`) had no control
on any screen. A person who uploaded a trace declaring a work order the mirror did not hold got
a run stuck at `awaiting_work_order` and no way forward inside the Test Manager.

Three writes now live on `api/api/routers/work_orders.py`:

| Route | Refusals | Provenance |
|---|---|---|
| `POST /api/v1/work-orders` | 409 `wo_exists` | `manual` |
| `PATCH /api/v1/work-orders/{wo_id}` | 404 `wo_not_found` | `manual` |
| `DELETE /api/v1/work-orders/{wo_id}` | 404 `wo_not_found`, 409 `work_order_has_runs` | unchanged |

`WorkOrderStatus` is still `Literal["active", "closed"]`. `closed` is the inactive state; there
is no `obsolete` member and no status state machine.

## Why it is shaped this way

**The mirror rule splits in two, it does not fall.** Planning still owns the *content* of the
campaigns it pushes — title, project, requestor — and no route edits those in place. What
changed is that a work order no longer has to come *from* planning, and its *status* is a
decision a person makes. Every comment, docstring, panel head and page subtitle that claimed
"read-only mirror / never editable here" was rewritten to say exactly that split.

**The status is written through `provenance.set_field` at `Source.MANUAL`**, the same path
`queries_requirements.patch_requirement` uses. The stored value carries the `manual` tag and the
journal gains a `work_order.status` change entry with the old value, the new value and the
caller's Portal name. A PATCH that states the status already stored writes nothing and journals
nothing — the idempotency rule `_mirror_journal` and `_write_link` already hold.

**The actor comes from the token, never from the body.** `WorkOrderStatusRequest` names `status`
and nothing else; `extra="forbid"` turns any content key into a 422. The route reads
`journal_actor_or_id(identity, identity.display_name)`, which is what `DELETE` on the same
entity already did, so one actor rule covers all three writes.

**A created row is not a planning row.** `create_work_order` writes `title`, `project` and
`status` at `manual`, and stores `synced_at: None`, `mirrored_at: None`, `raw: None`. The absent
`mirrored_at` keeps it out of the demo reset's delete scope (`planning_sync._reset` removes rows
with `mirrored_at > watermark`), exactly as a manual requirement stays out of it.

**`origin` is derived, never stored twice.** `WorkOrderRow` and `WorkOrderDetail` gained
`origin`, read at request time off `field_sources.title.source` and defaulting to `api:planning`
for rows written before the mirror tagged anything. The screens badged `api:planning`
statically on every row and in the metadata panel head; on a manually opened campaign that
badge was simply false. Deriving one field was cheaper than exposing the whole `field_sources`
map, which the work-order contract deliberately does not carry.

**`synced_at` became nullable** on both models, because a row opened here synced from nowhere.
The detail screen renders `—` for it and replaces the lock line with "Opened in the Test
Manager — no planning system knows this campaign."

## Ingest does NOT create a work order

A run that claims a `work_order_id` the mirror does not hold still resolves to nothing:
`queries_runs._resolve_claims` leaves the link unwritten, `_retained_claims` remembers the id in
`claimed_work_order_id`, and the run reads `awaiting_work_order` until
`planning_sync._link_retained_claims` closes the loop on a later sync pass. That path is
untouched. Three reasons:

1. **A claim is not an authority.** The id in an MF4 HD comment is a string a bench typed. Minting
   a campaign from it means a typo creates a campaign, and `work_order_has_runs` then refuses to
   delete the phantom for as long as the run exists — the typo would be permanent, closable but
   not removable.
2. **It would not have fixed the incident that prompted it.** The trace declaring
   `WO-BAT-2026-002` registered on run `TAS-1001`, which already carries `WO-BAT-2026-001` at
   `api:planning` provenance. An ingest-created work order would be written at `embedded`
   (rank 0), and `provenance.blocks` refuses a rank-0 write over a rank-1 value, so the run's
   link would not have moved. The result would be an empty phantom campaign plus the original
   disagreement.
3. **The hole it filled is now filled properly.** The reason auto-creation looked necessary was
   that a person had no way to open a work order. They have one now, and the retained claim is
   repaired by the existing repair path once the id exists.

Consequence to know about: after a person opens the work order, the waiting run links itself on
the **next planning sync pass**, not on the create call. `planning_sync._write_link` is the one
write path for a run's work-order link and it is not reachable from the create without a
circular import; a second write path for the same field is a worse trade than a sync interval of
delay. The journal note that repair writes reads "Linked by planning — the run claimed X, now
mirrored", which is inaccurate for a manually opened campaign.

## Known gap: a manual status on a *mirrored* work order does not survive a sync

`planning_sync._write_mirror` sets every field planning names with
`$set: {**values, **mirror_tags(values, ...)}` and performs **no precedence check** — unlike the
requirements mirror, which routes each field through `set_field` and is therefore blocked by a
stored `manual` tag. So on a work order planning also sends, the next pass rewrites both the
status and its source tag.

Concretely: `battery-trace-gen/seed/planning_payload.py:28` states `WORK_ORDER_STATUS = "active"`,
so `python -m seed all` reopens a closed `WO-BAT-2026-001`. A campaign **opened here** is never
in a planning payload, so its status stands.

The status control says this rather than promising otherwise: *"The status you set here is
yours, stored under your name — until a planning sync states a status of its own."* The fix, if
the mirror rule is allowed to move, is one clause in `_write_mirror` that drops a field whose
stored source outranks `Source.API_PLANNING`.

## Data flow

```
person → New work order dialog
           └─ POST /work-orders {wo_id,title,project}
                └─ queries_runs.create_work_order
                     ├─ 409 wo_exists when the id is taken
                     ├─ set_field × 3 @ manual  →  work_orders doc (+field_sources)
                     └─ add_event work_order.created  →  journal_entries
                        (a run holding claimed_work_order_id=<id> links on the next sync pass)

person → status select on the detail page
           └─ PATCH /work-orders/{id} {status}
                └─ queries_runs.set_work_order_status
                     ├─ 404 wo_not_found
                     ├─ unchanged status → no write, no journal entry
                     └─ set_field @ manual → work_orders.status + journal work_order.status

person → Delete work order → typed "delete"
           └─ DELETE /work-orders/{id}
                ├─ 409 work_order_has_runs → the dialog renders the count and offers closing
                └─ 200 → definitions cascade, journal keeps everything, screen routes to /work-orders
```

## File inventory

**API**

- `api/api/routers/work_orders.py` — `POST /work-orders` (201) and `PATCH /work-orders/{wo_id}`;
  module docstring rewritten from "deleted, never edited" to the content/status split.
- `api/api/services/queries_runs.py` — `create_work_order`, `set_work_order_status`,
  `work_order_origin`; `origin` added to the list items and the detail.
- `api/api/models/planning.py` — `WorkOrderCreateRequest`, `WorkOrderStatusRequest`; `origin` and
  nullable `synced_at` on `WorkOrderRow` and `WorkOrderDetail`.
- `api/api/main.py` — `ROUTE_ERRORS` entries for the two new routes.
- `api/tests/test_work_orders.py` — the 405 assertion narrowed to `PUT` (POST and PATCH now
  exist); module docstring corrected.

**Frontend**

- `frontend/types/work-order.ts` — `WorkOrderCreateBody`, `WorkOrderStatusBody`,
  `WorkOrderDeletionReport`, `origin?`, nullable `synced_at`.
- `frontend/lib/api/workOrders.ts` — `create`, `setStatus`, `remove`.
- `frontend/lib/hooks/use-work-orders.ts` — `useCreateWorkOrder`, `useSetWorkOrderStatus`,
  `useDeleteWorkOrder`.
- `frontend/components/screens/work-orders/add-work-order-dialog.tsx` — new.
- `frontend/components/screens/work-orders/work-order-status-control.tsx` — new.
- `frontend/components/screens/work-orders/delete-work-order-dialog.tsx` — new; reuses
  `CONFIRM_WORD` and `DESTRUCTIVE_CLASS` from `screens/runs/delete-runs-dialog`.
- `frontend/components/screens/work-orders/work-orders-screen.tsx` — "New work order" button,
  per-row badge from `origin`, header subtitle corrected.
- `frontend/components/screens/work-orders/work-order-detail-screen.tsx` — status control,
  delete control, badge from `origin`, null `synced_at`, corrected copy.

## Cache invalidation

`keys.workOrders.all` covers the list, its `view_counts`, the facets, the detail and the
work-order journal panel (which hangs under the detail key). On top of that: `keys.journal.all`
on every write, because all three journal; `keys.home` on create and delete, which move the
work-order count; `keys.testDefinitions.all` on delete, because the definitions cascade. No run
list is invalidated on delete — a work order holding runs cannot be deleted.

## Neighbours

- `docs/architecture-requirements-page.md` — the authored-write shape this follows (`set_field`,
  journal entry, named refusals, `manual` beats `api:planning`).
- `CLAUDE.md` "Ingestion pipeline" — the run-id ladder and the claim resolution this deliberately
  leaves alone.
- Backlog `BL-25` — `api/docs/openapi.v1.json` was already stale and its contract test already
  red. This change adds drift: two routes, two request models, and `origin` / nullable
  `synced_at` on two response models.
