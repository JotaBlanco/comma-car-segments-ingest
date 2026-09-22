"""PATCH /test-runs/{run_id} — a person repairs a run link by hand.

Planning owns the two link fields, and planning is not always reachable. So a
person may state a link. The id must name a mirrored row, the write carries
the `manual` tag, and the next sync pass reads that tag and leaves it alone.
"""

import pytest

from api import planning_sync
from tests.factories_planning import make_definition, make_run, make_work_order

RUN = "TAS-88214"
MIRRORED_WO = "WO-2026-0847"
MIRRORED_TD = "TD-BAT-114"
UNKNOWN_WO = "WO-2026-9999"
UNKNOWN_TD = "TD-NOPE-001"

# The planning mock points this run at a different work order.
MOCK_WO = "WO-2026-0851"


@pytest.fixture
def amber_run(routed_db):
    """The hero run as the seed leaves it: waiting for its work order."""
    routed_db["test_runs"].insert_one(
        make_run(
            run_id=RUN,
            work_order_id=None,
            definition_id=None,
            project=None,
            status="awaiting_work_order",
            # Pair-only planning: an amber run is amber BECAUSE its claim is
            # retained — that claim is what the sync fills per field.
            claimed_work_order_id=MIRRORED_WO,
            claimed_definition_id=MIRRORED_TD,
            field_sources={},
        )
    )
    routed_db["work_orders"].insert_one(make_work_order(wo_id=MIRRORED_WO, project="EX90"))
    routed_db["test_definitions"].insert_one(make_definition(td_id=MIRRORED_TD))
    return routed_db


def _patch(client, **fields):
    body = {"actor": "a.bergstrom", **fields}
    response = client.patch(f"/api/v1/test-runs/{RUN}", json=body)
    return response.status_code, response.json()


# --- the edit works ----------------------------------------------------------


def test_a_person_links_a_run_to_a_mirrored_work_order(client, amber_run) -> None:
    status, body = _patch(client, work_order_id=MIRRORED_WO)

    assert status == 200
    assert body["work_order_id"] == MIRRORED_WO
    assert body["field_sources"]["work_order_id"]["source"] == "manual"


def test_a_person_links_a_run_to_a_mirrored_definition(client, amber_run) -> None:
    _status, body = _patch(client, definition_id=MIRRORED_TD)

    assert body["definition_id"] == MIRRORED_TD


def test_the_manual_link_flips_the_run_out_of_the_amber_state(client, amber_run) -> None:
    _status, body = _patch(client, work_order_id=MIRRORED_WO)

    assert body["status"] == "complete"


def test_a_manual_link_copies_the_project_from_the_mirror(client, amber_run) -> None:
    """A person states the link. The project follows the work order."""
    _status, body = _patch(client, work_order_id=MIRRORED_WO)

    assert body["project"] == "EX90"
    assert body["field_sources"]["project"]["source"] == "manual"


def test_the_edit_journals_the_link_change(client, amber_run) -> None:
    _patch(client, work_order_id=MIRRORED_WO, note="linked from the paper log")

    entries = list(
        amber_run["journal_entries"].find({"entity_id": RUN, "field": "run.work_order"})
    )
    assert len(entries) == 1
    assert entries[0]["new"] == MIRRORED_WO
    assert entries[0]["source"] == "manual"
    assert entries[0]["note"] == "linked from the paper log"


# --- the edit refuses a link to nothing --------------------------------------


def test_an_unknown_work_order_answers_422(client, amber_run) -> None:
    """A person can retype. Telling them beats storing a link to nothing."""
    status, body = _patch(client, work_order_id=UNKNOWN_WO)

    assert status == 422
    assert body["code"] == "unknown_work_order"
    assert amber_run["test_runs"].find_one({"_id": RUN})["work_order_id"] is None


def test_an_unknown_definition_answers_422(client, amber_run) -> None:
    status, body = _patch(client, definition_id=UNKNOWN_TD)

    assert status == 422
    assert body["code"] == "unknown_definition"


# --- the edit survives the sync ---------------------------------------------


def test_a_manual_work_order_survives_the_next_sync_pass(
    client, amber_run, planning_client
) -> None:
    """The trap. The backfill runs over this run and must write nothing.

    `_RANK` says `manual` outranks `api:planning`. This test proves it instead
    of trusting it, because the backfill selector no longer skips a linked run.
    """
    _patch(client, work_order_id=MIRRORED_WO)

    planning_client.post("/admin/reset")
    planning_client.post("/admin/state", json={"online": True})
    planning_sync.run_sync_pass(amber_run, client=planning_client)

    run = amber_run["test_runs"].find_one({"_id": RUN})
    assert run["work_order_id"] == MIRRORED_WO, "planning must not overwrite a person"
    assert run["field_sources"]["work_order_id"]["source"] == "manual"
    assert run["work_order_id"] != MOCK_WO


def test_the_sync_journals_no_second_work_order_change(
    client, amber_run, planning_client
) -> None:
    """The sync writes nothing on the field a person holds.

    It still fills `definition_id`, which the person left empty. A manual link
    protects its own field, never the whole run.
    """
    _patch(client, work_order_id=MIRRORED_WO)

    planning_client.post("/admin/reset")
    planning_client.post("/admin/state", json={"online": True})
    planning_sync.run_sync_pass(amber_run, client=planning_client)

    work_order_entries = list(
        amber_run["journal_entries"].find({"entity_id": RUN, "field": "run.work_order"})
    )
    assert len(work_order_entries) == 1
    assert work_order_entries[0]["source"] == "manual"
    assert amber_run["test_runs"].find_one({"_id": RUN})["definition_id"] == MIRRORED_TD


# --- nothing else changes ----------------------------------------------------


def test_a_body_with_no_link_still_edits_the_old_three_fields(client, amber_run) -> None:
    status, body = _patch(client, operator="A. Bergström")

    assert status == 200
    assert body["operator"] == "A. Bergström"


def test_the_project_field_is_still_not_patchable(client, amber_run) -> None:
    """`project` follows the work order. The body refuses it."""
    status, _body = _patch(client, project="EX90")

    assert status == 422


def test_the_rig_is_still_not_patchable(client, amber_run) -> None:
    status, _body = _patch(client, rig_id="RIG-09")

    assert status == 422
