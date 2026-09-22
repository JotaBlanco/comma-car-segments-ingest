# Test harness for the Test Manager API.
# The base owns this file frame. Lanes append fixtures only inside their marked region.

import os
import re
import uuid

import pytest

# A test-only value. It is not a real secret.
TEST_TOKEN = "test-token-not-a-secret"


@pytest.fixture(scope="session", autouse=True)
def api_token() -> str:
    """Set the API token for the whole test session."""
    os.environ["TM_API_TOKEN"] = TEST_TOKEN
    return TEST_TOKEN


@pytest.fixture(autouse=True)
def no_platform_check():
    """Keep the platform identity check off, unless a test turns it on.

    `Quix__Portal__Api` sends an unknown token to the real Quix Portal. A
    developer who has that variable in their shell would otherwise make the
    whole suite open sockets to it. This clears the platform state before and
    after every test, so a test that turns the check on cannot leak into the
    next one either.

    **The name changed on 19 Aug 2026, from our own `TM_QUIX_PORTAL_URL` to the
    injected `Quix__Portal__Api`.** The platform injects that name everywhere,
    so a developer shell or a container is far more likely to hold it. This
    fixture therefore matters more than it did, not less.

    It clears the Portal URL only. `Quix__Workspace__Id` stays, because the blob
    store reads the same name (`api/ingest/store.py:40`) and the file-write path
    reads it too. With no Portal URL, that name reaches no platform call.
    """
    from api import quix_identity

    def clear() -> None:
        os.environ.pop(quix_identity.PORTAL_URL_VAR, None)
        quix_identity.TRANSPORT = None
        quix_identity.reset_cache()

    clear()
    yield
    clear()


@pytest.fixture(scope="session")
def app(api_token):
    from api.main import app as fastapi_app

    return fastapi_app


@pytest.fixture(scope="session")
def client(app):
    """A client that sends the bearer token on every call."""
    from fastapi.testclient import TestClient

    with TestClient(app, headers={"Authorization": f"Bearer {TEST_TOKEN}"}) as c:
        yield c


@pytest.fixture(scope="session")
def bare_client(app):
    """A client that sends no token."""
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        yield c


# The name that carries the mongo URL from the run to its parts.
#
# `pytest-xdist` starts each worker as a subprocess of the run, so a worker
# inherits this variable. One container therefore serves every worker. A
# container per worker does not work: 20 of them starve Docker Desktop, and
# the tests then fail on a pymongo timeout.
MONGO_URL_VAR = "TM_TEST_MONGO_URL"

_container = None


def _start_mongo():
    from testcontainers.community.mongodb import MongoDbContainer

    # `/data/db` sits in RAM. A test database lives for one test, so nothing
    # here needs to survive the run, and the disk write is pure cost.
    return MongoDbContainer("mongo:7").with_tmpfs_mount("/data/db")


def pytest_configure(config):
    """Start the one container before `pytest-xdist` starts the workers."""
    global _container
    if hasattr(config, "workerinput"):
        return  # A worker. It reads the URL the run put in the environment.
    if not getattr(config.option, "numprocesses", None):
        return  # A serial run. `mongo_url` starts the container on demand.
    _container = _start_mongo().start()
    os.environ[MONGO_URL_VAR] = _container.get_connection_url()


def pytest_unconfigure(config):
    global _container
    if _container is not None:
        _container.stop()
        _container = None


@pytest.fixture(scope="session")
def mongo_url():
    """The URL of the mongo:7 container. Needs Docker Desktop."""
    url = os.environ.get(MONGO_URL_VAR)
    if url:
        yield url
        return
    with _start_mongo() as container:
        yield container.get_connection_url()


@pytest.fixture(scope="session")
def mongo_client(mongo_url):
    from pymongo import MongoClient

    client = MongoClient(mongo_url, tz_aware=True)
    yield client
    client.close()


@pytest.fixture
def db(mongo_client):
    """A fresh database per test. The test never sees another test's data."""
    name = f"test_{uuid.uuid4().hex[:12]}"
    database = mongo_client[name]
    yield database
    mongo_client.drop_database(name)


@pytest.fixture
def planning_client():
    """An in-process client for the planning mock. No port, no network.

    httpx.ASGITransport is async-only, so the sync harness uses TestClient.
    """
    from fastapi.testclient import TestClient

    from mock_planning.main import app as planning_app

    with TestClient(planning_app) as c:
        yield c


# --- lane A fixtures ---
# Lane A appends its fixtures here. Do not write above or below this region.


@pytest.fixture(autouse=True)
def no_registry_push():
    """Keep the planning mock's push worker from reaching a real registry.

    The mock pushes to `TM_API_URL` now, and the worker runs for the lifetime
    of every `planning_client`. A developer who has that variable in their
    shell — the seed CLI reads the same name — would otherwise have the suite
    POST the demo cast at whatever it points to the moment a test flips the
    switch on. Same hazard, same guard as `no_platform_check` above.

    A test that wants the worker sets the variable itself, inside the test.
    """
    os.environ.pop("TM_API_URL", None)
    yield
    os.environ.pop("TM_API_URL", None)


