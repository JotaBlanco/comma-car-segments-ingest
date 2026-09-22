"""The registry assistant: GET /assistant/status, POST /assistant/chat.

Both routes are ALWAYS registered — conditional registration would make the
OpenAPI snapshot differ by environment and flap the contract guard
(AI-SIDEBAR §5.2). Availability follows the platform, the Explore-chat rule
(D-E3): the assistant is on exactly when ``Quix__Portal__Api`` is injected.
Off-platform, status answers ``enabled: false`` and chat answers 403. There
is no feature flag — the former ``TM_ASSISTANT`` gate left on 21 Aug 2026.

The chat rides the same Quix.AI sessions pipeline as the Explore tab
(AI-SIDEBAR §10, ticket U-4): the viewer's Portal token opens the session,
the registered agent calls TM's MCP tools, and ``ai_proxy`` maps the SSE
back to NDJSON frames. The one assistant-specific piece is the presenter —
``services/assistant_presenter.py`` intercepts the agent's ``present_answer``
call and hydrates hits, chain and deep link from the db, so the model still
never authors card content or URLs. This router only reads the flag, checks
the token and wires the stream, the same thin shape as ``explore_chat.py``.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pymongo.database import Database

from api.db import get_db
from api.errors import ApiError
from api.models.assistant import AssistantChatBody, AssistantStatus
from api.services import ai_client, ai_proxy, assistant_presenter

router = APIRouter(tags=["assistant"])

# The session context, sent flat because the platform binds context values to
# strings (AI-SIDEBAR AS-0 addendum). The agent's real instructions live in
# its prompt (api/docs/test-manager-agent.md); this is a per-surface nudge.
_CONTEXT = {
    "surface": "registry-sidebar",
    "hint": "use the registry tools; finish with present_answer",
}


def _available() -> bool:
    """The platform is present: ``Quix__Portal__Api`` is injected. Read at
    call time (settings.py pattern), so a test or a redeploy flips it without
    restarting the process."""
    return bool(ai_client.portal_base())


@router.get("/assistant/status")
def assistant_status() -> AssistantStatus:
    """Say whether the assistant is available: the Portal base URL is present.

    A configuration read, never a live probe. ``enabled`` and ``reachable``
    carry the same value now that the platform is the only condition; both
    stay in the shape so the FE contract is unchanged. The sessions path
    needs no proxy key: the viewer's Portal token is the credential, supplied
    per request. The status call is the FE's gate for showing the Ask
    control, so it must stay cheap and dependable.
    """
    available = _available()
    return AssistantStatus(enabled=available, reachable=available)


@router.post(
    "/assistant/chat",
    # D-2: the snapshot must say what the route really serves — an NDJSON stream.
    responses={200: {"content": {"application/x-ndjson": {}}}},
)
def assistant_chat(
    body: AssistantChatBody,
    request: Request,
    db: Annotated[Database, Depends(get_db)],
) -> StreamingResponse:
    """Stream one assistant turn as NDJSON frames (contract §E4).

    403 off-platform (no Portal). 403 ``ai_unavailable`` when the viewer sent no
    Portal token — the session runs as the viewer, so the assistant has no
    credential of its own. The stream itself never fails the request: an
    upstream error arrives as an ``error`` frame inside the 200 body (the
    HTTP status is already sent), exactly as the Explore chat behaves.
    """
    if not _available():
        raise ApiError(403, "assistant is disabled", "assistant_disabled")

    portal_token = (request.headers.get("x-portal-token") or "").strip()
    if not portal_token:
        raise ApiError(
            403, "no portal token; the assistant needs a Portal login", "ai_unavailable"
        )

    generator = ai_proxy.chat_stream(
        portal_token,
        "registry",
        body.message,
        body.session_id,
        _CONTEXT,
        presenter=lambda args: assistant_presenter.present(db, args),
    )
    return StreamingResponse(
        generator,
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
