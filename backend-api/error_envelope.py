"""The one shape every error response in this API has.

Before this module the API spoke three: ``require_blob``'s dict nested under
FastAPI's ``detail`` key, the registered ``BlobUnavailableError`` handler's
top-level dict, and door validation's ``{detail, stage, problem_count,
problems[]}``. The frontend had to carry an ``_unwrap`` adapter that flattened all
three, and a fourth shape would have been worse than the three, so the fix is one
envelope applied centrally rather than a new variant per route.

The contract, and it is a contract:

    {
      "error":    "<stable machine-readable code>",   # always present, a string
      "message":  "<human sentence naming the cause>",# always present, non-empty
      "problems": [ {code, message, entity_id, pointer}, ... ]   # optional
      ... any case-specific keys: hint, stage, trace_key, persisted, findings
    }

``error`` codes already in use keep their spelling - ``blob_storage_unavailable``
above all, which the frontend and the round-1 verification both key on. The
``problems`` list keeps its element shape (``validation.Problem.as_dict``).

The 33 ``raise HTTPException(...)`` sites in the routers are deliberately *not*
touched: a single ``StarletteHTTPException`` handler normalises whatever they pass
- a plain string, a dict with an ``error`` code, or a list - so there is one
implementation of the shape and no per-route opportunity to invent a fourth.
"""

DEFAULT_CODE_BY_STATUS = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "unprocessable_entity",
    429: "too_many_requests",
    500: "internal_error",
    503: "service_unavailable",
}

RESERVED_KEYS = ("error", "message", "problems", "detail")


def default_code(status_code: int) -> str:
    """A stable code for a status that nobody gave one, never an empty string."""
    if status_code in DEFAULT_CODE_BY_STATUS:
        return DEFAULT_CODE_BY_STATUS[status_code]
    return "client_error" if status_code < 500 else "server_error"


def envelope(
    status_code: int,
    message: str,
    error: str | None = None,
    problems: list[dict] | None = None,
    **extra,
) -> dict:
    """Build the envelope. ``extra`` keys are carried through verbatim."""
    body = {
        "error": error or default_code(status_code),
        "message": message or default_code(status_code).replace("_", " "),
    }
    if problems is not None:
        body["problems"] = problems
    body.update({key: value for key, value in extra.items() if key not in RESERVED_KEYS})
    return body


def from_detail(status_code: int, detail) -> dict:
    """Normalise whatever an ``HTTPException`` carried into the envelope.

    Three inputs occur in practice: a plain string (most routers), a dict already
    shaped like the envelope (``deps.require_blob``), and a list of validation
    errors (FastAPI's own). ``detail`` is the only place a caller-supplied ``error``
    code can come from, so a dict's code always wins over the status default.
    """
    if isinstance(detail, dict):
        message = detail.get("message") or detail.get("detail") or ""
        if not isinstance(message, str):
            message = str(message)
        extra = {
            key: value for key, value in detail.items() if key not in RESERVED_KEYS
        }
        return envelope(
            status_code,
            message,
            error=detail.get("error"),
            problems=detail.get("problems"),
            **extra,
        )
    if isinstance(detail, list):
        problems = [
            item if isinstance(item, dict) else {"message": str(item)} for item in detail
        ]
        return envelope(
            status_code, f"{len(problems)} problem(s) in the request", problems=problems
        )
    return envelope(status_code, str(detail) if detail is not None else "")
