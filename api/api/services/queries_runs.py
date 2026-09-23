"""Lane A queries over the run registry and the planning mirror.

The run upsert, list, detail, patch and invalid flag live here, next to the
file rollup helper, the mirror reads, the Home summary, the one search box
and the lineage chain. Every write goes through the provenance helpers, so
each stored value keeps its source tag and its journal line.
"""

from datetime import UTC, datetime, timedelta

from pymongo import ASCENDING, DESCENDING
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError

from api import provenance
from api.errors import ApiError
from api.models.common import Pagination, Source
from api.models.planning import default_render_markdown
from api.models.runs import custom_group_key
from api.provenance import add_event, derive_status, plain_values, set_field, sources
from api.services.query_text import every_word_matches, rank_by_relevance

# The upsert fills these from the manifest the pipeline sends. Identity fields
# are handled apart. `operator` and `bench_sw` joined on 19 Aug 2026: the run
# detail screen draws a meta cell for each, and only a hand edit could fill them.
# `lake_table` joined on 21 Aug 2026: ingestion states which lakehouse table
# holds the run's samples (tm-connector reads it from the LAKE_TABLE project
# variable - the same value mf4-sink's TABLE_NAME references, which is what
# keeps the claim from drifting from the writer), and the run records it so the
# pointer survives a later table bump.
_MERGEABLE_FIELDS = ("description", "test_cell", "operator", "bench_sw", "lake_table")

# Some writers stamp the epoch as a sentinel for "the source has no wall clock".
# The comma pipeline does this. A start time at or before this limit is unknown,
# never a real measurement time. The producer stamps the sentinel and the
# registry refuses it at its own door. The measurement-file parser that held the
# same limit moved to the ingestion pipeline on 19 Aug 2026, so the registry can
# no longer see the bytes and must keep checking what it is told.
#
# The limit is a one-day window and not an exact match, for two reasons. A writer
# that stamps a local midnight of 1970-01-01 lands up to 14 hours after the epoch
# in UTC, so an exact match misses it. MDF 4 also stores the time as unsigned
# nanoseconds, so no file can hold a time before the epoch, and the window only
# needs to reach forward. No MDF file records a real 1970 date.
EPOCH_SENTINEL_LIMIT = datetime(1970, 1, 2, tzinfo=UTC)


def _real_start(value: datetime | None) -> datetime | None:
    """Return the start time. Return None when the value is the epoch sentinel.

    A false 1970 time is worse than no time. The run start lowers to the
    earliest start it sees, and `first_data_at` is the runs-list sort key, so
    one sentinel sends the run to the bottom of every list.
    """
    if value is not None and value <= EPOCH_SENTINEL_LIMIT:
        return None
    return value


# Journal display labels (contract §A). Most fields read as run.<field>. The
# definition SET keeps the label the scalar carried, so the timeline of a run
# written before the set existed still reads as one history.
_FIELD_LABELS = {"work_order_id": "run.work_order", "definition_ids": "run.definition"}

# The definition store a person writes custom properties into. Planning names
# no such field, so `planning_sync._mirror_definitions` never writes it and no
# sync pass can erase a property a person typed. The router writes it; the
# definition detail reads it as `custom_properties`.
MANUAL_PROPERTIES_FIELD = "manual_custom_properties"

# The run document stores its own free property map under this name.
CUSTOM_PROPERTIES_FIELD = "custom_properties"

# Planning owns these fields (`api/api/planning_sync.py` PLANNING_FIELDS). The
# ingestion pipeline may CLAIM the two ids, and a claim is not a planning write.
# The claim resolves against the mirror the sync fills, so the registry links
# nothing planning does not already know.
_CLAIM_MIRRORS = {"work_order_id": "work_orders", "definition_id": "test_definitions"}

# The journal event an unresolved claim writes (contract §D, run link claims).
_CLAIM_EVENTS = {
    "work_order_id": "run.work_order_claim_unresolved",
    "definition_id": "run.definition_claim_unresolved",
}

# Where a claim the mirror could not answer is REMEMBERED (PROPOSED addition,
# see `api/api/models/runs.py` and plans/SECOND-WAVE-PROPOSAL.md). The claim
# used to survive only as prose inside a journal note, so a run produced before
# planning knew its work order could never be linked automatically, even once
# planning learned that id. `planning_sync._link_retained_claims` reads these.
#
# They are deliberately NOT the planning-owned fields, and they carry no
# `field_sources` entry: a memory has no authority, so it must never enter the
# precedence machinery, satisfy the `awaiting_work_order` exit, or be read
# anywhere a screen reads links. The `run.*_claim_unresolved` event already
# journals the claim, so retention adds no second entry and no new event name.
CLAIM_RETAINED = {
    "work_order_id": "claimed_work_order_id",
    "definition_id": "claimed_definition_id",
}


def _claimed_ids(body, field: str) -> list[str]:
    """The ids one claim field states, deduplicated and in a stable order.

    `definition_id` and `definition_ids` are ONE claim on the wire: a producer
    that knows a single test case states the scalar, and a bench that ticked off
    three states the list. Both resolve against the same mirror.
    """
    values = [value for value in (getattr(body, field, None),) if value is not None]
    if field == "definition_id":
        values.extend(getattr(body, "definition_ids", None) or [])
    return sorted(set(values))


def _resolve_claims(db: Database, body) -> tuple[dict, list[tuple[str, str]]]:
    """Split the claimed links into the resolved values and the unknown ids.

    A claim names a planning row. The registry links it only when the mirror
    holds that row. An unknown id links nothing and refuses nothing: the run
    stays amber, keeps the claim (`CLAIM_RETAINED`), and the next planning sync
    repairs it.

    The resolved definitions land under `definition_ids`, the field the document
    stores, whichever of the two wire fields carried them.
    """
    resolved: dict = {}
    unresolved: list[tuple[str, str]] = []
    for field, collection in _CLAIM_MIRRORS.items():
        for claimed in _claimed_ids(body, field):
            mirror = db[collection].find_one({"_id": claimed})
            if mirror is None:
                unresolved.append((field, claimed))
                continue
            if field == "definition_id":
                resolved["definition_ids"] = [*resolved.get("definition_ids", []), claimed]
                continue
            resolved[field] = claimed
            # `project` stays out of the body. It comes from the work order the
            # claim resolved to, the same way `_backfill_runs` derives it.
            if mirror.get("project") is not None:
                resolved["project"] = mirror["project"]
    return resolved, unresolved


def _claim_note(claimed: str) -> str:
    return f"Claimed {claimed}. The planning mirror holds no such row."


def _write_claims(
    db: Database, body, resolved: dict, update: dict, current_doc: dict | None
) -> list[dict]:
    """Write the resolved links and return their journal entries.

    A claim always carries the `embedded` tag, whatever `source` the body
    states. The pipeline states the id; it never states the authority. The
    precedence `manual > api:* > embedded` then lets a planning sync and a
    person outrank it.
    """
    entries: list[dict] = []
    for field, value in resolved.items():
        if current_doc is not None and current_doc.get(field) == value:
            continue
        entry = set_field(
            update,
            field,
            value,
            Source.EMBEDDED,
            body.actor,
            current_doc=current_doc,
            entity_id=body.run_id,
            field_label=_FIELD_LABELS.get(field, f"run.{field}"),
        )
        if entry is not None:
            entries.append(entry)
    return entries


def _retained_claims(unresolved: list[tuple[str, str]], current_doc: dict | None) -> dict:
    """The plain writes that remember each unknown claim. No source, no journal.

    A run already remembering the same id writes nothing, so a replaying
    pipeline leaves the stored document untouched. A later, different claim
    replaces the remembered one: the bench's latest word is the one a repair
    should act on.

    The memory is one id per field. A payload claiming several unknown
    definitions remembers the first, and `_resolve_retained_claim` re-opens the
    work order from it — enough to close the loop.
    """
    first: dict[str, str] = {}
    for field, claimed in unresolved:
        first.setdefault(CLAIM_RETAINED[field], claimed)
    return {
        target: claimed
        for target, claimed in first.items()
        if (current_doc or {}).get(target) != claimed
    }


