"""Mongo connection and index definitions. All BE-PLAN §3 indexes land here.

This file's frame is frozen after the base. A lane appends new indexes only
inside its own marked region.
"""

from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.database import Database
from pymongo.errors import OperationFailure

from api.settings import get_settings

DATABASE_NAME = "test_manager"

_client: MongoClient | None = None


def get_client() -> MongoClient:
    """One lazy, tz-aware client for the process."""
    global _client
    if _client is None:
        _client = MongoClient(get_settings().mongo_url, tz_aware=True)
    return _client


def get_db() -> Database:
    return get_client()[DATABASE_NAME]


def ensure_indexes(db: Database) -> None:
    """Create every index from BE-PLAN §3. Safe to run repeatedly."""

    # --- lane A indexes ---
    # Lane A appends only inside this region.
    runs = db["test_runs"]
    runs.create_index([("status", ASCENDING)])
    runs.create_index([("rig_id", ASCENDING)])
    runs.create_index([("work_order_id", ASCENDING)])
    # Multikey: a run holds a SET of definitions, and the definition detail,
    # the definition list's run count and the `definition` filter all match one
    # id against it.
    runs.create_index([("definition_ids", ASCENDING)])
    runs.create_index([("project", ASCENDING)])
    # Stated caller: the `test_cell` filter and the `group_by=test_cell` stage
    # of GET /test-runs/groups (contract §2, §2c).
    runs.create_index([("test_cell", ASCENDING)])
    runs.create_index([("invalid.flagged", ASCENDING)])
    runs.create_index([("first_data_at", DESCENDING)])
    runs.create_index([("definition_ids", ASCENDING), ("first_data_at", DESCENDING)])
    # Filter + default-sort compounds for the multi-select filter popovers
    # (§3.2). Demo scale needs none of these, but a runs table of 10^7 rows
    # would collection-scan without them. Every one is a write cost — never
    # add speculatively; each has a stated caller.
    runs.create_index([("status", ASCENDING), ("first_data_at", DESCENDING)])
    runs.create_index([("rig_id", ASCENDING), ("first_data_at", DESCENDING)])
    runs.create_index([("project", ASCENDING), ("first_data_at", DESCENDING)])

    work_orders = db["work_orders"]
    work_orders.create_index([("project", ASCENDING)])
    work_orders.create_index([("status", ASCENDING)])
    work_orders.create_index([("synced_at", ASCENDING)])

    definitions = db["test_definitions"]
    definitions.create_index([("work_order_id", ASCENDING)])
    definitions.create_index([("synced_at", ASCENDING)])
    # Multikey: the requirement projection matches a page of requirement ids
    # against every definition that names one (dev-planning/requirement-
    # status-from-runs/spec.md §5.3).
    definitions.create_index([("covers_req_ids", ASCENDING)])

    journal = db["journal_entries"]
    journal.create_index(
        [("entity_type", ASCENDING), ("entity_id", ASCENDING), ("at", DESCENDING)]
    )
    journal.create_index([("at", DESCENDING)])
    journal.create_index([("source", ASCENDING)])
    journal.create_index([("context_run_id", ASCENDING)])
    # --- end lane A indexes ---

    # --- lane B indexes ---
    # Lane B appends only inside this region.
    files = db["files"]
    # (run, checksum) is the idempotency key of a registered file (24 Aug
    # 2026): the same bytes attached to a DIFFERENT run are new work — a test
    # platform re-runs known recordings on purpose — while a redelivery to the
    # same run still folds into one document. A registered file always carries
    # a run (no run key → quarantined), so run_id never nulls here. A BLANK
    # checksum claims nothing about the bytes, so it keys nothing: two files
    # with no digest are two files. `$gt: ""` keeps the empty string out of
    # the index, so the second blank insert passes (21 Aug 2026).
    files.create_index(
        [("run_id", ASCENDING), ("checksum_sha256", ASCENDING)],
        unique=True,
        partialFilterExpression={"status": "registered", "checksum_sha256": {"$gt": ""}},
    )
    try:
        # A database seeded before 24 Aug 2026 still holds the global
        # one-per-checksum index, which would keep refusing the per-run
        # duplicates the compound key above now allows. Drop it.
        files.drop_index("checksum_sha256_1")
    except OperationFailure:
        pass  # never built here, or already dropped
    files.create_index([("run_id", ASCENDING)])
    files.create_index([("status", ASCENDING)])
    # Every /files list reads `lifecycle`, because the plain table hides the
    # deleted files (20 Aug 2026).
    files.create_index([("lifecycle", ASCENDING)])
    files.create_index([("source_system", ASCENDING)])
    files.create_index([("filename", ASCENDING)])
    # One document per (chain, version). Two parallel version uploads compute
    # the same next number, and this index makes the loser fail its insert, so
    # the route re-reads the newest version and tries again (20 Aug 2026).
    # The partial filter keeps every file registered before that day out: such
    # a document carries no `version_group`, so it is its own root.
    files.create_index(
        [("version_group", ASCENDING), ("version", ASCENDING)],
        unique=True,
        partialFilterExpression={"version_group": {"$exists": True}},
    )
    # Sort key + filter compounds (§3.2). ``registered_at`` was missing even
    # as a single-field index; adding it here for the default files sort.
    files.create_index([("registered_at", DESCENDING)])
    files.create_index([("status", ASCENDING), ("registered_at", DESCENDING)])
    files.create_index([("status", ASCENDING), ("size_bytes", DESCENDING)])
    files.create_index([("source_system", ASCENDING), ("registered_at", DESCENDING)])

    signals = db["signals"]
    signals.create_index([("unit", ASCENDING)])
    signals.create_index([("typical_rate_hz", ASCENDING)])
    signals.create_index([("last_seen", ASCENDING)])
    signals.create_index([("rig_ids", ASCENDING)])
    # The two FR-DM-111 filters. Each one also backs a `distinct` call of the
    # facets route, so the facets read an index and never the whole catalogue.
    signals.create_index([("dtype", ASCENDING)])
    signals.create_index([("source_systems", ASCENDING)])
    # New sort key from decision box 1 (§3.2). ``last_seen`` already covers
    # the default sort; ``name`` sorts by ``_id`` (free).
    signals.create_index([("run_count", DESCENDING)])

    file_signals = db["file_signals"]
    file_signals.create_index([("file_id", ASCENDING), ("name", ASCENDING)], unique=True)
    file_signals.create_index([("name", ASCENDING), ("run_id", ASCENDING)])
    # The name rides WITH the run id, so the runs list reads how many distinct
    # signals a run holds from this index and never opens a document. On
    # `run_id` alone Mongo fetched one document per row to read the name —
    # ~78,000 of them for a page holding one 720-file sortie, which is where a
    # three-second list went (`tests/test_runs_list_cost.py`). It also serves
    # every plain `run_id` lookup, `run_id` being its prefix, so the single-key
    # index below it is redundant and is dropped.
    file_signals.create_index([("run_id", ASCENDING), ("name", ASCENDING)])
    try:
        file_signals.drop_index("run_id_1")
    except OperationFailure:
        pass  # never built here, or already dropped

    results = db["processed_results"]
    results.create_index(
        [("run_id", ASCENDING), ("result_key", ASCENDING), ("version", ASCENDING)],
        unique=True,
    )
    results.create_index([("run_id", ASCENDING)])
    results.create_index([("created_at", ASCENDING)])
    # The requirement fold's newest-verdict query (§5.3): one (run, definition)
    # verdict chain, newest version first.
    results.create_index([("verdict.definition_id", ASCENDING), ("version", DESCENDING)])

    # Saved and shared searches (FR-DM-017). Every read filters on the owner
    # key or on the visibility, and the list sorts newest first.
    #
    # No unique index guards the (scope, owner, name) triple. `POST
    # /saved-searches` upserts on it, so the ordinary path already keeps one
    # row per name. Two saves of one name in the same millisecond would mint a
    # second row, and the next save of that name collapses it again. A unique
    # index would answer 500 on that race and buy nothing else.
    searches = db["saved_searches"]
    searches.create_index([("owner_key", ASCENDING)])
    searches.create_index([("visibility", ASCENDING)])
    searches.create_index([("scope", ASCENDING), ("saved_at", DESCENDING)])
    # --- end lane B indexes ---

    # A run's QuixLab notebooks are listed by run, and run deletion drops them by run.
    notebooks = db["notebooks"]
    notebooks.create_index([("run_id", ASCENDING), ("created_at", ASCENDING)])
