"""Lane B queries: file lists, file detail, per-run stats merge, cross-run stats."""

from datetime import UTC, datetime

from pymongo import ASCENDING, DESCENDING, InsertOne, ReplaceOne, UpdateOne
from pymongo.database import Database
from pymongo.errors import BulkWriteError, DuplicateKeyError

from api import provenance
from api.errors import ApiError
from api.models.common import Pagination, Source
from api.provenance import set_field
from api.services.query_text import every_word_matches

# The plain table. It holds the active files only: an archived file leaves the
# daily table, which is the whole promise of ``POST /files/{id}/archive``, and a
# deleted file sits in the recycle bin.
#
# A stored document written before 20 Aug 2026 carries no ``lifecycle`` field.
# Mongo matches an absent field against ``{"$in": [None]}``, so one clause
# covers the stored ``"active"`` and the old document alike.
#
# This was ``{"$ne": "deleted"}`` until 21 Aug 2026, and ``$ne`` matches
# ``"archived"``, so an archived file never left the table.
LIVE_FILES = {"lifecycle": {"$in": ["active", None]}}


def files_view_counts(db: Database) -> dict:
    """Whole-table counts for /files (contract §2.4).

    Filter-independent. ``all``, ``registered`` and ``quarantined`` count the
    active files, so the numbers match the plain table. ``archived`` and
    ``deleted`` count the two named views, so every tab of the table has a
    number.
    """
    files = db["files"]
    return {
        "all": files.count_documents(LIVE_FILES),
        "registered": files.count_documents({**LIVE_FILES, "status": "registered"}),
        "quarantined": files.count_documents({**LIVE_FILES, "status": "quarantined"}),
        "archived": files.count_documents({"lifecycle": "archived"}),
        "deleted": files.count_documents({"lifecycle": "deleted"}),
    }


def lifecycle_clause(values: list[str] | None) -> dict:
    """Build the ``lifecycle`` filter of /files.

    No value asks for the plain table, which holds the active files only. A
    value asks for one named view: ``lifecycle=archived`` and
    ``lifecycle=deleted`` are the two the screen offers.

    ``active`` also matches a document that carries no field. Mongo matches an
    absent field against ``{"$in": [None]}``, so one clause covers both.
    """
    values = [value for value in (values or []) if str(value).strip()]
    if not values:
        return dict(LIVE_FILES)
    if "active" in values:
        values = [*values, None]
    return {"lifecycle": {"$in": values}}


def files_query(
    status: list[str] | None = None,
    source_system: list[str] | None = None,
    run: str | None = None,
    unlinked: bool | None = None,
    invalid: bool | None = None,
    q: str | None = None,
    lifecycle: list[str] | None = None,
    source: list[str] | None = None,
) -> dict:
    """Build the Mongo query of every contract filter on the files table.

    ``list_files`` and the CSV export (`api/api/services/exports.py`) both read
    it, so the table and the exported file always select the same rows. A
    second copy of these clauses would let the two drift, and a person would
    then export rows the screen never showed.

    The docstring of ``list_files`` states what each filter means.
    """
    clauses: list[dict] = [lifecycle_clause(lifecycle)]
    for field, values in (("status", status), ("source_system", source_system)):
        clause = _in_clause(field, values)
        if clause is not None:
            clauses.append(clause)
    # TR-011: the file carries a source tag per field. This filter keeps the
    # files at least one field of which came from a named source.
    tagged = provenance.source_clause(source)
    if tagged is not None:
        clauses.append(tagged)
    if run:
        clauses.append({"run_id": run})
    if unlinked is not None:
        clauses.append({"run_id": None} if unlinked else {"run_id": {"$ne": None}})
    if invalid is not None:
        clauses.append(
            {"invalid.flagged": True} if invalid else {"invalid.flagged": {"$ne": True}}
        )
    # A blank q filters nothing. It must not become a match-all clause.
    if q and q.strip():
        clauses.append(every_word_matches(q, ("filename", "checksum_sha256", "run_id")))
    return {"$and": clauses} if clauses else {}


