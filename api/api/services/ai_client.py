"""Quix.AI Portal client for Test Manager's Ask-AI chat (Path A, session chat).

A port of the lakehouse ``quix_ai_client.py`` to httpx/async for FastAPI. The
caller's Portal bearer is forwarded verbatim, so the Quix.AI session belongs to
the end user and the platform-side tools scope per user. This module opens the
session and streams one message; the SSE->NDJSON mapping lives in
``ai_proxy.py``, exactly as the lakehouse splits client from proxy.

The two doors to Quix.AI and the reason we take Path A are recorded in
``plans/decisions/2026-08-19-explore-tab.md`` (D-E3). We create a session with
``POST {base}/ai/api/sessions`` then stream ``.../sessions/{id}/messages``.
"""

import json
import logging
import os

import httpx

logger = logging.getLogger(__name__)

# The default agent name. Configurable via TM_AI_AGENT_NAME so a registered TM
# agent (decision D-E6.2) can be named without a code change. Until such an
# agent exists the lookup finds nothing and sessions are created agentless —
# the supported fallback, exactly as the lakehouse does.
_DEFAULT_AGENT_NAME = "test-manager-agent"

# The test seam. Tests set an httpx transport here (an ASGITransport over the
# stub Portal, or a MockTransport), so no unit test opens a socket. Production
# leaves it None and the client builds its own transport. Same pattern as
# ``api.quix_identity.TRANSPORT``.
TRANSPORT: httpx.BaseTransport | None = None

# Agent id resolution is cached by name. Only a definitive lookup (a response
# arrived, agent found or not) is cached — agentless is the supported fallback
# for that case. A transport failure is not cached, so the next call re-probes
# instead of being stuck agentless for the process lifetime.
_agent_cache: dict[str, dict] = {}


class UpstreamError(RuntimeError):
    """The Portal answered a non-200 on the streaming message POST.

    Carries the status so the proxy can report ``upstream <status>`` in an
    error frame. The proxy never lets this raise to the client — the HTTP
    status of the stream is already sent by the time this fires.
    """

    def __init__(self, status: int):
        self.status = status
        super().__init__(f"upstream {status}")


def portal_base() -> str:
    """Return the Portal public API base URL, or "" when none is configured.

    Reads ``Quix__Portal__Api``, the name the platform injects into every
    workspace deployment. It is the only name. Never read a second name for a
    value the platform already injects. The Ask-AI pipe is "available" exactly
    when this is non-empty (decision D-E3).
    """
    return os.environ.get("Quix__Portal__Api", "").strip().rstrip("/")


def agent_name() -> str:
    return os.environ.get("TM_AI_AGENT_NAME", "").strip() or _DEFAULT_AGENT_NAME


def _timeout_seconds() -> float:
    try:
        return float(os.environ.get("CHAT_PROXY_TIMEOUT_SECONDS", "120"))
    except ValueError:
        return 120.0


def reset_cache() -> None:
    """Forget the resolved agent id. Tests call this between cases."""
    _agent_cache.clear()


def _headers(token: str, streaming: bool = False) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    if streaming:
        headers["Accept"] = "text/event-stream"
    return headers


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=TRANSPORT, timeout=_timeout_seconds())


async def resolve_agent_id(portal_token: str) -> str | None:
    """Resolve the configured agent name to its id, cached by name.

    Returns None when the agent is not found or the lookup fails — the caller
    then creates an agentless session, which the Portal supports.
    """
    name = agent_name()
    cached = _agent_cache.get(name)
    if cached is not None:
        return cached["id"]
    try:
        async with _client() as client:
            response = await client.get(
                f"{portal_base()}/ai/api/org/agents", headers=_headers(portal_token)
            )
    except httpx.HTTPError as error:
        logger.warning("Agent lookup failed (%s); will retry on next call", error)
        return None

    agent_id = None
    if response.is_success:
        try:
            agents = response.json() or []
        except ValueError:
            # A 200 carrying HTML is a broken Portal, not a crash of ours. A
            # login page and a proxy error page both land here. Read it as
            # "no agent found" and open an agentless session.
            logger.warning("Agent lookup answered a non-JSON body; using agentless sessions")
            agents = []
        for agent in agents:
            if not isinstance(agent, dict):
                continue
            if agent.get("name") == name and agent.get("isEnabled", True):
                agent_id = agent.get("id")
                break
    if agent_id is None:
        logger.warning("TM agent '%s' not found; using agentless sessions", name)
    _agent_cache[name] = {"id": agent_id}
    return agent_id


