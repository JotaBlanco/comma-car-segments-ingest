"""A-13 — contract #20, #21 and the ★ trigger.

The topbar toggle is the demo control. It flips the planning mock's switch and
then runs a real pass, so what the audience sees is the mechanism working, not
a canned response. The stub echoed a fixed body and changed nothing, which the
conformance review called the worst first-meeting break.
"""

from datetime import UTC, datetime, timedelta

import pytest

from api import planning_sync
from tests.factories_planning import make_run

HERO = "TAS-88214"
HERO_WO = "WO-2026-0851"


@pytest.fixture(autouse=True)
def _planning(planning_offline):
    """Every test here talks to the planning routes, so the shared override
    fixture (conftest.py, lane A region) is autouse. One mechanism, one home."""
    return planning_offline


def _seed_hero(db) -> None:
    db["test_runs"].insert_one(
        make_run(
            run_id=HERO,
            work_order_id=None,
            definition_id=None,
            project=None,
            status="awaiting_work_order",
            # Pair-only planning (24 Aug 2026): the hero CLAIMS its held-back
            # pair; the toggle closes the claim, never a run-id plan.
            claimed_work_order_id=HERO_WO,
            claimed_definition_id="TD-BAT-114",
            field_sources={},
        )
    )
    db["meta"].replace_one(
        {"_id": "demo_reset_watermark"},
        {"_id": "demo_reset_watermark", "at": datetime.now(UTC) - timedelta(seconds=1)},
        upsert=True,
    )


def _toggle(client, online: bool):
    return client.post("/api/v1/planning-sync/toggle", json={"online": online})


def test_the_status_starts_offline(client, routed_db) -> None:
    body = client.get("/api/v1/planning-sync/status").json()

    assert body["online"] is False
    assert body["last_sync_at"] is None
    assert body["work_orders_mirrored"] == 0


def test_toggling_on_runs_a_real_pass(client, routed_db) -> None:
    _seed_hero(routed_db)

    body = _toggle(client, True).json()

    assert body["online"] is True
    assert body["last_sync_result"]["runs_backfilled"] == 1
    assert body["work_orders_mirrored"] > 0


def test_the_status_agrees_with_the_toggle(client, routed_db) -> None:
    _seed_hero(routed_db)
    toggled = _toggle(client, True).json()

    status = client.get("/api/v1/planning-sync/status").json()

    assert status["online"] is True
    assert status["work_orders_mirrored"] == toggled["work_orders_mirrored"]
    assert status["last_sync_at"] is not None


def test_toggling_on_flips_the_hero_run_green(client, routed_db) -> None:
    """The money shot, through the endpoint the topbar calls."""
    _seed_hero(routed_db)

    _toggle(client, True)

    run = client.get(f"/api/v1/test-runs/{HERO}").json()
    assert run["work_order_id"] == HERO_WO
    assert run["status"] == "complete"


def test_toggling_off_deletes_nothing(client, routed_db) -> None:
    """A real registry never un-remembers.

    Toggling off reset the world until 20 Aug 2026. That delete could not tell
    a row a person typed in from a row the sync fetched, so a presenter's own
    work order left on a toggle. The toggle only stops the sync now.
    """
    _seed_hero(routed_db)
    _toggle(client, True)

    body = _toggle(client, False).json()

    assert body["online"] is False
    assert "demo_reset" not in body
    run = client.get(f"/api/v1/test-runs/{HERO}").json()
    assert run["work_order_id"] == HERO_WO
    assert run["status"] == "complete"


def test_toggling_to_the_same_state_is_a_no_op(client, routed_db) -> None:
    _seed_hero(routed_db)

    response = _toggle(client, False)

    assert response.status_code == 200
    assert response.json()["online"] is False


def test_toggling_on_twice_syncs_once(client, routed_db) -> None:
    """The second on is a no-op: no second pass, no moved clock.

    Review finding, 17 Aug: the route re-ran a full sync on every call while
    the acceptance line claimed a no-op.
    """
    _seed_hero(routed_db)
    first = _toggle(client, True).json()

    body = _toggle(client, True).json()

    assert body["last_sync_at"] == first["last_sync_at"]
    assert body["last_sync_result"]["runs_backfilled"] == 1


