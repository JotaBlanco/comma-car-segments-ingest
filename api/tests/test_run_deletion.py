"""Deleting a test run takes the run and everything the run is made of.

A run is not one document. It is the run, its registered files and the bytes
behind them, the signal rows those files declared, the processed results, and
the samples the lakehouse holds under the run's own partition folder. A delete
that leaves any of those behind leaves a run that is half gone: rows nothing
points at, bytes nobody can reach, and a partition that still answers a query.

Two rules shape the order below.

**The lakehouse goes first, and a refusal stops everything.** The samples are
the one part this service cannot find again once the registry row naming them
is gone, so if the lake will not delete them the registry keeps its record and
the operator can try again. The registry never goes first.

**The journal stays.** Every other trace of the run goes, but what happened to
it is the audit trail, and a deletion is the last thing that happened. The
entries stay and a `run.deleted` entry joins them.
"""

import threading
import time
import uuid
from datetime import UTC, datetime

import pytest

RUN = "RUN-DOOMED"
OTHER = "RUN-KEPT"
TABLE = "pcap_data_v1"
ACTOR = "Tomas Neubauer"


def _seed(db) -> None:
    from api.db import ensure_indexes
    from tests.factories import upsert_run

    ensure_indexes(db)
    stamp = datetime(2026, 9, 15, 9, 0, tzinfo=UTC)
    for run_id in (RUN, OTHER):
        upsert_run(db, _id=run_id, lake_table=TABLE)
        for n in range(3):
            file_id = f"{run_id}-f{n}"
            db["files"].insert_one(
                {
                    "_id": file_id,
                    "filename": f"chunk_{n}.pcap.gz",
                    "run_id": run_id,
                    "source_system": "TAS",
                    "format": "pcap",
                    "size_bytes": 10,
                    "checksum_sha256": uuid.uuid4().hex * 2,
                    "checksum_state": "verified",
                    "status": "registered",
                    "quarantine_reason": None,
                    "storage_ref": f"blob://bucket/{run_id}/{file_id}.pcap.gz",
                    "signal_count": 2,
                    "time_start": None,
                    "time_end": None,
                    "ingestion_job_id": None,
                    "field_sources": {},
                    "registered_at": stamp,
                    "updated_at": stamp,
                }
            )
            db["file_signals"].insert_many(
                [
                    {"_id": f"{file_id}:shared", "file_id": file_id, "run_id": run_id, "name": "shared"},
                    {"_id": f"{file_id}:{run_id}", "file_id": file_id, "run_id": run_id, "name": run_id},
                ]
            )
        db["processed_results"].insert_one(
            {"_id": f"{run_id}-r1", "run_id": run_id, "result_key": "k", "version": 1}
        )
        db["journal_entries"].insert_one(
            {"_id": f"j-{run_id}", "entity_type": "run", "entity_id": run_id, "at": stamp}
        )
    # Two catalogue rows: one name the doomed run shares, one only it holds.
    db["signals"].insert_many(
        [
            {"_id": "shared", "name": "shared", "run_count": 2},
            {"_id": RUN, "name": RUN, "run_count": 1},
        ]
    )


class _Lake:
    """Stands in for QuixLake. Records what it was asked to delete."""

    def __init__(self, *, fails: bool = False, partitions: list[str] | None = None) -> None:
        self.fails = fails
        self.partitions = ["platform=sn002/work_order=WO-1/run_id=" + RUN]
        if partitions is not None:
            self.partitions = partitions
        self.deleted: list[tuple[str, tuple[str, ...]]] = []

    def run_partitions(self, table, run_id, transport=None):
        return list(self.partitions)

    def delete_partitions(self, table, partitions, transport=None):
        from api.services.lake import LakeError

        if self.fails:
            raise LakeError("QuixLake did not answer: ConnectError")
        self.deleted.append((table, tuple(partitions)))
        return len(partitions)


class _Store:
    """Stands in for blob storage. Records removals, refuses the named key.

    Thread-safe and able to report how many removals were in flight at once:
    the run delete removes the bytes of ~700 files for one rig run, and it does
    so concurrently, so a test has to be able to SEE that.
    """

    def __init__(self, *, refuse: str | None = None, delay: float = 0.0) -> None:
        self.removed: list[str] = []
        self.refuse = refuse
        self.delay = delay
        self._lock = threading.Lock()
        self.in_flight = 0
        self.peak_in_flight = 0

    def remove(self, key: str) -> None:
        with self._lock:
            self.in_flight += 1
            self.peak_in_flight = max(self.peak_in_flight, self.in_flight)
        try:
            if self.delay:
                time.sleep(self.delay)
            if self.refuse is not None and key.endswith(self.refuse):
                raise OSError("permission denied")
            with self._lock:
                self.removed.append(key)
        finally:
            with self._lock:
                self.in_flight -= 1


