"""Lazily built process-wide dependencies, plus the honest-degradation helpers.

Everything is built on first use rather than at import, so the service starts and
answers ``/health`` even with no Mongo, no broker and no blob storage. That is
required behaviour, not a convenience: the live deployment currently runs without
blob because the testrig Storage Gateway is down, and the API must degrade
honestly instead of crashing at import or silently succeeding.
"""

import logging

from fastapi import HTTPException
from pymongo.database import Database
from pymongo.errors import PyMongoError

import blob_storage
import db as db_module
import mongo_schema
import topics
from blob_storage import BlobUnavailableError

logger = logging.getLogger(__name__)

_db: Database | None = None
_indexes_done = False


def get_db() -> Database:
    """The Mongo database handle. Raises 503 when Mongo cannot be reached."""
    global _db, _indexes_done
    try:
        if _db is None:
            _db = db_module.get_db(db_module.get_client())
        if not _indexes_done:
            mongo_schema.ensure_indexes(_db)
            _indexes_done = True
        return _db
    except KeyError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"MongoDB is not configured: environment variable {exc} is missing",
        ) from exc
    except PyMongoError as exc:
        raise HTTPException(status_code=503, detail=f"MongoDB is unreachable: {exc}") from exc


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
    global _db, _indexes_done
    _db = None
    _indexes_done = False
    blob_storage.reset_backend()
