"""Delete one test run and everything the run is made of (`DELETE /test-runs/{id}`).

A run is not one document. It is the run, the files it registered and the bytes
behind them, the signal rows those files declared, the processed results, and the
samples QuixLake holds under the run's own partition folder. A delete that leaves
any of those behind leaves a run that is half gone: rows nothing points at, bytes
nobody can reach, and a partition that still answers a query.

## The order, and why it is this one

**The lakehouse goes first, and a refusal stops everything.** The samples are the
one part this service cannot find again once the registry row naming the table is
gone. So they go first, and a lake that refuses leaves the registry whole: the
operator presses delete again. The registry never goes first.

**The journal is written before a byte moves.** That is the audit-before-bytes rule
(`plans/AGENT-RULES.md`), the same order `api/api/services/retention.py` keeps.

**The journal stays.** Every other trace of the run goes, but what happened to it is
the audit trail, and a deletion is the last thing that happened. The run's entries
stay where they are and a `run.deleted` entry joins them.

## What a failure leaves

There is no transaction across QuixLake, blob storage and Mongo, so the steps are
ordered so that any stop leaves a state a second press repairs. A byte that will not
delete is **reported, never hidden**: `blobs_failed` names how many stayed, the
registry rows still go, and the operator holds a key list in the log. Keeping the
whole run alive because one object is locked would be worse — the run would then
never delete at all.

## Whole partitions, never a conditional delete

QuixLake removes a hive folder outright. A conditional `WHERE run_id = ...` delete
would rewrite every parquet file of every partition the run touches and still leave
the folder standing. `api/api/services/lake.py` owns that call.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor

from pymongo import UpdateOne
from pymongo.database import Database

from api.errors import ApiError
from api.models.common import Source
from api.provenance import add_event
from api.services import lake as _lake
from api.services.lake import LakeError, LakePartitionError
from api.services.lake import is_configured as lake_is_configured

logger = logging.getLogger(__name__)

# The journal field a deletion writes. One name, so a reader can find every run
# that ever left the registry.
DELETE_EVENT = "run.deleted"

# The table a run points at when ingestion never stated one. `queries_stats` reads
# the same variable and the same default; a run that carries `lake_table` wins over
# both, because it names the table that actually holds its rows.
_DEFAULT_LAKE_TABLE = "test_signal_samples"

# How many objects are removed at once.
#
# One rig run registers ~700 files (`sn002_20260915T090000000Z`: 60 minutes, 641M
# lakehouse rows), and one storage round trip costs 100-300 ms. Removed one after
# another that is minutes inside a single request, and the ingress in front of the
# deployed API hangs up on the browser long before the end — the screen then reads
# "0 runs deleted" for a run whose samples the lakehouse has already dropped.
#
# 16 is deliberately modest. These are single-object deletes, never a bulk request:
# SAG refuses the bulk shapes s3fs builds ("[Errno 22] The request is invalid."),
# so the way to go faster is more requests in flight, not fewer bigger ones.
# `TM_RUN_DELETE_BLOB_WORKERS` dials it down if a gateway complains.
_BLOB_WORKERS = 16
_WORKERS_VAR = "TM_RUN_DELETE_BLOB_WORKERS"


def _blob_workers() -> int:
    """How many removals may be in flight. Never less than one."""
    stated = os.environ.get(_WORKERS_VAR, "").strip()
    if not stated:
        return _BLOB_WORKERS
    try:
        return max(1, int(stated))
    except ValueError:
        logger.warning("%s is not a number (%r), so %s stands", _WORKERS_VAR, stated, _BLOB_WORKERS)
        return _BLOB_WORKERS


def lake_table_of(run: dict) -> str:
    """Name the lakehouse table that holds this run's samples."""
    stated = str(run.get("lake_table") or "").strip()
    if stated:
        return stated
    return os.environ.get("TM_LAKE_TABLE", "").strip() or _DEFAULT_LAKE_TABLE


def _blob_store():
    """Return the blob store, or None when this process reaches no storage.

    Built per call and never cached: a delete is rare, and a cached client that
    went stale would refuse every later delete with no way to recover but a
    restart. A missing client answers None, and the caller reports every object
    as one it did not remove.
    """
    try:
        from ingest.store import build_store

        store, _ = build_store()
    except Exception:  # noqa: BLE001 — no storage must not turn into a 500.
        logger.warning("no blob storage is reachable, so no file byte can be removed")
        return None
    return store


def _delete_samples(table: str, run_id: str) -> dict:
    """Take the run's partition folders out of QuixLake. Fail closed.

    A lake this process cannot reach is not a run that may be deleted: the samples
    would outlive every pointer to them. The caller sees 502 and the registry stays
    exactly as it was.
    """
    if not lake_is_configured():
        logger.warning(
            "no lakehouse is configured, so the samples of run %s stay where they are",
            run_id,
        )
        return {"table": table, "status": "skipped", "partitions": [], "partitions_deleted": 0}

    try:
        partitions = _lake.run_partitions(table, run_id)
        deleted = _lake.delete_partitions(table, partitions)
    except LakePartitionError as error:
        # The lake answered; this client cannot turn the answer into folder paths.
        # Retrying changes nothing, so it does not read as a dependency failure.
        raise ApiError(409, str(error), "lake_partitions_unaddressable") from error
    except LakeError as error:
        raise ApiError(
            502,
            f"QuixLake did not delete the samples of run {run_id}: {error} "
            f"Nothing was removed — try again once the lakehouse answers.",
            "lake_unavailable",
        ) from error

    return {
        "table": table,
        # "empty" is not "skipped": the lake answered and holds nothing for this run.
        "status": "deleted" if partitions else "empty",
        "partitions": partitions,
        "partitions_deleted": deleted,
    }


