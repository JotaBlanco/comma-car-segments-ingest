"""App factory. Registers every router on day 1, so no lane edits this file.

This file is frozen after the base. Only the BE lead edits it.
"""

import asyncio
import inspect
import logging
from collections.abc import Iterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import httpx
import pymongo
from fastapi import APIRouter, Depends, FastAPI
from fastapi.openapi.utils import get_openapi
from fastapi.responses import Response, StreamingResponse
from pymongo.errors import PyMongoError

from api import capabilities, ingest_sweep, metrics
from api.auth import require_token
from api.db import ensure_indexes, get_client, get_db
from api.errors import (
    ERROR_SCHEMA,
    ERROR_SCHEMA_NAME,
    VALIDATION_ERROR_SCHEMA,
    VALIDATION_ERROR_SCHEMA_NAME,
    ApiError,
    register_error_handlers,
)
from api.models.common import ALLOWED_PAGE_SIZES
from api.routers import (
    assistant,
    definition_runs,
    explore,
    explore_chat,
    files,
    home,
    integrations,
    journal,
    mcp,
    planning_sync,
    quixlab_drafts,
    quixlab_labs,
    requirements,
    results,
    search,
    searches,
    signals,
    test_definitions,
    test_runs,
    work_orders,
)
from api.services import retention
from api.services.file_bytes import CHUNK_BYTES, content_disposition
from api.settings import get_settings

API_VERSION = "1.0.0"

# The `tm` command line, served as an installable wheel.
#
# `api/Dockerfile` runs `uv build --wheel` in the build stage and copies the
# result here, so the shipped image carries the wheel and a person installs the
# CLI from the deployment they already use. A developer machine builds no
# wheel, so this directory is normally empty there and the route answers 404.
#
# `__file__` is `<root>/api/main.py`, so the parent's parent is the project
# root: `/app` in the image, `api/` in the repository. `uv build` writes to
# `dist/` under that same root, so no environment variable joins the image.
CLI_WHEEL_DIR = Path(__file__).resolve().parent.parent / "dist"

# `pip` reads the package name and the version off the URL, and it refuses a
# wheel whose metadata states another name. So the route serves this exact
# name and the documentation states it. It comes from `[project] name` and
# `[project] version` in `pyproject.toml`, and
# `api/tests/test_cli_wheel.py` fails if either one moves.
CLI_WHEEL_NAME = "test_manager_api-0.1.0-py3-none-any.whl"

# The document description. `/docs` renders it, `/docs` is open in every
# environment, and it is the one page a person already opens. So the `tm`
# install line lives here and no new screen is needed.
#
# **It names no host.** A reader substitutes the address of the deployment whose
# `/docs` they are reading. A stated host would put a real address in the open
# schema, and `api/tests/test_docs_gate.py` holds that line.
API_DESCRIPTION = f"""Registry API for test runs, files, signals and results.

**The `tm` command line.** It reads the same routes this document describes.
Install it from this deployment. No registry, no credential and no private
repository:

```
pip install <the address of this API>/cli/{CLI_WHEEL_NAME}
```

Then set `TM_API_URL` and `TM_API_TOKEN`, and run `tm runs`.
"""

# The readiness ping must fail fast, because a probe that hangs reads as a hang
# and not as a failure. `pymongo.timeout` bounds server selection as well as the
# command, so a Mongo that is down raises inside this budget.
READY_PING_TIMEOUT_SECONDS = 0.5


# ---------------------------------------------------------------------------
# The OpenAPI document
#
# FastAPI writes a document that says less than the code does, and `/docs` is
# open in every environment, so a reader sees every gap. Six of them:
#
# 1. `page_size`, `sort` and `order` lose their allow-lists and read as a bare
#    integer and two bare strings. A generated client sends `page_size=25` and
#    gets 422.
# 2. The only error schema is FastAPI's `HTTPValidationError`. This app never
#    sends that shape. It sends `{detail, code, errors}` (`api/errors.py`).
# 3. The generator declares 200, 201 and 422 only. The routes also answer 400,
#    401, 403, 404, 409, 410, 413 and 503.
# 4. Five write routes answer 200 on a replay, and the document says 201 only.
# 5. Two routes stream NDJSON and one streams bytes. All three said JSON.
# 6. `/mcp` carried no security scheme, so a generated client sends no token
#    and gets 401.
#
# The block below states all six. It never widens a schema. Every value comes
# from the route code, and `api/tests/test_openapi_document.py` proves it.
# ---------------------------------------------------------------------------

