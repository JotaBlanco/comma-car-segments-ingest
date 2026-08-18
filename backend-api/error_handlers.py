"""One place where a domain error becomes an HTTP status, in one envelope.

Registered as FastAPI exception handlers rather than repeated try/except blocks in
every route, so the mapping is auditable in one screen and a new route cannot
accidentally report a validation rejection as a 500.

Every response body built here goes through ``error_envelope``, and so does every
``HTTPException`` raised anywhere in the routers - the ``StarletteHTTPException``
handler below normalises those, which is how 33 raise sites keep their plain-string
details while the wire format stays single. See ``error_envelope`` for the
contract and for what the three previous shapes were.

The dependency-unavailable cases are the ones that matter most operationally:
each must be a 503 that *names the cause*, never a 500 and never a silent 200.
There are four of them now - blob storage, Mongo, the event bus, and the event bus
after a trace's writes have already committed - and the last one also has to say
what did and did not persist, because a caller that cannot tell is a caller that
re-uploads blindly.

``SchemaLoadError`` is the one deliberate 500 in this table. An unparseable
published schema is a defect in this deployment, not in the request, so it must
not be dressed up as a 4xx - but it still has to name the file, which the default
handler does not.
"""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pymongo.errors import PyMongoError
from starlette.exceptions import HTTPException as StarletteHTTPException

import deps
from artifact_store import ItemNotFoundError, VersionNotFoundError
from baseline_service import BaselineRejected
from blob_storage import BlobUnavailableError
from error_envelope import envelope, from_detail
from run_service import RunNotFoundError, RunStateError
from schema_registry import SchemaLoadError
from topics import EventBusUnavailableError
from trace_service import TraceConflictError, TraceNotPublishedError
from validation import UploadRejected

logger = logging.getLogger(__name__)


def register(api: FastAPI) -> None:
    @api.exception_handler(StarletteHTTPException)
    async def _http_exception(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        """Normalise every ``raise HTTPException(...)`` into the one envelope.

        This is what lets the routers keep raising plain strings: the string
        becomes ``message`` and the status supplies a stable ``error`` code, while
        a dict detail (``deps.require_blob``) keeps its own code and is no longer
        nested under ``detail``.
        """
        return JSONResponse(
            status_code=exc.status_code,
            content=from_detail(exc.status_code, exc.detail),
            headers=getattr(exc, "headers", None),
        )

    @api.exception_handler(RequestValidationError)
    async def _request_invalid(request: Request, exc: RequestValidationError) -> JSONResponse:
        """FastAPI's own 422, in the same envelope as door validation's 422."""
        problems = [
            {
                "code": error.get("type", "request_validation"),
                "message": error.get("msg", ""),
                "entity_id": None,
                "pointer": "/" + "/".join(str(part) for part in error.get("loc", ())),
            }
            for error in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content=envelope(
                422,
                f"the request body or parameters are invalid ({len(problems)} problem(s))",
                error="request_validation_error",
                problems=problems,
            ),
        )

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
            content=envelope(
                503,
                str(exc),
                error="blob_storage_unavailable",
                hint=(
                    "set TM_BLOB_LOCAL_ROOT to use the local filesystem backend, or re-enable "
                    "blobStorage.bind on this deployment once the Storage Gateway is healthy"
                ),
            ),
        )

    @api.exception_handler(PyMongoError)
    async def _mongo_unavailable(request: Request, exc: PyMongoError) -> JSONResponse:
        """A query that dies mid-flight, after ``deps.get_db`` handed out its cache.

        ``get_db`` only touches the server on the first request of the process, so
        an outage that starts later used to surface as an unhandled driver error -
        a 500 - from inside whichever route happened to run. Same 503, same code,
        same envelope, wherever it is detected.
        """
        logger.error("MongoDB error during %s %s: %s", request.method, request.url.path, exc)
        return JSONResponse(
            status_code=503, content=from_detail(503, deps.mongo_unavailable_detail(exc))
        )

    @api.exception_handler(TraceNotPublishedError)
    async def _trace_not_published(
        request: Request, exc: TraceNotPublishedError
    ) -> JSONResponse:
        # A distinct class rather than a subclass of EventBusUnavailableError:
        # Starlette resolves handlers along the exception's MRO, and this case
        # must never be answered by the generic bus handler, which knows nothing
        # about the trace key or what already persisted.
        logger.error("Trace %s stored but not published: %s", exc.trace_key, exc.reason)
        return JSONResponse(status_code=503, content=exc.as_dict())

    @api.exception_handler(EventBusUnavailableError)
    async def _bus_unavailable(request: Request, exc: EventBusUnavailableError) -> JSONResponse:
        logger.error("Event bus unavailable: %s", exc)
        return JSONResponse(
            status_code=503, content=envelope(503, str(exc), error="event_bus_unavailable")
        )

    @api.exception_handler(SchemaLoadError)
    async def _schema_load_error(request: Request, exc: SchemaLoadError) -> JSONResponse:
        logger.error("Published schema could not be loaded: %s", exc)
        return JSONResponse(
            status_code=500,
            content=envelope(
                500,
                str(exc),
                error="schema_load_error",
                hint=(
                    "no artifact set can be validated until every published schema in "
                    "backend-api/schemas/ parses; GET /health reports the same list under "
                    "schema_registry.errors"
                ),
            ),
        )

    @api.exception_handler(VersionNotFoundError)
    async def _version_missing(request: Request, exc: VersionNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content=envelope(404, str(exc), error="not_found"))

    @api.exception_handler(ItemNotFoundError)
    async def _item_missing(request: Request, exc: ItemNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content=envelope(404, str(exc), error="not_found"))

    @api.exception_handler(RunNotFoundError)
    async def _run_missing(request: Request, exc: RunNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content=envelope(404, str(exc), error="not_found"))

    @api.exception_handler(RunStateError)
    async def _run_state(request: Request, exc: RunStateError) -> JSONResponse:
        return JSONResponse(status_code=409, content=envelope(409, str(exc), error="conflict"))

    @api.exception_handler(TraceConflictError)
    async def _trace_conflict(request: Request, exc: TraceConflictError) -> JSONResponse:
        return JSONResponse(
            status_code=409, content=envelope(409, str(exc), error="trace_key_collision")
        )

    @api.exception_handler(FileExistsError)
    async def _immutable(request: Request, exc: FileExistsError) -> JSONResponse:
        return JSONResponse(
            status_code=409, content=envelope(409, str(exc), error="immutable_artifact")
        )

    @api.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        """Last resort, so that a 500 is never an empty body.

        Round 1 lost time to exactly that: a 500 with nothing in it, from a defect
        that the exception message named precisely. Starlette re-raises after this
        handler returns, so a test client still sees the traceback and nothing is
        swallowed - only the wire response gains a body.
        """
        logger.exception("Unhandled error during %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content=envelope(
                500,
                f"{type(exc).__name__}: {exc}",
                error="internal_error",
                hint=(
                    "this is a defect in the API, not in the request; the log carries "
                    "the traceback"
                ),
            ),
        )
