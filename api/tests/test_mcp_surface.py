# The MCP transport: auth gates, JSON-RPC framing, the initialize handshake.
# Tool behavior (tools/list, tools/call) lives in test_mcp_tools.py.

import pytest

# A test-only value. It is not a real secret.
MCP_TOKEN = "mcp-test-token-not-a-secret"


@pytest.fixture
def mcp_enabled(monkeypatch):
    """Turn the MCP surface on for one test."""
    monkeypatch.setenv("Quix__Sdk__Token", MCP_TOKEN)


def post_mcp(client, payload, token=MCP_TOKEN):
    return client.post(
        "/mcp", json=payload, headers={"Authorization": f"Bearer {token}"}
    )


def rpc(method, params=None, id=1):
    message = {"jsonrpc": "2.0", "id": id, "method": method}
    if params is not None:
        message["params"] = params
    return message


def test_initialize_answers_the_handshake(bare_client, mcp_enabled):
    response = post_mcp(bare_client, rpc("initialize", {
        "protocolVersion": "2024-11-05",  # any client version is accepted
        "capabilities": {},
        "clientInfo": {"name": "quix-ai", "version": "0.0.1"},
    }))
    assert response.status_code == 200
    body = response.json()
    assert body["jsonrpc"] == "2.0" and body["id"] == 1
    assert body["result"] == {
        "protocolVersion": "2025-03-26",  # we echo ours, never the client's
        "capabilities": {"tools": {}},
        "serverInfo": {"name": "test-manager-registry", "version": "1.0.0"},
    }


def test_disabled_surface_answers_403(bare_client, monkeypatch):
    monkeypatch.delenv("Quix__Sdk__Token", raising=False)
    response = post_mcp(bare_client, rpc("initialize"))
    assert response.status_code == 403
    assert response.json()["error"]["message"] == "mcp surface disabled"


def test_wrong_token_answers_401(bare_client, mcp_enabled):
    response = post_mcp(bare_client, rpc("initialize"), token="wrong-token")
    assert response.status_code == 401
    assert "error" in response.json()


def test_missing_authorization_answers_401(bare_client, mcp_enabled):
    response = bare_client.post("/mcp", json=rpc("initialize"))
    assert response.status_code == 401


def test_registry_bearer_token_does_not_open_mcp(client, mcp_enabled):
    # `client` sends the TM_API_TOKEN bearer. The registry token must not
    # reach the MCP surface: two audiences, two secrets.
    response = client.post("/mcp", json=rpc("initialize"))
    assert response.status_code == 401


def test_malformed_json_rpc_answers_invalid_request(bare_client, mcp_enabled):
    response = post_mcp(bare_client, {"foo": "bar"})
    assert response.status_code == 200  # a JSON-RPC error is an answer
    assert response.json()["error"]["code"] == -32600


