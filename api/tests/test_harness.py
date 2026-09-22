# Harness smoke tests. These need Docker Desktop with the mongo:7 image.

from datetime import UTC, datetime

from api.db import ensure_indexes
from tests.factories import register_file, upsert_run, write_result


def test_tz_aware_roundtrip(db):
    # Mongo stores milliseconds. Write at millisecond precision and read
    # back the same tz-aware instant.
    written = datetime(2026, 8, 14, 9, 41, 33, 123000, tzinfo=UTC)
    db["smoke"].insert_one({"_id": "s1", "at": written})
    read = db["smoke"].find_one({"_id": "s1"})["at"]
    assert read.tzinfo is not None
    assert read == written


def test_ensure_indexes_is_repeatable(db):
    ensure_indexes(db)
    ensure_indexes(db)
    names = [index["name"] for index in db["files"].list_indexes()]
    assert any("checksum_sha256" in name for name in names)


def test_planning_mock_answers_in_process(planning_client):
    # Lane A tests the sync pass against this fixture — no port, no network.
    response = planning_client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_factories_insert_documents(db):
    upsert_run(db)
    register_file(db)
    write_result(db)
    assert db["test_runs"].count_documents({}) == 1
    assert db["files"].count_documents({}) == 1
    assert db["processed_results"].count_documents({}) == 1
