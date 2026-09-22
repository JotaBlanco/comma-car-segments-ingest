# Test helpers for the processed-result lane (ticket B-16).
# Lane B owns this file. tests/factories.py belongs to another lane.
#
# The file helper seeds the files collection straight into Mongo. B-01 owns
# POST /files, so a later ticket must prove both paths write the same shape.

import uuid
from datetime import UTC, datetime

import pytest

from api.db import ensure_indexes

RESULTS = "/api/v1/results"
RUN_ID = "TAS-88214"
RESULT_KEY = "thermal_summary"

PROVENANCE_KEYS = (
    "tool",
    "tool_version",
    "parameters",
    "input_file_ids",
    "produced_by",
    "produced_at",
)


@pytest.fixture
def results_db(routed_db):
    """The per-test database with every index and the run, routed into the app.

    `POST /results` refuses a result whose run this system never registered,
    so the run has to exist before a result may name it. Lane A owns the run
    document, so the shared factory writes it.
    """
    from tests.factories import upsert_run

    ensure_indexes(routed_db)
    upsert_run(routed_db)
    return routed_db


def provenance(**overrides) -> dict:
    """A complete provenance block. Every key is present."""
    body = {
        "tool": "bat-post",
        "tool_version": "2.3.1",
        "parameters": "--cycles all --dt 0.1",
        "input_file_ids": [],
        "produced_by": "e.lindqvist",
        "produced_at": "2026-08-14T12:02:00Z",
    }
    body.update(overrides)
    return body


def result_body(**overrides) -> dict:
    """A valid POST /results body. Every test starts from this shape."""
    body = {
        "run_id": RUN_ID,
        "name": "thermal_summary_v1.parquet",
        "result_key": RESULT_KEY,
        "description": "Cycle-level aggregates",
        "storage_ref": "blob://results/thermal_summary_v1.parquet",
        "provenance": provenance(),
    }
    body.update(overrides)
    return body


# The fingerprint POST /results writes for `result_body()`, stated by hand.
# `_fingerprint` owns the rule, so this helper must never call it: a fixture
# that computes its expectation with the function under test cannot fail when
# that function breaks. A change to the hash rule changes this literal, and
# `test_a_replay_of_a_seeded_result_mints_no_new_version` reports it.
DEFAULT_BODY_HASH = "c53bc54fe9a0e446a46db675fea7c4470409bda5d9b8e2a06e2fc4aae8ef6415"

# The document fields the fingerprint covers. The route hashes the request body
# only, so version, supersedes and created_at never reach the hash.
HASHED_FIELDS = ("run_id", "name", "result_key", "description", "storage_ref", "provenance")


def _default_request() -> dict:
    """The request shape DEFAULT_BODY_HASH belongs to."""
    return {
        "run_id": RUN_ID,
        "name": "thermal_summary_v1.parquet",
        "result_key": RESULT_KEY,
        "description": "Cycle-level aggregates",
        "storage_ref": "blob://results/thermal_summary_v1.parquet",
        "provenance": provenance(produced_at=datetime(2026, 8, 14, 12, 2, tzinfo=UTC)),
    }


def body_hash(doc: dict) -> str:
    """Return the fingerprint the route writes for this seeded document.

    The seed and the route must agree byte for byte, so a seeded copy of the
    default body carries the literal above. A document that differs in any
    hashed field carries a marker instead: no literal fits it, and the route
    can never mint that value, so a post of it mints a new version.
    """
    wanted = _default_request()
    if all(doc[field] == wanted[field] for field in HASHED_FIELDS):
        return DEFAULT_BODY_HASH
    return f"seeded-{doc['run_id']}-{doc['result_key']}-{doc['name']}"


def seed_result(db, **overrides) -> dict:
    """Insert one processed_results document straight into Mongo.

    The document carries the same body_hash the route writes, so a replay of
    a seeded result answers 200 and mints no phantom version.
    """
    doc = {
        "_id": f"res-{uuid.uuid4()}",
        "run_id": RUN_ID,
        "name": "thermal_summary_v1.parquet",
        "result_key": RESULT_KEY,
        "version": 1,
        "supersedes": None,
        "description": "Cycle-level aggregates",
        "storage_ref": "blob://results/thermal_summary_v1.parquet",
        "provenance": provenance(produced_at=datetime(2026, 8, 14, 12, 2, tzinfo=UTC)),
        "provenance_status": "verified",
        "created_at": datetime.now(UTC),
    }
    doc.update(overrides)
    doc.setdefault("body_hash", body_hash(doc))
    db["processed_results"].insert_one(doc)
    return doc


def seed_file(db, run_id: str = RUN_ID, **overrides) -> dict:
    """Insert one registered file so an input id resolves."""
    now = datetime.now(UTC)
    doc = {
        "_id": f"f-{uuid.uuid4()}",
        "filename": "bat_cyc_20260814_0941.mf4",
        "run_id": run_id,
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
        "registered_at": now,
        "updated_at": now,
    }
    doc.update(overrides)
    db["files"].insert_one(doc)
    return doc