# Every `/api/v1` route sits behind `require_token`, so every one of them can
# answer this pair. The 503 belongs to the platform path only (`api/auth.py`).
AUTH_ERRORS: tuple[tuple[int, str], ...] = (
    (401, "unauthorized"),
    (503, "platform_unavailable"),
)

# What every CSV export answers. The three routes call one service
# (`api/api/services/exports.py`), so one tuple states all three.
EXPORT_ERRORS: tuple[tuple[int, str], ...] = (
    (413, "export_too_large"),
    (422, "unknown_column"),
    (503, "not_ready"),
)

# What each operation raises on top of `AUTH_ERRORS` and its own
# `422 validation_error`. Read from the route code and its services.
ROUTE_ERRORS: dict[str, tuple[tuple[int, str], ...]] = {
    # The three CSV exports below share `api/api/services/exports.py`, so they
    # share one set: an unknown column, the row cap, and the audit row that
    # must land before the first byte moves.
    "GET /api/v1/test-runs/export": EXPORT_ERRORS,
    "GET /api/v1/test-runs/{run_id}": ((404, "run_not_found"),),
    "PATCH /api/v1/test-runs/{run_id}": (
        (400, "no_fields_to_update"),
        (404, "run_not_found"),
        (422, "unknown_work_order"),
        (422, "unknown_definition"),
    ),
    "POST /api/v1/test-runs/{run_id}/invalid-flag": (
        (404, "run_not_found"),
        (409, "already_flagged"),
        (422, "reason_required"),
    ),
    "DELETE /api/v1/test-runs/{run_id}/invalid-flag": (
        (404, "run_not_found"),
        (409, "not_flagged"),
        (422, "reason_required"),
    ),
    "POST /api/v1/test-runs/{run_id}/definitions": (
        (404, "run_not_found"),
        (422, "unknown_definition"),
    ),
    "DELETE /api/v1/test-runs/{run_id}/definitions/{definition_id}": (
        (404, "run_not_found"),
        (422, "unknown_definition"),
    ),
    "GET /api/v1/test-runs/{run_id}/files": ((404, "run_not_found"),),
    "GET /api/v1/test-runs/{run_id}/lineage": ((404, "run_not_found"),),
    "GET /api/v1/test-runs/{run_id}/journal": ((404, "run_not_found"),),
    "POST /api/v1/test-runs/{run_id}/journal": ((404, "run_not_found"),),
    "GET /api/v1/test-runs/{run_id}/signals": ((404, "run_not_found"),),
    "POST /api/v1/test-runs/{run_id}/signals": (
        (404, "run_not_found"),
        (503, "lake_unavailable"),
    ),
    "GET /api/v1/test-runs/{run_id}/explore/context": ((404, "run_not_found"),),
    "POST /api/v1/test-runs/{run_id}/explore/chat": (
        (403, "ai_unavailable"),
        (404, "run_not_found"),
    ),
    "GET /api/v1/test-definitions/{td_id}": ((404, "td_not_found"),),
    "POST /api/v1/test-definitions/{td_id}/requirements-files": (
        (404, "td_not_found"),
        (413, "file_too_large"),
        (422, "name_required"),
        (422, "content_required"),
    ),
    "POST /api/v1/test-definitions/{td_id}/requirements-files/upload": (
        (404, "td_not_found"),
        (413, "file_too_large"),
        (422, "name_required"),
        (422, "content_required"),
        (503, "storage_unreachable"),
        (503, "not_ready"),
    ),
    "PATCH /api/v1/test-definitions/{td_id}/requirements-files/{name}": (
        (404, "td_not_found"),
        (404, "requirements_file_not_found"),
        (409, "planning_owned_file"),
        (409, "requirements_file_has_no_text"),
        (413, "file_too_large"),
        (422, "content_required"),
    ),
    "DELETE /api/v1/test-definitions/{td_id}/requirements-files/{name}": (
        (404, "td_not_found"),
        (404, "requirements_file_not_found"),
        (409, "planning_owned_file"),
    ),
    "GET /api/v1/test-definitions/{td_id}/requirements-files/{name}/download": (
        (404, "td_not_found"),
        (404, "requirements_file_not_found"),
        (409, "requirements_file_has_no_bytes"),
        (503, "storage_unreachable"),
        (503, "not_ready"),
    ),
    "PATCH /api/v1/test-definitions/{td_id}/custom-properties": (
        (404, "td_not_found"),
        (422, "too_many_custom_properties"),
        (422, "custom_property_key_required"),
        (422, "custom_property_key_too_long"),
        (422, "custom_property_value_too_long"),
    ),
    "POST /api/v1/work-orders": ((409, "wo_exists"),),
    "GET /api/v1/work-orders/{wo_id}": ((404, "wo_not_found"),),
    "PATCH /api/v1/work-orders/{wo_id}": ((404, "wo_not_found"),),
    "DELETE /api/v1/work-orders/{wo_id}": (
        (404, "wo_not_found"),
        (409, "work_order_has_runs"),
    ),
    "GET /api/v1/files/export": EXPORT_ERRORS,
    "GET /api/v1/files/{file_id}": ((404, "file_not_found"),),
    "PATCH /api/v1/files/{file_id}": (
        (400, "no_fields_to_update"),
        (404, "file_not_found"),
        (409, "file_deleted"),
        (409, "file_archived"),
        (409, "checksum_already_registered"),
        (422, "unknown_run"),
    ),
    "DELETE /api/v1/files/{file_id}": ((404, "file_not_found"),),
    "POST /api/v1/files/{file_id}/archive": (
        (404, "file_not_found"),
        (409, "file_deleted"),
    ),
    "POST /api/v1/files/{file_id}/restore": ((404, "file_not_found"),),
    "GET /api/v1/files/{file_id}/versions": ((404, "file_not_found"),),
    "POST /api/v1/files/{file_id}/versions": (
        (404, "file_not_found"),
        (409, "file_deleted"),
        (409, "file_archived"),
        (409, "checksum_already_registered"),
        (409, "version_conflict"),
    ),
    "GET /api/v1/files/{file_id}/download": (
        (403, "not_allowed"),
        (404, "file_not_found"),
        (410, "file_deleted"),
        (503, "storage_unreachable"),
        (503, "not_ready"),
    ),
    "GET /api/v1/signals/export": EXPORT_ERRORS,
    "GET /api/v1/signals/{name}": ((404, "signal_not_found"),),
    "PATCH /api/v1/signals/{name}": (
        (400, "no_fields_to_update"),
        (404, "signal_not_found"),
    ),
    "GET /api/v1/signals/{name}/stats": (
        (400, "unsupported_window"),
        (404, "signal_not_found"),
        (503, "lake_unavailable"),
    ),
    "POST /api/v1/results": (
        (409, "version_conflict"),
        (422, "provenance_required"),
    ),
    "GET /api/v1/results/{result_id}": ((404, "result_not_found"),),
    "GET /api/v1/results/{result_id}/download": (
        (404, "result_not_found"),
        (409, "result_has_no_bytes"),
        (503, "storage_unreachable"),
        (503, "not_ready"),
    ),
    "POST /api/v1/results/upload": (
        (409, "version_conflict"),
        (413, "file_too_large"),
        (422, "provenance_required"),
        (422, "invalid_metadata"),
        (422, "storage_ref_not_allowed"),
        (503, "storage_unreachable"),
        (503, "not_ready"),
    ),
    "DELETE /api/v1/saved-searches/{search_id}": (
        (403, "not_the_owner"),
        (404, "saved_search_not_found"),
    ),
    # The route checks the named entity against the same table the journal
    # POST checks against, so it answers that entity's own 404 code.
    "POST /api/v1/access-requests": (
        (404, "run_not_found"),
        (404, "file_not_found"),
        (404, "signal_not_found"),
        (404, "wo_not_found"),
        (404, "result_not_found"),
        (404, "td_not_found"),
        (404, "requirement_not_found"),
    ),
    "POST /api/v1/assistant/chat": (
        (403, "assistant_disabled"),
        (403, "ai_unavailable"),
    ),
    "POST /api/v1/test-runs/{run_id}/definitions/{td_id}/run": (
        (401, "quixlab_needs_login"),
        (403, "quixlab_refused"),
        (404, "run_not_found"),
        (404, "td_not_found"),
        (404, "implementation_not_found"),
        (409, "quixlab_no_template"),
        (503, "storage_unreachable"),
        (503, "quixlab_unreachable"),
    ),
    "GET /api/v1/test-runs/{run_id}/definitions/{td_id}/run": (
        (401, "quixlab_needs_login"),
        (403, "quixlab_refused"),
        (404, "run_not_found"),
        (404, "td_not_found"),
        (404, "run_job_not_found"),
        (409, "quixlab_no_template"),
        (409, "version_conflict"),
        (503, "quixlab_unreachable"),
    ),
    "GET /api/v1/requirements/{req_id}": ((404, "requirement_not_found"),),
    "GET /api/v1/requirements/{req_id}/journal": ((404, "requirement_not_found"),),
    "POST /api/v1/requirements": ((409, "id_reuse"),),
    "PATCH /api/v1/requirements/{req_id}": (
        (404, "requirement_not_found"),
        (409, "stale_parent"),
        (409, "no_op_mint"),
    ),
    "POST /api/v1/requirements/{req_id}/retire": (
        (404, "requirement_not_found"),
        (409, "stale_parent"),
        (409, "already_obsolete"),
    ),
}