def list_files(
    db: Database,
    pagination: Pagination,
    sort_spec: list[tuple[str, int]] | None = None,
    status: list[str] | None = None,
    source_system: list[str] | None = None,
    run: str | None = None,
    unlinked: bool | None = None,
    invalid: bool | None = None,
    q: str | None = None,
    lifecycle: list[str] | None = None,
    source: list[str] | None = None,
) -> dict:
    """Page the files collection, newest registration first by default.

    Multi-value filters (``status``/``source_system``) OR within one key
    and AND across keys, per contract §2.2. A single value keeps its exact
    v1 meaning. ``q`` is word-AND over filename, checksum and run id: every
    word must appear in at least one of the three, in any order. A null run
    id never matches ``q``.

    ``sort_spec`` is the resolved Mongo sort (contract §2.3); when None the
    fixed default of ``registered_at desc`` applies, matching pre-change
    behavior byte-identically.

    ``lifecycle`` follows the same repeated-param style. A caller that sends
    none gets the plain table, which holds the active files only: an archived
    file and a deleted file both stay out of it (21 Aug 2026).

    ``source`` reads the ``field_sources`` map, not a column. A file matches
    when at least one of its fields carries one of the named tags (TR-011).

    ``invalid`` reads the flag a person raised on the file (24 Aug 2026). A
    file registered before that day holds no ``invalid`` key, so ``$ne: True``
    keeps it in the ``invalid=false`` answer, and ``None`` filters nothing.
    """
    query = files_query(
        status=status,
        source_system=source_system,
        run=run,
        unlinked=unlinked,
        invalid=invalid,
        q=q,
        lifecycle=lifecycle,
        source=source,
    )
    total = db["files"].count_documents(query)
    resolved_sort = sort_spec or [("registered_at", DESCENDING), ("_id", ASCENDING)]
    cursor = (
        db["files"]
        .find(query)
        .sort(resolved_sort)
        .skip((pagination.page - 1) * pagination.page_size)
        .limit(pagination.page_size)
    )
    envelope = pagination.envelope(list(cursor), total)
    envelope["view_counts"] = files_view_counts(db)
    return envelope


def _in_clause(field: str, values: list | None) -> dict | None:
    """Return an ``$in`` clause, or None when the caller passed nothing.

    A blank value is nothing. A cleared filter chip still sends its key, so
    the list arrives as ``[""]``. The strip drops it and the clause goes, so
    the table shows every row again.

    Duplicated here (also in ``queries_runs``) rather than imported: keeps
    the two lanes' service files independent, as the plan asks.
    """
    values = [value for value in (values or []) if str(value).strip()]
    if not values:
        return None
    return {field: {"$in": values}}


def get_file_detail(db: Database, file_id: str, signals_limit: int) -> dict:
    """Read the whole file-detail screen in one call.

    The ingestion timeline is the arrival story of the file, in chronological
    order. It leaves out ``file.downloaded``, because a download happens after
    the arrival and it belongs to a different beat. The journal keeps the
    download event: the query hides it, it never drops it.

    The signals come from the file_signals rows, capped by ``signals_limit``.
    """
    file = db["files"].find_one({"_id": file_id})
    if file is None:
        raise ApiError(404, f"File {file_id} not found", "file_not_found")

    timeline = list(
        db["journal_entries"]
        .find(
            {
                "entity_type": "file",
                "entity_id": file_id,
                "field": {"$ne": "file.downloaded"},
            }
        )
        # _id tiebreak, like every other journal read: the registration burst
        # lands same-millisecond entries, and without it the arrival story
        # reordered between two loads of the same screen (25 Aug 2026).
        .sort([("at", ASCENDING), ("_id", ASCENDING)])
    )
    signals = list(db["file_signals"].find({"file_id": file_id}).limit(signals_limit))
    return {**file, "ingestion_timeline": timeline, "signals": signals}


def _unit_entry(update: dict, signal, current_doc: dict | None) -> dict | None:
    """Stage the embedded unit write and return its journal entry, or None.

    One helper for both call sites, so the journal field, the entity and the
    source read the same on a create and on a refresh. ``set_field`` owns the
    precedence: a stored ``manual`` unit outranks the file, and it then returns
    None, so the row keeps its value and nothing is journalled.
    """
    return set_field(
        update,
        "unit",
        signal.unit,
        Source.EMBEDDED,
        actor="ingestion",
        current_doc=current_doc,
        entity_type="signal",
        entity_id=signal.name,
        field_label=f"signal.{signal.name}.unit",
    )


