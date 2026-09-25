"""BL-72 regression — `create_work_order` closes no retained claim.

`POST /work-orders` (`create_work_order`, `api/api/services/queries_runs.py:1852`)
is the manual door for a campaign planning never knew about. Its own docstring
says: "A run that claimed this id before it existed is NOT linked here.
`planning_sync._write_link` is the one write path for a run's work-order
link, and `_link_retained_claims` closes the claim on the next sync pass."

That "next sync pass" no longer happens on its own: `run_sync_pass`'s only
caller was the Planning Sync Mock's push worker, removed at `38ecd12`, and
`_link_retained_claims`'s other caller sits inside the inbound
`POST /planning/sync` receive path, which fires only when something posts to
it. A person who opens a work order by hand today leaves every run that
claimed that id amber indefinitely — the loop the docstring promises does
not close on its own.
"""

from tests.factories_planning import make_run

RUN = "TAS-96001"
WO = "WO-2026-0910"


def _seed_waiting_run(db) -> None:
    """A run that claimed WO before it existed — the seed's hero-run shape."""
    db["test_runs"].insert_one(
        make_run(
            run_id=RUN,
            work_order_id=None,
            definition_id=None,
            project=None,
            status="awaiting_work_order",
            claimed_work_order_id=WO,
            claimed_definition_id=None,
            field_sources={},
        )
    )


def test_opening_a_work_order_by_hand_closes_a_run_s_retained_claim(client, routed_db) -> None:
    """Validates the `create_work_order` docstring's own promise
    (`queries_runs.py:1862-1864`): a run that claimed this id before it
    existed should be linked once the work order exists here, the same close
    `_link_retained_claims` performs on a sync pass.
    """
    _seed_waiting_run(routed_db)

    response = client.post(
        "/api/v1/work-orders",
        json={"wo_id": WO, "title": "Bench campaign nobody planned", "project": "EX90"},
    )

    assert response.status_code == 201
    run = routed_db["test_runs"].find_one({"_id": RUN})
    assert run["work_order_id"] == WO, (
        "the run's retained claim was never closed by create_work_order; "
        f"work_order_id is still {run['work_order_id']!r}"
    )


def test_planning_sync_still_closes_the_same_claim(client, routed_db) -> None:
    """The surviving route: `POST /planning/sync`
    (`planning_sync.apply_planning_push` -> `_link_retained_claims`,
    `planning_sync.py:784`) still closes a retained claim. Guards a fix to
    `create_work_order` against breaking this path.
    """
    _seed_waiting_run(routed_db)

    response = client.post(
        "/api/v1/planning/sync",
        json={
            "work_orders": [{"id": WO, "title": "Bench campaign", "project": "EX90"}],
            "test_definitions": [],
            "links": [],
        },
    )

    assert response.status_code == 200
    run = routed_db["test_runs"].find_one({"_id": RUN})
    assert run["work_order_id"] == WO