# A write that a caller replays answers 200 and the stored body, and it mints
# nothing. The generator reads `status_code=201` and never sees the second one.
REPLAY_200_ROUTES = (
    "POST /api/v1/test-runs",
    "POST /api/v1/test-runs/{run_id}/signals",
    "POST /api/v1/files",
    "POST /api/v1/files/{file_id}/versions",
    "POST /api/v1/results",
)

# What the 200 body really carries on a route that streams.
STREAMING_MEDIA_TYPES = {
    "GET /api/v1/files/{file_id}/download": "application/octet-stream",
    "GET /api/v1/results/{result_id}/download": "application/octet-stream",
    "GET /api/v1/test-definitions/{td_id}/requirements-files/{name}/download": (
        "application/octet-stream"
    ),
    "POST /api/v1/test-runs/{run_id}/explore/chat": "application/x-ndjson",
    "POST /api/v1/assistant/chat": "application/x-ndjson",
}

# `/mcp` speaks JSON-RPC, so its refusals carry a JSON-RPC error object and
# never the `{detail, code, errors}` body of `/api/v1`.
MCP_RESPONSES = {
    "202": {"description": "A notification. The server answers no body."},
    "401": {
        "description": "The bearer token is missing or wrong. The body is a "
        "JSON-RPC error object.",
        "content": {"application/json": {"schema": {"type": "object"}}},
    },
    "403": {
        "description": "The MCP surface is off: Quix__Sdk__Token is not "
        "set (off-platform run). The body is a JSON-RPC error object.",
        "content": {"application/json": {"schema": {"type": "object"}}},
    },
}

