# POST /test-runs/{run_id}/explore/chat — the Ask-AI streaming route.
#
# The happy path rides the in-process stub Portal (tests/stub_portal.py) through
# an httpx.ASGITransport set on the `ai_client.TRANSPORT` seam, so no test opens
# a socket and no test calls a live model. The stub answers canned SSE; the
# route maps it to NDJSON frames.

import json

import httpx
import pytest

from api.services import ai_client
from tests import stub_portal
from tests.factories import upsert_run

RUN = "TAS-88214"
CHAT_PATH = f"/api/v1/test-runs/{RUN}/explore/chat"
CONTEXT_PATH = f"/api/v1/test-runs/{RUN}/explore/context"

PORTAL_URL_VAR = "Quix__Portal__Api"


@pytest.fixture(autouse=True)
def no_portal_env(monkeypatch):
    """Start every test with no Portal configured and a fresh agent cache."""
    monkeypatch.delenv(PORTAL_URL_VAR, raising=False)
    ai_client.reset_cache()
    monkeypatch.setattr(ai_client, "TRANSPORT", None)
    yield
    ai_client.reset_cache()


@pytest.fixture
def stub_ai(monkeypatch):
    """Configure the Portal env and route ai_client at the in-process stub."""
    monkeypatch.setenv(PORTAL_URL_VAR, "http://portal.stub")
    monkeypatch.setattr(
        ai_client, "TRANSPORT", httpx.ASGITransport(app=stub_portal.build_app())
    )


def _frames(response) -> list[dict]:
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


# --- auth: the Portal token is the credential ---


def test_no_portal_token_returns_403(client, routed_db):
    upsert_run(routed_db)
    response = client.post(CHAT_PATH, json={"message": "hello"})
    assert response.status_code == 403
    body = response.json()
    assert body["code"] == "ai_unavailable"
    assert body["detail"] == "no portal token; Ask AI needs a Portal login"


def test_an_empty_portal_token_returns_403(client, routed_db):
    upsert_run(routed_db)
    response = client.post(
        CHAT_PATH, json={"message": "hello"}, headers={"x-portal-token": "   "}
    )
    assert response.status_code == 403
    assert response.json()["code"] == "ai_unavailable"


# --- the unknown run (the token check passes first) ---


def test_unknown_run_returns_404(client, routed_db):
    response = client.post(
        "/api/v1/test-runs/TAS-00000/explore/chat",
        json={"message": "hello"},
        headers={"x-portal-token": "portal-tok"},
    )
    assert response.status_code == 404
    body = response.json()
    assert set(body) == {"detail", "code", "errors"}
    assert body["code"] == "run_not_found"


# --- request validation ---


def test_an_unknown_body_field_returns_422(client, routed_db):
    upsert_run(routed_db)
    response = client.post(
        CHAT_PATH,
        json={"message": "hi", "run_id": RUN},
        headers={"x-portal-token": "portal-tok"},
    )
    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


# --- the happy path, through the stub Portal ---