def _unresolved_claim_events(
    db: Database, body, unresolved: list[tuple[str, str]]
) -> list[dict]:
    """Journal each unknown claim once. A replay adds no second entry."""
    entries: list[dict] = []
    for field, claimed in unresolved:
        label = _CLAIM_EVENTS[field]
        note = _claim_note(claimed)
        already = db["journal_entries"].find_one(
            {"entity_type": "run", "entity_id": body.run_id, "field": label, "note": note}
        )
        if already is not None:
            continue
        entries.append(
            add_event("run", body.run_id, label, Source.EMBEDDED, body.actor, note=note)
        )
    return entries


def upsert_run(db: Database, body) -> tuple[dict, bool]:
    """Register a run, or merge new facts into the one already stored.

    Returns the run document and whether this call created it. The same
    payload may arrive many times — a rig retries, the watcher restarts, the
    seed replays — so only the first call writes a registration event, and an
    unchanged replay writes nothing at all.
    """
    existing = db["test_runs"].find_one({"_id": body.run_id})
    if existing is None:
        try:
            return _insert_run(db, body), True
        except DuplicateKeyError:
            # A parallel POST won the race between the find and the insert.
            # Read the winner and merge into it, so this caller answers 200.
            existing = db["test_runs"].find_one({"_id": body.run_id})
    return _merge_run(db, body, existing), False


def _insert_run(db: Database, body) -> dict:
    """Create the run. Every field the caller supplied carries its source."""
    now = datetime.now(UTC)
    started_at = _real_start(body.started_at)
    update: dict = {"_id": body.run_id}

    for field in ("rig_id", *_MERGEABLE_FIELDS):
        value = getattr(body, field)
        if value is not None:
            set_field(update, field, value, body.source, body.actor)

    resolved, unresolved = _resolve_claims(db, body)
    _write_claims(db, body, resolved, update, current_doc=None)

    doc = {
        "_id": body.run_id,
        "description": None,
        "work_order_id": None,
        "definition_ids": [],
        "claimed_work_order_id": None,
        "claimed_definition_id": None,
        "project": None,
        "rig_id": body.rig_id,
        "test_cell": None,
        "operator": None,
        "bench_sw": None,
        "started_at": started_at,
        "ended_at": body.ended_at,
        # The window the producer STATED for the run, kept apart from the
        # served window above. `apply_file_rollup` re-derives `started_at` and
        # `ended_at` from the run's files, so it needs the stated window as a
        # separate input: a file that re-links away must not take a time the
        # producer stated for the run itself. A run document written before
        # this pair existed holds neither key, and that reads as "the producer
        # stated no window".
        "reported_started_at": started_at,
        "reported_ended_at": body.ended_at,
        # The arrival column needs a value even when the file carries no start.
        "first_data_at": started_at or now,
        "invalid": {"flagged": False, "reason": None, "actor": None, "at": None},
        "file_count": 0,
        "signal_count": 0,
        "field_sources": {},
        "created_at": now,
        "updated_at": now,
    }
    doc.update(plain_values(update))
    doc.update(_retained_claims(unresolved, None))
    doc["field_sources"] = sources(update)
    doc["status"] = derive_status(doc)

    db["test_runs"].insert_one(doc)
    entries = [add_event("run", body.run_id, "run.registered", body.source, body.actor)]
    entries.extend(_unresolved_claim_events(db, body, unresolved))
    db["journal_entries"].insert_many(entries)
    return doc


def _merge_run(db: Database, body, existing: dict) -> dict:
    """Fill the fields this payload knows, and never lower a stored source."""
    update: dict = {}
    entries: list[dict] = []

    for field in _MERGEABLE_FIELDS:
        value = getattr(body, field)
        if value is None or existing.get(field) == value:
            continue
        entry = set_field(
            update,
            field,
            value,
            body.source,
            body.actor,
            current_doc=existing,
            field_label=_FIELD_LABELS.get(field, f"run.{field}"),
        )
        if entry is not None:
            entries.append(entry)

    resolved, unresolved = _resolve_claims(db, body)
    entries.extend(_write_claims(db, body, resolved, update, current_doc=existing))
    entries.extend(_unresolved_claim_events(db, body, unresolved))
    update.update(_retained_claims(unresolved, existing))

    entries.extend(_note_rig_conflict(db, body, existing, update))
    _extend_time_range(body, existing, update)

    # A rig conflict changes no stored value, so it journals without an update.
    if not update and not entries:
        return existing

    if update:
        update["updated_at"] = datetime.now(UTC)
        update["status"] = derive_status({**existing, **plain_values(update)})
        db["test_runs"].update_one({"_id": body.run_id}, {"$set": update})
    if entries:
        db["journal_entries"].insert_many(entries)

    return db["test_runs"].find_one({"_id": body.run_id})


def _note_rig_conflict(db: Database, body, existing: dict, update: dict) -> list[dict]:
    """Record a second rig for the same run without mutating the identity.

    A rig id is identity. Two rigs for one run means the caller is wrong, or
    the run id is not as unique as we believe. Keep the stored value, say so in
    the journal once, and let a human judge it (BE-PLAN §4.1).
    """
    if body.rig_id == existing.get("rig_id"):
        return []

    already_reported = db["journal_entries"].find_one(
        {"entity_type": "run", "entity_id": body.run_id, "field": "rig_id", "new": body.rig_id}
    )
    if already_reported is not None:
        return []

    # The conflict is journalled, never applied: the throwaway dict keeps the
    # stored document untouched. No stored doc is passed, because precedence
    # must not silence the report when a person already corrected the rig.
    entry = set_field(
        {}, "rig_id", body.rig_id, body.source, body.actor,
        note="conflicting embedded value ignored — the stored rig identity stands",
        entity_id=body.run_id,
    )
    entry["old"] = str(existing.get("rig_id"))
    return [entry]


def _extend_time_range(body, existing: dict, update: dict) -> None:
    """Grow the run's window to hold this payload. A run spans all its files.

    The stated window grows with the served one. `apply_file_rollup` reads the
    stated window, so a payload that widens the run must widen both, or the
    next file registration derives the run back to the narrower window.
    """
    reported_start = _earliest(existing.get("reported_started_at"), _real_start(body.started_at))
    if reported_start is not None and reported_start != existing.get("reported_started_at"):
        update["reported_started_at"] = reported_start

    reported_end = _latest(existing.get("reported_ended_at"), body.ended_at)
    if reported_end is not None and reported_end != existing.get("reported_ended_at"):
        update["reported_ended_at"] = reported_end

    started = _earliest(existing.get("started_at"), _real_start(body.started_at))
    if started is not None and started != existing.get("started_at"):
        update["started_at"] = started
        if existing.get("first_data_at") is None or started < existing["first_data_at"]:
            update["first_data_at"] = started

    ended = _latest(existing.get("ended_at"), body.ended_at)
    if ended is not None and ended != existing.get("ended_at"):
        update["ended_at"] = ended


def _earliest(stored, incoming):
    if stored is None:
        return incoming
    if incoming is None:
        return stored
    return min(stored, incoming)


def _latest(stored, incoming):
    if stored is None:
        return incoming
    if incoming is None:
        return stored
    return max(stored, incoming)