@pytest.fixture
def lake(monkeypatch):
    from api.services import run_deletion

    stub = _Lake()
    monkeypatch.setattr(run_deletion, "_lake", stub)
    monkeypatch.setattr(run_deletion, "lake_is_configured", lambda: True)
    return stub


@pytest.fixture
def store(monkeypatch):
    from api.services import run_deletion

    stub = _Store()
    monkeypatch.setattr(run_deletion, "_blob_store", lambda: stub)
    return stub


def _delete(client, api_token, run_id=RUN):
    return client.request(
        "DELETE",
        f"/api/v1/test-runs/{run_id}",
        json={"actor": ACTOR},
        headers={"Authorization": f"Bearer {api_token}"},
    )


def test_deleting_a_run_takes_everything_the_run_is_made_of(
    client, routed_db, api_token, lake, store
):
    db = routed_db
    _seed(db)

    response = _delete(client, api_token)

    assert response.status_code == 200, response.text
    report = response.json()
    assert report["run_id"] == RUN
    assert report["files"] == 3
    assert report["signals"] == 6
    assert report["results"] == 1
    assert report["blobs_removed"] == 3
    assert report["blobs_failed"] == 0

    assert db["test_runs"].find_one({"_id": RUN}) is None
    assert db["files"].count_documents({"run_id": RUN}) == 0
    assert db["file_signals"].count_documents({"run_id": RUN}) == 0
    assert db["processed_results"].count_documents({"run_id": RUN}) == 0

    # The other run is untouched, in every collection.
    assert db["test_runs"].find_one({"_id": OTHER}) is not None
    assert db["files"].count_documents({"run_id": OTHER}) == 3
    assert db["file_signals"].count_documents({"run_id": OTHER}) == 6
    assert db["processed_results"].count_documents({"run_id": OTHER}) == 1

    # The lakehouse lost the run's partition folder, and only that.
    assert lake.deleted == [(TABLE, tuple(lake.partitions))]
    assert report["lake"]["status"] == "deleted"
    assert report["lake"]["partitions"] == lake.partitions

    # The bytes of every file the run registered are gone.
    assert sorted(store.removed) == sorted(
        f"bucket/{RUN}/{RUN}-f{n}.pcap.gz" for n in range(3)
    )


def test_the_journal_keeps_what_happened_and_gains_the_deletion(
    client, routed_db, api_token, lake, store
):
    db = routed_db
    _seed(db)

    _delete(client, api_token)

    entries = list(db["journal_entries"].find({"entity_id": RUN}))
    kinds = {entry.get("field") or entry.get("kind") for entry in entries}
    assert len(entries) == 2, "the earlier entry stays and the deletion joins it"
    assert "run.deleted" in kinds
    deletion = next(e for e in entries if (e.get("field") or e.get("kind")) == "run.deleted")
    assert deletion["actor"].startswith(ACTOR)


def test_a_signal_the_run_alone_held_leaves_the_catalogue(
    client, routed_db, api_token, lake, store
):
    db = routed_db
    _seed(db)

    _delete(client, api_token)

    assert db["signals"].find_one({"_id": RUN}) is None, "no run holds it any more"
    shared = db["signals"].find_one({"_id": "shared"})
    assert shared["run_count"] == 1, "the other run still holds it"


def test_a_lakehouse_that_refuses_leaves_the_registry_whole(
    client, routed_db, api_token, lake, store
):
    """The samples are the part this service cannot find again. Fail closed."""
    db = routed_db
    _seed(db)
    lake.fails = True

    response = _delete(client, api_token)

    assert response.status_code == 502
    assert response.json()["code"] == "lake_unavailable"
    assert db["test_runs"].find_one({"_id": RUN}) is not None
    assert db["files"].count_documents({"run_id": RUN}) == 3
    assert store.removed == [], "no byte goes before the samples do"


def test_a_byte_that_will_not_delete_is_reported_not_hidden(
    client, routed_db, api_token, lake, monkeypatch
):
    from api.services import run_deletion

    db = routed_db
    _seed(db)
    stub = _Store(refuse="f1.pcap.gz")
    monkeypatch.setattr(run_deletion, "_blob_store", lambda: stub)

    report = _delete(client, api_token).json()

    assert report["blobs_removed"] == 2
    assert report["blobs_failed"] == 1
    assert db["test_runs"].find_one({"_id": RUN}) is None, "the registry still goes"


