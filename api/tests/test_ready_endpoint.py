"""The readiness route reuses the process Mongo client, and it still fails honestly.

Three things must hold at once, so all three have a test here.

1. `/ready` answers 200 when Mongo answers the ping.
2. `/ready` answers 503 when Mongo does not. A probe that reports ready while
   the database is down is worse than no probe.
3. `/ready` builds **no** new `MongoClient`. It reuses the one the process
   already holds. The old code built one per request, which cost a full
   topology discovery each time. The route needs no token, so that made it a
   lever an unauthenticated caller could pull.
"""

import pymongo
from pymongo.errors import ServerSelectionTimeoutError

from api import db, main


class _FakeAdmin:
    """Stands in for `client.admin`. It records every ping and can refuse."""

    def __init__(self, fails: bool) -> None:
        self.fails = fails
        self.pings = 0

    def command(self, name: str):
        assert name == "ping"
        self.pings += 1
        if self.fails:
            raise ServerSelectionTimeoutError("no servers")
        return {"ok": 1}


class _FakeClient:
    def __init__(self, fails: bool = False) -> None:
        self.admin = _FakeAdmin(fails)


def test_ready_answers_200_when_mongo_pings(bare_client, monkeypatch):
    fake = _FakeClient()
    monkeypatch.setattr(main, "get_client", lambda: fake)

    response = bare_client.get("/ready")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["mongo"] == "ok"
    assert body["planning_api"] in ("ok", "offline")
    # The route really pinged. A 200 that skipped the ping proves nothing.
    assert fake.admin.pings == 1


def test_ready_answers_503_when_mongo_is_down(bare_client, monkeypatch):
    fake = _FakeClient(fails=True)
    monkeypatch.setattr(main, "get_client", lambda: fake)

    response = bare_client.get("/ready")

    assert response.status_code == 503
    body = response.json()
    assert body["code"] == "not_ready"
    assert body["detail"] == "mongo ping failed"
    assert body["errors"] == []
    assert fake.admin.pings == 1


def test_main_holds_no_mongo_client_constructor():
    """The structural guard. This test fails against the old code.

    The old `/ready` did `from pymongo import MongoClient` at module level and
    called it per request. Binding that name in `api.main` again is the way the
    regression comes back, so the guard watches the name itself.
    """
    assert not hasattr(main, "MongoClient"), (
        "api.main binds MongoClient again. /ready must reuse api.db.get_client, "
        "never build its own client."
    )
    # The route must use the process client, not a private one.
    assert main.get_client is db.get_client


def test_ready_reuses_one_client_across_requests(bare_client, monkeypatch):
    """Three requests, one client, three pings, and no new client built."""
    built = []

    class _Tripwire:
        def __init__(self, *args, **kwargs):
            built.append(kwargs)
            raise AssertionError("the route built a MongoClient")

    monkeypatch.setattr(db, "MongoClient", _Tripwire)
    monkeypatch.setattr(pymongo, "MongoClient", _Tripwire)

    fake = _FakeClient()
    handed_out = []

    def _shared():
        handed_out.append(fake)
        return fake

    monkeypatch.setattr(main, "get_client", _shared)

    for _ in range(3):
        assert bare_client.get("/ready").status_code == 200

    assert built == [], f"the route built {len(built)} Mongo clients, expected 0"
    assert fake.admin.pings == 3, "every request must really ping"
    assert len({id(c) for c in handed_out}) == 1, "one client for all requests"


def test_ready_reports_planning_api_disabled_on_a_blank_url(bare_client, monkeypatch):
    """A blank PLANNING_API_URL means no planning system exists to probe.

    `/ready` must answer 200 with `planning_api: "disabled"` and make NO
    outbound HTTP call — a blank URL is a deliberate absence, not an
    unreachable target to time out against.
    """
    monkeypatch.setenv("PLANNING_API_URL", "")
    fake = _FakeClient()
    monkeypatch.setattr(main, "get_client", lambda: fake)

    def _tripwire(*args, **kwargs):
        raise AssertionError("ready() called httpx.get with a blank PLANNING_API_URL")

    monkeypatch.setattr(main.httpx, "get", _tripwire)

    response = bare_client.get("/ready")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["planning_api"] == "disabled"


def test_ready_bounds_the_ping_with_a_timeout(bare_client, monkeypatch):
    """A hung Mongo must read as a failure, not as a hang.

    The route wraps the ping in `pymongo.timeout`. This test proves the budget
    is in force by reading the deadline pymongo sets while the ping runs.
    """
    seen = {}

    class _DeadlineAdmin:
        def command(self, name: str):
            # `pymongo.timeout` installs a deadline for the enclosing block.
            seen["timeout"] = pymongo.timeout  # the context manager is in use
            seen["deadline_set"] = pymongo._csot.get_timeout() is not None
            seen["budget"] = pymongo._csot.get_timeout()
            return {"ok": 1}

    class _DeadlineClient:
        admin = _DeadlineAdmin()

    monkeypatch.setattr(main, "get_client", lambda: _DeadlineClient())

    assert bare_client.get("/ready").status_code == 200
    assert seen["deadline_set"] is True
    assert seen["budget"] == main.READY_PING_TIMEOUT_SECONDS
