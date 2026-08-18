"""One place where a domain error becomes an HTTP status.

Registered as FastAPI exception handlers rather than repeated try/except blocks in
every route, so the mapping is auditable in one screen and a new route cannot
accidentally report a validation rejection as a 500.

The blob-unavailable case is the one that matters most operationally: it must be
a 503 that *names the cause*, never a 500 and never a silent 200.
"""

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from artifact_store import ItemNotFoundError, VersionNotFoundError
from baseline_service import BaselineRejected
from blob_storage import BlobUnavailableError
from run_service import RunNotFoundError, RunStateError
from trace_service import TraceConflictError
from validation import UploadRejected

logger = logging.getLogger(__name__)


def register(api: FastAPI) -> None:
    @api.exception_handler(UploadRejected)
    async def _upload_rejected(request: Request, exc: UploadRejected) -> JSONResponse:
        logger.info("Upload rejected at %s: %s", exc.stage, exc)
        return JSONResponse(status_code=422, content=exc.as_dict())

    @api.exception_handler(BaselineRejected)
    async def _baseline_rejected(request: Request, exc: BaselineRejected) -> JSONResponse:
        return JSONResponse(status_code=422, content=exc.as_dict())

    @api.exception_handler(BlobUnavailableError)
    async def _blob_unavailable(request: Request, exc: BlobUnavailableError) -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={
                "error": "blob_storage_unavailable",
                "message": str(exc),
                "hint": (
                    "set TM_BLOB_LOCAL_ROOT to use the local filesystem backend, or re-enable "
                    "blobStorage.bind on this deployment once the Storage Gateway is healthy"
                ),
            },
        )

    @api.exception_handler(VersionNotFoundError)
    async def _version_missing(request: Request, exc: VersionNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"error": "not_found", "message": str(exc)})

    @api.exception_handler(ItemNotFoundError)
    async def _item_missing(request: Request, exc: ItemNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"error": "not_found", "message": str(exc)})

    @api.exception_handler(RunNotFoundError)
    async def _run_missing(request: Request, exc: RunNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"error": "not_found", "message": str(exc)})

    @api.exception_handler(RunStateError)
    async def _run_state(request: Request, exc: RunStateError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"error": "conflict", "message": str(exc)})

    @api.exception_handler(TraceConflictError)
    async def _trace_conflict(request: Request, exc: TraceConflictError) -> JSONResponse:
        return JSONResponse(
            status_code=409, content={"error": "trace_key_collision", "message": str(exc)}
        )

    @api.exception_handler(FileExistsError)
    async def _immutable(request: Request, exc: FileExistsError) -> JSONResponse:
        return JSONResponse(
            status_code=409, content={"error": "immutable_artifact", "message": str(exc)}
        )