def _in_clause(field: str, values: list | None) -> dict | None:
    """Return an ``$in`` clause, or None when the caller passed nothing.

    A blank value is nothing. A cleared filter chip still sends its key, so
    the list arrives as ``[""]``. The strip drops it and the clause goes, so
    the table shows every row again.

    A one-element list plans identically to an equality match in Mongo,
    so the single-value contract is byte-identical for old callers.
    """
    values = [value for value in (values or []) if str(value).strip()]
    if not values:
        return None
    return {field: {"$in": values}}


def runs_view_counts(db: Database) -> dict:
    """Whole-table counts for /test-runs (contract §2.4, decision box 3).

    Filter-independent. `attention` is `status != complete`, driven by
    an `$in` on the two non-complete statuses — index-friendlier than
    `$ne` on a non-sparse field.
    """
    runs = db["test_runs"]
    return {
        "all": runs.count_documents({}),
        "attention": runs.count_documents(
            {"status": {"$in": ["awaiting_work_order", "invalid"]}}
        ),
        "invalid": runs.count_documents({"status": "invalid"}),
    }


def _sorted_facet_strings(values: list) -> list[str]:
    """Sort the string values ascending and drop the null and blank ones.

    A null value belongs to no filter option — an unlinked run has no project
    a person can select — and a blank value filters nothing, because
    ``_in_clause`` drops it on the way in.
    """
    return sorted(value for value in values if isinstance(value, str) and value.strip())


def run_facets(db: Database) -> dict:
    """The distinct filter values of the whole runs table (contract #2b).

    Two Mongo ``distinct`` calls. ``rig_id`` and ``project`` each carry an
    index (``api/api/db.py``), so each call reads an index.
    """
    runs = db["test_runs"]
    return {
        "rigs": _sorted_facet_strings(runs.distinct("rig_id")),
        "projects": _sorted_facet_strings(runs.distinct("project")),
        "custom_property_keys": _custom_property_keys(runs),
    }


def _custom_property_keys(runs) -> list[str]:
    """Every custom property key the runs table holds, sorted ascending.

    `distinct` reads values, never keys, so this turns each map into its pairs
    and groups on the key. The Group-by control reads the answer, so a person
    picks a key some run really carries (contract §2b, FR-DM-108).
    """
    pipeline = [
        {"$project": {"pairs": {"$objectToArray": {"$ifNull": [f"${CUSTOM_PROPERTIES_FIELD}", {}]}}}},
        {"$unwind": "$pairs"},
        {"$group": {"_id": "$pairs.k"}},
    ]
    return _sorted_facet_strings([row["_id"] for row in runs.aggregate(pipeline)])


def work_order_facets(db: Database) -> dict:
    """The distinct filter values of the whole mirror (contract #10b)."""
    return {
        "projects": _sorted_facet_strings(db["work_orders"].distinct("project")),
    }


def runs_query(
    db: Database,
    status: list[str] | None = None,
    rig: list[str] | None = None,
    project: list[str] | None = None,
    test_cell: list[str] | None = None,
    definition: str | None = None,
    work_order: str | None = None,
    signal: str | None = None,
    q: str | None = None,
    source: list[str] | None = None,
) -> dict:
    """Build the Mongo query of every contract filter on the runs table.

    ``list_runs`` and ``group_runs`` both read it, so a grouped answer and a
    flat answer always select the same rows. A second copy of these clauses
    would let the two drift, and a count would then contradict its own list.

    Multi-value filters (``status``/``rig``/``project``/``test_cell``) OR
    within one key and AND across keys, per contract §2.2. A single value
    keeps its exact v1 meaning — a one-element `$in` plans as an equality
    match.
    """
    clauses: list[dict] = []
    for field, values in (
        ("status", status),
        ("rig_id", rig),
        ("project", project),
        ("test_cell", test_cell),
    ):
        clause = _in_clause(field, values)
        if clause is not None:
            clauses.append(clause)
    if definition:
        # Array containment: the clause matches a run whose set holds the id.
        clauses.append({"definition_ids": definition})
    if work_order:
        clauses.append({"work_order_id": work_order})
    if signal:
        clauses.append({"_id": {"$in": _runs_holding_signal(db, signal)}})
    # TR-011: keep the runs at least one field of which carries a named tag.
    tagged = provenance.source_clause(source)
    if tagged is not None:
        clauses.append(tagged)
    # A blank q filters nothing. It must not become a match-all clause.
    if q and q.strip():
        clauses.append(
            every_word_matches(
                q,
                ("_id", "description", "rig_id", "definition_ids", "work_order_id", "project"),
            )
        )
    return {"$and": clauses} if clauses else {}


# Contract §2c: the fixed wire values of ``group_by`` and the field each reads.
# The wire names repeat the filter names of §2, so ``group_by=rig`` and
# ``rig=RIG-04`` name one thing. The workbook also asks for `vehicle` and
# `bench`; no run document holds either field, so neither is offered here.
#
# A person names a criterion of their own with ``custom:<property key>``. See
# ``_group_expression`` below and ``api.models.runs.custom_group_key``.
RUN_GROUP_FIELDS = {
    "project": "project",
    "test_cell": "test_cell",
    "rig": "rig_id",
}


def _group_expression(group_by: str) -> tuple[object, list[dict]]:
    """The ``$group`` key expression, and the stages that follow it.

    A fixed name reads its own stored field, and the runs holding no value form
    the ``null`` group — contract §2c pins that.

    A ``custom:<key>`` name reads the property map with ``$getField``. The key
    never becomes part of a field path, so a key holding a dot or a dollar sign
    can address no other field. The runs that carry no such property are then
    dropped: a custom property is sparse, so that group would hold nearly every
    run and would say nothing, and a key no run carries answers no groups at
    all instead of one big ``null`` group.
    """
    key = custom_group_key(group_by)
    if key is None:
        return f"${RUN_GROUP_FIELDS[group_by]}", []
    expression = {
        "$getField": {"field": {"$literal": key}, "input": f"${CUSTOM_PROPERTIES_FIELD}"}
    }
    return expression, [{"$match": {"_id": {"$ne": None}}}]


def group_runs(
    db: Database,
    pagination: Pagination,
    group_by: str,
    **filters,
) -> dict:
    """Count the runs by one field. Same filters as the list, same rows.

    One ``$group`` stage does the counting, so Mongo answers with one row per
    group and this process never reads the runs themselves. The ``$facet``
    pages that group list and counts it in the same pass.

    ``total`` counts the GROUPS, because the pages page over groups. Sum
    ``count`` over every page and you get the ``total`` of the flat list for
    the same filters — ``api/tests/test_runs_grouping.py`` pins that equality.

    A run that holds no value for the field forms the ``null`` group. It is
    not dropped: dropping it would break the equality above and would hide
    exactly the runs a person groups the table to find.

    ``group_by=custom:<key>`` groups by a custom property instead. That answer
    counts only the runs that carry the key, so its counts add up to the runs
    that hold the property and not to the whole flat total. See
    ``_group_expression``.
    """
    expression, drop_missing = _group_expression(group_by)
    query = runs_query(db, **filters)
    skip = (pagination.page - 1) * pagination.page_size
    pipeline = [
        {"$match": query},
        {"$group": {"_id": expression, "count": {"$sum": 1}}},
        *drop_missing,
        # Biggest group first, then by value, so two runs never swap pages.
        {"$sort": {"count": DESCENDING, "_id": ASCENDING}},
        {
            "$facet": {
                "page": [{"$skip": skip}, {"$limit": pagination.page_size}],
                "total": [{"$count": "n"}],
            }
        },
    ]
    (result,) = db["test_runs"].aggregate(pipeline)
    items = [{"value": row["_id"], "count": row["count"]} for row in result["page"]]
    total = result["total"][0]["n"] if result["total"] else 0
    return pagination.envelope(items, total)


