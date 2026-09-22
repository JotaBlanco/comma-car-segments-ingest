"""The error model. Every non-2xx response has the contract body:

    { "detail": "<human string>", "code": "<machine snake_case>", "errors": [] }

`errors` carries the raw Pydantic list on 422 and is empty otherwise.
"""

from fastapi import FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class ApiError(HTTPException):
    """An HTTP error with a machine code. Raise this from route code."""

    def __init__(self, status_code: int, detail: str, code: str):
        super().__init__(status_code=status_code, detail=detail)
        self.code = code


_GENERIC_CODES = {
    404: "not_found",
    405: "method_not_allowed",
    401: "unauthorized",
    500: "internal_error",
}


def error_body(detail: str, code: str, errors: list | None = None) -> dict:
    return {"detail": detail, "code": code, "errors": errors or []}


# The JSON Schema of the body above. `api/main.py` puts both schemas in the
# OpenAPI document, because FastAPI's generator only knows its own default
# `HTTPValidationError` and that shape never reaches the wire from this app.
ERROR_SCHEMA_NAME = "ErrorResponse"
VALIDATION_ERROR_SCHEMA_NAME = "ValidationErrorResponse"

ERROR_SCHEMA = {
    "title": ERROR_SCHEMA_NAME,
    "type": "object",
    "required": ["detail", "code", "errors"],
    "properties": {
        "detail": {"type": "string", "title": "Detail", "description": "A human string."},
        "code": {
            "type": "string",
            "title": "Code",
            "description": "A machine code in snake_case.",
        },
        "errors": {
            "type": "array",
            "items": {"type": "object"},
            "title": "Errors",
            "description": "Empty on every status except 422.",
        },
    },
}

VALIDATION_ERROR_SCHEMA = {
    "title": VALIDATION_ERROR_SCHEMA_NAME,
    "type": "object",
    "required": ["detail", "code", "errors"],
    "properties": {
        "detail": {
            "type": "string",
            "title": "Detail",
            "description": "A human string that names the failing field.",
        },
        "code": {
            "type": "string",
            "title": "Code",
            "description": "A machine code in snake_case.",
        },
        "errors": {
            "type": "array",
            "items": {"$ref": "#/components/schemas/ValidationError"},
            "title": "Errors",
            "description": "The raw Pydantic list. Never empty on 422.",
        },
    },
}


def _friendly_validation_detail(errors: list) -> str:
    """Build a single friendly string that names the failing field.

    Never return a raw Pydantic dump as the detail.
    """
    if not errors:
        return "request validation failed"
    first = errors[0]
    loc = [str(part) for part in first.get("loc", []) if part not in ("body", "query", "path")]
    field = ".".join(loc) or "request"
    message = first.get("msg", "is invalid")
    return f"{field}: {message}"


def register_error_handlers(app: FastAPI) -> None:
    # Late import so `api.models.sorting` can import ApiError without a cycle.
    from api.models.sorting import QuerySortError

    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError):
        return JSONResponse(
            status_code=exc.status_code, content=error_body(exc.detail, exc.code)
        )

    @app.exception_handler(QuerySortError)
    async def query_sort_error_handler(request: Request, exc: QuerySortError):
        # Same shape as FastAPI's own 422 for typed params: loc starts with
        # "query" so the friendly detail names the failing param, and the
        # errors list is populated (never empty on 422 — contract §A).
        error = {
            "loc": ["query", exc.param],
            "msg": f"must be one of {exc.allowed}",
            "type": "value_error",
            "input": exc.value,
        }
        return JSONResponse(
            status_code=422,
            content=error_body(
                f"{exc.param}: must be one of {exc.allowed}",
                "validation_error",
                [error],
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException):
        code = _GENERIC_CODES.get(exc.status_code, "error")
        return JSONResponse(
            status_code=exc.status_code, content=error_body(str(exc.detail), code)
        )

    @app.exception_handler(Exception)
    async def unhandled_error_handler(request: Request, exc: Exception):
        # The server still logs the traceback. The client gets the contract
        # body and never the exception text.
        return JSONResponse(
            status_code=500, content=error_body("internal error", "internal_error")
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        errors = jsonable_encoder(exc.errors())
        return JSONResponse(
            status_code=422,
            content=error_body(
                _friendly_validation_detail(errors), "validation_error", errors
            ),
        )