def test_the_home_badge_follows_the_toggle(client, routed_db) -> None:
    """Contract #1's planning_sync.online — the Home tile and the topbar must
    agree through the money shot (review finding: it could never turn on)."""
    _seed_hero(routed_db)

    _toggle(client, True)
    home = client.get("/api/v1/home/summary").json()
    status = client.get("/api/v1/planning-sync/status").json()
    assert home["planning_sync"]["online"] is True
    assert status["online"] is True

    _toggle(client, False)
    home = client.get("/api/v1/home/summary").json()
    assert home["planning_sync"]["online"] is False


def test_a_dead_planning_system_does_not_500_the_toggle(client, app, routed_db) -> None:
    """A planning system that is DOWN — not switched off — is the demo-day
    risk. The toggle must answer 200 and read offline, never crash."""
    import httpx

    class _Dead:
        def get(self, url, **kwargs):
            raise httpx.ConnectError("planning is down")

        def post(self, url, **kwargs):
            raise httpx.ConnectError("planning is down")

    app.dependency_overrides[planning_sync.get_planning_client] = lambda: _Dead()
    try:
        response = _toggle(client, True)
    finally:
        app.dependency_overrides.pop(planning_sync.get_planning_client, None)

    assert response.status_code == 200
    assert response.json()["online"] is False


def test_the_trigger_runs_one_pass_without_changing_the_state(client, routed_db) -> None:
    _seed_hero(routed_db)
    _toggle(client, True)
    _toggle(client, False)

    # Planning is offline again, so a trigger finds nothing and says so.
    body = client.post("/api/v1/planning-sync/trigger").json()

    assert body["online"] is False


def test_the_trigger_syncs_while_online(client, routed_db, planning_offline) -> None:
    _seed_hero(routed_db)
    planning_offline.post("/admin/state", json={"online": True})

    body = client.post("/api/v1/planning-sync/trigger").json()

    assert body["last_sync_result"]["runs_backfilled"] == 1
    assert client.get(f"/api/v1/test-runs/{HERO}").json()["status"] == "complete"


def test_an_unknown_body_field_returns_422_naming_the_field(client, routed_db) -> None:
    """Guard test 11 for #21."""
    response = client.post(
        "/api/v1/planning-sync/toggle", json={"online": True, "force": True}
    )

    assert response.status_code == 422
    assert "force" in response.json()["detail"]


def test_the_toggle_needs_the_online_field(client, routed_db) -> None:
    response = client.post("/api/v1/planning-sync/toggle", json={})

    assert response.status_code == 422


def test_the_status_body_keeps_its_null_fields(client, routed_db) -> None:
    """Contract #20 shows nulls, so the FE can render an empty state."""
    body = client.get("/api/v1/planning-sync/status").json()

    assert set(body) == {"online", "last_sync_at", "last_sync_result", "work_orders_mirrored"}


# --- a broken planning system never crashes our status (finding 40a, 21 Aug 2026) ---


class _HtmlPlanning:
    """A planning system that answers 200 with an HTML body on every path.

    A proxy login page looks exactly like this, and it is a 200.
    """

    def get(self, *args, **kwargs):
        import httpx

        return httpx.Response(
            200, text="<html>login</html>", headers={"content-type": "text/html"}
        )

    def post(self, *args, **kwargs):
        return self.get()


def test_a_non_json_planning_reply_reads_as_offline(app, client, routed_db) -> None:
    """`GET /planning-sync/status` answered 500 on a 200 with an HTML body.

    `is_planning_online` read `.json()` outside its guard, while `_fetch`
    already guarded its own read. A broken planning system reads as offline,
    like every other failure on this path.
    """
    app.dependency_overrides[planning_sync.get_planning_client] = _HtmlPlanning

    try:
        response = client.get("/api/v1/planning-sync/status")
    finally:
        app.dependency_overrides.pop(planning_sync.get_planning_client, None)

    assert response.status_code == 200, response.text
    assert response.json()["online"] is False
