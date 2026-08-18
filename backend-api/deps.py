"""Lazily built process-wide dependencies, plus the honest-degradation helpers.

Everything is built on first use rather than at import, so the service starts and
answers ``/health`` even with no Mongo, no broker and no blob storage. That is
required behaviour, not a convenience: the live deployment currently runs without
blob because the testrig Storage Gateway is down, and the API must degrade
honestly instead of crashing at import or silently succeeding.

**Why there is no ``require_mongo()`` to match ``require_blob()``.** Every
Mongo-backed route already takes ``db=Depends(get_db)``, and a FastAPI dependency
runs before the route body - so ``get_db`` *is* the configuration guard, and a
second one would only be a place for the two to disagree. What ``get_db`` cannot
do is detect an *outage*: it hands out a cached handle without touching the
server, by design (see below). Reachability is therefore the route query's own
business, and the ``PyMongoError`` handler in ``error_handlers`` turns whatever it
hits - a stopped server, an outage that starts mid-request - into the same named
503 rather than a 500. One client, bounded timeouts (``db.py``), one place where a
missing variable becomes a 503 and one place where an outage does.

**Nothing on a request path may pay a Mongo timeout more than once.** ``get_db``
used to create the schema's indexes on the first Mongo-backed request of the
process; with Mongo down that loop paid ``serverSelectionTimeoutMS`` once per
collection and the first request took ~37 s - worse than the 30 s default the
pinned timeouts exist to prevent. Index creation now lives in
``ensure_indexes_once``, called from a background reconciler that the application
lifespan starts (``main.py``), never from a dependency. ``get_db`` does no I/O at
all: a *reachability* failure surfaces from the route's own query, bounded by one
server-selection timeout, as the same named 503.
"""

import logging
import os
import threading

from fastapi import HTTPException
from pymongo import MongoClient
from pymongo.database import Database
from pymongo.errors import PyMongoError

import blob_storage
import db as db_module
import mongo_schema
import topics
from blob_storage import BlobUnavailableError

logger = logging.getLogger(__name__)

MONGO_UNAVAILABLE = "mongo_unavailable"
MONGO_NOT_CONFIGURED = "mongo_not_configured"

# How often the background reconciler retries index creation while Mongo is down.
# It never runs on a request path, so this interval costs a sleeping daemon thread
# and nothing else.
INDEX_RETRY_INTERVAL_S = float(os.environ.get("TM_INDEX_RETRY_INTERVAL_S", "30"))

_client: MongoClient | None = None
_db: Database | None = None
_indexes_done = False
_indexes_lock = threading.Lock()
# Re-entrant: ``database()`` holds it while calling ``get_client()``.
_client_lock = threading.RLock()
_reconciler_stop = threading.Event()
_reconciler: threading.Thread | None = None


def get_client() -> MongoClient:
    """The one client for this process. Constructing it does no I/O.

    Locked because the index reconciler runs in a thread of its own: two threads
    racing here would build two clients, each with its own connection pool, and
    silently leak one.
    """
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = db_module.get_client()
    return _client


def database() -> Database:
    """The cached database handle. No I/O: ``client[name]`` is a lookup.

    Raises ``KeyError`` when a connection variable is missing. Used by ``get_db``
    and by the index reconciler, which must not have an ``HTTPException`` thrown
    at it.
    """
    global _db
    if _db is None:
        with _client_lock:
            if _db is None:
                _db = db_module.get_db(get_client())
    return _db


def get_db() -> Database:
    """The Mongo database handle. Raises 503 when Mongo is not configured.

    Deliberately free of I/O and of index creation: constructing the client and
    looking up the database are both lazy, so this dependency costs nothing and an
    outage is paid for exactly once, by the route's own query, which
    ``error_handlers`` turns into the same ``mongo_unavailable`` 503.
    """
    try:
        return database()
    except KeyError as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "error": MONGO_NOT_CONFIGURED,
                "message": f"MongoDB is not configured: environment variable {exc} is missing",
                "hint": "set MONGO_HOST, MONGO_USER, MONGO_PASSWORD and MONGO_DB_NAME",
            },
        ) from exc
    except PyMongoError as exc:
        raise HTTPException(status_code=503, detail=mongo_unavailable_detail(exc)) from exc


def mongo_unavailable_detail(exc: Exception) -> dict:
    """The one body a Mongo outage produces, wherever it is detected."""
    return {
        "error": MONGO_UNAVAILABLE,
        "message": f"MongoDB is unreachable: {exc}",
        "hint": (
            "the datastore is down or unreachable, not the request: check the mongodb "
            "deployment, then retry. Timeouts are bounded (see /health -> mongo.timeouts) "
            "so this answer arrives inside a normal client read timeout"
        ),
    }


def mongo_status() -> dict:
    """Bounded reachability probe for ``/health``. Never raises.

    A ``ping`` admin command, not a query: it needs no collection, no index and no
    privileges, and it is bounded by the client's server-selection timeout, so a
    stopped Mongo costs ``MONGO_SERVER_SELECTION_TIMEOUT_MS`` and not 30 s.

    "Never raises" is the contract, not a hope: ``/health`` is the endpoint that has
    to answer when everything else is broken, so the last clause catches whatever a
    driver or a test double throws that is not a ``PyMongoError`` and reports it as
    the reason instead of turning liveness into a 500.
    """
    status = {"available": False, "reason": None, "timeouts": db_module.timeouts()}
    try:
        get_client().admin.command("ping")
    except KeyError as exc:
        status["reason"] = f"not configured: environment variable {exc} is missing"
    except PyMongoError as exc:
        status["reason"] = str(exc)
    except Exception as exc:
        logger.exception("Mongo ping failed with a non-driver error")
        status["reason"] = f"{type(exc).__name__}: {exc}"
    else:
        status["available"] = True
    return status