def list_runs(
    db: Database,
    pagination: Pagination,
    sort_spec: list[tuple[str, int]] | None = None,
    status: list[str] | None = None,
    rig: list[str] | None = None,
    project: list[str] | None = None,
    test_cell: list[str] | None = None,
    definition: str | None = None,
    work_order: str | None = None,
    signal: str | None = None,
    q: str | None = None,
    source: list[str] | None = None,
) -> dict:
    """Page the runs, newest arrival first. Every contract filter applies.

    ``runs_query`` holds the filter clauses — the grouped route reads the
    same builder.

    ``sort_spec`` is the resolved Mongo sort (contract §2.3); when None the
    fixed default of ``first_data_at desc`` applies, matching pre-change
    behavior byte-identically.
    """
    query = runs_query(
        db,
        status=status,
        rig=rig,
        project=project,
        test_cell=test_cell,
        definition=definition,
        work_order=work_order,
        signal=signal,
        q=q,
        source=source,
    )
    total = db["test_runs"].count_documents(query)
    resolved_sort = sort_spec or [("first_data_at", DESCENDING), ("_id", ASCENDING)]
    cursor = (
        db["test_runs"]
        .find(query)
        .sort(resolved_sort)
        .skip((pagination.page - 1) * pagination.page_size)
        .limit(pagination.page_size)
    )
    envelope = pagination.envelope(with_facts(db, list(cursor)), total)
    envelope["view_counts"] = runs_view_counts(db)
    return envelope


def _runs_holding_signal(db: Database, name: str) -> list[str]:
    """The runs whose files recorded this signal.

    `file_signals` is Lane B's inventory. Reading it is allowed; writing is not.
    """
    return [run_id for run_id in db["file_signals"].distinct("run_id", {"name": name}) if run_id]


def run_facts(db: Database, run_ids: list[str]) -> dict[str, dict]:
    """Derive the inventory of each run from the rows that back it (R-01).

    This is the run's read model, and it is the ONE place that answers "how
    many files and how many signals does this run hold". Four writers used to
    answer it — the file route, the run upsert, the seed's filler and the
    seed's inventory — and they disagreed. Every route now reads this.

    `file_count` counts every `files` row that names the run, whatever its
    status. A quarantined file is still a file, and the run's Files tab lists
    it, so the number and the rows agree.

    `signal_count` counts the distinct `file_signals` names of the run. That
    collection is what `GET /test-runs/{id}/signals` lists, so the badge can
    never stand over a shorter table.

    Two aggregates serve a whole page of runs, so a list costs two round trips
    and not two per row.

    The run's time window is NOT derived here. `first_data_at` is the runs-list
    sort key, so Mongo must sort on a stored value; `apply_file_rollup` owns
    that write and re-derives the window on every file change (FR-DM-013).
    """
    if not run_ids:
        return {}

    files = db["files"].aggregate(
        [
            {"$match": {"run_id": {"$in": run_ids}}},
            {"$group": {"_id": "$run_id", "n": {"$sum": 1}}},
        ]
    )
    signals = db["file_signals"].aggregate(
        [
            {"$match": {"run_id": {"$in": run_ids}}},
            {"$group": {"_id": "$run_id", "names": {"$addToSet": "$name"}}},
        ]
    )
    counted = {row["_id"]: row["n"] for row in files}
    named = {row["_id"]: len(row["names"]) for row in signals}
    return {
        run_id: {
            "file_count": counted.get(run_id, 0),
            "signal_count": named.get(run_id, 0),
        }
        for run_id in run_ids
    }


def with_facts(db: Database, runs: list[dict]) -> list[dict]:
    """Overlay the derived inventory onto every run document.

    A stored count can be stale or plain wrong: the seed writes runs straight
    into Mongo, and an older seed wrote a literal. The screens read this, so
    no stored literal can contradict the table under it.
    """
    facts = run_facts(db, [run["_id"] for run in runs])
    return [{**run, **facts[run["_id"]]} for run in runs]


def get_run(db: Database, run_id: str) -> dict:
    """Read one run, with the two counts the detail shape carries."""
    run = db["test_runs"].find_one({"_id": run_id})
    if run is None:
        raise ApiError(404, f"Run {run_id} not found", "run_not_found")
    return with_counts(db, run)


def with_counts(db: Database, run: dict) -> dict:
    """Add the derived inventory, `result_count` and `journal_count` to a run.

    The journal count unions the run's own entries with the signal edits made
    in its context, so the tab count matches the timeline the FE renders.
    """
    run_id = run["_id"]
    return {
        **run,
        **run_facts(db, [run_id])[run_id],
        "result_count": db["processed_results"].count_documents({"run_id": run_id}),
        "journal_count": db["journal_entries"].count_documents(
            {"$or": [{"entity_type": "run", "entity_id": run_id}, {"context_run_id": run_id}]}
        ),
        "covers_req_ids": covered_requirement_ids(db, run.get("definition_ids") or []),
    }


def covered_requirement_ids(db: Database, definition_ids: list[str]) -> list[str]:
    """The union of `covers_req_ids` over a set of definitions, sorted.

    Detail-only (`dev-planning/requirement-status-from-runs/spec.md` §7.2):
    one extra query on a run detail read, and the runs list stays untouched.
    """
    if not definition_ids:
        return []
    covered: set[str] = set()
    for definition in db["test_definitions"].find(
        {"_id": {"$in": definition_ids}}, {"covers_req_ids": 1}
    ):
        covered.update(definition.get("covers_req_ids") or [])
    return sorted(covered)


def run_lineage(db: Database, run_id: str) -> dict:
    """Build the chain a run sits in: work order, definitions, files, results.

    The two blocks above the run are **null while the run is unsynced**. A run
    with no work order does not know its chain yet, and saying so is the amber
    state the screen draws dashed.

    A run fulfils a set of definitions. `definitions` holds them all and
    `definition` is the first, the field the chain read before the set existed.
    """
    run = with_facts(db, [_require_run(db, run_id)])[0]

    work_order = None
    if run.get("work_order_id"):
        mirror = db["work_orders"].find_one({"_id": run["work_order_id"]})
        if mirror is not None:
            work_order = {
                "wo_id": mirror["_id"],
                "title": mirror.get("title") or "",
                "project": mirror.get("project") or "",
                "source": Source.API_PLANNING.value,
            }
    definitions = []
    for td_id in run.get("definition_ids") or []:
        mirror = db["test_definitions"].find_one({"_id": td_id})
        if mirror is not None:
            definitions.append(
                {
                    "td_id": mirror["_id"],
                    "title": mirror.get("title") or "",
                    "source": Source.API_PLANNING.value,
                }
            )
    definition = definitions[0] if definitions else None

    files = [
        {
            "file_id": doc["_id"],
            "filename": doc.get("filename") or "",
            "source_system": doc.get("source_system") or "",
            "size_bytes": doc.get("size_bytes") or 0,
            "signal_count": doc.get("signal_count") or 0,
        }
        for doc in db["files"].find({"run_id": run_id}).sort("_id", ASCENDING)
    ]
    results = [
        {
            "result_id": doc["_id"],
            "name": doc.get("name") or "",
            "version": doc.get("version") or 1,
            "provenance_status": doc.get("provenance_status") or "verified",
            "provenance": doc.get("provenance") or {},
        }
        for doc in db["processed_results"].find({"run_id": run_id}).sort("_id", ASCENDING)
    ]

    return {
        "work_order": work_order,
        "definition": definition,
        "definitions": definitions,
        "run": {
            "run_id": run["_id"],
            "rig_id": run.get("rig_id") or "",
            "test_cell": run.get("test_cell"),
            "first_data_at": run["first_data_at"],
            "file_count": run.get("file_count") or 0,
            "signal_count": run.get("signal_count") or 0,
            "status": run.get("status") or derive_status(run),
        },
        "files": files,
        "results": results,
    }


