"""The claim a run could not resolve is remembered, so planning repairs it later.

An unresolved claim used to survive only as prose inside a journal note, so a
run produced while planning did not yet know its work order could never be
linked automatically — not even after planning learned that id. The run now
keeps the claim in its own fields, and the next planning sync, pulled or
pushed, closes the loop.

The retained claim is NOT a link. It carries no authority, it never satisfies
the `awaiting_work_order` exit, and it never outranks a person.

BL-81 changed the WORK-ORDER half of this: a claim naming a campaign the
registry has never heard of no longer waits — `POST /test-runs` OPENS it, at
`embedded`, before `_resolve_claims` runs, so the claim resolves and links in
the same request (`queries_runs._open_claimed_work_order`). Retention for a
work-order claim can therefore only happen once the open itself is refused or
raced, which this file does not exercise. The DEFINITION half is untouched: a
definition is an authored test case, never minted, so an unknown one is still
remembered exactly as before.
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

# Not in the mirror and not in the mock's cast. Since BL-81, claiming this as
# a WORK ORDER no longer leaves it unknown: `_open_claimed_work_order` opens
# it on arrival, because the id is only ever echoed, never validated against
# a catalogue the registry does not keep.
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


# --- a work-order claim opens its campaign instead of waiting (BL-81) --------


def test_an_unresolved_work_order_claim_opens_the_work_order(client, routed_db) -> None:
    """Spec upload-opens-its-work-order §4.4 case 1, §6 blast radius."""
    body = _post(client, work_order_id=UNKNOWN_WO)

    assert body["work_order_id"] == UNKNOWN_WO
    assert body["claimed_work_order_id"] is None
    assert body["status"] == "complete"


def test_an_unresolved_definition_claim_is_retained_on_the_run(client, routed_db) -> None:
    body = _post(client, definition_id=UNKNOWN_TD)

    assert body["claimed_definition_id"] == UNKNOWN_TD
    assert body["definition_id"] is None


def test_a_claim_that_arrives_after_registration_opens_the_work_order(client, routed_db) -> None:
    """The run lands first, and the manifest states the id on a later call.
    The merge path opens the campaign too — a link, not a retained memory."""
    _post(client)
    body = _post(client, work_order_id=UNKNOWN_WO)

    assert body["work_order_id"] == UNKNOWN_WO
    assert body["claimed_work_order_id"] is None


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


def test_a_later_different_work_order_claim_opens_its_own_campaign(client, routed_db) -> None:
    """Two posts naming two different unknown ids each open their own
    campaign — the second claim links, it does not replace a memory."""
    _post(client, work_order_id=UNKNOWN_WO)
    body = _post(client, work_order_id=MOCK_WO)

    assert body["work_order_id"] == MOCK_WO
    assert routed_db["work_orders"].find_one({"_id": UNKNOWN_WO}) is not None
    assert routed_db["work_orders"].find_one({"_id": MOCK_WO}) is not None


def test_a_replayed_claim_opens_the_work_order_once(client, routed_db) -> None:
    """Retention must not turn the once-only unresolved event into a flood —
    and opening a campaign must not, either."""
    for _ in range(3):
        _post(client, work_order_id=UNKNOWN_WO)

    unresolved_events = routed_db["journal_entries"].count_documents(
        {"entity_id": RUN, "field": "run.work_order_claim_unresolved"}
    )
    created_events = routed_db["journal_entries"].count_documents(
        {"entity_type": "work_order", "entity_id": UNKNOWN_WO, "field": "work_order.created"}
    )
    assert unresolved_events == 0
    assert created_events == 1


# --- retention is never a link ------------------------------------------------


def test_an_opened_claim_now_answers_the_work_order_filter(client, routed_db) -> None:
    _post(client, work_order_id=UNKNOWN_WO)

    body = client.get("/api/v1/test-runs", params={"work_order": UNKNOWN_WO}).json()

    assert body["total"] == 1


def test_an_opened_work_order_populates_lineage_while_the_definition_stays_null(
    client, routed_db
) -> None:
    """The work-order block fills the moment the claim opens its campaign.
    The definition is never minted, so that block still waits for a person."""
    routed_db["work_orders"].insert_one(make_work_order(wo_id=UNKNOWN_WO))
    _post(client, work_order_id=UNKNOWN_WO, definition_id=UNKNOWN_TD)

    body = client.get(f"/api/v1/test-runs/{RUN}/lineage").json()

    assert body["work_order"] is not None
    assert body["work_order"]["wo_id"] == UNKNOWN_WO
    assert body["definition"] is None


def test_an_opened_claim_leaves_the_awaiting_work_order_list(client, routed_db) -> None:
    """The run that used to wait in this list now links on arrival."""
    _post(client, work_order_id=UNKNOWN_WO)

    body = client.get("/api/v1/test-runs", params={"status": "awaiting_work_order"}).json()

    assert body["items"] == []
    assert body["view_counts"]["attention"] == 0


def test_an_opened_claim_counts_towards_its_own_work_order_only(client, routed_db) -> None:
    """The work-order screen counts links. A different campaign is untouched;
    the one this run opened and claimed now holds it."""
    routed_db["work_orders"].insert_one(make_work_order(wo_id=OTHER_WO))
    _post(client, work_order_id=UNKNOWN_WO)

    other = client.get(f"/api/v1/work-orders/{OTHER_WO}").json()
    opened = client.get(f"/api/v1/work-orders/{UNKNOWN_WO}").json()

    assert other["runs"] == []
    assert [run["run_id"] for run in opened["runs"]] == [RUN]


# --- the loop closes: the internal pass ---------------------------------------


def test_the_upload_links_the_run_before_any_sync_pass_runs(
    client, routed_db, online_planning
) -> None:
    """The run links itself the moment it claims an unknown campaign
    (§3.1). A later sync pass finds nothing left to repair: the run is no
    longer `waiting` by `_link_retained_claims`'s own selector, exactly as an
    ordinary resolved claim is never re-pointed by a later sync
    (test_runs_link_claims.py::test_a_resolved_claim_is_not_reassigned_by_the_sync)."""
    _post(client, work_order_id=MOCK_WO)
    opened = routed_db["test_runs"].find_one({"_id": RUN})
    assert opened["work_order_id"] == MOCK_WO
    assert opened["status"] == "complete"
    assert opened["field_sources"]["work_order_id"]["source"] == "embedded"

    planning_sync.run_sync_pass(routed_db, client=online_planning)

    run = routed_db["test_runs"].find_one({"_id": RUN})
    assert run["work_order_id"] == MOCK_WO
    assert run["status"] == "complete"
    assert run["field_sources"]["work_order_id"]["source"] == "embedded"


def test_a_mirrored_definition_links_the_run_and_carries_its_work_order(
    client, routed_db, online_planning
) -> None:
    """A definition claim is the richer one: it names the work order too."""
    _post(client, definition_id=MOCK_TD)

    planning_sync.run_sync_pass(routed_db, client=online_planning)

    run = routed_db["test_runs"].find_one({"_id": RUN})
    assert run["definition_ids"] == [MOCK_TD]
    assert run["work_order_id"] == MOCK_WO
    assert run["project"] == "EX90"


def test_the_opened_claim_journals_exactly_one_link_entry(
    client, routed_db, online_planning
) -> None:
    """A claim resolved on the merge path (the run already existed) journals
    its link once, at `embedded`. A later sync pass finds no hole left to
    repair — the run is no longer `waiting` by `_link_retained_claims`'s own
    selector, so it journals no second entry."""
    _post(client)  # the run lands first, with no claim
    _post(client, work_order_id=MOCK_WO)  # BL-81 opens MOCK_WO; the merge links it

    planning_sync.run_sync_pass(routed_db, client=online_planning)

    entries = list(routed_db["journal_entries"].find({"entity_id": RUN, "field": "run.work_order"}))
    assert len(entries) == 1
    assert entries[0]["source"] == "embedded"
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


def test_a_claim_naming_nothing_planning_knows_still_opens_its_own_campaign(
    client, routed_db, online_planning
) -> None:
    """A claim naming an id planning never sends now opens its own campaign
    instead of waiting for one — the sync pass has nothing left to add."""
    _post(client, work_order_id=UNKNOWN_WO)

    planning_sync.run_sync_pass(routed_db, client=online_planning)

    run = routed_db["test_runs"].find_one({"_id": RUN})
    assert run["work_order_id"] == UNKNOWN_WO
    assert run["claimed_work_order_id"] is None
    assert run["field_sources"]["work_order_id"]["source"] == "embedded"


# --- the loop closes: the pushed pass -----------------------------------------


def test_the_pushed_sync_finds_nothing_left_to_link(client, routed_db) -> None:
    """The claim already opened and linked its own campaign, so the pushed
    catalogue closes no hole and `links_applied` is zero."""
    _post(client, work_order_id=MOCK_WO)

    response = _push(client)

    run = routed_db["test_runs"].find_one({"_id": RUN})
    assert run["work_order_id"] == MOCK_WO
    assert run["field_sources"]["work_order_id"]["source"] == "embedded"
    assert response.json()["links_applied"] == 0


def test_the_pushed_sync_links_a_run_by_its_retained_definition_claim(client, routed_db) -> None:
    _post(client, definition_id=MOCK_TD)

    _push(client)

    run = routed_db["test_runs"].find_one({"_id": RUN})
    assert run["definition_ids"] == [MOCK_TD]
    assert run["work_order_id"] == MOCK_WO


def test_a_repeated_push_writes_nothing_once_the_claim_already_opened_its_campaign(
    client, routed_db
) -> None:
    _post(client, work_order_id=MOCK_WO)
    _push(client)
    before = routed_db["test_runs"].find_one({"_id": RUN})

    body = _push(client).json()

    assert body["links_applied"] == 0
    assert routed_db["test_runs"].find_one({"_id": RUN}) == before


# --- retention never outranks anybody ------------------------------------------


def test_a_retained_claim_never_overwrites_a_manual_link(client, routed_db) -> None:
    """A person outranks planning, and an opened claim is weaker than either.

    `MOCK_WO` is unknown at post time, so BL-81 opens it at `embedded` — the
    weakest rank — and the manual PATCH below still outranks it exactly as it
    outranked a retained claim before."""
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


def test_a_planning_link_wins_over_the_opened_claim(client, routed_db) -> None:
    """Planning decides which runs fulfill its work orders. The bench guesses.

    `MOCK_WO` opens itself at `embedded` on the post below; the explicit
    planning link (`api:planning`) still outranks it, exactly as it
    outranked a retained claim before."""
    routed_db["work_orders"].insert_one(make_work_order(wo_id=OTHER_WO, project="EC40"))
    _post(client, work_order_id=MOCK_WO)

    _push(
        client,
        work_orders=[WORK_ORDER_ROW, {"id": OTHER_WO, "title": "e-machine", "project": "EC40"}],
        links=[{"run_id": RUN, "work_order_id": OTHER_WO, "definition_id": None}],
    )

    run = routed_db["test_runs"].find_one({"_id": RUN})
    assert run["work_order_id"] == OTHER_WO


def test_a_run_linked_by_planning_is_never_re_pointed_by_an_old_claim(client, routed_db) -> None:
    """A repair only fills a hole. It never corrects a link planning owns.

    Built directly in the database, bypassing `POST /test-runs` — BL-81's
    `_open_claimed_work_order` runs only inside that route, so this scenario
    is unaffected by it."""
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
