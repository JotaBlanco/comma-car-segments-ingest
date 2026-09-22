# POST /planning/sync — the inbound half of the planning integration.
#
# Arrows point INTO the Test Manager. Planning polls the registry for the runs
# still waiting, matches them against its own catalog, and posts the catalog
# and the links it decided here. This suite pins that contract: the mirror is
# the same one the retiring outbound fetch wrote, and every link lands on the
# same provenance-aware path the internal backfill uses.

from datetime import UTC, datetime

import pytest

from tests.factories_planning import make_run

RUN = "TAS-88214"
WORK_ORDER = "WO-2026-0851"
DEFINITION = "TD-BAT-114"

WORK_ORDER_ROW = {
    "id": WORK_ORDER,
    "title": "HV battery thermal validation — winter cycle",
    "project": "EX90",
    "status": "active",
    "requestor": "L. Åkesson · Battery",
    "department": "Battery Test Labs",
    "priority": "P1 — expedite",
    "created_at": "2026-08-12T00:00:00Z",
}

DEFINITION_ROW = {
    "id": DEFINITION,
    "work_order_id": WORK_ORDER,
    "title": "HV battery thermal cycling · −20 °C → +40 °C",
    "planned_runs": 4,
    "run_ids": [RUN],
}


def _push(client, links=None, work_orders=None, definitions=None):
    return client.post(
        "/api/v1/planning/sync",
        json={
            "work_orders": [WORK_ORDER_ROW] if work_orders is None else work_orders,
            "test_definitions": [DEFINITION_ROW] if definitions is None else definitions,
            "links": [] if links is None else links,
        },
    )


def _link(**overrides) -> dict:
    return {"run_id": RUN, "work_order_id": WORK_ORDER, "definition_id": DEFINITION, **overrides}


@pytest.fixture
def waiting_run(routed_db):
    """The hero run as the seed leaves it: waiting for its work order."""
    routed_db["test_runs"].insert_one(
        make_run(
            run_id=RUN,
            work_order_id=None,
            definition_id=None,
            project=None,
            status="awaiting_work_order",
            field_sources={},
        )
    )
    return routed_db


# --- Auth ----------------------------------------------------------------------


def test_missing_token_returns_contract_401(bare_client) -> None:
    response = bare_client.post("/api/v1/planning/sync", json={})

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


def test_wrong_token_returns_401(bare_client) -> None:
    response = bare_client.post(
        "/api/v1/planning/sync", json={}, headers={"Authorization": "Bearer wrong-token"}
    )

    assert response.status_code == 401


def test_an_unknown_body_field_answers_422(client, routed_db) -> None:
    response = client.post("/api/v1/planning/sync", json={"work_order": []})

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


def test_an_empty_body_is_a_legal_pass(client, routed_db) -> None:
    """A planning system with nothing to say still says it."""
    response = client.post("/api/v1/planning/sync", json={})

    assert response.status_code == 200
    assert response.json() == {
        "work_orders_mirrored": 0,
        "definitions_mirrored": 0,
        "links_applied": 0,
        "links_unchanged": 0,
        "links_rejected": [],
    }


# --- The catalog mirror --------------------------------------------------------


def test_the_push_mirrors_the_work_order(client, routed_db) -> None:
    _push(client)

    row = routed_db["work_orders"].find_one({"_id": WORK_ORDER})
    assert row["title"] == "HV battery thermal validation — winter cycle"
    assert row["project"] == "EX90"
    assert row["status"] == "active"
    assert row["requestor"] == "L. Åkesson · Battery"
    assert row["synced_at"] is not None


def test_the_mirror_stores_created_at_as_a_datetime(client, routed_db) -> None:
    """A pushed row must mirror exactly like a fetched one (test_sync_pass)."""
    _push(client)

    row = routed_db["work_orders"].find_one({"_id": WORK_ORDER})
    assert isinstance(row["created_at_source"], datetime)


