"""The planning mock learns at runtime — demo overlay routes (mock_planning/demo_admin.py).

Overlay file (scripts/sync.config.json): the sync keeps it. It rides the
api suite's `planning_client` fixture, so every test gets a fresh cast.
"""

import pytest

from mock_planning import main as planning_main
from mock_planning.demo_admin import record_push


def _definition(client, definition_id: str) -> dict:
    client.post("/admin/state", json={"online": True})
    items = client.get("/api/v1/test-definitions").json()["items"]
    return next(row for row in items if row["id"] == definition_id)


# --- planning is run-id-unaware --------------------------------------------------------


def test_the_plan_route_is_gone(planning_client):
    """`POST /admin/plan` named run ids under a definition until 24 Aug 2026.
    Planning knows pairs; the TAS mints run ids; the claim correlates."""
    response = planning_client.post(
        "/admin/plan", json={"definition_id": "TD-RLD-301", "run_ids": ["TAS-90013"]}
    )
    assert response.status_code in (404, 405)


def test_every_served_definition_carries_no_planned_runs(planning_client):
    """The seed fixture still ships run_ids; every outward surface strips
    them, so neither the registry's backfill nor the push's plan rule can
    link a run planning was never supposed to know."""
    planning_client.post("/admin/state", json={"online": True})
    for route in ("/admin/catalog", "/api/v1/test-definitions"):
        body = planning_client.get(route).json()
        rows = body.get("test_definitions") or body.get("items") or []
        assert rows, route
        for row in rows:
            # ids stripped; the planned COUNT survives (pair-level metadata).
            assert row.get("run_ids") == [], (route, row.get("id"))


# --- POST /admin/catalog --------------------------------------------------------------


