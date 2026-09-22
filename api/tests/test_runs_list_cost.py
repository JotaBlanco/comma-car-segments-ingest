"""The runs list answers from numbers, never by reading the rows behind them.

One synthetic sortie registers ~720 chunk files and each file carries its
signals, so a single run holds tens of thousands of `file_signals` rows. The
list shows two NUMBERS from those rows — how many files the run has and how
many distinct signals — and nothing else. It must therefore never pay to read
the rows themselves.

It used to. `run_facts` grouped `file_signals` by `run_id` with `$addToSet` over
the name, and with an index on `run_id` alone Mongo fetched every matching
document to read that name: ~78,000 documents per page of twenty runs, which is
where a three-second list went. An index that carries the name beside the run id
answers the same question from the index alone.

The file LIST is the lazy half of the same rule: a run's files are read when a
person opens them, and then a page at a time.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

FILES = 300
SIGNALS_PER_FILE = 50
RUN = "RUN-SORTIE"

# What the index-only plan is allowed to touch. It examines no document at all;
# the slack absorbs the run document itself and anything the harness writes.
DOCUMENT_BUDGET = 50


def _seed_big_run(db) -> None:
    """One run with many files, each carrying the same signal names."""
    from api.db import ensure_indexes
    from tests.factories import upsert_run

    ensure_indexes(db)
    upsert_run(db, _id=RUN, description="the synthetic sortie")
    stamp = datetime(2026, 9, 15, 9, 0, tzinfo=UTC)
    names = [f"sig_{i:04d}" for i in range(SIGNALS_PER_FILE)]
    files, signals = [], []
    for n in range(FILES):
        file_id = f"{RUN}-f{n:04d}"
        files.append(
            {
                "_id": file_id,
                "filename": f"chunk_{n:05d}.pcap.gz",
                "run_id": RUN,
                "source_system": "TAS",
                "format": "pcap",
                "size_bytes": 1024,
                "checksum_sha256": uuid.uuid4().hex * 2,
                "checksum_state": "verified",
                "status": "registered",
                "quarantine_reason": None,
                "storage_ref": "blob://test/chunk",
                "signal_count": SIGNALS_PER_FILE,
                "time_start": None,
                "time_end": None,
                "ingestion_job_id": None,
                "field_sources": {},
                "registered_at": stamp + timedelta(seconds=n),
                "updated_at": stamp + timedelta(seconds=n),
            }
        )
        signals.extend(
            {"_id": f"{file_id}:{name}", "file_id": file_id, "run_id": RUN, "name": name}
            for name in names
        )
    db["files"].insert_many(files)
    db["file_signals"].insert_many(signals)


@pytest.fixture
def profiling(routed_db):
    """Record the operations of ONE request on this test's own database.

    The profiler is per database and every test has its own, so this records
    the request under test and nothing else, even with the suite running
    several tests at once. It is started after the seeding, so the writes that
    set the scene are not counted as the reading the request does.
    """
    started = False

    def start() -> None:
        nonlocal started
        routed_db.command("profile", 2)
        started = True

    yield start
    if started:
        routed_db.command("profile", 0)
        routed_db["system.profile"].drop()


def _documents_examined(db, collection: str) -> int:
    entries = db["system.profile"].find({"ns": f"{db.name}.{collection}"})
    return sum(entry.get("docsExamined", 0) for entry in entries)


def test_listing_runs_never_reads_the_signal_rows(client, routed_db, profiling, api_token):
    """A page of runs costs index keys, not documents."""
    db = routed_db
    _seed_big_run(db)
    profiling()

    response = client.get(
        "/api/v1/test-runs?page=1&page_size=20",
        headers={"Authorization": f"Bearer {api_token}"},
    )

    assert response.status_code == 200, response.text
    run = next(item for item in response.json()["items"] if item["run_id"] == RUN)
    assert run["file_count"] == FILES
    assert run["signal_count"] == SIGNALS_PER_FILE

    examined = _documents_examined(db, "file_signals")
    assert examined <= DOCUMENT_BUDGET, (
        f"the runs list read {examined} signal documents for one run of "
        f"{FILES} files; it needs their count, not their contents"
    )


def test_a_runs_files_are_read_one_page_at_a_time(client, routed_db, api_token):
    """The lazy half: a run's files page, and the total still names them all."""
    _seed_big_run(routed_db)
    headers = {"Authorization": f"Bearer {api_token}"}

    body = client.get(
        f"/api/v1/test-runs/{RUN}/files?page=2&page_size=20", headers=headers
    ).json()

    assert body["total"] == FILES
    assert len(body["items"]) == 20

    first = client.get(
        f"/api/v1/test-runs/{RUN}/files?page=1&page_size=20", headers=headers
    ).json()
    assert {item["file_id"] for item in first["items"]}.isdisjoint(
        {item["file_id"] for item in body["items"]}
    )


def test_asking_for_no_page_still_answers_with_every_file(client, routed_db, api_token):
    """Contract #6 is unchanged for a caller that names no page."""
    _seed_big_run(routed_db)

    body = client.get(
        f"/api/v1/test-runs/{RUN}/files", headers={"Authorization": f"Bearer {api_token}"}
    ).json()

    assert set(body) == {"items", "total"}
    assert body["total"] == FILES
    assert len(body["items"]) == FILES
