"""The claim a run could not resolve is remembered, so planning repairs it later.

An unresolved claim used to survive only as prose inside a journal note, so a
run produced while planning did not yet know its work order could never be
linked automatically — not even after planning learned that id. The run now
keeps the claim in its own fields, and the next planning sync, pulled or
pushed, closes the loop.

The retained claim is NOT a link. It carries no authority, it never satisfies
the `awaiting_work_order` exit, and it never outranks a person.
"""

from datetime import UTC, datetime

import pytest

from api import planning_sync
from tests.factories_planning import make_run, make_work_order

RUN = "TAS-95001"

# The planning mock's cast, mirrored by a sync pass. No definition names this
# run in its `run_ids`, so only the retained claim can ever link it.
MOCK_WO = "WO-2026-0853"
MOCK_TD = "TD-RLD-301"

# Not in the mirror and not in the mock's cast.
UNKNOWN_WO = "WO-2026-9999"
UNKNOWN_TD = "TD-NOPE-001"

OTHER_WO = "WO-2026-0847"

WORK_ORDER_ROW = {
    "id": MOCK_WO,
    "title": "Road-load correlation",
    "project": "EX90",
    "status": "active",
}
DEFINITION_ROW = {
    "id": MOCK_TD,
    "work_order_id": MOCK_WO,
    "title": "Road-load coastdown",
    "planned_runs": 6,
}


def _post(client, **overrides) -> dict:
    body = {"run_id": RUN, "rig_id": "RIG-04"}
    body.update(overrides)
    return client.post("/api/v1/test-runs", json=body).json()


def _push(client, links=None, work_orders=None, definitions=None):
    return client.post(
        "/api/v1/planning/sync",
        json={
            "work_orders": [WORK_ORDER_ROW] if work_orders is None else work_orders,
            "test_definitions": [DEFINITION_ROW] if definitions is None else definitions,
            "links": [] if links is None else links,
        },
    )


@pytest.fixture
def online_planning(planning_offline):
    """The planning mock, switched on, so a sync pass mirrors its cast."""
    planning_offline.post("/admin/state", json={"online": True})
    return planning_offline


# --- the claim is remembered --------------------------------------------------


def test_an_unresolved_work_order_claim_is_retained_on_the_run(client, routed_db) -> None:
    body = _post(client, work_order_id=UNKNOWN_WO)

    assert body["claimed_work_order_id"] == UNKNOWN_WO
    assert body["work_order_id"] is None
    assert body["status"] == "awaiting_work_order"


def test_an_unresolved_definition_claim_is_retained_on_the_run(client, routed_db) -> None:
    body = _post(client, definition_id=UNKNOWN_TD)

    assert body["claimed_definition_id"] == UNKNOWN_TD
    assert body["definition_id"] is None


def test_a_claim_that_arrives_after_registration_is_retained(client, routed_db) -> None:
    """The run lands first, and the manifest states the id on a later call."""
    _post(client)
    body = _post(client, work_order_id=UNKNOWN_WO)

    assert body["claimed_work_order_id"] == UNKNOWN_WO


def test_a_resolved_claim_remembers_nothing(client, routed_db) -> None:
    """Only the claim the registry could NOT honour needs remembering."""
    routed_db["work_orders"].insert_one(make_work_order(wo_id=OTHER_WO, project="EX90"))

    body = _post(client, work_order_id=OTHER_WO)

    assert body["work_order_id"] == OTHER_WO
    assert body["claimed_work_order_id"] is None


def test_a_run_without_a_claim_remembers_nothing(client, routed_db) -> None:
    body = _post(client)

    assert body["claimed_work_order_id"] is None
    assert body["claimed_definition_id"] is None


def test_a_later_claim_replaces_the_remembered_one(client, routed_db) -> None:
    """The bench's latest word is the one the repair should act on."""
    _post(client, work_order_id=UNKNOWN_WO)
    body = _post(client, work_order_id=MOCK_WO)

    assert body["claimed_work_order_id"] == MOCK_WO


