from dotenv import load_dotenv

load_dotenv()  # reads .env if present; does not override env vars already set by the platform

import logging  # noqa: E402
import os  # noqa: E402

from fastapi import FastAPI  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

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

    The schema registry is checked here as well. The first version hashed the raw
    schema bytes without ever parsing them, so ``/health`` stayed green while one
    illegal JSON escape made every upload endpoint answer 500: the one endpoint
    that exists to say what is broken said nothing.

    Mongo is probed with a bounded ``ping`` (``deps.mongo_status``). This endpoint
    still answers **200 while Mongo is down**, deliberately: it is the liveness
    signal, and a liveness probe that fails on a datastore outage restarts a
    process that has nothing wrong with it, repeatedly, for as long as the outage
    lasts. The aggregate is reported as ``ready`` and served with a status code by
    ``/health/ready``, which is what a readiness probe should key on.
    """
    schema_errors = schema_registry.load_errors()
    mongo = deps.mongo_status()
    return {
        "status": "ok",
        "ready": mongo["available"] and not schema_errors,
        "schema_registry": {
            "count": len(schema_registry.schema_names()),
            "compiled": not schema_errors,
            "errors": schema_errors,
        },
        "mongo": mongo,
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


@api.get("/health/ready", tags=["ops"])
def readiness() -> JSONResponse:
    """Readiness, with a status code: 200 when the API can serve its own purpose.

    Hard dependencies only. Mongo unreachable or a published schema that will not
    compile means requests will fail, so this answers 503 and names which. Blob
    storage is *not* a readiness condition: the deployment is expected to run
    unbound while the Storage Gateway is down, and the routes that need it already
    answer a 503 that says so.
    """
    schema_errors = schema_registry.load_errors()
    mongo = deps.mongo_status()
    ready = mongo["available"] and not schema_errors
    reasons = []
    if not mongo["available"]:
        reasons.append(f"mongo: {mongo['reason']}")
    reasons.extend(schema_errors)
    return JSONResponse(
        status_code=200 if ready else 503,
        content={
            "error": None if ready else "not_ready",
            "message": "ready" if ready else "; ".join(reasons),
            "ready": ready,
            "mongo": mongo,
            "schema_registry_compiled": not schema_errors,
        },
    )


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
