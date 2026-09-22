"""Assistant models: the chat body and the status probe.

The registry assistant (plans/design/AI-SIDEBAR.md) mirrors the Explore chat
shapes on purpose: one body model for a turn, one tiny status model the FE
polls before it shows the Ask control. The frame vocabulary of the stream is
not modelled here — frames are composed by ``services/ai_proxy.py`` (with ``assistant_presenter``) and
documented in the contract (§E4), the same split the explore chat uses.
"""

from api.models.common import ApiModel, RequestModel


class AssistantChatBody(RequestModel):
    """Body of POST /assistant/chat.

    ``message`` is the user's turn. ``session_id`` is null on the first turn
    and carries the id every frame returned on the turns after, so one
    server-side session spans the conversation. Unknown fields are rejected
    (extra=forbid), mirroring ``ExploreChatBody``.
    """

    message: str
    session_id: str | None = None


class AssistantStatus(ApiModel):
    """Answer of GET /assistant/status.

    ``enabled`` says the platform is present (``Quix__Portal__Api`` injected). ``reachable`` says whether the
    Quix.AI Quix.AI portal base URL is configured (sessions path; no key needed) — it is a
    configuration read, never a live probe, so the status call stays cheap.
    """

    enabled: bool
    reachable: bool
