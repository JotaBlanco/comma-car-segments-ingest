"""Explore models: the chat body and the context envelope.

Explore is read-only, so no body carries an actor (decision D-E5). The query
body and its result envelope left with `POST /explore/query` on 24 Aug 2026 —
the workbench posts its SQL straight to QuixLake through the frontend
(`plans/design/EXPLORE-DIRECT-LAKE.md`).
"""

from api.models.common import ApiModel, RequestModel


class ExploreChatBody(RequestModel):
    """Body of POST /test-runs/{run_id}/explore/chat.

    ``message`` is the user's turn. ``session_id`` is null on the first turn and
    carries the id the first frame returned on every turn after, so one Quix.AI
    session spans the conversation. Unknown fields are rejected (extra=forbid).
    """

    message: str
    session_id: str | None = None


class ExploreContextResponse(ApiModel):
    """What the Explore screen needs before the first query.

    ``sample_count`` is null on purpose: filling it costs a lakeside COUNT(*),
    and the context call must stay cheap. ``ai_available`` stays false until
    the Ask-AI phase ships (decision D-E3).
    """

    table: str
    columns: list[str]
    file_count: int
    signal_count: int
    sample_count: int | None
    ai_available: bool