def test_the_mirror_keeps_the_payload_verbatim(client, routed_db) -> None:
    """`raw` is the audit copy, so an extra key planning sends must survive."""
    _push(client, work_orders=[{**WORK_ORDER_ROW, "programme": "Winter 26"}])

    raw = routed_db["work_orders"].find_one({"_id": WORK_ORDER})["raw"]
    assert raw["programme"] == "Winter 26"
    assert "planned_runs" not in raw


def test_the_push_mirrors_the_definition(client, routed_db) -> None:
    _push(client)

    row = routed_db["test_definitions"].find_one({"_id": DEFINITION})
    assert row["work_order_id"] == WORK_ORDER
    assert row["planned_runs"] == 4
    # `run_ids` was never a mapped field. Planning decides the links now, so it
    # survives only as part of the audit copy.
    assert row["raw"]["run_ids"] == [RUN]


def test_a_work_order_without_an_id_answers_422(client, routed_db) -> None:
    response = _push(client, work_orders=[{"title": "no id"}])

    assert response.status_code == 422
    assert routed_db["work_orders"].count_documents({}) == 0


# --- Applying the links --------------------------------------------------------


def test_a_link_flips_the_waiting_run_green(client, waiting_run) -> None:
    """The demo's money shot, driven from planning's end."""
    response = _push(client, links=[_link()])

    assert response.status_code == 200
    run = waiting_run["test_runs"].find_one({"_id": RUN})
    assert run["work_order_id"] == WORK_ORDER
    assert run["definition_id"] == DEFINITION
    assert run["project"] == "EX90"
    assert run["status"] == "complete"


def test_the_response_counts_what_changed(client, waiting_run) -> None:
    body = _push(client, links=[_link()]).json()

    assert body == {
        "work_orders_mirrored": 1,
        "definitions_mirrored": 1,
        "links_applied": 1,
        "links_unchanged": 0,
        "links_rejected": [],
    }


def test_a_link_writes_at_planning_provenance(client, waiting_run) -> None:
    _push(client, links=[_link()])

    sources = waiting_run["test_runs"].find_one({"_id": RUN})["field_sources"]
    assert sources["work_order_id"]["source"] == "api:planning"
    assert sources["work_order_id"]["actor"] == "planning-sync"


def test_a_link_journals_the_change(client, waiting_run) -> None:
    _push(client, links=[_link()])

    entries = list(waiting_run["journal_entries"].find({"entity_id": RUN, "field": "run.work_order"}))
    assert len(entries) == 1
    assert entries[0]["old"] == "(empty)"
    assert entries[0]["new"] == WORK_ORDER
    assert entries[0]["source"] == "api:planning"


def test_a_link_without_a_definition_still_sets_the_work_order(client, waiting_run) -> None:
    """Planning may know the work order without knowing which definition."""
    _push(client, links=[_link(definition_id=None)])

    run = waiting_run["test_runs"].find_one({"_id": RUN})
    assert run["work_order_id"] == WORK_ORDER
    assert run["definition_id"] is None
    assert run["status"] == "complete"


def test_the_push_records_itself_as_the_last_sync(client, waiting_run) -> None:
    """Contract #20 and the Home tile read this. Planning speaking counts."""
    _push(client, links=[_link()])

    meta = waiting_run["meta"].find_one({"_id": "planning_sync"})
    assert meta["last_sync_at"] is not None
    assert meta["last_sync_result"]["runs_backfilled"] == 1


# --- Precedence ----------------------------------------------------------------


def test_a_manual_value_is_never_overwritten(client, waiting_run) -> None:
    """Precedence holds against the push too: a person outranks planning."""
    waiting_run["test_runs"].update_one(
        {"_id": RUN},
        {
            "$set": {
                "project": "set by hand",
                "field_sources.project": {
                    "source": "manual",
                    "actor": "a.bergstrom",
                    "at": datetime.now(UTC),
                },
            }
        },
    )

    _push(client, links=[_link()])

    run = waiting_run["test_runs"].find_one({"_id": RUN})
    assert run["project"] == "set by hand"
    assert run["work_order_id"] == WORK_ORDER


