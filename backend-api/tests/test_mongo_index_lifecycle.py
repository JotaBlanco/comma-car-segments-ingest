"""Round-2 regressions: index creation must never be paid for by a request.

Round 1 pinned Mongo's timeouts so an outage becomes a named 503 inside a client
read timeout. Round 2 found that the *first* Mongo-backed request in a fresh
process took 36.9 s anyway, because ``deps.get_db`` created the schema's indexes
inline and ``mongo_schema.ensure_indexes`` paid the full server-selection timeout
once per collection - eleven collections, one bound multiplied by eleven. The same
code also latched its once-per-process flag whether or not the attempt succeeded,
so a process that started during an outage never created indexes at all.

These tests pin all three properties: the bound, the abort-on-first-transport-
failure that produces it, and the retry.
"""

import time

import pytest
from pymongo.errors import ConnectionFailure, OperationFailure, ServerSelectionTimeoutError

import db as db_module
import deps
import mongo_schema

# Reserved for "IANA future use" (RFC 1112): nothing answers, and it is not a
# private range that a developer's LAN might route somewhere real. This is what
# makes the timing assertions exercise the pinned serverSelectionTimeoutMS instead
# of an instant connection-refused.
UNROUTABLE_MONGO = "240.0.0.1:27017"

# The bound the fix has to hold: the same one /health/ready already meets.
BOUND_S = 4.0


@pytest.fixture
def unreachable_mongo(monkeypatch):
    """A fresh, unconfigured-cache process pointed at a black-hole Mongo."""
    monkeypatch.setenv("MONGO_HOST", UNROUTABLE_MONGO)
    monkeypatch.setenv("MONGO_USER", "u")
    monkeypatch.setenv("MONGO_PASSWORD", "p")
    monkeypatch.setenv("MONGO_DB_NAME", "test_manager")
    monkeypatch.setenv("TM_BLOB_BACKEND", "off")
    # Assert the production budget rather than whatever a local .env carries, so a
    # timing test cannot pass or fail for environmental reasons.
    monkeypatch.setattr(db_module, "SERVER_SELECTION_TIMEOUT_MS", 3000)
    monkeypatch.setattr(db_module, "CONNECT_TIMEOUT_MS", 3000)
    deps.reset()
    yield
    deps.reset()


def test_first_mongo_backed_request_answers_503_inside_the_bound(unreachable_mongo):
    """The blocker from round 2: 36.94 s became a bounded ~3 s.

    ``TestClient`` is used *without* its context manager on purpose: no lifespan
    runs, so nothing has created indexes, and this is exactly the cold-start path
    that used to pay eleven timeouts.
    """
    from fastapi.testclient import TestClient

    import main

    client = TestClient(main.api)

    started = time.monotonic()
    response = client.get("/devices")
    elapsed = time.monotonic() - started

    assert response.status_code == 503
    assert response.json()["error"] == "mongo_unavailable"
    assert elapsed < BOUND_S, f"cold-start 503 took {elapsed:.2f}s, bound is {BOUND_S}s"


def test_start_up_does_not_wait_for_mongo_and_still_answers_health(unreachable_mongo):
    """Index creation moved to start-up; start-up must not block on Mongo for it."""
    from fastapi.testclient import TestClient

    import main

    started = time.monotonic()
    with TestClient(main.api) as client:
        booted = time.monotonic() - started
        health = client.get("/health")

    assert booted < 1.0, f"lifespan blocked for {booted:.2f}s; it must not wait on Mongo"
    assert health.status_code == 200
    assert health.json()["mongo"]["available"] is False
    assert health.json()["ready"] is False


def test_index_creation_is_skipped_and_retried_while_mongo_is_unreachable(monkeypatch):
    """The second-order bug: the flag used to latch on failure, killing all retries."""
    monkeypatch.setattr(deps, "_indexes_done", False)
    monkeypatch.setattr(deps, "database", lambda: object())

    reachable = {"value": False}
    monkeypatch.setattr(
        deps,
        "mongo_status",
        lambda: {"available": reachable["value"], "reason": "unreachable", "timeouts": {}},
    )

    attempts = []

    def fake_ensure_indexes(database):
        attempts.append(database)
        if len(attempts) == 1:
            raise ServerSelectionTimeoutError("no server available")
        return {}

    monkeypatch.setattr(mongo_schema, "ensure_indexes", fake_ensure_indexes)

    # Mongo unreachable: the ping decides, and createIndexes is never attempted.
    assert deps.ensure_indexes_once() is False
    assert attempts == []
    assert deps._indexes_done is False

    # Reachable, but the attempt fails: still not latched.
    reachable["value"] = True
    assert deps.ensure_indexes_once() is False
    assert len(attempts) == 1
    assert deps._indexes_done is False

    # Mongo is back: the next attempt runs and only now latches.
    assert deps.ensure_indexes_once() is True
    assert len(attempts) == 2
    assert deps._indexes_done is True

    # Latched means latched: no further conversation with the server.
    assert deps.ensure_indexes_once() is True
    assert len(attempts) == 2


class _FakeCollection:
    def __init__(self, name, parent):
        self._name = name
        self._parent = parent

    def create_indexes(self, models):
        self._parent.attempts.append(self._name)
        error = self._parent.errors.get(self._name)
        if error is not None:
            raise error
        return [f"{self._name}-{index}" for index, _ in enumerate(models)]


class _FakeDb:
    """Records which collections ``ensure_indexes`` actually talked to."""

    def __init__(self, errors=None):
        self.attempts = []
        self.errors = errors or {}

    def __getitem__(self, name):
        return _FakeCollection(name, self)


def test_ensure_indexes_pays_one_timeout_not_one_per_collection():
    """The root cause: 11 collections x 3.3 s = the 37 s that was measured."""
    assert len(mongo_schema.INDEXES) == 11
    first = next(iter(mongo_schema.INDEXES))
    fake = _FakeDb({first: ServerSelectionTimeoutError("no server available")})

    with pytest.raises(ConnectionFailure):
        mongo_schema.ensure_indexes(fake)

    assert fake.attempts == [first], "a transport failure must abort the whole attempt"


def test_ensure_indexes_still_survives_one_collections_own_failure():
    """Fail-fast is for outages only; a per-collection conflict must not cost the rest."""
    names = list(mongo_schema.INDEXES)
    victim = names[1]
    fake = _FakeDb({victim: OperationFailure("index options conflict")})

    created = mongo_schema.ensure_indexes(fake)

    assert fake.attempts == names
    assert created[victim] == []
    assert created[names[0]], "the collections around the conflict still got their indexes"