_HTTP_REASONS = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    410: "Gone",
    413: "Content Too Large",
    422: "Unprocessable Entity",
    503: "Service Unavailable",
}


def _error_response(status: int, codes: list[str]) -> dict:
    """One response entry that names the schema and every `code` it carries."""
    name = VALIDATION_ERROR_SCHEMA_NAME if status == 422 else ERROR_SCHEMA_NAME
    reason = _HTTP_REASONS.get(status, "Error")
    return {
        "description": f"{reason} — code: {', '.join(codes)}.",
        "content": {
            "application/json": {"schema": {"$ref": f"#/components/schemas/{name}"}}
        },
    }


def _walk_routes(routes, prefix: str = ""):
    """Yield `(full path, route)` for every route, included routers included.

    `include_router` keeps a nested holder in this FastAPI version, so
    `app.routes` carries routers and not only routes.
    """
    for route in routes:
        inner = getattr(route, "original_router", None)
        if inner is not None:
            yield from _walk_routes(inner.routes, prefix + inner.prefix)
        elif getattr(route, "path", None) is not None:
            yield prefix + route.path, route


def _sort_allow_list(route) -> tuple[str, ...] | None:
    """The `sort` allow-list of one route, read off its sort dependency.

    `api/models/sorting.py` closes over `whitelist`, so the allow-list has one
    home and this document can never state a second one. A route that rejects
    both params carries no `whitelist`, and the answer is then `None`.
    """
    for dependency in getattr(getattr(route, "dependant", None), "dependencies", []):
        try:
            nonlocals = inspect.getclosurevars(dependency.call).nonlocals
        except TypeError:
            continue
        if "whitelist" in nonlocals:
            return tuple(nonlocals["whitelist"])
    return None