def test_unparseable_body_answers_parse_error(bare_client, mcp_enabled):
    response = bare_client.post(
        "/mcp",
        content=b"this is not json",
        headers={
            "Authorization": f"Bearer {MCP_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    assert response.json()["error"]["code"] == -32700


def test_unknown_method_answers_method_not_found(bare_client, mcp_enabled):
    response = post_mcp(bare_client, rpc("resources/list"))
    body = response.json()
    assert body["error"]["code"] == -32601
    assert body["id"] == 1


def test_initialized_notification_answers_202_with_no_body(bare_client, mcp_enabled):
    response = post_mcp(
        bare_client, {"jsonrpc": "2.0", "method": "notifications/initialized"}
    )
    assert response.status_code == 202
    assert response.content == b""


def test_batch_answers_every_request(bare_client, mcp_enabled):
    response = post_mcp(bare_client, [
        rpc("initialize", id=1),
        rpc("tools/list", id=2),
    ])
    body = response.json()
    assert isinstance(body, list) and len(body) == 2
    by_id = {answer["id"]: answer for answer in body}
    assert "protocolVersion" in by_id[1]["result"]
    assert "tools" in by_id[2]["result"]


def test_batch_of_notifications_answers_202(bare_client, mcp_enabled):
    response = post_mcp(bare_client, [
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
    ])
    assert response.status_code == 202
    assert response.content == b""


def test_empty_batch_is_invalid(bare_client, mcp_enabled):
    response = post_mcp(bare_client, [])
    assert response.json()["error"]["code"] == -32600


def test_get_answers_405(bare_client, mcp_enabled):
    # No server-initiated SSE stream is offered; the 2025-03-26 spec permits
    # answering the GET half of the transport with 405.
    assert bare_client.get("/mcp").status_code == 405


def test_sdk_token_opens_the_door(client, monkeypatch):
    """The platform-injected workspace token admits.

    The registration stores the workspace's own Quix__Sdk__Token, so no
    hand-set secret is needed for a same-workspace MCP setup.
    """
    monkeypatch.setenv("Quix__Sdk__Token", "sdk-workspace-token")
    response = client.post(
        "/mcp",
        headers={"Authorization": "Bearer sdk-workspace-token"},
        json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
    )
    assert response.status_code == 200
    assert response.json()["result"]["serverInfo"]["name"] == "test-manager-registry"


# --- the route must not hold the event loop (finding 8, 21 Aug 2026) ---
#
# `POST /mcp` is the only `async def` route in the app, and the protocol handler
# under it runs blocking pymongo. Calling it inline froze every other screen for
# the length of one Mongo round trip. The two tests below pin both halves: the
# handler runs off the loop, and a second request answers while the first one is
# still inside the handler.


def test_the_handler_runs_off_the_event_loop(bare_client, mcp_enabled, monkeypatch):
    """The blocking handler must never run in the thread that owns the loop."""
    import asyncio

    from api.services import mcp_server

    seen: dict = {}
    # Bind the real function first. The patch below replaces the same module
    # attribute, so reading it inside the spy would call the spy.
    real = mcp_server.handle_payload

    def spy(db, payload):
        try:
            asyncio.get_running_loop()
            seen["loop"] = True
        except RuntimeError:
            seen["loop"] = False
        return real(db, payload)

    monkeypatch.setattr("api.routers.mcp.mcp_server.handle_payload", spy)

    assert post_mcp(bare_client, rpc("initialize")).status_code == 200
    assert seen["loop"] is False


def test_a_second_request_answers_while_the_first_one_blocks(app, mcp_enabled):
    """Two calls, and the first one only returns after the second one landed.

    The first request waits on an event that the second request sets. Inline,
    the first call would hold the loop, the second could never start, and this
    would time out. Off the loop, both finish.
    """
    import asyncio
    import threading

    import httpx

    from api.services import mcp_server

    started = threading.Event()
    release = threading.Event()
    real = mcp_server.handle_payload

    def blocking(db, payload):
        if payload.get("id") == "slow":
            started.set()
            assert release.wait(timeout=10), "the fast call never arrived"
        return real(db, payload)

    async def drive() -> tuple[int, int]:
        transport = httpx.ASGITransport(app=app)
        headers = {"Authorization": f"Bearer {MCP_TOKEN}"}
        async with httpx.AsyncClient(transport=transport, base_url="http://tm") as ac:
            slow = asyncio.create_task(
                ac.post("/mcp", json=rpc("initialize", id="slow"), headers=headers)
            )
            await asyncio.to_thread(started.wait, 10)
            fast = await ac.post("/mcp", json=rpc("initialize", id="fast"), headers=headers)
            release.set()
            return (await slow).status_code, fast.status_code

    original = mcp_server.handle_payload
    mcp_server.handle_payload = blocking
    try:
        slow_status, fast_status = asyncio.run(asyncio.wait_for(drive(), timeout=20))
    finally:
        mcp_server.handle_payload = original
        release.set()

    assert (slow_status, fast_status) == (200, 200)