def list_run_files(
    db: Database, run_id: str, page: int | None = None, page_size: int | None = None
) -> dict:
    """The run's files, newest first — contract #6 returns `{items, total}`.

    A caller that names no page still gets every file, which is the contract
    and what every existing caller expects. A caller that names one gets that
    slice, and `total` still names them all: one synthetic sortie registers 720
    chunk files, and a screen that lists them reads a page at a time rather
    than the whole set every ten seconds.
    """
    _require_run(db, run_id)

    files = db["files"]
    cursor = files.find({"run_id": run_id}).sort("registered_at", DESCENDING)
    if page is None and page_size is None:
        items = list(cursor)
        return {"items": items, "total": len(items)}

    size = page_size or 20
    number = page or 1
    total = files.count_documents({"run_id": run_id})
    items = list(cursor.skip((number - 1) * size).limit(size))
    return {"items": items, "total": total}


# How many rows each Needs-attention category names on Home. The count
# beside the rows stays the true total, so the panel says what it hides.
ATTENTION_ROW_LIMIT = 3


def home_summary(db: Database) -> dict:
    """Build the whole Home screen in one round trip.

    Every count is a live `count_documents`. At demo scale that is cheap, and a
    stale count on the opening frame is the cheapest way to look wrong.
    """
    midnight = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    # Bounded on both sides, so a future-dated document never counts as today.
    today = {"$gte": midnight, "$lt": midnight + timedelta(days=1)}
    runs = db["test_runs"]
    files = db["files"]

    meta = db["meta"].find_one({"_id": "planning_sync"}) or {}

    # One id list serves the orphan count AND the orphan rows below, so the
    # two can never disagree inside one response.
    known = mirrored_work_order_ids(db)

    def _run_rows(status: str) -> list[dict]:
        """The newest runs in one status — the same clause the count reads."""
        return [
            {
                "run_id": doc["_id"],
                "rig_id": doc.get("rig_id"),
                "reason": (doc.get("invalid") or {}).get("reason"),
            }
            for doc in runs.find({"status": status})
            .sort("first_data_at", DESCENDING)
            .limit(ATTENTION_ROW_LIMIT)
        ]

    return {
        "counts": {
            "test_runs": runs.count_documents({}),
            "files": files.count_documents({}),
            "signals": db["signals"].count_documents({}),
            "work_orders": db["work_orders"].count_documents({}),
            # The whole definition mirror, the set the /definitions list pages.
            "test_definitions": db["test_definitions"].count_documents({}),
            "requirements": db["requirements"].count_documents({}),
            "runs_today": runs.count_documents({"first_data_at": today}),
            "files_today": files.count_documents({"registered_at": today}),
            "rig_count": len(runs.distinct("rig_id")),
        },
        "needs_attention": {
            "awaiting_work_order": runs.count_documents({"status": "awaiting_work_order"}),
            "quarantined_files": files.count_documents({"status": "quarantined"}),
            "invalid_runs": runs.count_documents({"status": "invalid"}),
            "orphaned_definitions": db["test_definitions"].count_documents(orphan_clause(known)),
        },
        # The named entities behind the counts above. Each list reads the
        # same clause as its count and stops at ATTENTION_ROW_LIMIT rows.
        "attention_rows": {
            "awaiting_work_order": _run_rows("awaiting_work_order"),
            "quarantined_files": [
                {
                    "file_id": doc["_id"],
                    "filename": doc.get("filename"),
                    "quarantine_reason": doc.get("quarantine_reason"),
                }
                for doc in files.find({"status": "quarantined"})
                .sort("registered_at", DESCENDING)
                .limit(ATTENTION_ROW_LIMIT)
            ],
            "invalid_runs": _run_rows("invalid"),
            "orphaned_definitions": [
                {"td_id": doc["_id"], "title": doc.get("title")}
                for doc in db["test_definitions"]
                .find(orphan_clause(known))
                .sort("_id", ASCENDING)
                .limit(ATTENTION_ROW_LIMIT)
            ],
        },
        "planning_sync": {
            "online": bool(meta.get("online", False)),
            "last_sync_at": meta.get("last_sync_at"),
        },
        "recent_runs": list(runs.find().sort("first_data_at", DESCENDING).limit(5)),
        "source_breakdown": _source_breakdown(db),
    }


def _source_breakdown(db: Database) -> list[dict]:
    """One row per source, in the enum order, counting the tagged fields.

    Every `Source` value appears, even at zero. A card that drops a row when
    a count reaches zero would change height between two loads, and a reader
    could not tell "nobody wrote this" from "the API forgot it".
    """
    counted = provenance.count_fields_by_source(db)
    return [
        {"source": value.value, "field_count": counted.get(value.value, 0)}
        for value in Source
    ]


# Which fields each collection offers the one search box.
_SEARCH_FIELDS: dict[str, tuple[str, ...]] = {
    "test_runs": ("_id", "description", "rig_id"),
    "work_orders": ("_id", "title", "project"),
    "files": ("filename", "checksum_sha256", "run_id"),
    "signals": ("_id", "description"),
    "test_definitions": ("_id", "title", "work_order_id"),
    "processed_results": ("_id", "name", "result_key", "run_id"),
}

_SEARCH_GROUPS = (
    "test_runs",
    "work_orders",
    "files",
    "signals",
    "test_definitions",
    "processed_results",
)


def search(db: Database, q: str, limit_per_group: int) -> dict:
    """Search six collections and group the hits by type.

    Every word of the query must match, in any order, and each word is
    escaped text (guard test 7). A blank query answers no groups, because an
    empty needle would match the world. Empty groups are omitted.

    Each group is then ranked by relevance (FR-DM-015, UC-003 step 2). The
    ranking reorders the group; it never drops a hit.
    """
    if not q.strip():
        return {"query": q, "groups": []}

    groups = []
    for collection in _SEARCH_GROUPS:
        query = every_word_matches(q, _SEARCH_FIELDS[collection])
        rows = list(db[collection].find(query).limit(limit_per_group))
        if rows:
            items = [_search_item(collection, row) for row in rows]
            groups.append({"type": collection, "items": rank_by_relevance(q, items)})

    return {"query": q, "groups": groups}


def _search_item(collection: str, row: dict) -> dict:
    """Shape one hit for the search list: what it is, and where it goes.

    The shapes come from contract #19. The id is what the reader recognizes
    (a filename, not an internal file id) and the nav block names the exact
    key its screen needs.
    """
    if collection == "test_runs":
        return {
            "id": row["_id"],
            "sub": _dotted(row.get("description"), row.get("rig_id")),
            "status": row.get("status"),
            "nav": {"run_id": row["_id"]},
        }
    if collection == "work_orders":
        return {
            "id": row["_id"],
            "sub": _dotted(row.get("title"), row.get("project")),
            "status": row.get("status"),
            "nav": {"wo_id": row["_id"]},
        }
    if collection == "files":
        size = row.get("size_bytes")
        return {
            "id": row.get("filename") or row["_id"],
            "sub": _dotted(
                row.get("run_id") or "unlinked",
                _format_size(size) if size else None,
                row.get("source_system"),
            ),
            "status": row.get("status"),
            "nav": {"file_id": row["_id"]},
        }
    if collection == "test_definitions":
        return {
            "id": row["_id"],
            "sub": _dotted(row.get("title"), row.get("work_order_id")),
            "status": row.get("status"),
            "nav": {"definition": row["_id"]},
        }
    if collection == "processed_results":
        version = row.get("version")
        return {
            "id": row.get("name") or row["_id"],
            "sub": _dotted(row.get("run_id"), f"v{version}" if version else None),
            "status": row.get("provenance_status"),
            "nav": {"run_id": row.get("run_id") or ""},
        }
    rate = row.get("typical_rate_hz")
    run_count = row.get("run_count")
    return {
        "id": row["_id"],
        "sub": _dotted(
            row.get("unit") or "(no unit)",
            f"{rate} Hz" if rate is not None else None,
            f"{run_count} runs" if run_count is not None else None,
        ),
        "status": None,
        "nav": {"name": row["_id"]},
    }