def test_an_embedded_claim_is_corrected(client, routed_db) -> None:
    """The ingestion pipeline's claim carries `embedded`, and planning outranks it."""
    routed_db["test_runs"].insert_one(
        make_run(
            run_id=RUN,
            work_order_id="WO-2026-0847",
            definition_id=None,
            status="complete",
            field_sources={
                "work_order_id": {
                    "source": "embedded",
                    "actor": "ingestion",
                    "at": datetime.now(UTC),
                }
            },
        )
    )

    body = _push(client, links=[_link()]).json()

    assert body["links_applied"] == 1
    assert routed_db["test_runs"].find_one({"_id": RUN})["work_order_id"] == WORK_ORDER


# --- Idempotency ---------------------------------------------------------------


def test_re_posting_the_same_link_writes_nothing(client, waiting_run) -> None:
    """A second identical push must not touch the run or the journal."""
    _push(client, links=[_link()])
    before = waiting_run["test_runs"].find_one({"_id": RUN})
    journal_before = waiting_run["journal_entries"].count_documents({})

    body = _push(client, links=[_link()]).json()

    assert body["links_applied"] == 0
    assert body["links_unchanged"] == 1
    assert waiting_run["journal_entries"].count_documents({}) == journal_before
    assert waiting_run["test_runs"].find_one({"_id": RUN}) == before


# --- Refusals ------------------------------------------------------------------


def test_a_link_naming_an_unknown_run_is_rejected(client, routed_db) -> None:
    body = _push(client, links=[_link(run_id="TAS-00000")]).json()

    assert body["links_applied"] == 0
    assert body["links_rejected"] == [{"run_id": "TAS-00000", "reason": "unknown run"}]


def test_a_link_naming_an_unsent_work_order_is_rejected(client, waiting_run) -> None:
    """The registry links nothing planning did not also tell it about."""
    body = _push(client, links=[_link(work_order_id="WO-2026-9999")]).json()

    assert body["links_rejected"] == [{"run_id": RUN, "reason": "unknown work order"}]
    assert waiting_run["test_runs"].find_one({"_id": RUN})["work_order_id"] is None


def test_a_link_naming_an_unsent_definition_is_rejected(client, waiting_run) -> None:
    body = _push(client, links=[_link(definition_id="TD-BAT-999")]).json()

    assert body["links_rejected"] == [{"run_id": RUN, "reason": "unknown test definition"}]
    assert waiting_run["test_runs"].find_one({"_id": RUN})["work_order_id"] is None


def test_one_bad_link_does_not_stop_the_good_ones(client, waiting_run) -> None:
    waiting_run["test_runs"].insert_one(
        make_run(run_id="TAS-88215", work_order_id=None, definition_id=None, project=None,
                 status="awaiting_work_order", field_sources={})
    )

    body = _push(
        client,
        links=[
            _link(run_id="TAS-00000"),
            _link(),
            _link(run_id="TAS-88215"),
        ],
    ).json()

    assert body["links_applied"] == 2
    assert [row["reason"] for row in body["links_rejected"]] == ["unknown run"]
    assert waiting_run["test_runs"].find_one({"_id": "TAS-88215"})["status"] == "complete"


# --- A field planning left null (21 Aug 2026) -----------------------------------
#
# The mirror stored a null title, a null project and a null status, and the read
# models require a string for all three. A response `ValidationError` is not a
# request error, so ONE null row answered 500 for the whole page. The mirror
# coerces on the way in now, and `raw` still holds what planning said.


def test_a_work_order_without_a_title_still_lists(client, routed_db) -> None:
    _push(client, work_orders=[{"id": WORK_ORDER}], definitions=[])

    response = client.get("/api/v1/work-orders")

    assert response.status_code == 200, response.text
    row = response.json()["items"][0]
    assert row["title"] == ""
    assert row["project"] == ""
    assert row["status"] == "active"


def test_a_work_order_without_a_title_opens_its_detail(client, routed_db) -> None:
    _push(client, work_orders=[{"id": WORK_ORDER}], definitions=[])

    response = client.get(f"/api/v1/work-orders/{WORK_ORDER}")

    assert response.status_code == 200, response.text
    assert response.json()["title"] == ""


