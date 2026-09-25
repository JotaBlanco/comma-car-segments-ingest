"""POST /test-runs — the work-order and definition claims (INGEST-SPLIT §4.2a).

The ingestion pipeline states the ids its manifest carries. Planning stays the
owner of both fields. So a claim resolves against the planning mirror, it
carries the `embedded` tag, and an unknown id refuses nothing.

Since BL-81 (`dev-planning/upload-opens-its-work-order/spec.md`), an unknown
WORK ORDER no longer links nothing: `_open_claimed_work_order` opens it before
the claim resolves, so it always links. A definition is an authored test case
and is never minted, so an unknown definition still links nothing — the
scenarios this file keeps under "the claim never blocks ingestion" now cover
that half alone; the opening behaviour has its own file,
`test_upload_opens_work_order.py`.
"""

import pytest

from api import planning_sync
from tests.factories_planning import make_definition, make_work_order

RUN = "TAS-95001"
KNOWN_WO = "WO-2026-0847"
KNOWN_TD = "TD-BAT-114"
UNKNOWN_WO = "WO-2026-9999"
UNKNOWN_TD = "TD-NOPE-001"

# The planning mock's own cast. The sync pass mirrors it and the backfill
# points the hero run at this work order.
MOCK_HERO_RUN = "TAS-88214"
MOCK_HERO_WO = "WO-2026-0851"


def _post(client, **overrides) -> tuple[int, dict]:
    body = {"run_id": RUN, "rig_id": "RIG-04"}
    body.update(overrides)
    response = client.post("/api/v1/test-runs", json=body)
    return response.status_code, response.json()


def _events(db, run_id: str, field: str) -> list[dict]:
    return list(
        db["journal_entries"].find({"entity_type": "run", "entity_id": run_id, "field": field})
    )


@pytest.fixture
def mirror(routed_db):
    """The planning mirror, holding one work order and one definition."""
    routed_db["work_orders"].insert_one(make_work_order(wo_id=KNOWN_WO, project="EX90"))
    routed_db["test_definitions"].insert_one(make_definition(td_id=KNOWN_TD))
    return routed_db


# --- the claim resolves ------------------------------------------------------


def test_a_claimed_work_order_links_the_run_when_the_mirror_holds_it(client, mirror) -> None:
    status, body = _post(client, work_order_id=KNOWN_WO)

    assert status == 201
    assert body["work_order_id"] == KNOWN_WO
    assert body["status"] == "complete"


def test_a_claimed_definition_links_the_run_when_the_mirror_holds_it(client, mirror) -> None:
    _status, body = _post(client, definition_id=KNOWN_TD)

    assert body["definition_id"] == KNOWN_TD


def test_a_resolved_work_order_claim_copies_the_project_from_the_mirror(client, mirror) -> None:
    """`project` stays out of the body. It comes from the mirrored work order."""
    _status, body = _post(client, work_order_id=KNOWN_WO)

    assert body["project"] == "EX90"
    assert body["field_sources"]["project"]["source"] == "embedded"


def test_a_claim_that_arrives_later_links_the_stored_run(client, mirror) -> None:
    """The run lands first and the context joins when it is available."""
    _post(client)
    status, body = _post(client, work_order_id=KNOWN_WO)

    assert status == 200
    assert body["work_order_id"] == KNOWN_WO


# --- the claim never masters planning ---------------------------------------


def test_a_claim_writes_the_embedded_tag_even_when_the_body_states_a_planning_source(
    client, mirror
) -> None:
    """The pipeline states the id. It never states the authority."""
    _status, body = _post(client, work_order_id=KNOWN_WO, source="api:planning")

    assert body["field_sources"]["work_order_id"]["source"] == "embedded"


def test_a_resolved_claim_is_not_reassigned_by_the_sync(client, routed_db, planning_client) -> None:
    """Pair-only planning (24 Aug 2026): planning holds no plan of run ids,
    so the sync has no ground to move a link the data itself resolved — the
    run said which work order it ran under, and nobody knows better. (Until
    24 Aug the pull corrected this from a run-id plan; correction now needs a
    person, via PATCH.)"""
    routed_db["work_orders"].insert_one(make_work_order(wo_id=KNOWN_WO))
    body = {"run_id": MOCK_HERO_RUN, "rig_id": "RIG-04", "work_order_id": KNOWN_WO}
    client.post("/api/v1/test-runs", json=body)
    assert routed_db["test_runs"].find_one({"_id": MOCK_HERO_RUN})["work_order_id"] == KNOWN_WO

    planning_client.post("/admin/reset")
    planning_client.post("/admin/state", json={"online": True})
    planning_sync.run_sync_pass(routed_db, client=planning_client)

    run = routed_db["test_runs"].find_one({"_id": MOCK_HERO_RUN})
    assert run["work_order_id"] == KNOWN_WO
    assert run["field_sources"]["work_order_id"]["source"] == "embedded"


# --- the claim never blocks ingestion ---------------------------------------


def test_an_unknown_work_order_claim_opens_it_and_links_the_run(client, mirror) -> None:
    """BL-81: a work-order claim the registry has never heard of no longer
    waits — `_open_claimed_work_order` opens it before this resolves, so the
    run links in the same request (upload-opens-its-work-order spec §3.1)."""
    status, body = _post(client, work_order_id=UNKNOWN_WO, platform="Porsche_Taycan")

    assert status == 201
    assert body["work_order_id"] == UNKNOWN_WO
    assert body["status"] == "complete"


def test_an_unknown_definition_claim_links_nothing_and_still_registers(client, mirror) -> None:
    status, body = _post(client, definition_id=UNKNOWN_TD)

    assert status == 201
    assert body["definition_id"] is None


def test_an_unknown_definition_claim_writes_a_journal_event_that_names_the_id(
    client, mirror
) -> None:
    """A definition is an authored test case and is never minted, so this is
    the only claim field left that can still go unresolved (BL-81 §2.2)."""
    _post(client, definition_id=UNKNOWN_TD)

    events = _events(mirror, RUN, "run.definition_claim_unresolved")
    assert len(events) == 1
    assert UNKNOWN_TD in events[0]["note"]


def test_an_unresolved_definition_claim_is_journalled_once_over_many_replays(
    client, mirror
) -> None:
    """A restarting pipeline must not flood the run timeline."""
    for _ in range(4):
        _post(client, definition_id=UNKNOWN_TD)

    assert len(_events(mirror, RUN, "run.definition_claim_unresolved")) == 1


# --- nothing else changes ----------------------------------------------------


def test_a_body_without_a_claim_registers_exactly_as_before(client, routed_db) -> None:
    status, body = _post(client, test_cell="TC-2")

    assert status == 201
    assert body["work_order_id"] is None
    assert body["definition_id"] is None
    assert body["project"] is None
    assert body["status"] == "awaiting_work_order"


def test_an_unknown_body_field_is_still_refused(client, routed_db) -> None:
    """`extra="forbid"` did not move. A new optional field is additive only."""
    status, _body = _post(client, nonsense="x")

    assert status == 422


def test_the_run_counts_still_derive_after_a_claim(client, mirror) -> None:
    """`run_facts` owns the counts. A claim writes none of them by hand."""
    _status, body = _post(client, work_order_id=KNOWN_WO)

    assert body["file_count"] == 0
    assert body["signal_count"] == 0