def _remove_one(store, key: str) -> str | None:
    """Remove one object. Return None, or the fault as text.

    A worker never raises: one locked object must not take the other 699 with it,
    and a raising worker would do exactly that.
    """
    try:
        store.remove(key)
    except Exception as error:  # noqa: BLE001 — every fault is reported, not raised.
        return f"{type(error).__name__}: {error}"
    return None


def _remove_bytes(storage_refs: Iterable[str | None]) -> tuple[int, int]:
    """Delete the object behind every reference. Return (removed, failed).

    A reference nobody stored names no bytes, so it counts as neither. Every fault
    is counted and logged with its key, and none of them stops the pass.

    The removals run CONCURRENTLY (`_blob_workers`). The counting happens here, in
    one thread, over the finished results — so the two numbers add up to the keys
    this pass was given whatever the workers did.
    """
    from api.services.file_bytes import blob_key

    keys = []
    for ref in storage_refs:
        if ref and str(ref).strip():
            keys.append(blob_key(ref))
    if not keys:
        return 0, 0

    store = _blob_store()
    if store is None:
        return 0, len(keys)

    workers = min(_blob_workers(), len(keys))
    # The pod log states the size of the job BEFORE it starts. A request the
    # ingress cuts off leaves no response to read, and this line is then the only
    # record of what the delete was doing when it went.
    logger.info("removing %s object(s) of a deleted run, %s at a time", len(keys), workers)

    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="run-delete") as pool:
        faults = list(pool.map(lambda key: (key, _remove_one(store, key)), keys))

    removed = 0
    failed = 0
    for key, fault in faults:
        if fault is None:
            removed += 1
        else:
            failed += 1
            logger.error("the object %s stayed in storage (%s)", key, fault)
    return removed, failed


def _refresh_catalogue(db: Database, names: list[str]) -> None:
    """Re-derive `run_count` for the names the run held, and drop the empty rows.

    Read AFTER the rows are gone: `run_count` counts the runs the stored rows
    support, never the runs they once supported. A name no run declares any more is
    not a catalogue entry with a zero on it — nothing in the registry knows that
    signal, so the row goes.

    No journal entry is written here. The catalogue is derived state, and the one
    event worth recording (the run left) is already in the journal.
    """
    if not names:
        return

    counts = {
        row["_id"]: row["n"]
        for row in db["file_signals"].aggregate(
            [
                {"$match": {"name": {"$in": names}, "run_id": {"$ne": None}}},
                {"$group": {"_id": {"name": "$name", "run_id": "$run_id"}}},
                {"$group": {"_id": "$_id.name", "n": {"$sum": 1}}},
            ]
        )
    }
    updates = [
        UpdateOne({"_id": name}, {"$set": {"run_count": counts[name]}})
        for name in names
        if counts.get(name)
    ]
    orphaned = [name for name in names if not counts.get(name)]
    if updates:
        db["signals"].bulk_write(updates, ordered=False)
    if orphaned:
        db["signals"].delete_many({"_id": {"$in": orphaned}})


def delete_run(db: Database, run_id: str, *, actor: str) -> dict:
    """Delete one run, everywhere it exists. Return what went.

    Raises 404 for a run the registry does not hold, 502 for a lakehouse that would
    not answer, and 409 when the run's samples cannot be named as whole partitions.
    In each of those the registry is untouched.
    """
    run = db["test_runs"].find_one({"_id": run_id})
    if run is None:
        raise ApiError(404, f"test run '{run_id}' not found", "run_not_found")

    lake_report = _delete_samples(lake_table_of(run), run_id)

    # Read what the bytes are before the documents naming them go.
    refs = [doc.get("storage_ref") for doc in db["files"].find({"run_id": run_id}, {"storage_ref": 1})]
    refs += [
        doc.get("storage_ref")
        for doc in db["processed_results"].find({"run_id": run_id}, {"storage_ref": 1})
    ]
    names = db["file_signals"].distinct("name", {"run_id": run_id})

    # Audit before the bytes go, and before the record does.
    partitions = lake_report["partitions"]
    note = (
        f"Deleted the run and everything under it. "
        f"Lakehouse partitions removed: {len(partitions)} "
        f"({', '.join(partitions) if partitions else 'none'})."
    )
    db["journal_entries"].insert_one(
        add_event("run", run_id, DELETE_EVENT, Source.MANUAL, actor, note=note)
    )

    removed, failed = _remove_bytes(refs)

    signals = db["file_signals"].delete_many({"run_id": run_id}).deleted_count
    files = db["files"].delete_many({"run_id": run_id}).deleted_count
    results = db["processed_results"].delete_many({"run_id": run_id}).deleted_count
    db["test_runs"].delete_one({"_id": run_id})
    _refresh_catalogue(db, names)

    logger.warning(
        "deleted run %s: %s file(s), %s signal row(s), %s result(s), "
        "%s object(s) removed and %s left, lakehouse %s",
        run_id,
        files,
        signals,
        results,
        removed,
        failed,
        lake_report["status"],
    )
    return {
        "run_id": run_id,
        "files": files,
        "signals": signals,
        "results": results,
        "blobs_removed": removed,
        "blobs_failed": failed,
        "lake": lake_report,
    }


__all__ = ["DELETE_EVENT", "delete_run", "lake_table_of"]