def _dotted(*parts: str | None) -> str:
    """Join the non-empty parts with the interpunct the screens use."""
    return " · ".join(part for part in parts if part)


def _format_size(size_bytes: int) -> str:
    """Render a byte count the way the file screens do."""
    if size_bytes >= 1024**3:
        return f"{size_bytes / 1024**3:.2f} GB"
    if size_bytes >= 1024**2:
        mb = size_bytes / 1024**2
        return f"{round(mb)} MB" if mb >= 10 else f"{mb:.1f} MB"
    return f"{size_bytes / 1024:.1f} KB"


def _run_journal_query(run_id: str) -> dict:
    """The run's own entries, plus edits made while looking at this run.

    A signal-unit change carries `context_run_id`, so it belongs to the run's
    timeline as well as the signal's (BE-PLAN §4.5).
    """
    return {
        "$or": [
            {"entity_type": "run", "entity_id": run_id},
            {"context_run_id": run_id},
        ]
    }


def list_run_journal(
    db: Database,
    run_id: str,
    pagination: Pagination,
    kind: str | None = None,
) -> dict:
    """Page one run's timeline, newest first."""
    _require_run(db, run_id)

    clauses = [_run_journal_query(run_id)]
    if kind:
        clauses.append({"kind": kind})
    query = {"$and": clauses}

    total = db["journal_entries"].count_documents(query)
    # `_id` breaks the tie. Two entries that share the same `at` have no order
    # of their own, so Mongo may answer them in one order on page 1 and the
    # other order on page 2. The reader then sees one entry twice and another
    # never. The ingestion path writes several entries in one millisecond, so
    # the tie is the normal case here, not a rare one.
    cursor = (
        db["journal_entries"]
        .find(query)
        .sort([("at", DESCENDING), ("_id", DESCENDING)])
        .skip((pagination.page - 1) * pagination.page_size)
        .limit(pagination.page_size)
    )
    return pagination.envelope(list(cursor), total)


def add_run_note(db: Database, run_id: str, note: str, actor: str) -> dict:
    """Store a free-text note against a run. The helper builds the entry."""
    _require_run(db, run_id)

    entry = add_event("run", run_id, None, Source.MANUAL, actor, note=note)
    entry["kind"] = "note"
    db["journal_entries"].insert_one(entry)
    return entry


# A hand edit may state a link. The id must name a mirrored row: a person can
# fix a typo, and a link to nothing helps nobody. The ingestion claim takes the
# opposite rule on purpose — it never blocks, because a pipeline cannot retype.
_LINK_ERRORS = {
    "work_order_id": ("unknown_work_order", "work order"),
    "definition_id": ("unknown_definition", "test definition"),
}


def _resolve_manual_links(db: Database, changes: dict) -> dict:
    """Check each stated link. Return the values the edit writes.

    A person states ONE `definition_id` and it REPLACES the run's set, so the
    edit dialog is also the only way to take a definition off a run: a planning
    push unions its links and never removes one.
    """
    values = dict(changes)
    for field, (code, label) in _LINK_ERRORS.items():
        claimed = changes.get(field)
        if claimed is None:
            continue
        mirror = db[_CLAIM_MIRRORS[field]].find_one({"_id": claimed})
        if mirror is None:
            raise ApiError(422, f"No {label} {claimed} is mirrored here", code)
        # `project` follows the work order. A person states the link, never
        # the project, so the edit derives it from the mirror row.
        if field == "work_order_id" and mirror.get("project") is not None:
            values["project"] = mirror["project"]
    if "definition_id" in values:
        values["definition_ids"] = [values.pop("definition_id")]
    return values


def patch_run(db: Database, run_id: str, changes: dict, actor: str, note: str | None) -> dict:
    """Apply a hand edit. Every field goes through the provenance helper.

    An unchanged field is skipped, so the journal carries edits and not noise.
    """
    run = db["test_runs"].find_one({"_id": run_id})
    if run is None:
        raise ApiError(404, f"Run {run_id} not found", "run_not_found")

    # A run written before the property map existed carries no key at all.
    # Reading that as an empty map keeps "clear the properties" a no-op there,
    # so the journal stays free of a change that changed nothing.
    run.setdefault("custom_properties", {})

    changes = _resolve_manual_links(db, changes)
    update: dict = {}
    entries: list[dict] = []
    for field, value in changes.items():
        if run.get(field) == value:
            continue
        entry = set_field(
            update,
            field,
            value,
            Source.MANUAL,
            actor,
            note=note,
            current_doc=run,
            field_label=_FIELD_LABELS.get(field, f"run.{field}"),
        )
        if entry is not None:
            entries.append(entry)

    if not update:
        return with_counts(db, run)

    update["updated_at"] = datetime.now(UTC)
    update["status"] = derive_status({**run, **plain_values(update)})
    db["test_runs"].update_one({"_id": run_id}, {"$set": update})
    if entries:
        db["journal_entries"].insert_many(entries)

    return get_run(db, run_id)


def set_invalid_flag(db: Database, run_id: str, reason: str, actor: str) -> dict:
    """Mark a run invalid. The reason and the actor are part of the record."""
    run = _require_run(db, run_id)
    if (run.get("invalid") or {}).get("flagged"):
        raise ApiError(409, f"Run {run_id} is already flagged invalid", "already_flagged")

    return _write_flag(db, run, flagged=True, reason=reason, actor=actor)


def clear_invalid_flag(db: Database, run_id: str, reason: str, actor: str) -> dict:
    """Undo an invalid flag. Rehearsals need it; the journal keeps both halves."""
    run = _require_run(db, run_id)
    if not (run.get("invalid") or {}).get("flagged"):
        raise ApiError(409, f"Run {run_id} is not flagged invalid", "not_flagged")

    return _write_flag(db, run, flagged=False, reason=reason, actor=actor)


def _require_run(db: Database, run_id: str) -> dict:
    run = db["test_runs"].find_one({"_id": run_id})
    if run is None:
        raise ApiError(404, f"Run {run_id} not found", "run_not_found")
    return run


def _write_flag(db: Database, run: dict, flagged: bool, reason: str, actor: str) -> dict:
    """Store one side of the invalid flag and journal the judgment.

    The provenance helper records who judged the run, the way the seed's
    `_flag_invalid` does. A manual write is the top rank, so it never blocks.
    """
    now = datetime.now(UTC)
    invalid = {
        "flagged": flagged,
        "reason": reason if flagged else None,
        "actor": actor if flagged else None,
        "at": now if flagged else None,
    }

    update: dict = {}
    entry = set_field(
        update,
        "invalid",
        invalid,
        Source.MANUAL,
        actor,
        note=reason,
        current_doc=run,
        entity_id=run["_id"],
        field_label="run.invalid_flag",
    )
    update["updated_at"] = now
    update["status"] = derive_status({**run, "invalid": invalid})
    db["test_runs"].update_one({"_id": run["_id"]}, {"$set": update})

    # The stored value is a block, and a block reads badly in a timeline.
    # Contract #5 shows the flag state instead: false → true, and back.
    entry["old"] = "true" if not flagged else "false"
    entry["new"] = "true" if flagged else "false"
    db["journal_entries"].insert_one(entry)

    return get_run(db, run["_id"])


# How many times `apply_file_rollup` re-derives after a lost race.
ROLLUP_RETRIES = 5


