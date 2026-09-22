# The retention purge of the recycle bin (FR-DM-042).
#
# `DELETE /files/{id}` is a soft delete, and until this file the bin never
# emptied. `api/api/services/retention.py` empties it: a file that stays
# deleted for `TM_FILE_RETENTION_DAYS` days loses its registry record.
#
# The four things this file proves:
#
# 1. The purge removes what it should — a deleted file past the period.
# 2. The purge keeps what it should — an active file, an archived file, a
#    deleted file inside the period, and a quarantined file (never-drop).
# 3. The audit entry lands BEFORE the record goes.
# 4. The purge deletes no byte.
#
# Style follows tests/test_files_lifecycle.py.

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from api.services import retention
from tests import factories
from tests.factories import register_file, upsert_run

files_db = factories.files_db

RUN = "TAS-88214"


@pytest.fixture(autouse=True)
def thirty_day_retention(monkeypatch):
    """Every test states the period it works with. None reads a stray shell."""
    monkeypatch.setenv(retention.RETENTION_DAYS_VAR, "30")


def _deleted_days_ago(db, days: int, **overrides) -> dict:
    """Store one soft-deleted file whose delete landed `days` ago."""
    stamp = datetime.now(UTC) - timedelta(days=days)
    return register_file(db, lifecycle="deleted", updated_at=stamp, **overrides)


def _stored(db, file_id: str) -> dict | None:
    return db["files"].find_one({"_id": file_id})


def _purge_events(db, file_id: str) -> list[dict]:
    return list(
        db["journal_entries"].find({"entity_id": file_id, "field": retention.PURGE_EVENT})
    )


# --- the period reads the environment ---------------------------------------


def test_the_retention_period_reads_the_environment(monkeypatch):
    monkeypatch.setenv(retention.RETENTION_DAYS_VAR, "7")

    assert retention.retention_days() == 7


def test_an_absent_or_nonsense_period_reads_the_default(monkeypatch):
    monkeypatch.delenv(retention.RETENTION_DAYS_VAR, raising=False)
    assert retention.retention_days() == retention.DEFAULT_RETENTION_DAYS

    monkeypatch.setenv(retention.RETENTION_DAYS_VAR, "soon")
    assert retention.retention_days() == retention.DEFAULT_RETENTION_DAYS


def test_a_zero_period_turns_the_purge_off(files_db, monkeypatch):
    # An operator needs an off switch for a destructive pass.
    monkeypatch.setenv(retention.RETENTION_DAYS_VAR, "0")
    upsert_run(files_db)
    file_id = _deleted_days_ago(files_db, 400)["_id"]

    assert retention.purge_once(files_db) == 0
    assert _stored(files_db, file_id) is not None


# --- the purge removes what it should ----------------------------------------


def test_the_purge_removes_a_deleted_file_past_the_period(files_db):
    upsert_run(files_db)
    file_id = _deleted_days_ago(files_db, 31)["_id"]

    assert retention.purge_once(files_db) == 1
    assert _stored(files_db, file_id) is None


def test_the_purge_removes_the_inventory_rows_of_the_file(files_db):
    # A row left behind would count on its run for ever.
    upsert_run(files_db)
    file_id = _deleted_days_ago(files_db, 31)["_id"]
    files_db["file_signals"].insert_one(
        {"_id": f"{file_id}:speed", "file_id": file_id, "run_id": RUN, "name": "speed"}
    )

    retention.purge_once(files_db)

    assert files_db["file_signals"].count_documents({"file_id": file_id}) == 0


def test_the_purge_re_derives_the_run_file_count(files_db):
    upsert_run(files_db, file_count=1)
    _deleted_days_ago(files_db, 31)

    retention.purge_once(files_db)

    assert files_db["test_runs"].find_one({"_id": RUN})["file_count"] == 0


# --- the purge keeps what it should ------------------------------------------


