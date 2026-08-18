"""MongoDB collections and indexes (spec 3.4).

Nothing in the previous implementation created an index; ``crud.py`` inserted
``item: dict`` verbatim into implicit collections. Every unique constraint the
spec relies on - one document per ``(test_run_id, run_version, tc_id)``, one per
``trace_key``, one per ``(device_id, sw_version, hw_version)`` - is created here
and is idempotent, so a redeploy re-asserts it.

``_id`` is left to ``ObjectId`` everywhere (decision D3). Human ids live in
normal indexed fields and every by-id route queries those fields, so no route
coerces a path parameter through ``ObjectId()``.

Every document in these collections is **derived and rebuildable** from blob
artifacts, lake rows and ``run_trace_links``; blob stays the record of truth for
anything that appears in a report.
"""

import logging

from pymongo import ASCENDING, DESCENDING, IndexModel
from pymongo.database import Database
from pymongo.errors import ConnectionFailure, PyMongoError

logger = logging.getLogger(__name__)

DEVICES = "devices"
DEVICE_VERSIONS = "device_versions"
PARAMETER_SETS = "parameter_sets"
BASELINES = "baselines"
REQ_COVERAGE = "req_coverage"
TRACES = "traces"
RUN_TRACE_LINKS = "run_trace_links"
TEST_RUNS = "test_runs"
RUN_METRICS = "run_metrics"
RESULTS = "results"
REQ_VERDICTS = "req_verdicts"

INDEXES: dict[str, list[IndexModel]] = {
    DEVICES: [
        IndexModel([("device_id", ASCENDING)], unique=True, name="uq_device_id"),
    ],
    DEVICE_VERSIONS: [
        IndexModel(
            [("device_id", ASCENDING), ("sw_version", ASCENDING), ("hw_version", ASCENDING)],
            unique=True,
            name="uq_device_version",
        ),
        IndexModel([("device_id", ASCENDING)], name="ix_device_id"),
    ],
    PARAMETER_SETS: [
        IndexModel(
            [("config_id", ASCENDING), ("config_version", ASCENDING)],
            unique=True,
            name="uq_config_version",
        ),
        IndexModel([("config_id", ASCENDING)], name="ix_config_id"),
        IndexModel([("canonical_sha256", ASCENDING)], name="ix_canonical_sha256"),
        IndexModel([("config_hash12", ASCENDING)], name="ix_config_hash12"),
    ],
    BASELINES: [
        IndexModel([("baseline_id", ASCENDING)], unique=True, name="uq_baseline_id"),
        IndexModel([("created_utc", DESCENDING)], name="ix_created_utc"),
    ],
    REQ_COVERAGE: [
        IndexModel(
            [("baseline_id", ASCENDING), ("req_id", ASCENDING)],
            unique=True,
            name="uq_baseline_req",
        ),
        IndexModel([("baseline_id", ASCENDING)], name="ix_baseline_id"),
    ],
    TRACES: [
        IndexModel([("trace_key", ASCENDING)], unique=True, name="uq_trace_key"),
        IndexModel([("device_id", ASCENDING)], name="ix_device_id"),
        IndexModel([("content_sha256", ASCENDING)], name="ix_content_sha256"),
        IndexModel([("mf4.config_hash12", ASCENDING)], name="ix_config_hash12"),
        IndexModel([("ingest_status", ASCENDING)], name="ix_ingest_status"),
    ],
    RUN_TRACE_LINKS: [
        IndexModel(
            [
                ("test_run_id", ASCENDING),
                ("run_version", ASCENDING),
                ("tc_id", ASCENDING),
                ("trace_key", ASCENDING),
            ],
            unique=True,
            name="uq_run_link",
        ),
        IndexModel([("trace_key", ASCENDING)], name="ix_trace_key"),
        IndexModel([("test_run_id", ASCENDING), ("run_version", ASCENDING)], name="ix_run"),
    ],
    TEST_RUNS: [
        IndexModel([("test_run_id", ASCENDING)], unique=True, name="uq_test_run_id"),
        IndexModel([("baseline_id", ASCENDING)], name="ix_baseline_id"),
        IndexModel([("device_id", ASCENDING)], name="ix_device_id"),
        IndexModel([("status", ASCENDING)], name="ix_status"),
        IndexModel([("created_utc", DESCENDING)], name="ix_created_utc"),
    ],
    RUN_METRICS: [
        IndexModel(
            [("test_run_id", ASCENDING), ("run_version", ASCENDING)],
            unique=True,
            name="uq_run_metrics",
        ),
        IndexModel([("test_run_id", ASCENDING)], name="ix_test_run_id"),
    ],
    RESULTS: [
        IndexModel(
            [("test_run_id", ASCENDING), ("run_version", ASCENDING), ("tc_id", ASCENDING)],
            unique=True,
            name="uq_result",
        ),
        IndexModel(
            [("test_run_id", ASCENDING), ("run_version", ASCENDING), ("verdict", ASCENDING)],
            name="ix_run_verdict",
        ),
        IndexModel([("req_ids", ASCENDING)], name="ix_req_ids"),
    ],
    REQ_VERDICTS: [
        IndexModel(
            [("test_run_id", ASCENDING), ("run_version", ASCENDING), ("req_id", ASCENDING)],
            unique=True,
            name="uq_req_verdict",
        ),
        IndexModel(
            [("test_run_id", ASCENDING), ("run_version", ASCENDING), ("verdict", ASCENDING)],
            name="ix_run_verdict",
        ),
    ],
}


def ensure_indexes(db: Database) -> dict[str, list[str]]:
    """Create every index. Idempotent. **Aborts on the first transport failure.**

    Two failure modes, deliberately handled differently, because the first
    version treated them alike and that cost 37 s:

    * a ``ConnectionFailure`` (which is what ``ServerSelectionTimeoutError``,
      ``AutoReconnect`` and ``NetworkTimeout`` all are) means *the server*, not
      this collection, is the problem - so every remaining collection would pay
      the same ``serverSelectionTimeoutMS`` for the same answer. Eleven
      collections turned one 3 s budget into 37 s. It is re-raised immediately,
      so the whole attempt costs one timeout;
    * any other ``PyMongoError`` - an index-options conflict on one collection,
      say - is genuinely collection-local, is logged, and the loop continues, so
      one legacy conflict cannot cost the other ten collections their indexes.

    A failure here must not stop the service from booting; the caller
    (``deps.ensure_indexes_once``) decides that, and this function never runs on
    a request path.
    """
    created: dict[str, list[str]] = {}
    for collection_name, models in INDEXES.items():
        try:
            created[collection_name] = db[collection_name].create_indexes(models)
        except ConnectionFailure:
            logger.warning(
                "Index creation aborted at %s (%d of %d collections done): MongoDB is "
                "unreachable, so the remaining collections would only pay the same timeout",
                collection_name,
                len(created),
                len(INDEXES),
            )
            raise
        except PyMongoError as exc:
            logger.warning("Could not create indexes on %s: %s", collection_name, exc)
            created[collection_name] = []
    return created


def serialize(doc: dict | None) -> dict | None:
    """Drop Mongo's ``_id`` from an API response.

    The human id is always present in a normal field, so ``_id`` carries no
    information a client needs and exposing it invites the very mistake
    decision D3 exists to prevent.
    """
    if doc is None:
        return None
    return {key: value for key, value in doc.items() if key != "_id"}


def serialize_all(docs) -> list[dict]:
    return [serialize(doc) for doc in docs]