def apply_file_rollup(
    db: Database,
    run_id: str,
    file_doc: dict,
) -> None:
    """Re-derive the run's counts and time range from the rows that back it.

    Lane B calls this from `POST /files`, for a quarantined file as well as a
    registered one. The file route owns the file; this owns what the file does
    to the run, so the two lanes never disagree about `file_count`,
    `signal_count` or the run's window.

    The counts come from `run_facts`, the run's one read model, so the stored
    value and the served value can never differ. `run_facts` reads the stored
    documents rather than incrementing, so a replayed registration cannot
    double-count, and two files sharing a signal count it once.

    The route writes the file and its inventory rows BEFORE it calls this, so
    the derivation already sees them. This helper takes no signal names of its
    own: a second name source is exactly how the four numbers drifted apart.

    The window derives the same way (FR-DM-013). It is the union of the time
    ranges of the files the run holds NOW, joined with the window the producer
    stated on `POST /test-runs`. A window that only grew was the drift this
    helper had left: a file that re-linked to another run took its times with
    it, and the old run kept a start and an end that no remaining file
    supported. `file_doc` is already stored when this runs, so the derivation
    reads it back with the rest and this helper needs no time of its own.

    An unknown run is a no-op. An unlinked file names no run, and this helper
    never creates one.
    """
    for _ in range(ROLLUP_RETRIES):
        run = db["test_runs"].find_one({"_id": run_id})
        if run is None:
            return
        seen = run.get("rollup_seq")

        update: dict = {
            **run_facts(db, [run_id])[run_id],
            "updated_at": datetime.now(UTC),
        }

        file_start, file_end = _file_window(db, run_id)
        started = _earliest(run.get("reported_started_at"), file_start)
        update["started_at"] = started
        update["ended_at"] = _latest(run.get("reported_ended_at"), file_end)

        # first_data_at is the list column and the list sort key. It must never
        # be later than the run start. It keeps the rule `_extend_time_range`
        # keeps — lower, never raise — because it marks when the run first held
        # data, and a run that first held data at 09:00 still did so after a
        # file left.
        first = run.get("first_data_at")
        if started is not None and (first is None or started < first):
            update["first_data_at"] = started

        update["status"] = derive_status({**run, **update})
        update["rollup_seq"] = (seen or 0) + 1

        # The guard makes the write atomic without a lock. The derivation above
        # read the files collection; a second registration may have finished
        # since, and a blind `$set` would then put this stale count back. The
        # filter matches only while `rollup_seq` still holds the value this
        # pass read, so a lost race writes nothing and the loop derives again.
        # An absent field reads as null in Mongo, so a run written before this
        # field existed matches on the first pass.
        written = db["test_runs"].update_one(
            {"_id": run_id, "rollup_seq": seen}, {"$set": update}
        )
        if written.matched_count == 1:
            return
    # Every pass lost. The last derivation is still the newest one this process
    # holds, so it lands unguarded rather than leaving the run with a count
    # that no file supports.
    db["test_runs"].update_one({"_id": run_id}, {"$set": update})


def _file_window(db: Database, run_id: str) -> tuple[datetime | None, datetime | None]:
    """The union of the time ranges of every file that names this run.

    A quarantined file counts, the same way it counts in `file_count`: the
    run's Files tab lists it, so the window it states is the run's too. A file
    that states no time states nothing. `_real_start` drops the epoch sentinel,
    and that same file still gives its end time.
    """
    starts: list[datetime] = []
    ends: list[datetime] = []
    for row in db["files"].find({"run_id": run_id}, {"time_start": 1, "time_end": 1}):
        start = _real_start(row.get("time_start"))
        if start is not None:
            starts.append(start)
        if row.get("time_end") is not None:
            ends.append(row["time_end"])
    return (min(starts) if starts else None, max(ends) if ends else None)


def mirrored_work_order_ids(db: Database) -> list[str]:
    """Every work-order id the mirror holds. One read serves a whole page.

    The mirror holds 42 work orders at demo scale, so this list costs less
    than a lookup stage per definition row.
    """
    return [row["_id"] for row in db["work_orders"].find({}, {"_id": 1})]


def orphan_clause(known: list[str], orphaned: bool = True) -> dict:
    """The Mongo clause for an orphaned test definition, or for a linked one.

    TR-001 calls a definition orphaned when it names no work order, or when it
    names one the mirror does not hold. `$nin` answers both shapes in one
    clause: a null value and a missing field both sit outside the id list.
    """
    return {"work_order_id": {"$nin" if orphaned else "$in": known}}


def _derived_definitions(db: Database, orphaned: bool | None = None) -> list[dict]:
    """The definition mirror, id ascending, with every derived field filled.

    `actual_runs` and `status` derive at read time, through the same helper
    #11 uses; `orphaned` derives from the mirrored work-order ids. One grouped
    count serves the whole read.
    """
    known = mirrored_work_order_ids(db)
    query = {} if orphaned is None else orphan_clause(known, orphaned)
    rows = list(db["test_definitions"].find(query).sort("_id", ASCENDING))

    actual_runs = _count_by(db, "test_runs", "definition_ids", [row["_id"] for row in rows])
    linked = set(known)
    return [
        {
            **row,
            "work_order_id": row.get("work_order_id"),
            "planned_runs": row.get("planned_runs") or 0,
            "actual_runs": actual_runs.get(row["_id"], 0),
            "status": _definition_status(
                row.get("planned_runs"), actual_runs.get(row["_id"], 0)
            ),
            "orphaned": row.get("work_order_id") not in linked,
        }
        for row in rows
    ]


def _definition_matches(
    row: dict,
    work_order: list[str] | None,
    status: list[str] | None,
    requirement: list[str] | None,
    q: str | None,
) -> bool:
    """Every filter `GET /test-definitions` accepts beyond `orphaned`.

    All four run over the already-derived row. `status` is one of them: it is
    computed from planned versus actual runs and sits on no stored document,
    so it cannot be pushed into the Mongo `find()`.
    """
    if work_order and row.get("work_order_id") not in work_order:
        return False
    if status and row["status"] not in status:
        return False
    if requirement and not set(row.get("covers_req_ids") or []) & set(requirement):
        return False
    if q:
        needle = q.strip().lower()
        haystack = " ".join(str(row.get(field) or "") for field in ("_id", "title")).lower()
        if needle not in haystack:
            return False
    return True


def list_test_definitions(
    db: Database,
    pagination: Pagination,
    *,
    work_order: list[str] | None = None,
    status: list[str] | None = None,
    requirement: list[str] | None = None,
    q: str | None = None,
    orphaned: bool | None = None,
) -> dict:
    """Page the definition mirror, with the orphan flag TR-001 asks for.

    `orphaned=true` pages the orphans, `orphaned=false` the linked rows, and
    no param at all pages both. The sort is fixed on the id, lowest first —
    the order the work-order detail (#11) already lists a definition in, so
    the two screens never disagree. There is no sort param.

    `work_order`, `status` and `requirement` take repeated params and OR within
    one key; `q` searches the id and the title. Every key ANDs with the others,
    and each narrows the whole derived table before the page is cut, so the
    total counts the filtered set.
    """
    rows = _derived_definitions(db, orphaned)
    filtered = [row for row in rows if _definition_matches(row, work_order, status, requirement, q)]
    total = len(filtered)
    start = (pagination.page - 1) * pagination.page_size
    return pagination.envelope(filtered[start : start + pagination.page_size], total)