def test_a_definition_without_a_title_still_lists(client, routed_db) -> None:
    _push(client, work_orders=[], definitions=[{"id": DEFINITION}])

    response = client.get("/api/v1/test-definitions")

    assert response.status_code == 200, response.text
    assert response.json()["items"][0]["title"] == ""


def test_the_coercion_leaves_the_pushed_payload_alone(client, routed_db) -> None:
    """The coercion serves the read models. The audit still reads the truth."""
    _push(client, work_orders=[{"id": WORK_ORDER}], definitions=[])

    assert routed_db["work_orders"].find_one({"_id": WORK_ORDER})["raw"] == {"id": WORK_ORDER}


# --- The mirror journals what planning decided (21 Aug 2026) --------------------
#
# A work order and a test definition are journalled entities. The mirror upserted
# both in silence until now, so no screen could say who moved a title and when.


def test_mirroring_a_new_work_order_journals_it(client, routed_db) -> None:
    _push(client, definitions=[])

    entries = list(routed_db["journal_entries"].find({"entity_type": "work_order"}))
    assert len(entries) == 1
    assert entries[0]["entity_id"] == WORK_ORDER
    assert entries[0]["field"] == "work_order.mirrored"
    assert entries[0]["kind"] == "event"
    assert entries[0]["source"] == "api:planning"
    assert entries[0]["actor"] == "planning-sync"


def test_mirroring_a_new_definition_journals_it(client, routed_db) -> None:
    _push(client, work_orders=[])

    entries = list(routed_db["journal_entries"].find({"entity_type": "test_definition"}))
    assert len(entries) == 1
    assert entries[0]["entity_id"] == DEFINITION
    assert entries[0]["field"] == "test_definition.mirrored"
    assert entries[0]["kind"] == "event"


def test_a_renamed_work_order_journals_the_old_and_the_new(client, routed_db) -> None:
    _push(client, definitions=[])
    renamed = {**WORK_ORDER_ROW, "title": "HV battery thermal validation — re-planned"}

    _push(client, work_orders=[renamed], definitions=[])

    entries = list(routed_db["journal_entries"].find({"field": "work_order.title"}))
    assert len(entries) == 1
    assert entries[0]["kind"] == "change"
    assert entries[0]["old"] == WORK_ORDER_ROW["title"]
    assert entries[0]["new"] == renamed["title"]
    assert entries[0]["source"] == "api:planning"


def test_a_replanned_definition_journals_the_planned_runs(client, routed_db) -> None:
    _push(client, work_orders=[])
    replanned = {**DEFINITION_ROW, "planned_runs": 9}

    _push(client, work_orders=[], definitions=[replanned])

    entries = list(routed_db["journal_entries"].find({"field": "test_definition.planned_runs"}))
    assert len(entries) == 1
    assert entries[0]["old"] == "4"
    assert entries[0]["new"] == "9"


def test_the_definition_journal_read_serves_what_the_mirror_wrote(client, routed_db) -> None:
    """The write side and the read side meet (TR-012).

    The mirror journalled a definition from the day it landed, and no route
    served it, so the entries sat where nobody could see them.
    """
    _push(client, work_orders=[])
    _push(client, work_orders=[], definitions=[{**DEFINITION_ROW, "planned_runs": 9}])

    body = client.get(f"/api/v1/test-definitions/{DEFINITION}/journal").json()

    assert [entry["field"] for entry in body["items"]] == [
        "test_definition.planned_runs",
        "test_definition.mirrored",
    ]
    assert body["items"][0]["old"] == "4"
    assert body["items"][0]["new"] == "9"
    assert body["items"][0]["source"] == "api:planning"


def test_re_mirroring_the_same_catalog_journals_nothing(client, routed_db) -> None:
    """A second pass over an unchanged catalog stays silent, and idempotent."""
    _push(client)
    before = routed_db["journal_entries"].count_documents({})

    _push(client)

    assert routed_db["journal_entries"].count_documents({}) == before
