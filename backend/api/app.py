from contextlib import asynccontextmanager
import logging
import os
from typing import AsyncGenerator

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import mongo, influx
from .routes.admin import router as admin_router
from .routes.devices import router as devices_router
from .routes.files import router as files_router
from .routes.integrations import router as integrations_router
from .routes.links import router as links_router
from .routes.logbook import router as logbook_router
from .routes.lookups import router as lookups_router
from .routes.tests import router as tests_router
from .routes.user import router as user_router
from .routes.vm_baselines import router as vm_baselines_router
from .routes.vm_requirements import router as vm_requirements_router
from .routes.vm_results import router as vm_results_router
from .routes.vm_runs import router as vm_runs_router
from .routes.vm_seed import router as vm_seed_router
from .routes.vm_test_impls import router as vm_test_impls_router
from .routes.vm_test_specs import router as vm_test_specs_router
from .seed_data import seed_lookup_tables
from .settings import get_settings
from .vmodel_seed import seed_vmodel_safe

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    Handles startup and shutdown events for the application.
    Connects to MongoDB on startup and closes the connection on shutdown.
    """
    settings = get_settings()

    # Log startup mode
    local_dev_mode = os.getenv("LOCAL_DEV_MODE") == "true"
    if local_dev_mode:
        logger.info("=" * 60)
        logger.info("🐳 STARTING IN LOCAL DEVELOPMENT MODE")
        logger.info("=" * 60)
        logger.info("✓ Using local MongoDB and Config API")
        logger.info("✓ Using mock authentication (all requests allowed)")
        logger.info(f"✓ API authentication: {'DISABLED' if not settings.api_auth_active else 'ENABLED'}")
        logger.info(f"✓ Config API: {settings.config_api_url}")
        logger.info(f"✓ InfluxDB logbook mirror: {'ENABLED' if settings.influx.enabled else 'DISABLED'}")
        logger.info("=" * 60)
    else:
        logger.info("=" * 60)
        logger.info("☁️  STARTING IN PRODUCTION MODE (Quix Cloud)")
        logger.info("=" * 60)
        logger.info(f"✓ Workspace ID: {settings.workspace_id}")
        logger.info(f"✓ API authentication: {'ENABLED' if settings.api_auth_active else 'DISABLED'}")
        logger.info(f"✓ Config API: {settings.config_api_url}")
        logger.info(f"✓ InfluxDB logbook mirror: {'ENABLED' if settings.influx.enabled else 'DISABLED'}")
        logger.info("=" * 60)

    mongo.connect(settings.mongo)
    # Optional write-only logbook mirror. Installs a no-op when INFLUXDB_USER /
    # INFLUXDB_PASSWORD are unset or the server is unreachable; never raises.
    influx.connect(settings.influx)

    # Seed lookup tables if they're empty
    seed_lookup_tables(mongo.get_mongo())

    # Seed the V-model fixtures (idempotent, keyed on each set's canonical sha256)
    seed_vmodel_safe(mongo.get_mongo())

    yield
    mongo.disconnect()


def format_validation_error(errors: list[dict]) -> str:
    """
    Transform Pydantic validation errors into user-friendly messages.

    Args:
        errors: List of Pydantic validation error dictionaries

    Returns:
        User-friendly error message string
    """
    if not errors:
        return "Validation error occurred"

    friendly_messages = []

    for error in errors:
        error_type = error.get("type", "")
        location = error.get("loc", [])
        msg = error.get("msg", "")

        # Extract field name (skip 'body' prefix if present)
        field_path = [str(loc) for loc in location if loc != "body"]
        field_name = ".".join(field_path) if field_path else "field"

        # Create user-friendly messages based on error type
        if error_type == "dict_type":
            if "sensors" in field_path:
                friendly_messages.append(
                    f"'{field_name}' must be a dictionary format like: "
                    '{"sensor1": {"type": "temperature", "unit": "C"}, "sensor2": {...}}'
                )
            else:
                friendly_messages.append(f"'{field_name}' must be an object/dictionary, not a list or string")

        elif error_type == "list_type":
            friendly_messages.append(f"'{field_name}' must be a list/array")

        elif error_type == "missing":
            friendly_messages.append(f"'{field_name}' is required but was not provided")

        elif error_type.startswith("enum"):
            # Extract allowed values if available in the message
            friendly_messages.append(f"'{field_name}' has an invalid value. {msg}")

        elif error_type in ["int_type", "float_type", "bool_type", "string_type"]:
            expected_type = error_type.replace("_type", "")
            friendly_messages.append(f"'{field_name}' must be a {expected_type}")

        elif error_type == "datetime_parsing":
            friendly_messages.append(f"'{field_name}' must be a valid datetime (ISO 8601 format)")

        elif error_type == "value_error":
            friendly_messages.append(f"'{field_name}': {msg}")

        elif "too_short" in error_type:
            friendly_messages.append(f"'{field_name}' is too short. {msg}")

        elif "too_long" in error_type:
            friendly_messages.append(f"'{field_name}' is too long. {msg}")

        else:
            # Fallback to original message
            friendly_messages.append(f"'{field_name}': {msg}")

    return " | ".join(friendly_messages)


async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """
    Custom exception handler for Pydantic validation errors.
    Transforms technical validation errors into user-friendly messages.
    """
    errors = exc.errors()
    friendly_message = format_validation_error(errors)

    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "detail": friendly_message,
            "errors": errors  # Keep original errors for debugging
        }
    )


def create_app() -> FastAPI:
    application = FastAPI(
        title="Test Manager API",
        docs_url="/",
        lifespan=lifespan,
    )

    # Register custom exception handler for validation errors
    application.add_exception_handler(RequestValidationError, validation_exception_handler)

    application.include_router(tests_router, tags=["tests"], prefix="/api/v1")
    application.include_router(devices_router, tags=["devices"], prefix="/api/v1")
    application.include_router(lookups_router, tags=["lookups"], prefix="/api/v1")
    application.include_router(logbook_router, tags=["logbook"], prefix="/api/v1")
    application.include_router(files_router, tags=["files"], prefix="/api/v1")
    application.include_router(links_router, tags=["links"], prefix="/api/v1")
    application.include_router(admin_router, tags=["admin"], prefix="/api/v1")
    application.include_router(user_router, tags=["user"], prefix="/api/v1")
    application.include_router(integrations_router, tags=["integrations"], prefix="/api/v1")
    # V-model chain. Namespaced under /api/v1/vmodel so nothing collides with the
    # Phase 2 /tests, /devices and /lookups routes.
    application.include_router(
        vm_requirements_router, tags=["vmodel"], prefix="/api/v1/vmodel"
    )
    application.include_router(vm_baselines_router, tags=["vmodel"], prefix="/api/v1/vmodel")
    application.include_router(vm_test_specs_router, tags=["vmodel"], prefix="/api/v1/vmodel")
    application.include_router(vm_test_impls_router, tags=["vmodel"], prefix="/api/v1/vmodel")
    application.include_router(vm_runs_router, tags=["vmodel"], prefix="/api/v1/vmodel")
    application.include_router(vm_results_router, tags=["vmodel"], prefix="/api/v1/vmodel")
    application.include_router(vm_seed_router, tags=["vmodel"], prefix="/api/v1/vmodel")

    application.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @application.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return application


# Create app instance at module level for uvicorn hot reload
app = create_app()