def test_a_replayed_claim_still_journals_once(client, routed_db) -> None:
    """Retention must not turn the once-only unresolved event into a flood."""
    for _ in range(3):
        _post(client, work_order_id=UNKNOWN_WO)

    events = routed_db["journal_entries"].count_documents(
        {"entity_id": RUN, "field": "run.work_order_claim_unresolved"}
    )
    assert events == 1


# --- retention is never a link ------------------------------------------------


def test_a_retained_claim_does_not_answer_the_work_order_filter(client, routed_db) -> None:
    _post(client, work_order_id=UNKNOWN_WO)

    body = client.get("/api/v1/test-runs", params={"work_order": UNKNOWN_WO}).json()

    assert body["total"] == 0


def test_a_retained_claim_leaves_the_lineage_chain_empty(client, routed_db) -> None:
    """The blocks above an unsynced run stay null — the amber state."""
    routed_db["work_orders"].insert_one(make_work_order(wo_id=UNKNOWN_WO))
    _post(client, work_order_id=UNKNOWN_TD)

    body = client.get(f"/api/v1/test-runs/{RUN}/lineage").json()

    assert body["work_order"] is None
    assert body["definition"] is None


def test_a_retained_claim_keeps_the_run_in_the_waiting_list(client, routed_db) -> None:
    """The run planning must still be told about stays in the orphan list."""
    _post(client, work_order_id=UNKNOWN_WO)

    body = client.get(
        "/api/v1/test-runs", params={"status": "awaiting_work_order"}
    ).json()

    assert [item["run_id"] for item in body["items"]] == [RUN]
    assert body["view_counts"]["attention"] == 1


def test_a_retained_claim_never_counts_towards_a_work_order(client, routed_db) -> None:
    """The work-order screen counts links, and a claim is not one."""
    routed_db["work_orders"].insert_one(make_work_order(wo_id=OTHER_WO))
    _post(client, work_order_id=UNKNOWN_WO)

    body = client.get(f"/api/v1/work-orders/{OTHER_WO}").json()

    assert body["runs"] == []


# --- the loop closes: the internal pass ---------------------------------------


def test_a_mirrored_work_order_links_the_run_that_claimed_it(
    client, routed_db, online_planning
) -> None:
    _post(client, work_order_id=MOCK_WO)
    assert routed_db["test_runs"].find_one({"_id": RUN})["work_order_id"] is None

    planning_sync.run_sync_pass(routed_db, client=online_planning)

    run = routed_db["test_runs"].find_one({"_id": RUN})
    assert run["work_order_id"] == MOCK_WO
    assert run["status"] == "complete"
    assert run["field_sources"]["work_order_id"]["source"] == "api:planning"


def test_a_mirrored_definition_links_the_run_and_carries_its_work_order(
    client, routed_db, online_planning
) -> None:
    """A definition claim is the richer one: it names the work order too."""
    _post(client, definition_id=MOCK_TD)

    planning_sync.run_sync_pass(routed_db, client=online_planning)

    run = routed_db["test_runs"].find_one({"_id": RUN})
    assert run["definition_id"] == MOCK_TD
    assert run["work_order_id"] == MOCK_WO
    assert run["project"] == "EX90"


def test_the_repair_journals_the_link_with_the_existing_vocabulary(
    client, routed_db, online_planning
) -> None:
    _post(client, work_order_id=MOCK_WO)

    planning_sync.run_sync_pass(routed_db, client=online_planning)

    entries = list(
        routed_db["journal_entries"].find({"entity_id": RUN, "field": "run.work_order"})
    )
    assert len(entries) == 1
    assert entries[0]["source"] == "api:planning"
    assert entries[0]["new"] == MOCK_WO


def test_a_second_pass_over_a_repaired_run_writes_nothing(
    client, routed_db, online_planning
) -> None:
    _post(client, work_order_id=MOCK_WO)
    planning_sync.run_sync_pass(routed_db, client=online_planning)
    before = routed_db["test_runs"].find_one({"_id": RUN})
    entries = routed_db["journal_entries"].count_documents({})

    planning_sync.run_sync_pass(routed_db, client=online_planning)

    assert routed_db["test_runs"].find_one({"_id": RUN}) == before
    assert routed_db["journal_entries"].count_documents({}) == entries


