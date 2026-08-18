"""Lazily built process-wide dependencies, plus the honest-degradation helpers.

Everything is built on first use rather than at import, so the service starts and
answers ``/health`` even with no Mongo, no broker and no blob storage. That is
required behaviour, not a convenience: the live deployment currently runs without
blob because the testrig Storage Gateway is down, and the API must degrade
honestly instead of crashing at import or silently succeeding.

**Why there is no ``require_mongo()`` to match ``require_blob()``.** Every
Mongo-backed route already takes ``db=Depends(get_db)``, and a FastAPI dependency
runs before the route body - so ``get_db`` *is* the guard, and a second one would
only be a place for the two to disagree. What ``get_db`` could not do is catch an
outage that starts *after* the first successful request, because by then it
returns the cached handle without touching the server; that case is covered by the
``PyMongoError`` handler in ``error_handlers``, so a query that dies mid-flight is
also a named 503 rather than a 500. One client, bounded timeouts (``db.py``), two
places where the failure becomes an HTTP status.
"""

import logging

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

_client: MongoClient | None = None
_db: Database | None = None
_indexes_done = False


def get_client() -> MongoClient:
    """The one client for this process. Constructing it does no I/O."""
    global _client
    if _client is None:
        _client = db_module.get_client()
    return _client


def get_db() -> Database:
    """The Mongo database handle. Raises 503 when Mongo cannot be reached."""
    global _db, _indexes_done
    try:
        if _db is None:
            _db = db_module.get_db(get_client())
        if not _indexes_done:
            mongo_schema.ensure_indexes(_db)
            _indexes_done = True
        return _db
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
    """Drop cached handles (used when configuration changes under test)."""
    global _client, _db, _indexes_done
    if _client is not None:
        _client.close()
    _client = None
    _db = None
    _indexes_done = False
    blob_storage.reset_backend()
