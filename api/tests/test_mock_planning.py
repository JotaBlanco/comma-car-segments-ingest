"""A-11 — the standalone planning mock (BE-PLAN §6).

The mock stands in for the planning system. The demo toggle flips its
`/admin/state` switch, and the backend then runs a real sync pass against it.
The switch is the only mutable state, so every test states the state it needs.
The mock starts offline, because the demo starts amber.
"""

import json

from fastapi.testclient import TestClient

from mock_planning import main as planning_main

HERO_RUN_ID = "TAS-88214"
HERO_DEFINITION_ID = "TD-BAT-114"
SYNC_WO_ID = "WO-2026-0851"
OFFLINE_DETAIL = "planning system offline"

DEMO_WORK_ORDER_IDS = [
    "WO-2026-0836",
    "WO-2026-0839",
    "WO-2026-0843",
    "WO-2026-0847",
    SYNC_WO_ID,
    "WO-2026-0853",
]
DEMO_DEFINITION_IDS = [
    "TD-BAT-091",
    "TD-BAT-102",
    HERO_DEFINITION_ID,
    "TD-EM-201",
    "TD-EM-204",
    "TD-INV-077",
    "TD-RLD-301",
]


def _go_online(client) -> None:
    """Flip the switch on. The mock starts offline, so the read tests need this."""
    response = client.post("/admin/state", json={"online": True})
    assert response.status_code == 200


# --- /health ----------------------------------------------------------------


def test_health_answers_while_online(planning_client) -> None:
    _go_online(planning_client)

    response = planning_client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_answers_while_offline(planning_client) -> None:
    # Compose polls /health. An offline planning system is still a running
    # container, so the healthcheck must pass while the switch is off.
    assert planning_client.get("/admin/state").json() == {"online": False}

    response = planning_client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


# --- online reads -----------------------------------------------------------


def test_the_work_order_list_serves_the_six_demo_work_orders(planning_client) -> None:
    _go_online(planning_client)

    body = planning_client.get("/api/v1/work-orders").json()

    assert body["total"] == 6
    assert sorted(item["id"] for item in body["items"]) == DEMO_WORK_ORDER_IDS


def test_the_list_carries_the_work_order_that_arrives_on_the_toggle(planning_client) -> None:
    # WO-2026-0851 is the only work order the seed does not pre-mirror. It
    # reaches the registry through the sync pass, and it is the visible delta.
    _go_online(planning_client)

    rows = {item["id"]: item for item in planning_client.get("/api/v1/work-orders").json()["items"]}

    assert rows[SYNC_WO_ID]["title"] == "HV battery thermal validation — winter cycle"
    assert rows[SYNC_WO_ID]["project"] == "EX90"
    assert rows[SYNC_WO_ID]["status"] == "active"


def test_a_work_order_carries_the_fields_the_mirror_stores(planning_client) -> None:
    _go_online(planning_client)

    body = planning_client.get("/api/v1/work-orders/WO-2026-0847").json()

    assert body["id"] == "WO-2026-0847"
    assert body["title"] == "E-machine efficiency characterisation"
    assert body["project"] == "EX90"
    assert body["status"] == "active"
    assert body["requestor"] == "M. Ekholm · Propulsion"
    assert body["department"] == "Propulsion Test Labs"
    assert body["priority"] == "P2 — standard"
    assert body["created_at"] == "2026-08-03T00:00:00Z"


def test_the_payload_keeps_its_utf8_text(planning_client) -> None:
    # The cast carries "Å", "·" and "—". A broken encoding step shows here first.
    _go_online(planning_client)

    body = planning_client.get(f"/api/v1/work-orders/{SYNC_WO_ID}").json()

    assert body["requestor"] == "L. Åkesson · Battery"


def test_an_unknown_work_order_returns_404(planning_client) -> None:
    _go_online(planning_client)

    response = planning_client.get("/api/v1/work-orders/WO-2026-9999")

    assert response.status_code == 404
    assert response.json() == {"detail": "work order not found"}


def test_the_definition_list_serves_the_seven_demo_definitions(planning_client) -> None:
    _go_online(planning_client)

    body = planning_client.get("/api/v1/test-definitions").json()

    assert body["total"] == 7
    assert sorted(item["id"] for item in body["items"]) == DEMO_DEFINITION_IDS


def test_every_definition_carries_the_linkage_the_backfill_reads(planning_client) -> None:
    # The backfill reads work_order_id and run_ids from every definition. A
    # definition missing either field would skip runs without an error.
    _go_online(planning_client)

    items = planning_client.get("/api/v1/test-definitions").json()["items"]

    for definition in items:
        assert definition["work_order_id"] in DEMO_WORK_ORDER_IDS
        assert isinstance(definition["run_ids"], list)
        assert "planned_runs" in definition