@pytest.fixture
def planning_offline(app, planning_client):
    """Point the API at the in-process planning mock, switched off.

    The planning routes call a real planning system now, so any test that
    touches them needs one. The mock starts offline, which is the state the
    demo opens in.
    """
    from api import planning_sync

    planning_client.post("/admin/reset")
    app.dependency_overrides[planning_sync.get_planning_client] = lambda: planning_client
    yield planning_client
    app.dependency_overrides.pop(planning_sync.get_planning_client, None)

# --- lane B fixtures ---
# Lane B appends its fixtures here. Do not write above or below this region.


@pytest.fixture
def routed_db(app, db):
    """Route the app's Mongo reads to this test's fresh database."""
    from api import db as db_module

    app.dependency_overrides[db_module.get_db] = lambda: db
    yield db
    app.dependency_overrides.pop(db_module.get_db, None)


@pytest.fixture
def seeded_db(routed_db):
    """The routed database, seeded with the stub demo data.

    Each lane seeds the collections it owns. The golden contract requests read
    across all of them, so every lane that moves a route onto Mongo adds its
    seeder here.
    """
    from api.db import ensure_indexes
    from tests.factories import seed_demo_files
    from tests.factories_planning import seed_demo_mirror
    from tests.factories_signals import seed_demo_signals

    ensure_indexes(routed_db)
    seed_demo_signals(routed_db)
    seed_demo_files(routed_db)
    seed_demo_mirror(routed_db)
    return routed_db


# --- the stub lake ---
#
# QuixLake serves the numbers of #7 and #16, and the suite runs no lake. A
# module that reads either endpoint installs `stub_lake`, and a module that
# checks the loud failure installs `no_lake`.

_STATS_SQL = re.compile(
    r"^SELECT (?P<group>run_id|signal), .+ "
    r"WHERE (?P<column>run_id|signal) = '(?P<value>.*)' GROUP BY (?P=group)$"
)

# The eight quantities the real aggregate selects. The last four are
# optional on both sides, so the stub answers a column only when the seeded
# block states a number for it.
_STATS_FIELDS = ("min", "max", "mean", "std", "rms", "p50", "p95", "p99")

# The lake column and the registry field name the signal differently.
_REGISTRY_FIELD = {"run_id": "run_id", "signal": "name"}


def _capture_lake_query():
    from api.services import lake

    return lake.query


# Captured at import, which happens before any fixture replaces the client.
_REAL_LAKE_QUERY = _capture_lake_query()


def real_lake_query():
    """Return the true lake client, as it was before any stub replaced it."""
    return _REAL_LAKE_QUERY


@pytest.fixture
def stub_lake(monkeypatch, app):
    """Answer the two statistics aggregates from the registry rows.

    QuixLake computes those numbers in a deployment. This stub reads the
    statistics block that the `file_signals` row already carries, and answers
    the aggregate from it. No socket opens.

    The stub merges nothing. A real lake reads the samples of the whole run, so
    it needs no merge. Where two files measure one signal of one run, the stub
    answers the block of the first file by id.

    A test that needs its own numbers, or a lake that fails, patches
    `lake.query` again after this fixture.

    The fixture also sets the two lake variables, because a stub lake stands
    in for a lake this process CAN reach. #7 reads the variables before it
    builds a query: with none of them set it serves the registry rows and asks
    nobody, so a stub with an empty environment would answer nothing.
    """
    from api import db as db_module
    from api.services import lake

    monkeypatch.setenv(lake.URL_VAR, "http://lake.stub.test")
    monkeypatch.setenv(lake.TOKEN_VAR, "stub-token-not-a-secret")

    def query(sql: str, transport=None) -> list[dict[str, str]]:
        parsed = _STATS_SQL.match(sql)
        if parsed is None:
            raise lake.LakeError(f"the stub lake cannot run this statement: {sql}")
        get_db = app.dependency_overrides.get(db_module.get_db)
        if get_db is None:
            return []
        wanted = parsed["value"].replace("''", "'")
        found = get_db()["file_signals"].find(
            {_REGISTRY_FIELD[parsed["column"]]: wanted}
        )
        rows: dict[str, dict[str, str]] = {}
        for row in sorted(found, key=lambda row: row.get("file_id") or ""):
            key = row.get(_REGISTRY_FIELD[parsed["group"]])
            block = row.get("stats")
            if not key or not block or key in rows:
                continue
            rows[key] = {
                field: str(block[field])
                for field in _STATS_FIELDS
                if block.get(field) is not None
            }
        return [{parsed["group"]: key, **numbers} for key, numbers in rows.items()]

    monkeypatch.setattr(lake, "query", query)
    return query


@pytest.fixture
def no_lake(monkeypatch):
    """Take every lake variable away, and put the true lake client back.

    A module that installs `stub_lake` still needs the loud failure: with no
    lake, #7 and #16 answer 503 `lake_unavailable` and never a Mongo number.
    The stub answers every query, so the stub steps aside here.
    """
    from api.services import lake

    monkeypatch.setattr(lake, "query", real_lake_query())
    for name in (lake.URL_VAR, "QUIX_LAKE_URL", lake.TOKEN_VAR, "Quix__Sdk__Token"):
        monkeypatch.delenv(name, raising=False)