def test_the_purge_keeps_a_deleted_file_inside_the_period(files_db):
    upsert_run(files_db)
    file_id = _deleted_days_ago(files_db, 29)["_id"]

    assert retention.purge_once(files_db) == 0
    assert _stored(files_db, file_id) is not None


def test_the_purge_keeps_an_active_file_however_old(files_db):
    upsert_run(files_db)
    stamp = datetime.now(UTC) - timedelta(days=900)
    file_id = register_file(files_db, lifecycle="active", updated_at=stamp)["_id"]

    assert retention.purge_once(files_db) == 0
    assert _stored(files_db, file_id) is not None


def test_the_purge_keeps_an_archived_file_however_old(files_db):
    # An archive is a keep decision. Only the bin empties.
    upsert_run(files_db)
    stamp = datetime.now(UTC) - timedelta(days=900)
    file_id = register_file(files_db, lifecycle="archived", updated_at=stamp)["_id"]

    assert retention.purge_once(files_db) == 0
    assert _stored(files_db, file_id) is not None


def test_the_purge_keeps_a_quarantined_file(files_db):
    # The never-drop rule keeps a file the registry could not place, whatever
    # a person did to its lifecycle.
    upsert_run(files_db)
    file_id = _deleted_days_ago(
        files_db, 400, status="quarantined", quarantine_reason="checksum mismatch"
    )["_id"]

    assert retention.purge_once(files_db) == 0
    assert _stored(files_db, file_id) is not None


def test_a_restore_before_the_period_saves_the_file(client, files_db):
    upsert_run(files_db)
    file_id = _deleted_days_ago(files_db, 31)["_id"]

    restored = client.post(f"/api/v1/files/{file_id}/restore", json={"actor": "a.bergstrom"})
    assert restored.status_code == 200, restored.text

    assert retention.purge_once(files_db) == 0
    assert _stored(files_db, file_id) is not None


# --- audit before the record goes --------------------------------------------


def test_the_purge_journals_the_file_before_it_removes_the_record(files_db):
    upsert_run(files_db)
    file_id = _deleted_days_ago(files_db, 31)["_id"]

    retention.purge_once(files_db)

    entries = _purge_events(files_db, file_id)
    assert len(entries) == 1
    assert entries[0]["entity_type"] == "file"
    assert entries[0]["kind"] == "event"
    assert entries[0]["actor"] == retention.PURGE_ACTOR
    assert "30 days" in entries[0]["note"]
    # The journal outlives the record it describes.
    assert _stored(files_db, file_id) is None


def test_a_failed_audit_write_keeps_the_file(files_db):
    """The write order proves itself: break the journal and the record stays."""
    upsert_run(files_db)
    file_id = _deleted_days_ago(files_db, 31)["_id"]

    class _NoJournal:
        """The test database, with a journal collection that refuses writes."""

        def __getitem__(self, name):
            if name == "journal_entries":
                raise RuntimeError("the journal is down")
            return files_db[name]

    with pytest.raises(RuntimeError):
        retention.purge_once(_NoJournal())

    assert _stored(files_db, file_id) is not None


def test_the_purge_keeps_every_byte(files_db):
    # This service exposes no byte delete, and the purge adds none. The
    # stored object stays, and the storage layer owns it.
    upsert_run(files_db)
    _deleted_days_ago(files_db, 31, storage_ref="blob://test/keep-me")

    retention.purge_once(files_db)

    from api.services import file_bytes

    assert not hasattr(file_bytes.FileBytesProvider, "delete")


# --- the worker --------------------------------------------------------------


def test_the_app_starts_the_purge_worker(monkeypatch):
    """A pass nobody schedules empties nothing, so the lifespan must start it."""
    from fastapi.testclient import TestClient

    from api import main

    started: list[str] = []

    async def fake_worker() -> None:
        started.append("started")
        await asyncio.sleep(3600)

    monkeypatch.setattr(retention, "purge_worker", fake_worker)

    with TestClient(main.create_app()) as started_client:
        # One request turns the event loop, so the created task gets to run.
        started_client.get("/health")

    assert started == ["started"]
