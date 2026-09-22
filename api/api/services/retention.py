"""The retention purge of the recycle bin (FR-DM-042).

`DELETE /files/{file_id}` is a soft delete. It writes `lifecycle: "deleted"`,
it keeps every byte, and it keeps the whole registry record. FR-DM-042 asks
for one more step: a deleted file leaves the recycle bin by itself after a
configurable retention period.

This module is that step.

## What a purge removes, and what it never touches

A purge removes the **registry record**: the `files` document and the
`file_signals` rows that hang off it. It then re-derives the run's counts, so
no run keeps a `file_count` no stored row supports.

**A purge deletes no byte.** No provider in this service exposes a delete
(`api/api/services/file_bytes.py`), the storage layer owns the object, and
`plans/scenarios/COVERAGE-CHECK.md:137` names that split. A purge is therefore
**final for the registry and reversible from storage**: an operator can
register the same object again.

## Audit before the record goes

The pass writes the `file.purged` journal event **first**, and it removes the
document second. That is the write order of the audit-before-bytes rule
(`plans/AGENT-RULES.md`). The journal lives in another collection and no code
deletes a journal entry, so the trace outlives the record it describes.

A restore that lands between the journal write and the delete leaves the entry
and keeps the file: the delete filter still names `lifecycle: "deleted"`. The
window is one round trip wide, and the safe half is the one that keeps the
file.

## A quarantined file never purges

The never-drop rule keeps a file the registry could not place. So the query
skips `status: "quarantined"`, whatever a person did to its lifecycle.

## Why this is a pass and not a TTL index

A Mongo TTL index is one line of setup and it deletes in silence. It writes no
journal entry, it removes the `file_signals` rows of nothing, and it re-derives
no run count. The audit rule beats the one-line setup, so this module runs a
pass instead.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import UTC, datetime, timedelta

from pymongo.database import Database

from api.models.common import Source
from api.provenance import add_event
from api.services import queries_runs

logger = logging.getLogger(__name__)

# Days a deleted file stays in the recycle bin. `0` turns the purge off.
RETENTION_DAYS_VAR = "TM_FILE_RETENTION_DAYS"
DEFAULT_RETENTION_DAYS = 30

# Seconds between two passes. This is a constant on purpose: FR-DM-042 asks for
# one configurable value, the retention period, and a second name would give an
# operator a knob the requirement never asked for.
PASS_INTERVAL_SECONDS = 3600.0

# The journal event of a purge, and the service that writes it. "system" names
# nobody and `provenance._check_actor` refuses it, so the actor names this pass.
PURGE_EVENT = "file.purged"
PURGE_ACTOR = "retention"


def retention_days() -> int:
    """Read the retention period in days.

    An absent value and a value that is not a number both read as the default.
    `0` and any negative number turn the purge off, because a destructive pass
    needs an off switch an operator can reach.
    """
    raw = os.environ.get(RETENTION_DAYS_VAR, "").strip()
    if not raw:
        return DEFAULT_RETENTION_DAYS
    try:
        return int(raw)
    except ValueError:
        return DEFAULT_RETENTION_DAYS


def purge_cutoff(now: datetime | None = None) -> datetime | None:
    """The moment a deleted file becomes old enough to purge.

    Return `None` when the purge is off. A file whose delete landed before this
    moment leaves the recycle bin on the next pass.
    """
    days = retention_days()
    if days <= 0:
        return None
    return (now or datetime.now(UTC)) - timedelta(days=days)


def _stale_query(cutoff: datetime) -> dict:
    """Match every file the purge may remove.

    `updated_at` is the clock. `_write_lifecycle` stamps it on the delete, and
    `PATCH /files/{file_id}` refuses a deleted file with 409, so nothing bumps
    the stamp while the file waits in the bin. A restore writes `active`, which
    takes the row out of this match at once.
    """
    return {
        "lifecycle": "deleted",
        "status": {"$ne": "quarantined"},
        "updated_at": {"$lt": cutoff},
    }


def purge_once(db: Database, now: datetime | None = None) -> int:
    """Run one purge pass and return how many records it removed.

    The order per file is fixed: journal first, rows second, document third,
    run rollup last.
    """
    cutoff = purge_cutoff(now)
    if cutoff is None:
        return 0

    purged = 0
    days = retention_days()
    note = (
        f"Purged after {days} days in the recycle bin. "
        f"The stored object stays, and the storage layer owns it."
    )
    for file_doc in list(db["files"].find(_stale_query(cutoff))):
        file_id = file_doc["_id"]
        # Audit before the record goes. A failed journal write raises, and the
        # document then stays, so no record leaves without a trace.
        db["journal_entries"].insert_one(
            add_event("file", file_id, PURGE_EVENT, Source.EMBEDDED, PURGE_ACTOR, note=note)
        )
        removed = db["files"].delete_one({"_id": file_id, "lifecycle": "deleted"})
        if not removed.deleted_count:
            # A restore won the race. The file stays whole and its rows stay.
            continue
        db["file_signals"].delete_many({"file_id": file_id})
        purged += 1
        # The run counts read the stored rows, so the run must re-derive them.
        queries_runs.apply_file_rollup(db, file_doc.get("run_id"), file_doc)

    if purged:
        logger.warning(
            "the retention purge removed %s file record(s) older than %s days",
            purged,
            days,
        )
    return purged


async def purge_worker() -> None:
    """Run one purge pass every `PASS_INTERVAL_SECONDS`, for the app's lifetime.

    **The worker waits first and purges second.** A destructive pass must not
    ride a pod restart, and a restart loop would otherwise run it over and over.

    Every failure stays inside this loop. A purge that raises must never take
    the `/api/v1` routes down with it, so the pass logs and the loop goes on.
    """
    from api.db import get_db

    while True:
        await asyncio.sleep(PASS_INTERVAL_SECONDS)
        try:
            await asyncio.to_thread(purge_once, get_db())
        except Exception:
            logger.exception("the retention purge pass failed")