def _new_catalogue_row(
    signal, rig_id: str | None, source_system: str | None, run_count: int, now: datetime
) -> tuple[dict, dict | None]:
    """The document that creates a catalogue row, and the journal entry a stated unit earns."""
    update: dict = {}
    entry = None
    if signal.unit is not None:
        entry = _unit_entry(update, signal, None)
    doc = {
        "_id": signal.name,
        "description": None,
        "unit": signal.unit,
        "unit_source": "embedded",
        "dtype": signal.dtype,
        "typical_rate_hz": signal.rate_hz,
        "run_count": run_count,
        "first_seen": now,
        "last_seen": now,
        "sensor_ref": None,
        "catalogue_ref": None,
        "rig_ids": [rig_id] if rig_id is not None else [],
        # The producing system of the file that taught this row
        # (FR-DM-111). It grows the same way ``rig_ids`` does.
        "source_systems": [source_system] if source_system is not None else [],
        "field_sources": {
            key.removeprefix("field_sources."): value
            for key, value in update.items()
            if key.startswith("field_sources.")
        },
    }
    return doc, entry


def _catalogue_refresh(
    signal,
    existing: dict,
    rig_id: str | None,
    source_system: str | None,
    run_count: int,
    now: datetime,
) -> tuple[dict, dict | None]:
    """The update that refreshes an existing catalogue row, and its journal entry if any."""
    update = {"last_seen": now, "run_count": run_count}
    entry = None
    if existing.get("unit") is None and signal.unit is not None:
        # A stored manual source outranks the file. The helper then returns
        # None and the row keeps its value, its tag and its unit_source.
        entry = _unit_entry(update, signal, existing)
        if entry is not None:
            update["unit_source"] = "embedded"
    change: dict = {"$set": update}
    add_to_set: dict = {}
    if rig_id is not None:
        add_to_set["rig_ids"] = rig_id
    if source_system is not None:
        add_to_set["source_systems"] = source_system
    if add_to_set:
        change["$addToSet"] = add_to_set
    return change, entry


def _upsert_catalogue_row(
    db: Database,
    signal,
    rig_id: str | None,
    source_system: str | None,
    run_count: int,
    now: datetime,
) -> list[dict]:
    """Create or refresh the catalogue row of one signal name.

    Returns the journal entries the write earned. The caller writes them. A
    unit the file taught the catalogue is a real change of a real field, so it
    belongs in the timeline exactly like a person's edit does — the ingest path
    built these entries and threw them away until 21 Aug 2026.

    One row at a time; `upsert_file_signals` stages a whole file in bulk and
    falls back to this for the names that lost a parallel-registration race.
    """
    existing = db["signals"].find_one({"_id": signal.name})
    if existing is None:
        doc, entry = _new_catalogue_row(signal, rig_id, source_system, run_count, now)
        try:
            db["signals"].insert_one(doc)
        except DuplicateKeyError:
            # Two files carrying the same new signal name register in parallel.
            # Both read no row, both insert, and the loser used to raise a 500.
            # The winner's row exists now, so re-read it and take the refresh
            # path below, which is the same work the loser would have done had
            # it read a moment later.
            existing = db["signals"].find_one({"_id": signal.name})
            if existing is None:
                raise
        else:
            return [entry] if entry is not None else []

    change, entry = _catalogue_refresh(signal, existing, rig_id, source_system, run_count, now)
    db["signals"].update_one({"_id": signal.name}, change)
    return [entry] if entry is not None else []


def backfill_source_systems(db: Database) -> int:
    """Fill ``source_systems`` on the catalogue rows written before it existed.

    Run it once. It reads the inventory, maps each file to its producing
    system and adds that system to every catalogue row the file taught. The
    write uses ``$addToSet``, so a second run changes nothing.

    Returns the number of catalogue rows the pass touched.
    """
    systems: dict[str, set[str]] = {}
    file_systems = {
        doc["_id"]: doc.get("source_system")
        for doc in db["files"].find({}, {"source_system": 1})
    }
    for row in db["file_signals"].find({}, {"file_id": 1, "name": 1}):
        system = file_systems.get(row.get("file_id"))
        if system:
            systems.setdefault(row["name"], set()).add(system)

    touched = 0
    for name, values in systems.items():
        result = db["signals"].update_one(
            {"_id": name}, {"$addToSet": {"source_systems": {"$each": sorted(values)}}}
        )
        touched += result.matched_count
    return touched


