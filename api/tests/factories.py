# Test factories. The base ships naive versions; the lanes extend them.

import uuid
from datetime import UTC, datetime

import pytest

from api import provenance, stub_data
from api.db import ensure_indexes
from api.models.common import Source
from tests.factories_signals import make_file_signal


def _now() -> datetime:
    return datetime.now(UTC)


def upsert_run(db, **overrides) -> dict:
    doc = {
        "_id": "TAS-88214",
        "description": "HV battery thermal cycling",
        "work_order_id": None,
        "definition_id": None,
        "project": None,
        "rig_id": "RIG-04",
        "test_cell": "TC-2",
        "operator": None,
        "bench_sw": None,
        "started_at": None,
        "ended_at": None,
        "first_data_at": _now(),
        "invalid": {"flagged": False, "reason": None, "actor": None, "at": None},
        "file_count": 0,
        "signal_count": 0,
        "status": "awaiting_work_order",
        "field_sources": {},
        "created_at": _now(),
        "updated_at": _now(),
    }
    doc.update(overrides)
    db["test_runs"].replace_one({"_id": doc["_id"]}, doc, upsert=True)
    return doc


def register_file(db, **overrides) -> dict:
    doc = {
        "_id": f"f-{uuid.uuid4()}",
        "filename": "bat_cyc_20260814_0941.mf4",
        "run_id": "TAS-88214",
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 1024,
        "checksum_sha256": uuid.uuid4().hex * 2,
        "checksum_state": "verified",
        "status": "registered",
        "quarantine_reason": None,
        "storage_ref": "blob://test/file",
        "signal_count": 0,
        "time_start": None,
        "time_end": None,
        "ingestion_job_id": None,
        "field_sources": {},
        "registered_at": _now(),
        "updated_at": _now(),
    }
    doc.update(overrides)
    db["files"].replace_one({"_id": doc["_id"]}, doc, upsert=True)
    return doc


def write_result(db, **overrides) -> dict:
    doc = {
        "_id": f"res-{uuid.uuid4()}",
        "run_id": "TAS-88214",
        "name": "thermal_summary_v1.parquet",
        "result_key": "thermal_summary",
        "version": 1,
        "supersedes": None,
        "description": None,
        "storage_ref": None,
        "provenance": {
            "tool": "bat-post",
            "tool_version": "2.3.1",
            "parameters": "--cycles all --dt 0.1",
            "input_file_ids": [],
            "produced_by": "e.lindqvist",
            "produced_at": _now(),
        },
        "provenance_status": "verified",
        "created_at": _now(),
    }
    doc.update(overrides)
    db["processed_results"].replace_one({"_id": doc["_id"]}, doc, upsert=True)
    return doc


@pytest.fixture
def files_db(routed_db):
    """The per-test database with all indexes applied, routed into the app."""
    ensure_indexes(routed_db)
    return routed_db


def seed_demo_files(db) -> None:
    """Write the demo files, their signals and the journal into Mongo.

    seed_state() returns a fresh copy, so the pops never touch shared data.
    """
    state = stub_data.seed_state()

    files = []
    run_of_file = {}
    for file in state["files"]:
        file["_id"] = file.pop("file_id")
        run_of_file[file["_id"]] = file["run_id"]
        files.append(file)

    file_signals = [
        {"file_id": file_id, "run_id": run_of_file.get(file_id), **row}
        for file_id, rows in state["file_signals"].items()
        for row in rows
    ]

    entries = []
    for entry in state["journal"]:
        entry["_id"] = entry.pop("id")
        entries.append(entry)

    db["files"].insert_many(files)
    db["file_signals"].insert_many(file_signals)
    db["journal_entries"].insert_many(entries)


def insert_file_signal(db, file_id: str, name: str, **overrides) -> dict:
    """Insert one file_signals row. The signal lane owns the defaults."""
    return make_file_signal(db, file_id, name, **overrides)


def insert_file_event(
    db, file_id: str, field: str, at: datetime | None = None, **overrides
) -> dict:
    doc = provenance.add_event("file", file_id, field, Source.EMBEDDED, "ingestion")
    if at is not None:
        doc["at"] = at
    doc.update(overrides)
    db["journal_entries"].insert_one(doc)
    return doc
