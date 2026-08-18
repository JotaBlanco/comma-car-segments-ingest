from dotenv import load_dotenv

load_dotenv()  # reads .env if present; does not override env vars already set by the platform

import logging  # noqa: E402
import os  # noqa: E402

from fastapi import FastAPI  # noqa: E402

import blob_storage  # noqa: E402
import deps  # noqa: E402
import error_handlers  # noqa: E402
import lakehouse  # noqa: E402
import schema_registry  # noqa: E402
import settings  # noqa: E402
from routers import (  # noqa: E402
    artifacts,
    baselines,
    catalog,
    graph,
    internal,
    registry,
    results,
    test_runs,
    traces,
    uploads,
)

logging.basicConfig(level=os.environ.get("LOGLEVEL", "INFO"))
logger = logging.getLogger(__name__)

api = FastAPI(
    title="V-Model Test Manager API",
    version="1.0.0",
    description=(
        "Requirements, test specifications, test implementations, traces, runs, results and "
        "reports for the right leg of the V at system level. JSON Schema validates artifact "
        "documents at the door; Pydantic validates API bodies. Artifacts live in immutable "
        "versioned blob folders, the device/config registry and the operational records live in "
        "MongoDB, and MF4-derived test vectors live in the Lakehouse."
    ),
)

error_handlers.register(api)

api.include_router(uploads.router)
api.include_router(artifacts.router)
api.include_router(artifacts.schemas_router)
api.include_router(catalog.router)
api.include_router(baselines.router)
api.include_router(registry.router)
api.include_router(traces.router)
api.include_router(test_runs.router)
api.include_router(results.router)
api.include_router(results.reports_router)
api.include_router(graph.router)
api.include_router(internal.router)


@api.get("/health", tags=["ops"])
def health() -> dict:
    """Answers even with no Mongo, no broker and no blob storage.

    Each dependency reports its own state and, when it is unavailable, the reason.
    An endpoint that needs blob storage then fails with 503 carrying that same
    reason rather than a 500 or, worse, a silent success.
    """
    return {
        "status": "ok",
        "blob_storage": {
            "available": blob_storage.is_available(),
            "backend": blob_storage.backend_name(),
            "reason": blob_storage.unavailable_reason(),
        },
        "lakehouse_query": {
            "available": lakehouse.is_available(),
            "reason": lakehouse.unavailable_reason(),
        },
        "schemas": {
            name: schema_registry.schema_sha256(name)[:12]
            for name in schema_registry.schema_names()
        },
        "topics": settings.topic_names(),
        "versions": {
            "validator": settings.VALIDATOR_VERSION,
            "evaluator": settings.EVALUATOR_VERSION,
            "extractor": settings.EXTRACTOR_VERSION,
            "report_generator": settings.REPORT_GENERATOR_VERSION,
        },
    }


@api.get("/health/mongo", tags=["ops"])
def mongo_health() -> dict:
    """Separate from ``/health`` so a Mongo outage cannot make liveness fail."""
    db = deps.get_db()
    return {
        "status": "ok",
        "database": db.name,
        "collections": sorted(db.list_collection_names()),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(api, host="0.0.0.0", port=80)