def ensure_indexes_once() -> bool:
    """Create the schema's indexes at most once per process. Never raises.

    Returns ``True`` when the indexes are in place - because this call created
    them or because an earlier one did - and ``False`` when the attempt was
    skipped or failed, which is the reconciler's cue to try again later.

    Two bugs are fixed here, both from one root:

    * **the attempt is bounded as a whole.** One ``mongo_status()`` ping decides
      reachability, and ``mongo_schema.ensure_indexes`` re-raises the first
      transport failure, so an unreachable Mongo costs one server-selection
      timeout rather than one per collection;
    * **the flag latches only on success.** It used to be set whether or not the
      indexes had been created, so a process that started while Mongo was down
      never created them at all, even after Mongo came back.

    The lock is what stops a thundering herd: concurrent callers do not each open
    their own ping-plus-eleven-``createIndexes`` conversation with the server.
    """
    global _indexes_done
    if _indexes_done:
        return True
    with _indexes_lock:
        if _indexes_done:  # another caller won the race while we waited
            return True
        status = mongo_status()
        if not status["available"]:
            logger.warning(
                "Skipping index creation: MongoDB is not reachable (%s). Will retry.",
                status["reason"],
            )
            return False
        try:
            mongo_schema.ensure_indexes(database())
        except KeyError as exc:
            logger.warning("Skipping index creation: environment variable %s is missing", exc)
            return False
        except PyMongoError as exc:
            logger.warning("Index creation failed and will be retried: %s", exc)
            return False
        _indexes_done = True
        logger.info("MongoDB indexes ensured")
        return True


def _reconcile_indexes(interval_s: float) -> None:
    """Retry ``ensure_indexes_once`` until it succeeds. Never on a request path."""
    attempt = 0
    while not _reconciler_stop.is_set():
        attempt += 1
        try:
            done = ensure_indexes_once()
        except Exception:
            # ``ensure_indexes_once`` is written never to raise. If it ever does,
            # this thread has to say so: a daemon thread that dies silently would
            # leave the process running without indexes and without a reason.
            logger.exception("Index reconciler hit an unexpected error")
            done = False
        if done:
            return
        if attempt == 1 or attempt % 10 == 0:
            logger.warning(
                "MongoDB indexes still not created after %d attempt(s); retrying every %.0fs",
                attempt,
                interval_s,
            )
        if _reconciler_stop.wait(interval_s):
            return


def start_index_reconciler(interval_s: float | None = None) -> threading.Thread | None:
    """Start the background index creator. Returns the thread, or ``None``.

    Called from the application lifespan, so indexes are created at start-up
    rather than by whichever request happens to be first - and in a *thread*, so a
    Mongo outage at start-up can neither delay nor prevent the process from
    booting. That property is load-bearing: every one of these applications must
    import and start with no environment variables set at all.
    """
    global _reconciler
    if _indexes_done:
        return None
    interval = INDEX_RETRY_INTERVAL_S if interval_s is None else interval_s
    _reconciler_stop.clear()
    _reconciler = threading.Thread(
        target=_reconcile_indexes,
        args=(interval,),
        name="mongo-index-reconciler",
        daemon=True,
    )
    _reconciler.start()
    return _reconciler


def stop_index_reconciler(timeout_s: float = 2.0) -> None:
    """Ask the reconciler to stop and wait briefly. Safe when none is running."""
    global _reconciler
    _reconciler_stop.set()
    if _reconciler is not None:
        _reconciler.join(timeout=timeout_s)
        _reconciler = None


def get_bus() -> topics.EventBus:
    return topics.get_bus()


def require_blob() -> None:
    """Guard for endpoints that cannot work without blob storage.

    Returns nothing and raises ``503`` with the *cause* named, so the caller sees
    "not bound to blob storage because the Storage Gateway is unreachable"
    rather than an opaque 500 or, worse, a 200 with no artifact written.
    """
    reason = blob_storage.unavailable_reason()
    if reason is not None:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "blob_storage_unavailable",
                "message": reason,
                "hint": (
                    "set TM_BLOB_LOCAL_ROOT for a local filesystem backend, or re-enable "
                    "blobStorage.bind on this deployment once the Storage Gateway is healthy"
                ),
            },
        )


def blob_error(exc: BlobUnavailableError) -> HTTPException:
    return HTTPException(
        status_code=503,
        detail={"error": "blob_storage_unavailable", "message": str(exc)},
    )


def reset() -> None:
    """Drop cached handles (used when configuration changes under test).

    Stops the reconciler first: a thread still holding the old client would
    otherwise latch ``_indexes_done`` against a database the caller has just
    reconfigured.
    """
    global _client, _db, _indexes_done
    stop_index_reconciler()
    if _client is not None:
        _client.close()
    _client = None
    _db = None
    _indexes_done = False
    blob_storage.reset_backend()
