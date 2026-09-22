"""Ask-AI over one run: POST /test-runs/{run_id}/explore/chat. Owner: Chris.

Path A, copied from the lakehouse (decision D-E3). The route reads the viewer's
Portal token from the ``x-portal-token`` header — the header the TM frontend
proxy forwards — and streams the Quix.AI answer back as NDJSON. The transport
and the SSE->NDJSON mapping live in ``services/ai_client.py`` and
``services/ai_proxy.py``; this router builds the run context and wires the
stream. A chat turn is a read: no journal entry, no actor (decision D-E5).
"""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pymongo.database import Database

from api.db import get_db
from api.errors import ApiError
from api.models.explore import ExploreChatBody
from api.services import ai_proxy, explore_query, lake, queries_stats

logger = logging.getLogger(__name__)

router = APIRouter(tags=["explore"])

# The context stays small on purpose: a large context inflates every turn's
# token cost and the Portal caps the payload. The signal inventory is the
# spine; per-signal lakeside stats ride along only when the lake answers.
_MAX_CONTEXT_SIGNALS = 40


def _build_run_context(db: Database, run_id: str) -> dict:
    """Describe the run for the assistant: its signals and their statistics.

    The inventory (name, unit, rate) comes from the registry, one row per
    signal name, capped at ``_MAX_CONTEXT_SIGNALS``. Per-signal lakeside stats
    are added when the lake is configured and answers; a lake that is down or
    unconfigured degrades to the inventory, never to an error — the chat still
    works, it just answers from less. Reuses the statistics-lane helpers so the
    context and the statistics screens describe one run the same way.
    """
    rows = list(db["file_signals"].find({"run_id": run_id}))
    by_name = queries_stats._weigh_rows(db, rows, "name")

    stats: dict[str, dict | None] = {}
    if lake.is_configured():
        try:
            stats = queries_stats._lake_stats_by_signal(run_id)
        except ApiError as error:
            # A lake that is down is not a chat that is down. Log and go on.
            logger.warning("Lake stats unavailable for chat context (run=%s): %s",
                           run_id, error.detail)

    signals = []
    for name in sorted(by_name)[:_MAX_CONTEXT_SIGNALS]:
        inventory = queries_stats._inventory(by_name[name])
        signal = {
            "name": inventory["name"],
            "unit": inventory.get("unit"),
            "rate_hz": inventory.get("rate_hz"),
        }
        numbers = stats.get(name)
        if numbers:
            signal["stats"] = numbers
        signals.append(signal)

    return {
        "run_id": run_id,
        # The PHYSICAL table and its real column spellings, resolved from
        # `TM_LAKE_TABLE`. The backend guard that once rewrote the user's SQL
        # was deleted on 24 Aug 2026, so SQL the assistant suggests reaches
        # QuixLake unchanged. A logical name here made the assistant write
        # `test_signal_samples` and `timestamp`, and every such statement
        # answered a binder error. `GET /explore/context` keeps the logical
        # name; no query builder reads that route.
        "table": explore_query.physical_table_name(),
        "columns": list(explore_query.physical_columns()),
        "signal_count": len(by_name),
        "signals": signals,
    }


@router.post("/test-runs/{run_id}/explore/chat")
def run_explore_chat(
    run_id: str,
    body: ExploreChatBody,
    request: Request,
    db: Annotated[Database, Depends(get_db)],
) -> StreamingResponse:
    """Stream one Ask-AI turn over the run as NDJSON (proxied to Quix.AI).

    403 when the viewer sent no Portal token — Ask AI runs as the viewer, so it
    has no credential of its own. 404 when the data does not know the run. The
    stream itself never fails the request: an upstream error arrives as an
    ``error`` frame inside the 200 body (the HTTP status is already sent).
    """
    portal_token = (request.headers.get("x-portal-token") or "").strip()
    if not portal_token:
        raise ApiError(
            403, "no portal token; Ask AI needs a Portal login", "ai_unavailable"
        )
    if not queries_stats.run_exists(db, run_id):
        raise ApiError(404, f"Run {run_id} not found", "run_not_found")

    context = _build_run_context(db, run_id)
    generator = ai_proxy.chat_stream(
        portal_token, run_id, body.message, body.session_id, context
    )
    return StreamingResponse(
        generator,
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
