"""POST /test-runs opens the campaign it claims (BL-81).

`dev-planning/upload-opens-its-work-order/spec.md` §4.4. A trace states its
campaign in its own header (`test.work_order`), and until now a claim naming
a work order the registry had never heard of linked nothing: the run went
amber and waited for a person. `_open_claimed_work_order` now opens the
campaign the operator stated, at `embedded`, before the claim resolves — so
the run links itself in the same request. The id is only ever echoed: an
upload claiming no work order opens nothing (§3.2), and the project states
the declared platform, never the rig (§3.4, the `_adopt_order` regression the
spec names in §1.1).
"""

from tests.factories_planning import make_work_order

RUN = "TAS-96001"
NEW_WO = "WO-BAT-2026-002"
PLATFORM = "Porsche_Taycan"
EXISTING_WO = "WO-2026-0847"
RIG = "battery-sim-01"


def _post(client, **overrides) -> tuple[int, dict]:
    body = {"run_id": RUN, "rig_id": RIG}
    body.update(overrides)
    response = client.post("/api/v1/test-runs", json=body)
    return response.status_code, response.json()


# --- case 1: opens it, links the run, complete on arrival --------------------


def test_a_claim_naming_an_unknown_work_order_opens_it_and_links_the_run(client, routed_db) -> None:
    status, body = _post(client, work_order_id=NEW_WO, platform=PLATFORM)

    assert status == 201
    assert body["work_order_id"] == NEW_WO
    assert body["claimed_work_order_id"] is None
    assert body["status"] == "complete"


# --- case 2: the opened row's shape (spec §5.2) -------------------------------


def test_the_opened_row_carries_the_placeholder_title_status_and_platform(
    client, routed_db
) -> None:
    _post(client, work_order_id=NEW_WO, platform=PLATFORM)

    row = routed_db["work_orders"].find_one({"_id": NEW_WO})
    assert row["title"] == "Opened by an upload"
    assert row["project"] == PLATFORM
    assert row["status"] == "active"
    for field in ("title", "project", "status"):
        assert row["field_sources"][field]["source"] == "embedded"
        assert row["field_sources"][field]["actor"] == "ingestion"

    detail = client.get(f"/api/v1/work-orders/{NEW_WO}").json()
    assert detail["origin"] == "embedded"

    created = routed_db["journal_entries"].find_one(
        {"entity_type": "work_order", "entity_id": NEW_WO, "field": "work_order.created"}
    )
    assert created is not None
    assert RUN in created["note"]


# --- case 3: no claim opens nothing (§3.2, the never-invent rule) ------------


def test_a_claim_naming_no_work_order_opens_nothing_and_stays_amber(client, routed_db) -> None:
    before = routed_db["work_orders"].count_documents({})

    status, body = _post(client)

    assert routed_db["work_orders"].count_documents({}) == before
    assert status == 201
    assert body["work_order_id"] is None
    assert body["status"] == "awaiting_work_order"


# --- case 4: the `_adopt_order` regression guard (§1.1, §3.4) ----------------


def test_an_opened_campaign_without_a_declared_platform_reads_an_empty_project(
    client, routed_db
) -> None:
    status, _body = _post(client, work_order_id=NEW_WO)

    assert status == 201
    row = routed_db["work_orders"].find_one({"_id": NEW_WO})
    assert row["project"] == ""


def test_the_rig_id_never_reaches_the_opened_work_order_document(client, routed_db) -> None:
    """The named `_adopt_order` defect: `project = run.project or run.rig_id`
    produced the live `project = 0225` bug. The rig must appear nowhere in the
    document this door writes, whatever the caller posts as `rig_id`."""
    _post(client, work_order_id=NEW_WO, rig_id=RIG)

    row = routed_db["work_orders"].find_one({"_id": NEW_WO})
    assert "rig_id" not in row
    assert RIG not in row.values()
    assert row["project"] == ""


# --- case 5: an existing campaign is never re-opened -------------------------


def test_a_claim_naming_an_existing_campaign_writes_no_second_document(client, routed_db) -> None:
    routed_db["work_orders"].insert_one(make_work_order(wo_id=EXISTING_WO, project="EX90"))

    status, body = _post(client, work_order_id=EXISTING_WO)

    assert status == 201
    assert body["work_order_id"] == EXISTING_WO
    assert routed_db["work_orders"].count_documents({"_id": EXISTING_WO}) == 1


def test_a_claim_naming_an_existing_campaign_journals_no_second_created_event(
    client, routed_db
) -> None:
    routed_db["work_orders"].insert_one(make_work_order(wo_id=EXISTING_WO, project="EX90"))

    _post(client, work_order_id=EXISTING_WO)

    created = routed_db["journal_entries"].count_documents(
        {"entity_type": "work_order", "entity_id": EXISTING_WO, "field": "work_order.created"}
    )
    assert created == 0


# --- case 6: a replayed upsert opens nothing further --------------------------


def test_a_replayed_identical_upsert_opens_the_campaign_only_once(client, routed_db) -> None:
    for _ in range(3):
        _post(client, work_order_id=NEW_WO, platform=PLATFORM)

    assert routed_db["work_orders"].count_documents({"_id": NEW_WO}) == 1
    created = routed_db["journal_entries"].count_documents(
        {"entity_type": "work_order", "entity_id": NEW_WO, "field": "work_order.created"}
    )
    assert created == 1


# --- case 7: precedence proved at the route, not the rank table --------------


def test_a_later_status_edit_outranks_the_opened_status(client, routed_db) -> None:
    _post(client, work_order_id=NEW_WO, platform=PLATFORM)

    response = client.patch(f"/api/v1/work-orders/{NEW_WO}", json={"status": "closed"})

    assert response.status_code == 200
    row = routed_db["work_orders"].find_one({"_id": NEW_WO})
    assert row["status"] == "closed"
    assert row["field_sources"]["status"]["source"] == "manual"


def test_a_later_planning_push_outranks_the_opened_title_and_project(client, routed_db) -> None:
    _post(client, work_order_id=NEW_WO, platform=PLATFORM)

    client.post(
        "/api/v1/planning/sync",
        json={
            "work_orders": [
                {
                    "id": NEW_WO,
                    "title": "Road load, instrumented route",
                    "project": "EX90",
                    "status": "active",
                }
            ],
            "test_definitions": [],
            "links": [],
        },
    )

    row = routed_db["work_orders"].find_one({"_id": NEW_WO})
    assert row["title"] == "Road load, instrumented route"
    assert row["project"] == "EX90"
    assert row["field_sources"]["title"]["source"] == "api:planning"
