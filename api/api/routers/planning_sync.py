"""Contract #20, #21 and the ★ trigger. Owner: Lane A."""

from typing import Annotated

from fastapi import APIRouter, Depends
from pymongo.database import Database

from api import planning_sync
from api.db import get_db
from api.models.planning import (
    PlanningPushRequest,
    PlanningPushResponse,
    PlanningSyncStatus,
    PlanningSyncToggleResponse,
    ToggleRequest,
)

router = APIRouter(tags=["planning-sync"])

PlanningDep = Annotated[planning_sync.PlanningClient, Depends(planning_sync.get_planning_client)]


@router.get("/planning-sync/status")
def get_sync_status(
    db: Annotated[Database, Depends(get_db)],
    planning: PlanningDep,
) -> PlanningSyncStatus:
    """Report the planning switch and what the last pass did."""
    return PlanningSyncStatus(**planning_sync.sync_status(db, planning))


@router.post("/planning-sync/toggle")
def toggle_sync(
    body: ToggleRequest,
    db: Annotated[Database, Depends(get_db)],
    planning: PlanningDep,
) -> PlanningSyncToggleResponse:
    """The demo control. It flips the planning switch and runs a real pass.

    Toggling **on** brings the planning system up and syncs, which fills the
    waiting runs and turns them green. Toggling **off** stops future syncs, and
    it deletes nothing.

    **Toggling off undid the sync until 20 Aug 2026.** A real registry never
    un-remembers, and that delete could not tell a row a person typed in from a
    No route resets now. The seed command line is the one reset, and a person
    runs it by name.

    Toggling to the current state is a no-op 200 and runs no second sync.
    "Current" means both the recorded switch AND the live system agree with the
    request — when they disagree (a re-seeded world, a restarted mock), the
    toggle proceeds and re-aligns them.
    """
    if (
        planning_sync.switch_state(db) == body.online
        and planning_sync.is_planning_online(planning) == body.online
    ):
        return PlanningSyncToggleResponse(**planning_sync.sync_status(db, planning))

    if body.online:
        try:
            # Quietly (wake: false, 25 Aug 2026): the toggle runs its own
            # full pass below, and the woken worker's immediate push would
            # RACE it — whichever pass ran second overwrote planning's
            # last_push with an empty one, and the strip read "0 links"
            # right after a successful adoption. The worker's 30 s cadence
            # continues while online regardless.
            planning.post("/admin/state", json={"online": True, "wake": False}, timeout=10.0)
        except Exception:  # noqa: BLE001 - an unreachable planning reads offline
            pass
    else:
        planning_sync.set_planning_online(planning, False)
    planning_sync.record_switch(db, body.online)

    if body.online:
        planning_sync.run_sync_pass(db, client=planning)
        try:
            # The push half too, explicitly: it is where an orphan claimed
            # pair is ADOPTED, and a presenter's toggle-on must link
            # everything linkable before it answers.
            planning.post("/admin/push/run", timeout=30.0)
        except Exception:  # noqa: BLE001 - the toggle's answer is the status
            pass

    return PlanningSyncToggleResponse(**planning_sync.sync_status(db, planning))


class PlanningSyncTriggerResult(PlanningSyncStatus):
    """The trigger's answer: the pull status, plus what planning's push did."""

    push: dict | None = None


@router.post("/planning-sync/trigger")
def trigger_sync(
    db: Annotated[Database, Depends(get_db)],
    planning: PlanningDep,
) -> PlanningSyncTriggerResult:
    """Run one FULL sync pass, whatever the switch says (★).

    The switch means "planning syncs continuously"; this route means "sync
    once, now" — one iteration of exactly what the online worker does. A pass
    is the pull (the registry mirrors planning's catalog and links what it
    can) and then planning's push — the half that ADOPTS an unknown claimed
    pair and fills the waiting runs, which the pull can never do because the
    catalog is planning's to grow (24 Aug 2026).

    While the switch is off planning declines both halves, and a Sync button
    that answers "nothing happened" reads as broken (observed the same day).
    So the trigger wakes planning for exactly this pass and puts the switch
    back afterwards — the recorded switch is never touched — and the answer
    carries the push outcome so the caller can narrate what actually changed.
    """
    was_online = planning_sync.is_planning_online(planning)
    if not was_online:
        try:
            # Quietly: `wake: false` skips planning's push-at-once, so the
            # adoption happens in — and is narrated by — THIS pass's push.
            planning.post("/admin/state", json={"online": True, "wake": False}, timeout=10.0)
        except Exception:  # noqa: BLE001 - an unreachable planning still pulls
            pass
    push: dict | None = None
    try:
        planning_sync.run_sync_pass(db, client=planning)
        try:
            push = planning.post("/admin/push/run", timeout=30.0).json()
        except Exception:  # noqa: BLE001 - the pull result must still answer
            push = None
    finally:
        if not was_online:
            try:
                # Restore ONLY while the recorded switch still says off: a
                # toggle-on that landed mid-pass owns the switch now, and
                # putting it back off left the worker silently dead under a
                # Home tile still reading on (found 25 Aug 2026). Same rule
                # heals a restarted mock: the recorded switch is the truth.
                if not planning_sync.switch_state(db):
                    planning_sync.set_planning_online(planning, False)
            except Exception:  # noqa: BLE001 - never fail the pass on restore
                pass
    return PlanningSyncTriggerResult(**planning_sync.sync_status(db, planning), push=push)


@router.post("/planning/sync")
def receive_planning_push(
    body: PlanningPushRequest,
    db: Annotated[Database, Depends(get_db)],
) -> PlanningPushResponse:
    """Take a planning push: its catalog, and the links it decided.

    PROPOSED addition, not yet in plans/API-CONTRACT.md — see
    plans/SECOND-WAVE-PROPOSAL.md.

    **This replaces the registry's outbound `run_sync_pass` fetch.** Arrows
    point INTO the Test Manager: it depends on nobody, so planning polls
    `GET /test-runs?status=awaiting_work_order` on its own timer, matches those
    runs against its own catalog — planning owns the decision of which runs
    fulfil its work orders — and posts the answer here. The fetch, the toggle
    and the trigger stay until the push is proven in the cloud; the internal
    backfill stays for good, as the idempotent safety net.

    The catalog mirrors through the same helpers the fetch used, and every link
    lands on the same provenance-aware write path the backfill uses: planning
    corrects an `embedded` claim from the ingestion pipeline and never
    overwrites a person's `manual` edit. Re-posting a link the run already
    holds writes nothing and journals nothing — it answers `links_unchanged`.

    A link naming a run the registry does not hold, or an id planning did not
    send in the same body, is refused with its reason rather than guessed at.
    Bearer auth comes from the `/api/v1` router, like every other write.
    """
    return PlanningPushResponse(
        **planning_sync.apply_planning_push(
            db,
            work_orders=_rows(body.work_orders),
            definitions=_rows(body.test_definitions),
            links=[link.model_dump() for link in body.links],
            requirements=_rows(body.requirements),
        )
    )


def _rows(models: list) -> list[dict]:
    """The catalog rows as planning sent them, for the mirror to store verbatim.

    `exclude_unset` keeps a key planning omitted out of the stored `raw`, and
    `mode="json"` hands `created_at` back as the ISO string the mirror's
    `_parse_when` reads — so a pushed row mirrors exactly like a fetched one.
    """
    return [model.model_dump(mode="json", exclude_unset=True) for model in models]
