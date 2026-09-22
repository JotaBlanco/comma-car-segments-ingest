"""Environment reading. Every value is read at call time, never at import.

The apps read their configuration through this one module, so a test scrubs the
environment and gets the documented defaults with no import-order trap.
"""

import os
from dataclasses import dataclass

# The registry route prefix. `api = APIRouter(prefix="/api/v1", dependencies=[
# Depends(require_token)])` (api/api/main.py:52), so every route below needs the
# bearer token — including POST /test-runs and POST /files.
DEFAULT_API_URL = "http://test-manager-backend/api/v1"

# `RunUpsertRequest.actor` defaults to "ingestion" (api/api/models/runs.py:156)
# and "ingestion" is outside PLACEHOLDER_ACTORS, which answers 422
# (api/api/models/journal.py:24-39).
DEFAULT_ACTOR = "ingestion"

# The filename fallback for a run key, when neither channel states one.
DEFAULT_RUN_KEY_PATTERN = r"TAS-\d+"


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _text(name: str, default: str) -> str:
    return os.environ.get(name, "").strip() or default


@dataclass(frozen=True)
class Config:
    """Everything tm-connector reads from its environment."""

    api_url: str = DEFAULT_API_URL
    api_token: str | None = None
    actor: str = DEFAULT_ACTOR
    http_timeout_seconds: float = 30.0
    retry_max_backoff_seconds: float = 60.0
    # The bound on retries WITHIN one delivery. The contract's "retry
    # indefinitely" means never commit past a failed run upsert; it does not
    # mean spin forever inside one handler holding the consumer. Exhausting the
    # attempts raises out of the handler, so the offset stays uncommitted and
    # redelivery — or a pod restart — retries from the same message. Bounded
    # in-process, unbounded across deliveries: no loss, no infinite spin.
    retry_max_attempts: int = 6
    run_key_pattern: str = DEFAULT_RUN_KEY_PATTERN
    # Which lakehouse table holds the samples, stated on every run this
    # connector registers. Read from LAKE_TABLE - the PROJECT variable
    # mf4-sink's TABLE_NAME also references, which is what makes the claim
    # unable to drift from the writer. None (unset) means the connector states
    # nothing, and the registry stores nothing: an absent fact, never a guess.
    # Deliberately no code default: a default here would be a second copy of
    # the value the project variable exists to hold once.
    lake_table: str | None = None
    # A file whose metadata landed but whose batches never arrived. After this
    # many seconds the status endpoint reports it `stalled` instead of leaving
    # it looking merely slow. It never changes what is sent to the registry.
    stall_seconds: float = 900.0
    status_port: int = 80

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            api_url=_text("TM_API_URL", DEFAULT_API_URL).rstrip("/"),
            api_token=os.environ.get("TM_API_TOKEN", "").strip() or None,
            actor=_text("TM_ACTOR", DEFAULT_ACTOR),
            http_timeout_seconds=_float("TM_HTTP_TIMEOUT_SECONDS", 30.0),
            retry_max_backoff_seconds=_float("TM_RETRY_MAX_BACKOFF_SECONDS", 60.0),
            retry_max_attempts=_int("TM_RETRY_MAX_ATTEMPTS", 6),
            run_key_pattern=_text("TM_RUN_KEY_PATTERN", DEFAULT_RUN_KEY_PATTERN),
            stall_seconds=_float("TM_STALL_SECONDS", 900.0),
            status_port=_int("TM_STATUS_PORT", 80),
            lake_table=os.environ.get("LAKE_TABLE", "").strip() or None,
        )