def _patch_parameters(operation: dict, allow_list: tuple[str, ...] | None) -> None:
    """Put the three allow-lists back on the query parameters."""
    for parameter in operation.get("parameters", []):
        name = parameter.get("name")
        if name == "page_size":
            parameter["schema"]["enum"] = list(ALLOWED_PAGE_SIZES)
        elif name == "sort":
            if allow_list is None:
                parameter["description"] = (
                    "Not accepted on this endpoint. Any value answers 422."
                )
            else:
                parameter["schema"] = {
                    "anyOf": [
                        {"type": "string", "enum": list(allow_list)},
                        {"type": "null"},
                    ],
                    "title": "Sort",
                }
        elif name == "order":
            if allow_list is None:
                parameter["description"] = (
                    "Not accepted on this endpoint. Any value answers 422."
                )
            else:
                parameter["schema"] = {
                    "anyOf": [
                        {"type": "string", "enum": ["asc", "desc"]},
                        {"type": "null"},
                    ],
                    "title": "Order",
                }


def _patch_operation(key: str, operation: dict) -> None:
    """State the errors, the replay 200 and the streamed media type."""
    responses = operation["responses"]

    by_status: dict[int, list[str]] = {}
    for status, code in AUTH_ERRORS + ROUTE_ERRORS.get(key, ()):
        by_status.setdefault(status, []).append(code)
    if "422" in responses:
        by_status.setdefault(422, []).insert(0, "validation_error")
    for status, codes in sorted(by_status.items()):
        responses[str(status)] = _error_response(status, codes)

    if key in REPLAY_200_ROUTES:
        responses["200"] = {
            "description": "The caller replayed a stored write. Nothing was "
            "written and the stored body comes back.",
            "content": responses["201"]["content"],
        }

    media_type = STREAMING_MEDIA_TYPES.get(key)
    if media_type is not None:
        responses["200"]["content"] = {media_type: {"schema": {"type": "string"}}}


