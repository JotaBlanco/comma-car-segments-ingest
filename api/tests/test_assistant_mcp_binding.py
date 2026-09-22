# ai_client.register_session_mcp — the per-session MCP binding.
#
# Org-level MCP registration attaches nothing by itself (measured 20 Aug 2026);
# the binding is POST /ai/api/sessions/{id}/mcp-servers per session, and
# chat_stream fires it exactly once, on a fresh session only. Every test rides
# an httpx.MockTransport on the `ai_client.TRANSPORT` seam — no sockets — and
# the env is scripted per test, the same style as test_assistant_stream.py.

import asyncio
import json
import logging

import httpx
import pytest

from api.services import ai_client, ai_proxy

PORTAL_URL_VAR = "Quix__Portal__Api"

SESSION_ID = "sess-1"
BIND_PATH = f"/ai/api/sessions/{SESSION_ID}/mcp-servers"
MCP_URL = "https://tm.example/mcp"


@pytest.fixture(autouse=True)
def portal_env(monkeypatch):
    """Portal configured, MCP env cleared, transport reset per test."""
    monkeypatch.setenv(PORTAL_URL_VAR, "http://portal.stub")
    monkeypatch.delenv("TM_MCP_URL", raising=False)
    monkeypatch.delenv("Quix__Deployment__Network__PublicUrl", raising=False)
    monkeypatch.delenv("Quix__Sdk__Token", raising=False)
    monkeypatch.setattr(ai_client, "TRANSPORT", None)
    ai_client.reset_cache()
    yield
    ai_client.reset_cache()


def _capture(monkeypatch, *, status: int = 200) -> list[httpx.Request]:
    """Answer every request with `status` and record what arrived."""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status, json={})

    monkeypatch.setattr(ai_client, "TRANSPORT", httpx.MockTransport(handler))
    return requests


def _register() -> None:
    asyncio.run(ai_client.register_session_mcp("portal-tok", SESSION_ID))


def test_the_platform_public_url_sets_the_mcp_address(monkeypatch):
    """Nobody must paste an address. The platform injects the public host.

    `Quix__Deployment__Network__PublicUrl` carries this deployment's own
    public URL, and `/mcp` is our door on it. `TM_MCP_URL` stays an override
    for a person who must point the platform somewhere else.
    """
    monkeypatch.delenv("TM_MCP_URL", raising=False)
    monkeypatch.setenv(
        "Quix__Deployment__Network__PublicUrl",
        "https://tm-api-ws.deployments-dev.quix.io/",
    )

    assert ai_client.mcp_url() == "https://tm-api-ws.deployments-dev.quix.io/mcp"

    monkeypatch.setenv("TM_MCP_URL", MCP_URL)
    assert ai_client.mcp_url() == MCP_URL


def test_the_binding_registers_with_the_injected_public_url(monkeypatch):
    """The whole point: the assistant holds its registry tools with no action."""
    monkeypatch.setenv(
        "Quix__Deployment__Network__PublicUrl", "https://tm-api-ws.deployments-dev.quix.io"
    )
    monkeypatch.setenv("Quix__Sdk__Token", "mcp-secret")
    requests = _capture(monkeypatch)

    _register()

    assert len(requests) == 1
    body = json.loads(requests[0].content)
    assert body["url"] == "https://tm-api-ws.deployments-dev.quix.io/mcp"


def test_a_configured_binding_posts_the_bearer_body(monkeypatch):
    monkeypatch.setenv("TM_MCP_URL", MCP_URL)
    monkeypatch.setenv("Quix__Sdk__Token", "mcp-secret")
    requests = _capture(monkeypatch)

    _register()

    assert len(requests) == 1
    request = requests[0]
    assert request.method == "POST"
    assert request.url.path == BIND_PATH
    assert request.headers["Authorization"] == "Bearer portal-tok"
    assert json.loads(request.content) == {
        "name": "test-manager-registry",
        "url": MCP_URL,
        "credential": "mcp-secret",
        "authType": "bearer",
    }


def test_the_sdk_token_is_the_credential(monkeypatch):
    # The credential mirrors the /mcp door's own rule (routers/mcp.py):
    # the injected workspace token.
    monkeypatch.setenv("TM_MCP_URL", MCP_URL)
    monkeypatch.setenv("Quix__Sdk__Token", "sdk-secret")
    requests = _capture(monkeypatch)

    _register()

    assert len(requests) == 1
    assert json.loads(requests[0].content)["credential"] == "sdk-secret"


def test_with_neither_url_nor_credential_no_call_is_made(monkeypatch):
    requests = _capture(monkeypatch)

    _register()

    assert requests == []


def test_an_upstream_500_is_swallowed(monkeypatch):
    # A toolless chat beats a dead one: the refusal is logged, never raised.
    monkeypatch.setenv("TM_MCP_URL", MCP_URL)
    monkeypatch.setenv("Quix__Sdk__Token", "mcp-secret")
    requests = _capture(monkeypatch, status=500)

    _register()  # must not raise

    assert len(requests) == 1


def test_the_credential_never_reaches_the_log(monkeypatch, caplog):
    secret = "super-secret-mcp-token"
    monkeypatch.setenv("TM_MCP_URL", MCP_URL)
    monkeypatch.setenv("Quix__Sdk__Token", secret)

    with caplog.at_level(logging.DEBUG, logger="api.services.ai_client"):
        _capture(monkeypatch, status=500)
        _register()  # the refusal path logs a warning

        def boom(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        monkeypatch.setattr(ai_client, "TRANSPORT", httpx.MockTransport(boom))
        _register()  # the transport-failure path logs a warning

    assert caplog.text, "the failure paths should have logged something"
    assert secret not in caplog.text


# --- chat_stream drives the binding: once for a fresh session, never for a
# --- supplied one ---


def _script_turn(monkeypatch) -> None:
    """Answer agents/sessions/messages so chat_stream runs a whole turn."""
    body = (
        'event: text_delta\ndata: {"text": "hello"}\n\n'
        "data: [DONE]\n\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/ai/api/org/agents":
            return httpx.Response(200, json=[])
        if path == "/ai/api/sessions":
            return httpx.Response(200, json={"id": SESSION_ID})
        assert path.endswith("/messages"), path
        return httpx.Response(
            200, text=body, headers={"content-type": "text/event-stream"}
        )

    monkeypatch.setattr(ai_client, "TRANSPORT", httpx.MockTransport(handler))


async def _frames(stream) -> list[dict]:
    return [json.loads(line) async for line in stream]


def test_chat_stream_binds_a_fresh_session_once_and_a_supplied_one_never(monkeypatch):
    calls: list[tuple[str, str]] = []

    async def counting_register(portal_token: str, session_id: str) -> None:
        calls.append((portal_token, session_id))

    monkeypatch.setattr(ai_client, "register_session_mcp", counting_register)
    _script_turn(monkeypatch)

    fresh = asyncio.run(_frames(ai_proxy.chat_stream(
        "portal-tok", "TAS-88214", "hello", None, {}
    )))
    assert fresh[-1] == {"type": "done", "session_id": SESSION_ID}
    assert calls == [("portal-tok", SESSION_ID)]

    supplied = asyncio.run(_frames(ai_proxy.chat_stream(
        "portal-tok", "TAS-88214", "and today?", SESSION_ID, {}
    )))
    assert supplied[-1] == {"type": "done", "session_id": SESSION_ID}
    assert calls == [("portal-tok", SESSION_ID)], "a supplied session must not re-bind"