def test_planning_learns_a_new_work_order_and_definition(planning_client):
    response = planning_client.post(
        "/admin/catalog",
        json={
            "work_order": {"id": "WO-2026-0901", "title": "Bench: brake fade", "project": "EX90"},
            "test_definition": {
                "id": "TD-BENCH-001",
                "title": "Brake fade · bench",
                "work_order_id": "WO-2026-0901",
            },
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["created"] == {"work_order": "WO-2026-0901", "test_definition": "TD-BENCH-001"}
    assert body["work_orders"] == 7 and body["test_definitions"] == 8
    planning_client.post("/admin/state", json={"online": True})
    order = planning_client.get("/api/v1/work-orders/WO-2026-0901").json()
    assert order["project"] == "EX90" and order["status"] == "active" and order["created_at"]
    definition = _definition(planning_client, "TD-BENCH-001")
    assert definition["run_ids"] == []


def test_a_definition_needs_its_work_order_in_the_catalog(planning_client):
    response = planning_client.post(
        "/admin/catalog",
        json={"test_definition": {"id": "TD-X", "title": "x", "work_order_id": "WO-NOPE"}},
    )
    assert response.status_code == 422
    assert "WO-NOPE" in response.json()["detail"]


def test_learning_an_existing_row_again_changes_nothing(planning_client):
    """Same ids, same titles — and any run_ids in the body are IGNORED, not a
    change: planning holds no plan of runs to grow."""
    body = {
        "work_order": {"id": "WO-2026-0853", "title": "Road load data acquisition — instrumented route", "project": "EX90"},
        "test_definition": {
            "id": "TD-RLD-301",
            "title": "Road load capture · instrumented durability route",
            "work_order_id": "WO-2026-0853",
            "run_ids": ["TAS-90001", "TAS-90099"],
        },
    }
    response = planning_client.post("/admin/catalog", json=body).json()

    assert response["created"] == {}
    assert response["work_orders"] == 6 and response["test_definitions"] == 7
    definition = _definition(planning_client, "TD-RLD-301")
    assert definition["run_ids"] == [] and definition["planned_runs"] == 6


def test_an_empty_catalog_body_is_422(planning_client):
    assert planning_client.post("/admin/catalog", json={}).status_code == 422


def test_a_reset_forgets_what_planning_learned(planning_client):
    planning_client.post(
        "/admin/catalog",
        json={"work_order": {"id": "WO-2026-0999", "title": "Ephemeral", "project": "EX90"}},
    )
    planning_client.post("/admin/reset")

    planning_client.post("/admin/state", json={"online": True})
    orders = planning_client.get("/api/v1/work-orders").json()["items"]
    assert "WO-2026-0999" not in {row["id"] for row in orders}


# --- orphan-claim adoption --------------------------------------------------------------


def _catalog(planning_client) -> dict:
    return planning_client.get("/admin/catalog").json()


def test_an_orphan_claim_is_adopted_with_a_plausible_pair(planning_client):
    """A pair the rigs reference that the catalog lacks becomes a themed row:
    id family decides the vocabulary, the RUN's own rig decides the platform."""
    from mock_planning.demo_admin import adopt_orphan_claims

    runs = [{
        "run_id": "TAS-95001",
        "rig_id": "HYUNDAI_IONIQ",
        "claimed_work_order_id": "WO-2026-0949",
        "claimed_definition_id": "TD-RLD-441",
    }]
    orders, definitions = adopt_orphan_claims(runs, [], [])

    order = next(row for row in _catalog(planning_client)["work_orders"] if row["id"] == "WO-2026-0949")
    assert order["title"].startswith("Road load data acquisition")
    # `project` is the platform the lake sink falls back to. It was the constant
    # "EX90" — the one car the estate recorded — until this file arrived back
    # from the PCAP estate carrying a better rule: the run that made the claim
    # names its own rig, so the adopted work order names that. An estate with
    # one platform cannot tell the two rules apart; this one records many.
    assert order["project"] == "HYUNDAI_IONIQ" and order["department"] == "Vehicle Dynamics"
    definition = next(row for row in _catalog(planning_client)["test_definitions"] if row["id"] == "TD-RLD-441")
    assert definition["work_order_id"] == "WO-2026-0949"
    assert definition["title"].startswith("Road load data acquisition")
    assert any(row["id"] == "WO-2026-0949" for row in orders)
    assert any(row["id"] == "TD-RLD-441" for row in definitions)


def test_a_definition_only_claim_mints_its_parent_work_order(planning_client):
    """A definition cannot hang in the air (TR-001): a claim naming only a
    definition gets a minted parent, themed by the id family."""
    from mock_planning.demo_admin import adopt_orphan_claims

    adopt_orphan_claims([{"run_id": "TAS-95002", "claimed_definition_id": "TD-BAT-777"}], [], [])

    definition = next(row for row in _catalog(planning_client)["test_definitions"] if row["id"] == "TD-BAT-777")
    parent = next(row for row in _catalog(planning_client)["work_orders"] if row["id"] == definition["work_order_id"])
    assert parent["title"].startswith("HV battery thermal validation")
    assert parent["department"] == "Battery Lab"


def test_a_known_pair_adopts_nothing(planning_client):
    from mock_planning.demo_admin import adopt_orphan_claims
    from mock_planning import main as planning

    before_orders = len(planning._state["work_orders"])
    before_definitions = len(planning._state["test_definitions"])
    runs = [{
        "run_id": "TAS-95003",
        "claimed_work_order_id": "WO-2026-0853",
        "claimed_definition_id": "TD-RLD-301",
    }]
    adopt_orphan_claims(runs, planning._state["work_orders"], planning._state["test_definitions"])

    assert len(planning._state["work_orders"]) == before_orders
    assert len(planning._state["test_definitions"]) == before_definitions


# --- GET /admin/push ------------------------------------------------------------------


def test_no_push_yet_says_so(planning_client):
    # The cast reloads per client; the push record is demo state the reset never knew.
    planning_main._state.pop("last_push", None)
    body = planning_client.get("/admin/push").json()
    assert body["pushed"] is None and body["at"] is None
    assert "no push" in body["reason"]


def test_the_last_push_is_served_with_its_time(planning_client):
    record_push({"pushed": True, "runs": 3, "links": 1, "counts": {"links_applied": 1}})

    body = planning_client.get("/admin/push").json()
    assert body["pushed"] is True and body["links"] == 1 and body["counts"] == {"links_applied": 1}
    assert body["at"].startswith("20")


@pytest.mark.anyio
async def test_the_worker_records_its_pass(planning_client):
    """The worker's pass lands in /admin/push — here the offline pass on a
    fresh boot. Once ANY result is recorded, an offline no-op never
    overwrites it: the 30 s worker's tick used to clobber the trigger's
    adoption seconds after the toast narrated it, so the guard lives at the
    recorder itself (25 Aug 2026)."""
    planning_main._state["online"] = False
    planning_main._state.pop("last_push", None)
    record_push(await planning_main.push_once())

    body = planning_client.get("/admin/push").json()
    assert body["pushed"] is False and body["reason"] == planning_main.OFFLINE_DETAIL

    record_push({"pushed": True, "runs": 2, "links": 2, "adopted": ["WO-2026-A900"], "counts": {}})
    record_push(await planning_main.push_once())

    kept = planning_client.get("/admin/push").json()
    assert kept["pushed"] is True and kept["adopted"] == ["WO-2026-A900"]


def test_an_adopted_definition_records_the_demand_as_its_plan(planning_client):
    """Adoption used to synthesize a definition with no planned_runs, so the
    definition screen read "2 of 0 planned runs" (25 Aug 2026). The
    rig-submitted demand IS the plan."""
    from mock_planning.demo_admin import adopt_orphan_claims

    runs = [
        {"run_id": "TAS-97101", "claimed_work_order_id": "WO-2026-0990",
         "claimed_definition_id": "TD-BAT-990"},
        {"run_id": "TAS-97102", "claimed_work_order_id": "WO-2026-0990",
         "claimed_definition_id": "TD-BAT-990"},
    ]
    _, definitions = adopt_orphan_claims(runs, [], [])

    row = next(r for r in definitions if r["id"] == "TD-BAT-990")
    assert row["planned_runs"] == 2


def test_adopted_timestamps_speak_z(planning_client):
    """+00:00 flip-flopped against pydantic's Z through the pull/push
    round-trip, read as "changed" on every pass, and minted two phantom
    Dynamic Configuration versions per sync press (25 Aug 2026)."""
    from mock_planning.demo_admin import adopt_orphan_claims

    runs = [{"run_id": "TAS-97201", "claimed_work_order_id": "WO-2026-0991",
             "claimed_definition_id": "TD-RLD-991"}]
    adopt_orphan_claims(runs, [], [])

    row = next(r for r in planning_main._state["work_orders"] if r["id"] == "WO-2026-0991")
    assert row["created_at"].endswith("Z")
    assert "+00:00" not in row["created_at"]


def test_minted_adoption_ids_never_reuse_after_a_reset(planning_client):
    """len(orders)+1 re-minted an id the registry and config store already
    held once a catalog reset shrank the list (25 Aug 2026): the mint scans
    the existing A-band max instead."""
    from mock_planning.demo_admin import adopt_orphan_claims

    planning_main._state["work_orders"].append({"id": "WO-2026-A007", "title": "held"})
    runs = [{"run_id": "TAS-97301", "claimed_definition_id": "TD-EMC-993"}]

    adopt_orphan_claims(runs, [], [])

    minted = {r["id"] for r in planning_main._state["work_orders"]}
    assert "WO-2026-A008" in minted
    assert len([i for i in minted if i == "WO-2026-A008"]) == 1