def test_the_hero_definition_links_the_hero_run(planning_client) -> None:
    # This one linkage is the amber-to-green flip: TD-BAT-114 hands TAS-88214
    # to WO-2026-0851, so the sync fills the run's empty work order.
    _go_online(planning_client)

    rows = {
        item["id"]: item
        for item in planning_client.get("/api/v1/test-definitions").json()["items"]
    }

    # Pair-only planning (24 Aug 2026): the served plan names NO run ids —
    # the hero correlates by the claim it carries. The pair and the planned
    # COUNT survive.
    assert rows[HERO_DEFINITION_ID]["run_ids"] == []
    assert rows[HERO_DEFINITION_ID]["work_order_id"] == SYNC_WO_ID
    assert rows[HERO_DEFINITION_ID]["planned_runs"] == 4


def test_no_other_definition_claims_the_hero_run(planning_client) -> None:
    # Two definitions claiming TAS-88214 would make the backfill result depend
    # on the read order.
    _go_online(planning_client)

    items = planning_client.get("/api/v1/test-definitions").json()["items"]

    claimants = [item["id"] for item in items if item["run_ids"]]
    assert claimants == []  # no definition names ANY run — the claim correlates


# --- offline ----------------------------------------------------------------


def test_offline_blocks_the_work_order_list(planning_client) -> None:
    response = planning_client.get("/api/v1/work-orders")

    assert response.status_code == 503
    assert response.json() == {"detail": OFFLINE_DETAIL}


def test_offline_blocks_the_work_order_detail(planning_client) -> None:
    response = planning_client.get("/api/v1/work-orders/WO-2026-0847")

    assert response.status_code == 503
    assert response.json() == {"detail": OFFLINE_DETAIL}


def test_offline_blocks_the_definition_list(planning_client) -> None:
    response = planning_client.get("/api/v1/test-definitions")

    assert response.status_code == 503
    assert response.json() == {"detail": OFFLINE_DETAIL}


def test_offline_hides_whether_a_work_order_exists(planning_client) -> None:
    # An offline system answers 503 for every id. It never leaks a 404.
    response = planning_client.get("/api/v1/work-orders/WO-2026-9999")

    assert response.status_code == 503
    assert response.json() == {"detail": OFFLINE_DETAIL}


def test_going_offline_again_blocks_the_reads(planning_client) -> None:
    _go_online(planning_client)
    assert planning_client.get("/api/v1/work-orders").status_code == 200

    planning_client.post("/admin/state", json={"online": False})

    assert planning_client.get("/api/v1/work-orders").status_code == 503


# --- /admin/state -----------------------------------------------------------


def test_the_switch_starts_off(planning_client) -> None:
    # The demo starts amber, so a restarted mock must not serve work orders.
    response = planning_client.get("/admin/state")

    assert response.status_code == 200
    assert response.json() == {"online": False}


def test_the_switch_flips_on_and_off(planning_client) -> None:
    assert planning_client.post("/admin/state", json={"online": True}).json() == {"online": True}
    assert planning_client.get("/admin/state").json() == {"online": True}

    assert planning_client.post("/admin/state", json={"online": False}).json() == {"online": False}
    assert planning_client.get("/admin/state").json() == {"online": False}


def test_setting_the_same_state_twice_changes_nothing(planning_client) -> None:
    _go_online(planning_client)

    response = planning_client.post("/admin/state", json={"online": True})

    assert response.status_code == 200
    assert response.json() == {"online": True}
    assert planning_client.get("/api/v1/work-orders").status_code == 200


def test_the_switch_needs_the_online_field(planning_client) -> None:
    response = planning_client.post("/admin/state", json={})

    assert response.status_code == 422


def test_a_new_client_starts_from_the_fixture_state(planning_client) -> None:
    # The mock is a module-level app, so tests would share its switch. Startup
    # reloads the fixture, which keeps every test independent.
    _go_online(planning_client)

    with TestClient(planning_main.app) as fresh:
        assert fresh.get("/admin/state").json() == {"online": False}


# --- /admin/reset -----------------------------------------------------------


def test_reset_reloads_the_fixture_from_disk(planning_client, tmp_path, monkeypatch) -> None:
    # The seed script rewrites fixture.json and then calls reset, so a running
    # mock picks up the new cast without a restart.
    replacement = tmp_path / "fixture.json"
    replacement.write_text(
        json.dumps(
            {
                "work_orders": [{"id": "WO-2026-0999", "title": "Späte Prüfung"}],
                "test_definitions": [],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(planning_main, "FIXTURE_PATH", replacement)

    response = planning_client.post("/admin/reset")

    assert response.status_code == 200
    assert response.json() == {"online": False, "work_orders": 1, "test_definitions": 0}
    _go_online(planning_client)
    body = planning_client.get("/api/v1/work-orders").json()
    assert [item["id"] for item in body["items"]] == ["WO-2026-0999"]
    assert body["items"][0]["title"] == "Späte Prüfung"


def test_reset_puts_the_switch_back_off(planning_client) -> None:
    _go_online(planning_client)

    planning_client.post("/admin/reset")

    assert planning_client.get("/admin/state").json() == {"online": False}
    assert planning_client.get("/api/v1/work-orders").status_code == 503


def test_reset_restores_the_demo_cast(planning_client) -> None:
    planning_client.post("/admin/reset")
    _go_online(planning_client)

    body = planning_client.get("/api/v1/work-orders").json()

    assert sorted(item["id"] for item in body["items"]) == DEMO_WORK_ORDER_IDS