def test_an_unconfigured_lakehouse_is_said_plainly(client, routed_db, api_token, store, monkeypatch):
    from api.services import run_deletion

    db = routed_db
    _seed(db)
    monkeypatch.setattr(run_deletion, "lake_is_configured", lambda: False)

    report = _delete(client, api_token).json()

    assert report["lake"]["status"] == "skipped"
    assert report["lake"]["partitions"] == []
    assert db["test_runs"].find_one({"_id": RUN}) is None


def test_deleting_a_run_that_is_not_there_answers_404(client, routed_db, api_token, lake, store):
    _seed(routed_db)

    response = _delete(client, api_token, run_id="RUN-NEVER")

    assert response.status_code == 404
    assert response.json()["code"] == "run_not_found"


# --- the bytes of a big run ----------------------------------------------------------
#
# `sn002_20260915T090000000Z` is a 60-minute rig run: 641M rows in the lakehouse and
# ~700 registered files (`flight-test-station/ai/kb/signals.md`). One HTTP request has
# to remove ~700 objects, and one storage round trip takes 100-300 ms, so removing them
# one after another is minutes of work — long enough for the ingress in front of the
# deployed API to hang up on the browser while the delete is still running. That failure
# reached the screen as "0 runs deleted ... Request failed with status 500", with the
# run's samples already gone from the lakehouse.
#
# So the removals go CONCURRENTLY, and these two tests hold that: the first proves the
# concurrency is real (a sequential loop cannot show more than one removal in flight),
# the second proves the counting stays right when several threads report at once.

BIG = "RUN-BIG"
BIG_FILES = 60


def _seed_big(db) -> None:
    """One run with many files, each carrying bytes of its own."""
    from api.db import ensure_indexes
    from tests.factories import upsert_run

    ensure_indexes(db)
    stamp = datetime(2026, 9, 15, 9, 0, tzinfo=UTC)
    upsert_run(db, _id=BIG, lake_table=TABLE)
    db["files"].insert_many(
        [
            {
                "_id": f"{BIG}-f{n}",
                "filename": f"chunk_{n}.pcap.gz",
                "run_id": BIG,
                "source_system": "TAS",
                "format": "pcap",
                "size_bytes": 10,
                "checksum_sha256": uuid.uuid4().hex * 2,
                "checksum_state": "verified",
                "status": "registered",
                "quarantine_reason": None,
                "storage_ref": f"blob://bucket/{BIG}/{BIG}-f{n}.pcap.gz",
                "signal_count": 0,
                "time_start": None,
                "time_end": None,
                "ingestion_job_id": None,
                "field_sources": {},
                "registered_at": stamp,
                "updated_at": stamp,
            }
            for n in range(BIG_FILES)
        ]
    )


def test_the_bytes_of_a_big_run_are_removed_concurrently(
    client, routed_db, api_token, lake, monkeypatch
):
    """A sequential loop over 700 objects outlives the request that asked for it."""
    from api.services import run_deletion

    _seed_big(routed_db)
    # Each removal takes a little while, as a real one does. Without concurrency the
    # 60 of them would take 60 x delay and never overlap.
    store = _Store(delay=0.02)
    monkeypatch.setattr(run_deletion, "_blob_store", lambda: store)

    started = time.monotonic()
    report = _delete(client, api_token, run_id=BIG).json()
    elapsed = time.monotonic() - started

    assert report["blobs_removed"] == BIG_FILES
    assert report["blobs_failed"] == 0
    assert sorted(store.removed) == sorted(
        f"bucket/{BIG}/{BIG}-f{n}.pcap.gz" for n in range(BIG_FILES)
    ), "every object exactly once, and none twice"
    assert store.peak_in_flight >= 2, "a sequential loop never has two removals in flight"
    # The honest bound: many at a time must beat one at a time by a wide margin.
    assert elapsed < BIG_FILES * store.delay, (
        f"{elapsed:.2f}s is no better than removing them one by one"
    )


def test_a_refusal_among_many_is_still_counted_exactly(
    client, routed_db, api_token, lake, monkeypatch
):
    """Threads report into one pair of counters, so the arithmetic must hold."""
    from api.services import run_deletion

    _seed_big(routed_db)
    # Three of the sixty refuse: every file whose name ends in this suffix.
    store = _Store(refuse="9.pcap.gz", delay=0.01)
    monkeypatch.setattr(run_deletion, "_blob_store", lambda: store)

    report = _delete(client, api_token, run_id=BIG).json()

    refused = sum(1 for n in range(BIG_FILES) if f"{n}".endswith("9"))
    assert report["blobs_failed"] == refused
    assert report["blobs_removed"] == BIG_FILES - refused
    assert report["blobs_removed"] + report["blobs_failed"] == BIG_FILES
    assert routed_db["test_runs"].find_one({"_id": BIG}) is None, "the registry still goes"