def test_a_claim_the_mirror_still_does_not_hold_links_nothing(
    client, routed_db, online_planning
) -> None:
    """A claim naming nothing planning knows stays amber, which is normal."""
    _post(client, work_order_id=UNKNOWN_WO)

    planning_sync.run_sync_pass(routed_db, client=online_planning)

    run = routed_db["test_runs"].find_one({"_id": RUN})
    assert run["work_order_id"] is None
    assert run["claimed_work_order_id"] == UNKNOWN_WO


# --- the loop closes: the pushed pass -----------------------------------------


def test_the_pushed_sync_links_a_run_by_its_retained_claim(client, routed_db) -> None:
    """Planning sends its catalog and no link for this run. The claim is enough."""
    _post(client, work_order_id=MOCK_WO)

    response = _push(client)

    run = routed_db["test_runs"].find_one({"_id": RUN})
    assert run["work_order_id"] == MOCK_WO
    assert run["project"] == "EX90"
    assert run["field_sources"]["work_order_id"]["source"] == "api:planning"
    assert response.json()["links_applied"] == 1


def test_the_pushed_sync_links_a_run_by_its_retained_definition_claim(
    client, routed_db
) -> None:
    _post(client, definition_id=MOCK_TD)

    _push(client)

    run = routed_db["test_runs"].find_one({"_id": RUN})
    assert run["definition_id"] == MOCK_TD
    assert run["work_order_id"] == MOCK_WO


def test_a_repeated_push_over_a_repaired_run_writes_nothing(client, routed_db) -> None:
    _post(client, work_order_id=MOCK_WO)
    _push(client)
    before = routed_db["test_runs"].find_one({"_id": RUN})

    body = _push(client).json()

    assert body["links_applied"] == 0
    assert routed_db["test_runs"].find_one({"_id": RUN}) == before


# --- retention never outranks anybody ------------------------------------------


def test_a_retained_claim_never_overwrites_a_manual_link(client, routed_db) -> None:
    """A person outranks planning, and a claim is weaker than either."""
    _post(client, work_order_id=MOCK_WO)
    routed_db["work_orders"].insert_one(make_work_order(wo_id=OTHER_WO, project="EC40"))
    client.patch(
        f"/api/v1/test-runs/{RUN}",
        json={"work_order_id": OTHER_WO, "actor": "a.bergstrom"},
    )

    _push(client)

    run = routed_db["test_runs"].find_one({"_id": RUN})
    assert run["work_order_id"] == OTHER_WO
    assert run["field_sources"]["work_order_id"]["source"] == "manual"


def test_a_planning_link_wins_over_the_retained_claim(client, routed_db) -> None:
    """Planning decides which runs fulfill its work orders. The bench guesses."""
    routed_db["work_orders"].insert_one(make_work_order(wo_id=OTHER_WO, project="EC40"))
    _post(client, work_order_id=MOCK_WO)

    _push(
        client,
        work_orders=[WORK_ORDER_ROW, {"id": OTHER_WO, "title": "e-machine", "project": "EC40"}],
        links=[{"run_id": RUN, "work_order_id": OTHER_WO, "definition_id": None}],
    )

    run = routed_db["test_runs"].find_one({"_id": RUN})
    assert run["work_order_id"] == OTHER_WO


def test_a_run_linked_by_planning_is_never_re_pointed_by_an_old_claim(
    client, routed_db
) -> None:
    """A repair only fills a hole. It never corrects a link planning owns."""
    routed_db["test_runs"].insert_one(
        make_run(
            run_id=RUN,
            work_order_id=OTHER_WO,
            definition_id=None,
            status="complete",
            claimed_work_order_id=MOCK_WO,
            field_sources={
                "work_order_id": {
                    "source": "api:planning",
                    "actor": "planning-sync",
                    "at": datetime.now(UTC),
                }
            },
        )
    )

    _push(client)

    assert routed_db["test_runs"].find_one({"_id": RUN})["work_order_id"] == OTHER_WO