def test_a_chat_turn_streams_ndjson_frames_ending_in_done(client, routed_db, stub_ai):
    upsert_run(routed_db, signal_count=7)
    response = client.post(
        CHAT_PATH,
        json={"message": "How does this run look?"},
        headers={"x-portal-token": "portal-tok"},
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/x-ndjson")

    frames = _frames(response)
    types = [frame["type"] for frame in frames]
    # Opens with the synthetic status, carries answer text, closes with done.
    assert types[0] == "status"
    assert "answer_delta" in types
    assert types[-1] == "done"

    # Every content frame carries the session id the stub minted.
    for frame in frames:
        if frame["type"] != "ping":
            assert frame["session_id"] == stub_portal.STUB_SESSION_ID


def test_a_second_turn_reuses_the_supplied_session_id(client, routed_db, stub_ai):
    upsert_run(routed_db)
    response = client.post(
        CHAT_PATH,
        json={"message": "and now?", "session_id": "carried-session"},
        headers={"x-portal-token": "portal-tok"},
    )
    assert response.status_code == 200, response.text
    frames = _frames(response)
    assert frames[-1] == {"type": "done", "session_id": "carried-session"}
    # No session was created, so the id we sent is the id every frame carries.
    for frame in frames:
        if frame["type"] != "ping":
            assert frame["session_id"] == "carried-session"


def test_an_unconfigured_portal_streams_an_error_frame(client, routed_db):
    # 200 status (the stream already started) with an error+done body, never a
    # 500: chat_stream never raises to the caller.
    upsert_run(routed_db)
    response = client.post(
        CHAT_PATH,
        json={"message": "hello"},
        headers={"x-portal-token": "portal-tok"},
    )
    assert response.status_code == 200, response.text
    frames = _frames(response)
    assert frames[0]["type"] == "error"
    assert frames[-1]["type"] == "done"


def test_the_upstream_context_carries_only_text_values(client, routed_db, monkeypatch):
    """Upstream binds ``context`` to a dictionary of string to string.

    A number or a nested object breaks that binding, so Quix.AI answers 400
    before the chat runs and the viewer reads "upstream 400". The client must
    render every context value as text.
    """
    upsert_run(routed_db)
    captured: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/messages"):
            captured.append(json.loads(request.content))
            return httpx.Response(
                200,
                text="data: [DONE]\n\n",
                headers={"content-type": "text/event-stream"},
            )
        if request.url.path.endswith("/agents"):
            return httpx.Response(200, json=[])
        return httpx.Response(200, json={"id": "mock-session"})

    monkeypatch.setenv(PORTAL_URL_VAR, "http://portal.stub")
    monkeypatch.setattr(ai_client, "TRANSPORT", httpx.MockTransport(handler))

    response = client.post(
        CHAT_PATH,
        json={"message": "how does this run look?"},
        headers={"x-portal-token": "portal-tok"},
    )
    assert response.status_code == 200, response.text
    assert captured, "the route never posted to the upstream messages endpoint"

    context = captured[0]["context"]
    assert "signal_count" in context
    bad = {k: v for k, v in context.items() if not isinstance(v, str)}
    assert not bad, f"non-text context values break the upstream binding: {bad}"


# --- ai_available flips with the Portal configuration ---


def test_context_ai_available_is_false_without_a_portal(client, routed_db):
    upsert_run(routed_db)
    response = client.get(CONTEXT_PATH)
    assert response.status_code == 200, response.text
    assert response.json()["ai_available"] is False


def test_context_ai_available_is_true_with_a_portal(client, routed_db, monkeypatch):
    upsert_run(routed_db)
    monkeypatch.setenv(PORTAL_URL_VAR, "http://portal.stub")
    response = client.get(CONTEXT_PATH)
    assert response.status_code == 200, response.text
    assert response.json()["ai_available"] is True


def test_context_ai_available_is_true_on_the_injected_portal_name(
    client, routed_db, monkeypatch
):
    """A deployment sets no name by hand. The platform injects this one.

    `ai_client.portal_base()` reads `Quix__Portal__Api` and nothing else since
    21 Aug 2026. It read `Quix__Portal__PublicApiBasePath` first before that,
    and nothing injects that name (`plans/reference/QUIX-INJECTED-VARIABLES.md`
    section 6). The local stack leaves the canonical name empty on purpose.
    """
    upsert_run(routed_db)
    monkeypatch.delenv(PORTAL_URL_VAR, raising=False)
    monkeypatch.setenv("Quix__Portal__Api", "http://portal.stub")

    response = client.get(CONTEXT_PATH)

    assert response.status_code == 200, response.text
    assert response.json()["ai_available"] is True


# --- the chat context names the PHYSICAL table ---
#
# This section replaces the old "one table name for every caller" rule
# (finding 14b). That rule held while a backend guard rewrote the user's SQL:
# a LOGICAL name was then the only name that could work. The guard was
# deleted on 24 Aug 2026, and the workbench now posts SQL straight to
# QuixLake. SQL the assistant suggests reaches the lake unchanged, so a
# logical name the lake never heard of is a binder error every time. The chat
# context must state the real table and the real column spellings.
#
# GET /explore/context keeps the logical name on purpose. No query builder
# reads it, and the last test below pins that it did not move.


def _capture_chat_context(client, monkeypatch) -> dict:
    """Post one chat turn and return the context the route sent upstream."""
    captured: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/messages"):
            captured.append(json.loads(request.content))
            return httpx.Response(
                200,
                text="data: [DONE]\n\n",
                headers={"content-type": "text/event-stream"},
            )
        if request.url.path.endswith("/agents"):
            return httpx.Response(200, json=[])
        return httpx.Response(200, json={"id": "mock-session"})

    monkeypatch.setenv(PORTAL_URL_VAR, "http://portal.stub")
    monkeypatch.setattr(ai_client, "TRANSPORT", httpx.MockTransport(handler))

    response = client.post(
        CHAT_PATH,
        json={"message": "which signals are here?"},
        headers={"x-portal-token": "portal-tok"},
    )
    assert response.status_code == 200, response.text
    assert captured, "the route never posted to the upstream messages endpoint"
    return captured[0]["context"]


def test_the_chat_context_states_the_configured_physical_table(
    client, routed_db, monkeypatch
):
    """`TM_LAKE_TABLE` names the table, and the columns follow that table."""
    upsert_run(routed_db)
    monkeypatch.setenv("TM_LAKE_TABLE", "tm_signals")

    context = _capture_chat_context(client, monkeypatch)

    assert context["table"] == "tm_signals"
    # `flatten_context` renders a list as compact JSON text, the only shape
    # Quix.AI binds. So the columns arrive as a string; read them back.
    assert json.loads(context["columns"]) == [
        "run_id",
        "signal",
        "ts_ms",
        "value",
        "file_name",
    ]


def test_an_unset_lake_table_keeps_the_local_stack_spellings(
    client, routed_db, monkeypatch
):
    """An unset variable must behave the way it does today, and never crash."""
    upsert_run(routed_db)
    monkeypatch.delenv("TM_LAKE_TABLE", raising=False)

    context = _capture_chat_context(client, monkeypatch)

    assert context["table"] == "test_signal_samples"
    assert json.loads(context["columns"]) == [
        "run_id",
        "signal",
        "timestamp",
        "value",
        "filename",
    ]


def test_the_context_route_still_states_the_logical_table(
    client, routed_db, monkeypatch
):
    """GET /explore/context is out of scope. Its answer must not move."""
    upsert_run(routed_db)
    monkeypatch.setenv("TM_LAKE_TABLE", "tm_signals")

    assert client.get(CONTEXT_PATH).json()["table"] == "test_signal_samples"


# --- the first status frame carries `message` (finding 40f, 21 Aug 2026) ---


def test_the_first_status_frame_carries_message_not_text(client, routed_db, stub_ai):
    """The contract, ai_proxy's own docstring and explore.ts all say `message`.

    The synthetic opening frame sent `text`, so the front-end rendered an empty
    progress line on every turn while every later status frame was correct.
    """
    upsert_run(routed_db)
    response = client.post(
        CHAT_PATH,
        json={"message": "How does this run look?"},
        headers={"x-portal-token": "portal-tok"},
    )

    first = _frames(response)[0]
    assert first["type"] == "status"
    assert first["message"] == "generating"
    assert "text" not in first


# --- a non-JSON Portal never kills the stream (finding 40e, 21 Aug 2026) ---


def test_an_html_agent_lookup_still_streams(client, routed_db, monkeypatch):
    """A Portal answering 200 with HTML must not raise inside the generator.

    `resolve_agent_id` read `.json()` outside its try. A proxy login page then
    killed the turn with no error frame at all. The lookup reads as "no agent
    found" now, and the session opens agentless.
    """
    class HtmlAgentLookup(httpx.AsyncBaseTransport):
        """The stub Portal, but the agent list answers an HTML login page."""

        def __init__(self, inner: httpx.AsyncBaseTransport) -> None:
            self._inner = inner

        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            if request.url.path == "/ai/api/org/agents":
                return httpx.Response(
                    200, text="<html>login</html>", headers={"content-type": "text/html"}
                )
            return await self._inner.handle_async_request(request)

    monkeypatch.setenv(PORTAL_URL_VAR, "http://portal.stub")
    monkeypatch.setattr(
        ai_client,
        "TRANSPORT",
        HtmlAgentLookup(httpx.ASGITransport(app=stub_portal.build_app())),
    )

    upsert_run(routed_db)
    response = client.post(
        CHAT_PATH,
        json={"message": "hello"},
        headers={"x-portal-token": "portal-tok"},
    )

    assert response.status_code == 200, response.text
    types = [frame["type"] for frame in _frames(response)]
    assert types[0] == "status"
    assert "answer_delta" in types
    assert types[-1] == "done"
