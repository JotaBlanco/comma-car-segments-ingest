"""Is the deployed environment alive, guarded and shaped right?

Every check reads; nothing here writes unless TM_SMOKE_TOGGLE opts in. A
failure names the broken half — infra (/health, /ready), auth, or a route.
"""

import httpx
import pytest

from tests_smoke.conftest import _HTTP_TIMEOUT_SECONDS, flag

# Contract §B #1 — asserted only under TM_SMOKE_EXPECT_DEMO.
CONTRACT_HOME_COUNTS = {
    "test_runs": 128,
    "files": 512,
    "signals": 6412,
    "work_orders": 42,
    "test_definitions": 7,
    "runs_today": 6,
    "files_today": 31,
    "rig_count": 4,
}


def test_health_answers(smoke_url) -> None:
    response = httpx.get(f"{smoke_url}/health", timeout=_HTTP_TIMEOUT_SECONDS)
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_ready_reports_its_dependencies(smoke_url) -> None:
    """Mongo must be reachable; the planning system may legally be offline."""
    response = httpx.get(f"{smoke_url}/ready", timeout=_HTTP_TIMEOUT_SECONDS)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["mongo"] == "ok"
    assert body["planning_api"] in ("ok", "offline")


def test_the_door_is_guarded(smoke_url) -> None:
    bare = httpx.get(f"{smoke_url}/api/v1/home/summary", timeout=_HTTP_TIMEOUT_SECONDS)
    assert bare.status_code == 401


def test_home_answers_in_the_contract_shape(smoke) -> None:
    body = smoke.get("/home/summary").json()

    assert set(body["counts"]) == set(CONTRACT_HOME_COUNTS)
    assert all(isinstance(value, int) and value >= 0 for value in body["counts"].values())
    assert set(body["needs_attention"]) == {
        "awaiting_work_order",
        "quarantined_files",
        "invalid_runs",
    }
    assert set(body["planning_sync"]) == {"online", "last_sync_at"}
    assert isinstance(body["recent_runs"], list)


def test_every_list_route_answers(smoke) -> None:
    for path in ("/test-runs", "/files", "/signals", "/work-orders"):
        body = smoke.get(path).json()
        assert "items" in body and "total" in body, path


def test_search_answers(smoke) -> None:
    body = smoke.get("/search", params={"q": "TAS"}).json()
    assert set(body) == {"query", "groups"}


def test_planning_status_answers(smoke) -> None:
    body = smoke.get("/planning-sync/status").json()
    assert set(body) == {"online", "last_sync_at", "last_sync_result", "work_orders_mirrored"}


def test_the_demo_cast_is_loaded(smoke) -> None:
    """The contract's Home example, verbatim. Opt-in: a live environment may
    legitimately have drifted from the pristine seed."""
    if not flag("TM_SMOKE_EXPECT_DEMO"):
        pytest.skip("set TM_SMOKE_EXPECT_DEMO=1 right after a fresh seed --reset")

    body = smoke.get("/home/summary").json()
    assert body["counts"] == CONTRACT_HOME_COUNTS
    assert body["needs_attention"] == {
        "awaiting_work_order": 1,
        "quarantined_files": 2,
        "invalid_runs": 1,
    }


def test_the_toggle_round_trip(smoke) -> None:
    """Opt-in and STATE-CHANGING: it ends with the switch off, and it runs a
    real sync pass on the way. The toggle deletes nothing, so the sync writes
    stay. Run `seed --reset` to put the stage back to amber."""
    if not flag("TM_SMOKE_TOGGLE"):
        pytest.skip("set TM_SMOKE_TOGGLE=1 to walk the toggle beat (state-changing)")

    on = smoke.post("/planning-sync/toggle", json={"online": True}).json()
    assert on["online"] is True

    off = smoke.post("/planning-sync/toggle", json={"online": False}).json()
    assert off["online"] is False
