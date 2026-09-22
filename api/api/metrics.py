"""Prometheus series for this process (FR-DM-081).

The platform build already runs Prometheus and Grafana: the monitoring role
installs the `kube-prometheus-stack` chart. So this module runs no stack and
stores nothing. It only **exposes** series, and a scrape reads them.

`GET /metrics` serves four series of our own:

* `tm_api_http_requests_total` counts every request, by outcome. An error rate
  is a ratio over the `status` label.
* `tm_api_http_request_duration_seconds` is a histogram, so a dashboard reads a
  latency quantile.
* `tm_api_uptime_seconds` counts the seconds since this process started.
* `tm_api_storage_registry_bytes` reports the bytes the file registry recorded.
  Read "the storage utilisation section" below: it states what that number is
  not.

**The route never reports an identifier.** It reports counts, latencies and one
uptime number. It names no file, no signal, no token and no workspace value.
Every label takes a value from a small, fixed set:

* `method` is one of the HTTP methods below. Any other method reads as `other`,
  because an ASGI server accepts a free method token, and a free token would let
  one caller mint one series per request.
* `route` is the ROUTE TEMPLATE, never the request path. A download of one file
  reports `/api/v1/files/{file_id}`, so the identifier stays out of the scrape.
  A request that matches no route reports `unmatched`, for the same reason.
* `status` is the HTTP status code.

The route sits OPEN, beside `/health` and `/ready`. A Prometheus scrape carries
no bearer token, and this body holds nothing to protect.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import pymongo
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

from api.db import get_db

logger = logging.getLogger(__name__)

# The label value of a request that matched no route.
UNMATCHED_ROUTE = "unmatched"

# The label value of a method outside this set.
OTHER_METHOD = "other"

# A server accepts any token as a method, so the label set is fixed here.
KNOWN_METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"})

REQUESTS = Counter(
    "tm_api_http_requests_total",
    "Requests this API answered, by method, route template and status code.",
    ["method", "route", "status"],
)

LATENCY = Histogram(
    "tm_api_http_request_duration_seconds",
    "Seconds this API took to answer a request.",
    ["method", "route"],
)

UPTIME = Gauge(
    "tm_api_uptime_seconds",
    "Seconds since this API process started.",
)

_started_at = time.monotonic()
UPTIME.set_function(lambda: time.monotonic() - _started_at)

# --- storage utilisation ------------------------------------------------------------
#
# FR-DM-081 names storage utilisation beside uptime, latency and errors. This
# API cannot answer that question in full, and it must not invent a number.
#
# **What it cannot see.** SAG owns the bucket. It publishes no usage total and
# no quota, and `ingest.store.FileSource` exposes open and read only. So no
# real bucket total and no fill ratio is reachable from this process.
#
# **What it can see.** The Mongo `files` collection carries `size_bytes` on
# every registered file. Their sum is "the bytes the registry knows it landed".
# That is the series below, and the HELP text states the same limit, so a
# person who reads the scrape reads the limit with the number.
#
# A deleted record still counts. `DELETE /files/{file_id}` is a soft delete and
# the retention purge removes the record only, so neither one deletes a byte
# (`api/api/services/retention.py`). A record the purge removed stops counting,
# and its bytes stay in the bucket, so this number is a FLOOR, never a ceiling.
#
# **The series carries no label.** A per-file, per-workspace or per-status
# label would copy a stored value into the scrape and would grow the series
# count without a bound. One number leaks nothing.

# Seconds between two reads of the registry total. A scrape reads the published
# value; it never reads Mongo.
STORAGE_REFRESH_SECONDS = 60.0

# Seconds one registry read may take. An absent Mongo blocks the driver for its
# whole server selection window, and this worker must not hold a thread for it.
STORAGE_READ_TIMEOUT_SECONDS = 5.0

STORAGE_BYTES = Gauge(
    "tm_api_storage_registry_bytes",
    "Bytes the file registry recorded: the sum of size_bytes over the files "
    "collection. This is what the registry knows it landed, NOT real bucket "
    "usage, and this API reads no bucket total and no quota. Deleted records "
    "count, because no purge deletes a byte.",
)

# One row, one number. The pipeline reads no filename, no storage reference and
# no workspace value, so nothing it returns can reach a label.
_STORAGE_PIPELINE: list[dict] = [{"$group": {"_id": None, "bytes": {"$sum": "$size_bytes"}}}]


def refresh_storage_bytes(db: Any | None = None) -> None:
    """Publish the registry byte total. **This never raises.**

    `/metrics` must answer 200 in every state. A Mongo that is slow, absent or
    broken may therefore not reach the route, and it may not reach this caller
    either. Every fault reads as "no new number": the series then reports the
    last value it knew, or nothing at all before the first good read.

    `db` names a database handle. A test passes a fake one. The worker passes
    none, and the process handle serves.
    """
    try:
        database = get_db() if db is None else db
        with pymongo.timeout(STORAGE_READ_TIMEOUT_SECONDS):
            rows = list(database["files"].aggregate(_STORAGE_PIPELINE))
    # A scrape must survive every fault, so the catch is deliberately wide.
    except Exception:
        logger.warning("the storage metric could not read the registry", exc_info=True)
        return
    STORAGE_BYTES.set(rows[0]["bytes"] if rows else 0)


async def storage_worker() -> None:
    """Refresh the storage series for the life of the process.

    The registry read runs here, in a worker thread, and never on the scrape
    path. `api/api/main.py` starts this task in the lifespan, beside the
    retention purge and the ingestion sweep.
    """
    while True:
        await asyncio.to_thread(refresh_storage_bytes)
        await asyncio.sleep(STORAGE_REFRESH_SECONDS)


# Route object -> whole route template. `create_app` fills it once, after it
# registers every router.
#
# FastAPI nests an included router now: `app.routes` holds a router object, not
# the routes inside it, and the route the request handler writes into the scope
# carries the path RELATIVE to that router (`/home/summary`). This map turns
# that route into the whole template (`/api/v1/home/summary`), so one label
# reads the same way for every route.
# A Starlette route defines `__eq__` and no `__hash__`, so it cannot be a key.
# The identity is the key, and `_ROUTE_OBJECTS` keeps every route alive, so no
# collected object can ever hand its identity to another one.
_ROUTE_TEMPLATES: dict[int, str] = {}
_ROUTE_OBJECTS: list[Any] = []


def _templates(routes: Any) -> Any:
    """Yield one (route, whole template) pair per route, included routers too."""
    for route in routes:
        contexts = getattr(route, "effective_route_contexts", None)
        if callable(contexts):
            for context in contexts():
                template = getattr(context, "path_format", None) or getattr(context, "path", None)
                if template:
                    yield context.original_route, template
            continue
        template = getattr(route, "path_format", None) or getattr(route, "path", None)
        if template:
            yield route, template


def bind_routes(app: Any) -> None:
    """Learn the whole template of every route. Call it once, at build time."""
    _ROUTE_TEMPLATES.clear()
    _ROUTE_OBJECTS.clear()
    for route, template in _templates(app.routes):
        _ROUTE_TEMPLATES[id(route)] = template
        _ROUTE_OBJECTS.append(route)


def route_label(scope: dict) -> str:
    """Return the route template of one request, or `unmatched`.

    The raw path never reaches a label. It carries file ids and signal names,
    and any caller can invent one. An unknown route falls back to its own
    template, which is still a fixed string with no value in it.
    """
    route = scope.get("route")
    if route is None:
        return UNMATCHED_ROUTE
    known = _ROUTE_TEMPLATES.get(id(route))
    if known:
        return known
    return getattr(route, "path_format", None) or UNMATCHED_ROUTE


def method_label(method: str) -> str:
    """Return a known method, or `other`."""
    return method if method in KNOWN_METHODS else OTHER_METHOD


def observe(method: str, route: str, status: int, seconds: float) -> None:
    """Record one answered request."""
    safe_method = method_label(method)
    LATENCY.labels(safe_method, route).observe(seconds)
    REQUESTS.labels(safe_method, route, str(status)).inc()


def render() -> tuple[bytes, str]:
    """Return the scrape body and its content type."""
    return generate_latest(), CONTENT_TYPE_LATEST


class MetricsMiddleware:
    """Time every request and count it. A pure ASGI middleware, on purpose.

    `BaseHTTPMiddleware` buffers a streaming response, and this API streams
    NDJSON and file bytes. This class passes the messages straight through and
    reads the status off `http.response.start`.
    """

    def __init__(self, app: Any) -> None:
        self._app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self._app(scope, receive, send)
            return

        # A request that raises before any response counts as a 500. The error
        # middleware above answers 500, so the series states the same outcome.
        status = 500
        started = time.perf_counter()

        async def watched_send(message: dict) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self._app(scope, receive, watched_send)
        finally:
            # The router writes the matched route into this same scope, so
            # the template is known by now.
            observe(
                scope.get("method", ""),
                route_label(scope),
                status,
                time.perf_counter() - started,
            )