async def create_session(portal_token: str, agent_id: str | None = None) -> str:
    """Open a Quix.AI session and return its id.

    The body carries ``agentConfigurationId`` only when an agent resolved;
    otherwise the session is agentless. The Portal answers ``id`` (older shapes
    used ``sessionId``); either is accepted.
    """
    body: dict[str, str] = {}
    if agent_id:
        body["agentConfigurationId"] = agent_id
    async with _client() as client:
        response = await client.post(
            f"{portal_base()}/ai/api/sessions",
            headers=_headers(portal_token),
            json=body,
        )
    response.raise_for_status()
    try:
        data = response.json()
    except ValueError as error:
        # Same fault as the agent lookup: a 200 with an HTML body. Raise the
        # httpx error the proxy already catches, so the stream still gets its
        # error frame instead of dying on a ValueError.
        raise httpx.HTTPError("session response is not JSON") from error
    session_id = data.get("id") or data.get("sessionId") if isinstance(data, dict) else None
    if not session_id:
        raise httpx.HTTPError("session response missing 'id'/'sessionId'")
    logger.info(
        "Opened Quix.AI session %s (agent=%s)", session_id, agent_id or "agentless"
    )
    return session_id


def flatten_context(context: dict | None) -> dict[str, str]:
    """Render the run context as a flat map of text, the shape upstream takes.

    Quix.AI binds ``context`` to a dictionary of string to string
    (``Quix.AI.Contract/ChatRequest.cs``), and its own web client sends
    ``Record<string, string>``. A number, a list or a nested object breaks that
    binding, so the Portal answers 400 before the chat starts. Numbers become
    text, structures become compact JSON text, and an empty value drops out.
    """
    flat: dict[str, str] = {}
    for key, value in (context or {}).items():
        if value is None:
            continue
        flat[str(key)] = value if isinstance(value, str) else json.dumps(value)
    return flat


async def stream_message(
    portal_token: str, session_id: str, message: str, context: dict
):
    """POST one user message and yield the upstream SSE lines verbatim.

    Raises ``UpstreamError`` on a non-200 response. The response is closed when
    the generator is closed (client disconnect) via the ``async with`` blocks.
    """
    url = f"{portal_base()}/ai/api/sessions/{session_id}/messages"
    body = {"message": message, "context": flatten_context(context)}
    async with _client() as client, client.stream(
        "POST", url, headers=_headers(portal_token, streaming=True), json=body
    ) as response:
        if response.status_code != 200:
            await response.aread()
            logger.warning(
                "Upstream %d on message POST (session=%s): %s",
                response.status_code,
                session_id,
                response.text[:500],
            )
            raise UpstreamError(response.status_code)
        async for line in response.aiter_lines():
            yield line


# The platform's own name for this deployment's public address. Every public
# deployment holds it: the live API pod and the live mf4-import pod both carry
# `https://<urlPrefix>-<workspace>.deployments-dev.quix.io`
# (`plans/design/DEPLOYED-AUTH-DIAGNOSIS.md` section 1). NEVER DECLARE THIS
# NAME in a descriptor. A declared empty value would overwrite the injected one.
PUBLIC_URL_VAR = "Quix__Deployment__Network__PublicUrl"


def mcp_url() -> str:
    """The public URL of this deployment's own /mcp surface, or "".

    The platform registers this address on a Quix.AI session, and the agent
    runner then dials it from outside this namespace. So the address must be
    the public one. An in-cluster service name would not resolve there.

    `TM_MCP_URL` is an override and nothing else. It is empty by default, and
    the injected public URL then carries the whole answer, so nobody must paste
    a host. A variable nobody sets is the trap `TM_QUIX_PORTAL_URL` already
    cost this project once.
    """
    chosen = os.environ.get("TM_MCP_URL", "").strip()
    if chosen:
        return chosen
    public = os.environ.get(PUBLIC_URL_VAR, "").strip().rstrip("/")
    return f"{public}/mcp" if public else ""


def _mcp_credential() -> str:
    """What the platform must present at our /mcp door — mirrors the door's
    own rule in ``routers/mcp.py``: the injected workspace token."""
    return os.environ.get("Quix__Sdk__Token", "").strip()


async def register_session_mcp(portal_token: str, session_id: str) -> None:
    """Bind our registry MCP server to one session, if configured.

    Org-level MCP registration attaches nothing by itself (measured 20 Aug
    2026); the binding is ``POST /ai/api/sessions/{id}/mcp-servers`` per
    session, exactly how QuixLab does it. ``authType`` must be ``bearer`` —
    the platform's ``api_key`` mode sends ``X-API-Key``, which our door does
    not read. Any failure is logged and swallowed: a toolless chat beats a
    dead one.
    """
    url = mcp_url()
    credential = _mcp_credential()
    if not url or not credential:
        return
    body = {
        "name": "test-manager-registry",
        "url": url,
        "credential": credential,
        "authType": "bearer",
    }
    try:
        async with _client() as client:
            response = await client.post(
                f"{portal_base()}/ai/api/sessions/{session_id}/mcp-servers",
                headers=_headers(portal_token),
                json=body,
            )
        if not response.is_success:
            logger.warning(
                "MCP session binding refused (%d, session=%s)",
                response.status_code,
                session_id,
            )
    except httpx.HTTPError as error:
        logger.warning("MCP session binding failed: %s", error)