def test_definition_facets(db: Database) -> dict:
    """The distinct filter values of the whole definition mirror.

    Two reads, because the three lists do not come from one place: the work
    orders and the covered requirements are stored fields one `$group` folds,
    and `status` derives, so it is read off the same projection the list pages.
    An empty collection answers three empty lists.
    """
    pipeline = [
        {
            "$group": {
                "_id": None,
                "work_orders": {"$addToSet": "$work_order_id"},
                "requirements": {"$addToSet": "$covers_req_ids"},
            }
        },
        {
            "$project": {
                "work_orders": 1,
                # `$addToSet` over an array field leaves a set of ARRAYS.
                "requirements": {
                    "$reduce": {
                        "input": "$requirements",
                        "initialValue": [],
                        "in": {"$setUnion": ["$$value", "$$this"]},
                    }
                },
            }
        },
    ]
    grouped = next(db["test_definitions"].aggregate(pipeline), {})
    return {
        "work_orders": _sorted_facet_strings(grouped.get("work_orders") or []),
        "statuses": _sorted_facet_strings(
            list({row["status"] for row in _derived_definitions(db)})
        ),
        "requirements": _sorted_facet_strings(grouped.get("requirements") or []),
    }


def get_test_definition_detail(db: Database, td_id: str) -> dict:
    """Read one definition, with its work order and the runs that carry it.

    Every derived field uses the helper the list and the work-order detail
    already use, so the three screens can never disagree about one definition.
    The runs sort newest arrival first, the order #11 lists a run in.
    """
    definition = db["test_definitions"].find_one({"_id": td_id})
    if definition is None:
        raise ApiError(404, f"Test definition {td_id} not found", "td_not_found")

    work_order = None
    if definition.get("work_order_id"):
        work_order = db["work_orders"].find_one({"_id": definition["work_order_id"]})

    runs = with_facts(
        db,
        list(db["test_runs"].find({"definition_ids": td_id}).sort("first_data_at", DESCENDING)),
    )
    actual_runs = len(runs)
    return {
        **definition,
        "work_order_id": definition.get("work_order_id"),
        "planned_runs": definition.get("planned_runs") or 0,
        "actual_runs": actual_runs,
        "status": _definition_status(definition.get("planned_runs"), actual_runs),
        # An orphan names no work order, or names one the mirror does not hold.
        "orphaned": work_order is None,
        "work_order": work_order,
        "runs": runs,
        "requirements_files": requirements_files(definition),
        # The manual property map, read from the store that sits beside the
        # mirror. A definition nobody typed a property on reads as empty.
        "custom_properties": definition.get(MANUAL_PROPERTIES_FIELD) or {},
    }


def requirements_files(definition: dict) -> list[dict]:
    """Merge the two document stores of one definition, manual first.

    The registry keeps them apart on purpose. Planning owns
    `requirements_files` and replaces it on every sync pass. A person owns
    `manual_requirements_files`, and no sync pass reads it. So a push can never
    delete a document a person uploaded.

    The two stores may hold the same name. Both documents stay, and the manual
    one sorts first, because a person wrote it last and reads it first.

    A document stored before the markdown flag existed carries no
    `render_markdown` key. This read fills it from the name, so an old planning
    document renders the way a new one renders. A BINARY document keeps the null
    the upload route stored: bytes carry no markdown.
    """
    documents = [
        *(definition.get("manual_requirements_files") or []),
        *(definition.get("requirements_files") or []),
    ]
    for document in documents:
        if "render_markdown" not in document:
            document["render_markdown"] = default_render_markdown(document["name"])
    return sorted(documents, key=lambda doc: (doc["source"] != "manual", doc["name"]))


def _definition_status(planned_runs: int | None, actual_runs: int) -> str:
    """Derive the planned-versus-actual state. A null plan is never behind."""
    if not planned_runs:
        return "on_plan"
    return "on_plan" if actual_runs >= planned_runs else "awaiting_data"


def work_orders_view_counts(db: Database) -> dict:
    """Whole-table counts for /work-orders (contract §2.4)."""
    wos = db["work_orders"]
    return {
        "all": wos.count_documents({}),
        "active": wos.count_documents({"status": "active"}),
        "closed": wos.count_documents({"status": "closed"}),
    }


def list_work_orders(
    db: Database,
    pagination: Pagination,
    status: list[str] | None = None,
    project: list[str] | None = None,
    q: str | None = None,
    source: list[str] | None = None,
) -> dict:
    """Page the work-order mirror, with the definition and run rollups.

    Multi-value filters (``status``/``project``) OR within one key and AND
    across keys. The sort is fixed — decision box 2 (closed): no sort or
    order params on #10. It runs on the id, highest first, so the newest
    campaign opens the screen. The counts derive at read time. At demo
    scale (42 work orders) two grouped counts beat a per-row query.
    """
    clauses: list[dict] = []
    for field, values in (("status", status), ("project", project)):
        clause = _in_clause(field, values)
        if clause is not None:
            clauses.append(clause)
    # TR-011: the mirror tags every field planning owns, so this filter keeps
    # the work orders planning wrote.
    tagged = provenance.source_clause(source)
    if tagged is not None:
        clauses.append(tagged)
    # A blank q filters nothing. It must not become a match-all clause.
    if q and q.strip():
        clauses.append(every_word_matches(q, ("_id", "title")))

    query: dict = {"$and": clauses} if clauses else {}
    total = db["work_orders"].count_documents(query)
    rows = list(
        db["work_orders"]
        .find(query)
        .sort("_id", DESCENDING)
        .skip((pagination.page - 1) * pagination.page_size)
        .limit(pagination.page_size)
    )

    wo_ids = [row["_id"] for row in rows]
    definitions = _count_by(db, "test_definitions", "work_order_id", wo_ids)
    runs = _count_by(db, "test_runs", "work_order_id", wo_ids)

    items = [
        {
            **row,
            "definition_count": definitions.get(row["_id"], 0),
            "run_count": runs.get(row["_id"], 0),
        }
        for row in rows
    ]
    envelope = pagination.envelope(items, total)
    envelope["view_counts"] = work_orders_view_counts(db)
    return envelope


def _count_by(db: Database, collection: str, field: str, values: list[str]) -> dict[str, int]:
    """Group-count one collection by a field, for the given values only.

    `$unwind` turns an ARRAY field into one document per element, so a run
    carrying three definitions counts once under each. On a scalar it yields
    the document unchanged, so the one helper still serves `work_order_id`.
    The second `$match` drops the elements of a matched array that the caller
    did not ask about.
    """
    if not values:
        return {}
    grouped = db[collection].aggregate(
        [
            {"$match": {field: {"$in": values}}},
            {"$unwind": f"${field}"},
            {"$match": {field: {"$in": values}}},
            {"$group": {"_id": f"${field}", "n": {"$sum": 1}}},
        ]
    )
    return {row["_id"]: row["n"] for row in grouped}


def get_work_order_detail(db: Database, wo_id: str) -> dict:
    """Read the whole work-order screen in one call.

    The definitions carry planned versus actual; the runs are the rollup panel,
    newest first. Both derive at read time — planning owns the stored fields.
    """
    work_order = db["work_orders"].find_one({"_id": wo_id})
    if work_order is None:
        raise ApiError(404, f"Work order {wo_id} not found", "wo_not_found")

    runs = with_facts(
        db,
        list(db["test_runs"].find({"work_order_id": wo_id}).sort("first_data_at", DESCENDING)),
    )
    actual_runs: dict[str, int] = {}
    for run in runs:
        for definition_id in run.get("definition_ids") or []:
            actual_runs[definition_id] = actual_runs.get(definition_id, 0) + 1

    definitions = []
    for definition in db["test_definitions"].find({"work_order_id": wo_id}).sort("_id", ASCENDING):
        planned = definition.get("planned_runs") or 0
        actual = actual_runs.get(definition["_id"], 0)
        definitions.append(
            {
                **definition,
                "planned_runs": planned,
                "actual_runs": actual,
                "status": _definition_status(definition.get("planned_runs"), actual),
            }
        )

    return {**work_order, "definitions": definitions, "runs": runs}