def upsert_file_signals(db: Database, file_doc: dict, signals: list) -> None:
    """Write the inventory of one registered file and feed the catalogue.

    Every row lands in ``file_signals``, keyed on (file_id, name). The
    catalogue row in ``signals`` follows. A file unit fills a null catalogue
    unit. Write precedence blocks it when a person set that unit, and a
    manual null unit stays null.

    Every catalogue unit this pass writes also lands in the journal. One
    ``insert_many`` for the whole file keeps that to a single round trip.

    In bulk (14 Sep 2026): one recording carries thousands of signals, and one
    round trip per row per step took minutes per file - long enough for every
    client to time out and register the file again. The inventory
    is one ``bulk_write``, the run counts one aggregation, the existing
    catalogue rows one read, and the catalogue writes one bulk per kind. The
    per-row path (``_upsert_catalogue_row``) remains for the names that lose
    a parallel-registration race, exactly as before.
    """
    if not signals:
        return

    run = db["test_runs"].find_one({"_id": file_doc.get("run_id")}, {"rig_id": 1})
    rig_id = (run or {}).get("rig_id")
    # The producing system of this file. The catalogue row keeps every system
    # it ever saw, so a signal that arrives from TAS and from INCA lists both.
    source_system = file_doc.get("source_system")
    now = datetime.now(UTC)

    db["file_signals"].bulk_write(
        [
            ReplaceOne(
                {"file_id": file_doc["_id"], "name": signal.name},
                {
                    "file_id": file_doc["_id"],
                    "run_id": file_doc["run_id"],
                    "name": signal.name,
                    "unit": signal.unit,
                    "unit_source": "embedded",
                    "rate_hz": signal.rate_hz,
                    "dtype": signal.dtype,
                    "stats": signal.stats.model_dump() if signal.stats is not None else None,
                },
                upsert=True,
            )
            for signal in signals
        ],
        ordered=False,
    )

    # run_count counts runs, never registrations. Read it after the write.
    # A row with a null run_id names no run, so it never lifts the count.
    names = [signal.name for signal in signals]
    run_counts = {
        row["_id"]: row["n"]
        for row in db["file_signals"].aggregate(
            [
                {"$match": {"name": {"$in": names}, "run_id": {"$ne": None}}},
                {"$group": {"_id": {"name": "$name", "run_id": "$run_id"}}},
                {"$group": {"_id": "$_id.name", "n": {"$sum": 1}}},
            ]
        )
    }
    existing = {row["_id"]: row for row in db["signals"].find({"_id": {"$in": names}})}

    entries: list[dict] = []
    inserts: list = []
    insert_entries: dict[str, dict | None] = {}
    updates: list = []
    for signal in signals:
        run_count = run_counts.get(signal.name, 0)
        current = existing.get(signal.name)
        if current is None:
            doc, entry = _new_catalogue_row(signal, rig_id, source_system, run_count, now)
            inserts.append(InsertOne(doc))
            insert_entries[signal.name] = entry
        else:
            change, entry = _catalogue_refresh(
                signal, current, rig_id, source_system, run_count, now
            )
            updates.append(UpdateOne({"_id": signal.name}, change))
            if entry is not None:
                entries.append(entry)

    if inserts:
        lost: set[str] = set()
        try:
            db["signals"].bulk_write(inserts, ordered=False)
        except BulkWriteError as error:
            # Two files carrying the same new signal name register in parallel:
            # the names this bulk lost take the per-row path, which re-reads the
            # winner's row and refreshes it. Anything but a duplicate key is a
            # real failure and is raised as such.
            for write_error in error.details.get("writeErrors", []):
                if write_error.get("code") != 11000:
                    raise
                lost.add(write_error["op"]["_id"])
        for signal in signals:
            if signal.name in lost:
                entries.extend(
                    _upsert_catalogue_row(
                        db, signal, rig_id, source_system, run_counts.get(signal.name, 0), now
                    )
                )
            elif signal.name in insert_entries and insert_entries[signal.name] is not None:
                entries.append(insert_entries[signal.name])
    if updates:
        db["signals"].bulk_write(updates, ordered=False)

    if entries:
        db["journal_entries"].insert_many(entries)