def customise_openapi(app: FastAPI) -> None:
    """Make `app.openapi()` describe what the routes really do."""

    def build() -> dict:
        if app.openapi_schema is not None:
            return app.openapi_schema
        schema = get_openapi(
            title=app.title,
            version=app.version,
            description=app.description,
            routes=app.routes,
        )
        schemas = schema.setdefault("components", {}).setdefault("schemas", {})
        schemas[ERROR_SCHEMA_NAME] = ERROR_SCHEMA
        schemas[VALIDATION_ERROR_SCHEMA_NAME] = VALIDATION_ERROR_SCHEMA
        # Nothing points at it once every 422 names the real body.
        schemas.pop("HTTPValidationError", None)

        allow_lists = {
            f"{method} {path}": _sort_allow_list(route)
            for path, route in _walk_routes(app.routes)
            for method in getattr(route, "methods", ())
        }
        for path, operations in schema["paths"].items():
            for method, operation in operations.items():
                key = f"{method.upper()} {path}"
                _patch_parameters(operation, allow_lists.get(key))
                if path.startswith("/api/v1/"):
                    _patch_operation(key, operation)

        mcp_operation = schema["paths"]["/mcp"]["post"]
        # The route holds its own bearer token (the workspace SDK token).
        # Without this line a generated client sends no header -> 401.
        mcp_operation["security"] = [{"HTTPBearer": []}]
        mcp_operation["responses"].update(MCP_RESPONSES)

        app.openapi_schema = schema
        return schema

    app.openapi = build


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Run the background workers for the life of the application.

    Three workers run here. The retention purge empties the recycle bin
    (FR-DM-042); `api/api/services/retention.py` holds the order and the audit
    rule. The ingestion sweep is the cron and file-watcher trigger (FR-DM-003);
    it stays OFF until `MF4_IMPORT_URL` names a URL, so `start` answers None and
    the sweep then does nothing. The storage worker refreshes the registry byte
    total (FR-DM-081); it runs here so a slow or absent Mongo can never reach
    the `/metrics` route.

    `api/mock_planning/main.py` runs its push worker the same way. No scheduler
    library joins the image for either worker.
    """
    # Indexes are code, not seed-time state: only the seed and the tests ran
    # `ensure_indexes` until 25 Aug 2026, so a deployed Mongo kept whatever
    # index shape its LAST seed knew — the legacy global-unique checksum index
    # survived the (run_id, checksum_sha256) migration and the "re-run a known
    # recording as a new run" write answered 500 off it. Best-effort: a slow
    # Mongo must not block startup, and the seed path still ensures too.
    try:
        ensure_indexes(get_db())
    except Exception:  # noqa: BLE001 - startup must survive a slow Mongo
        logging.getLogger("api.main").warning(
            "ensure_indexes failed at startup; relying on seed-time indexes", exc_info=True
        )

    workers = [
        asyncio.create_task(retention.purge_worker()),
        asyncio.create_task(metrics.storage_worker()),
    ]
    sweep = ingest_sweep.start()
    if sweep is not None:
        workers.append(sweep)
    try:
        yield
    finally:
        for worker in workers:
            worker.cancel()
        for worker in workers:
            with suppress(asyncio.CancelledError):
                await worker


def create_app() -> FastAPI:
    # `/docs`, `/redoc` and `/openapi.json` are OPEN, in every environment.
    #
    # A `TM_ENV` switch closed them until 20 Aug 2026. It is gone: a reviewer
    # who reads the live contract serves the traceability story, and the schema
    # protects nothing. It names routes and shapes. It carries no host, no
    # credential and no data. Every `/api/v1` route still needs the bearer
    # token, and `test_docs_gate.py` holds that line.
    app = FastAPI(
        title="Test Manager API",
        version=API_VERSION,
        # The `tm` install line rides the description, because `/docs` is the
        # one place a person already looks and it needs no token. The line
        # names no host: a reader substitutes the address of the deployment
        # whose `/docs` they are reading, and a stated host would put a real
        # address in the open schema.
        description=API_DESCRIPTION,
        lifespan=lifespan,
    )
    register_error_handlers(app)

    @app.get("/swagger", include_in_schema=False)
    def swagger_alias():
        """The ASP.NET spelling of /docs. Fingers trained on the Quix Portal
        type /swagger, and a 404 there reads as "this API has no docs"."""
        from fastapi.responses import RedirectResponse

        return RedirectResponse("/docs", status_code=307)
    # The metric middleware sits outermost, so it times the whole answer, the
    # error handling included.
    app.add_middleware(metrics.MetricsMiddleware)

    api = APIRouter(prefix="/api/v1", dependencies=[Depends(require_token)])
    for module in (
        home,
        test_runs,
        work_orders,
        test_definitions,
        requirements,
        files,
        signals,
        results,
        journal,
        search,
        searches,
        planning_sync,
        explore,
        explore_chat,
        assistant,
        integrations,
        definition_runs,
        quixlab_labs,
        quixlab_drafts,
    ):
        api.include_router(module.router)
    app.include_router(api)
    # App-level like /health: /mcp carries its own bearer auth (the workspace
    # SDK token), so it must not sit behind the /api/v1 require_token dependency.
    app.include_router(mcp.router)

    @app.get("/health", tags=["infra"])
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/ready", tags=["infra"])
    def ready() -> dict:
        settings = get_settings()
        # Reuse the process client. Building one per request costs a full
        # topology discovery each time, which made this open route 22 times
        # slower than /health and let an unauthenticated caller slow the
        # authenticated ones. The ping still runs, so a Mongo that is down
        # still answers 503.
        try:
            with pymongo.timeout(READY_PING_TIMEOUT_SECONDS):
                get_client().admin.command("ping")
        except PyMongoError as exc:
            raise ApiError(503, "mongo ping failed", "not_ready") from exc
        if not settings.planning_api_url:
            planning = "disabled"
        else:
            try:
                response = httpx.get(f"{settings.planning_api_url}/health", timeout=1.0)
                planning = "ok" if response.status_code == 200 else "offline"
            except httpx.HTTPError:
                planning = "offline"
        # A probe or a person can now ask "can you serve statistics? can you
        # serve downloads?" and read a straight answer. This never decides the
        # status: the registry works without either value, so a missing
        # capability must not fail a readiness probe and restart the pod.
        return {
            "status": "ready",
            "mongo": "ok",
            "planning_api": planning,
            "capabilities": capabilities.report(),
        }

    # `/metrics` is OPEN, beside `/health` and `/ready`. A Prometheus scrape
    # carries no bearer token, and the body holds counts and latencies only.
    # `api/api/metrics.py` states why no label can carry an identifier.
    #
    # It stays OUT of the OpenAPI document. The document describes the v1 JSON
    # contract a generated client calls. This route serves the Prometheus text
    # format, no client reads it, and a scrape needs no schema.
    @app.get("/metrics", tags=["infra"], include_in_schema=False)
    def scrape() -> Response:
        body, content_type = metrics.render()
        return Response(content=body, media_type=content_type)

    # The `tm` command line, served as an installable wheel. It is OPEN, beside
    # `/health`, `/ready` and `/metrics`, because `pip` presents no bearer token
    # and a route behind the token gate cannot be installed from.
    #
    # **The wheel holds our own client code and nothing else**: `cli/__init__.py`
    # and `cli/tm.py`, the same two files the public image already carries. It
    # carries no secret, no credential and no customer data, so serving it opens
    # nothing that the image did not open already. Nothing else moves out of
    # `/api/v1`, and every `/api/v1` route still needs the token.
    #
    # It stays OUT of the OpenAPI document, beside `/metrics`. `pip` reads it,
    # no generated client does, and a scrape of a wheel needs no schema. The
    # install line rides the document description instead.
    @app.get(f"/cli/{CLI_WHEEL_NAME}", tags=["infra"], include_in_schema=False)
    def cli_wheel() -> Response:
        """Stream the `tm` wheel so an engineer installs the CLI in one line.

        The bytes stream in `CHUNK_BYTES` pieces and the disposition comes from
        the same helper the file download uses
        (`api/api/services/file_bytes.py`), so one filename rule guards both.

        Errors:

        * ``404 wheel_not_found`` — this process carries no wheel. A developer
          machine sees this, because nobody builds a wheel to run the API
          locally; `api/Dockerfile` builds one into the shipped image. The
          route never raises: a missing file is an answer, not a fault.
        """
        wheel = CLI_WHEEL_DIR / CLI_WHEEL_NAME
        try:
            size = wheel.stat().st_size
        except OSError as error:
            raise ApiError(
                404,
                f"{CLI_WHEEL_NAME} is not present in this process. A deployed "
                "image carries it; a local run builds it with `uv build --wheel`.",
                "wheel_not_found",
            ) from error

        def stream() -> Iterator[bytes]:
            with wheel.open("rb") as handle:
                while chunk := handle.read(CHUNK_BYTES):
                    yield chunk

        return StreamingResponse(
            stream(),
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": content_disposition(CLI_WHEEL_NAME),
                "Content-Length": str(size),
            },
        )

    customise_openapi(app)
    # Every router is registered now, so the middleware can turn an endpoint
    # into its route template. Without this map every request reads as
    # `unmatched`.
    metrics.bind_routes(app)
    # One line per missing capability, at start, before any request. A
    # deployment that receives no lake and no bucket then says so in its own
    # log instead of waiting for a reader to open a screen.
    capabilities.warn_once()
    return app


app = create_app()
