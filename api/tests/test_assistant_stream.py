# POST /assistant/chat — the registry assistant's streaming turn.
#
# The assistant rides the Quix.AI sessions pipeline (AI-SIDEBAR §10, U-4) —
# the same ai_client/ai_proxy path as the Explore chat — so no test calls a
# live model: the Portal's SSE answers are scripted through an
# httpx.MockTransport on the `ai_client.TRANSPORT` seam (or the in-process
# stub Portal for the plain-text path). The presenter hydrates against the
# per-test Mongo, which is the point — the frames must carry what the DB
# says, never what the model said.

import json

import httpx
import pytest

from api.services import ai_client
from tests import stub_portal
from tests.factories import upsert_run

CHAT_PATH = "/api/v1/assistant/chat"

PORTAL_URL_VAR = "Quix__Portal__Api"

STUB_SESSION = "stub-session"
PORTAL_HEADERS = {"x-portal-token": "portal-tok"}


@pytest.fixture(autouse=True)
def assistant_on(monkeypatch):
    """Portal configured (the availability condition), caches reset per test."""
    monkeypatch.setenv(PORTAL_URL_VAR, "http://portal.stub")
    monkeypatch.setattr(ai_client, "TRANSPORT", None)
    ai_client.reset_cache()
    yield
    ai_client.reset_cache()


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _script(monkeypatch, events: list[tuple[str, dict]], *, message_status: int = 200) -> dict:
    """Answer the Portal endpoints from a scripted SSE event list.

    Returns a capture dict — the bodies POSTed to .../messages and the number
    of sessions created — so a test can look at what the route sent upstream.
    """
    body_text = "".join(_sse(event, data) for event, data in events) + "data: [DONE]\n\n"
    captured: dict = {"messages": [], "sessions_created": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/ai/api/org/agents":
            return httpx.Response(
                200,
                json=[{"id": "stub-agent-1", "name": "test-manager-agent", "isEnabled": True}],
            )
        if path == "/ai/api/sessions":
            captured["sessions_created"] += 1
            return httpx.Response(200, json={"id": STUB_SESSION})
        assert path.endswith("/messages"), path
        captured["messages"].append(json.loads(request.content))
        if message_status != 200:
            return httpx.Response(message_status, json={"error": "boom"})
        return httpx.Response(
            200, text=body_text, headers={"content-type": "text/event-stream"}
        )

    monkeypatch.setattr(ai_client, "TRANSPORT", httpx.MockTransport(handler))
    return captured


def _frames(response) -> list[dict]:
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


# The two-step script: the agent lists runs (an ordinary tool call, rendered
# as a trace card), then finishes with present_answer. Its text claims RIG-99
# on purpose — a lie the cards must not repeat, because cards hydrate from
# the DB. The present_answer arguments stream as two deltas, the way the
# platform actually sends them.
PRESENT_ARGS = {
    "text": "One run is awaiting a work order, on rig RIG-99.",
    "hit_refs": [{"run_id": "TAS-88214"}],
    "link_spec": {"screen": "runs", "params": {"status": ["awaiting_work_order"]}},
}
_RAW_ARGS = json.dumps(PRESENT_ARGS)
TURN_EVENTS = [
    ("tool_call_start", {"toolCallId": "tc-1", "toolName": "list_runs",
                         "displayName": "List runs"}),
    ("tool_call_delta", {"toolCallId": "tc-1",
                         "argumentsDelta": '{"status": ["awaiting_work_order"]}'}),
    ("tool_call_end", {"toolCallId": "tc-1"}),
    ("tool_result", {"toolCallId": "tc-1", "userSummary": "1 runs, page 1",
                     "isError": False}),
    ("tool_call_start", {"toolCallId": "tc-2", "toolName": "present_answer",
                         "displayName": "Present answer"}),
    ("tool_call_delta", {"toolCallId": "tc-2", "argumentsDelta": _RAW_ARGS[:40]}),
    ("tool_call_delta", {"toolCallId": "tc-2", "argumentsDelta": _RAW_ARGS[40:]}),
    ("tool_call_end", {"toolCallId": "tc-2"}),
    ("tool_result", {"toolCallId": "tc-2", "userSummary": "delivered",
                     "isError": False}),
]


# --- the flag and the token gate behavior, not registration ---


def test_off_platform_answers_403_assistant_disabled(client, routed_db, monkeypatch):
    monkeypatch.delenv(PORTAL_URL_VAR, raising=False)
    response = client.post(CHAT_PATH, json={"message": "hello"})
    assert response.status_code == 403
    body = response.json()
    assert body["code"] == "assistant_disabled"
    assert body["detail"] == "assistant is disabled"


def test_no_portal_token_answers_403_ai_unavailable(client, routed_db):
    # The session runs as the viewer, so the Portal token is the credential.
    response = client.post(CHAT_PATH, json={"message": "hello"})
    assert response.status_code == 403
    body = response.json()
    assert body["code"] == "ai_unavailable"
    assert body["detail"] == "no portal token; the assistant needs a Portal login"


def test_an_empty_portal_token_answers_403_ai_unavailable(client, routed_db):
    response = client.post(
        CHAT_PATH, json={"message": "hello"}, headers={"x-portal-token": "   "}
    )
    assert response.status_code == 403
    assert response.json()["code"] == "ai_unavailable"


# --- the happy path: pass-through trace, then server-hydrated answer frames ---


def test_a_turn_streams_the_frame_vocabulary_in_order(client, routed_db, monkeypatch):
    upsert_run(routed_db)  # TAS-88214, RIG-04, awaiting_work_order
    _script(monkeypatch, TURN_EVENTS)

    response = client.post(
        CHAT_PATH, json={"message": "which runs need work orders?"},
        headers=PORTAL_HEADERS,
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/x-ndjson")

    frames = _frames(response)
    assert [frame["type"] for frame in frames] == [
        "status", "tool_start", "tool_args", "tool_end", "tool_result",
        "answer_delta", "hits", "deeplink", "done",
    ]
    assert frames[1]["tool_name"] == "list_runs"
    assert frames[1]["tool_call_id"] == "tc-1"
    assert frames[1]["display_name"] == "List runs"
    assert frames[4]["tool_call_id"] == "tc-1"
    assert frames[4]["summary"] == "1 runs, page 1"
    assert frames[4]["is_error"] is False
    assert frames[7]["url"] == "/runs?status=awaiting_work_order"
    assert frames[7]["label"] == "Open runs"


def test_no_tool_frame_for_present_answer_leaks(client, routed_db, monkeypatch):
    # The presenter REPLACES the present_answer call: neither its call id nor
    # its raw argument stream may reach the FE in any frame.
    upsert_run(routed_db)
    _script(monkeypatch, TURN_EVENTS)

    frames = _frames(client.post(
        CHAT_PATH, json={"message": "which runs need work orders?"},
        headers=PORTAL_HEADERS,
    ))
    wire = json.dumps(frames)
    assert "present_answer" not in wire
    assert "tc-2" not in wire
    for frame in frames:
        if frame["type"].startswith("tool_"):
            assert frame["tool_call_id"] == "tc-1"


def _namespaced(events: list[tuple[str, dict]]) -> list[tuple[str, dict]]:
    """The same turn with present_answer under its platform-namespaced name."""
    renamed: list[tuple[str, dict]] = []
    for event, data in events:
        if data.get("toolName") == "present_answer":
            data = {**data, "toolName": "mcp__test-manager-registry__present_answer"}
        renamed.append((event, data))
    return renamed


def test_a_namespaced_present_answer_is_intercepted_all_the_same(
    client, routed_db, monkeypatch
):
    # The platform namespaces MCP tools as ``mcp__<server>__<name>`` (measured
    # 20 Aug 2026), so the present call arrives as
    # ``mcp__test-manager-registry__present_answer``. Interception must fire on
    # that form exactly as on the bare name: no tool_* frame for the call
    # leaks, the presenter's frames take its place, done arrives.
    upsert_run(routed_db)
    _script(monkeypatch, _namespaced(TURN_EVENTS))

    frames = _frames(client.post(
        CHAT_PATH, json={"message": "which runs need work orders?"},
        headers=PORTAL_HEADERS,
    ))
    assert [frame["type"] for frame in frames] == [
        "status", "tool_start", "tool_args", "tool_end", "tool_result",
        "answer_delta", "hits", "deeplink", "done",
    ]
    wire = json.dumps(frames)
    assert "present_answer" not in wire
    assert "tc-2" not in wire
    for frame in frames:
        if frame["type"].startswith("tool_"):
            assert frame["tool_call_id"] == "tc-1"


def test_prose_after_a_successful_present_answer_is_dropped(
    client, routed_db, monkeypatch
):
    # present_answer IS the reply; models restate it in prose anyway. After
    # the presented frames, further text deltas in the turn must be dropped —
    # exactly one answer_delta (the presenter's own) reaches the FE, and the
    # stream still ends in its honest done.
    upsert_run(routed_db)
    _script(monkeypatch, TURN_EVENTS + [
        ("text_delta", {"text": "Restating: one run waits on RIG-99. "}),
        ("text_delta", {"text": "Let me know if you need more."}),
    ])

    frames = _frames(client.post(
        CHAT_PATH, json={"message": "which runs need work orders?"},
        headers=PORTAL_HEADERS,
    ))
    assert [frame["type"] for frame in frames] == [
        "status", "tool_start", "tool_args", "tool_end", "tool_result",
        "answer_delta", "hits", "deeplink", "done",
    ]
    assert "Restating" not in json.dumps(frames)


def test_an_error_after_a_successful_present_answer_still_passes_through(
    client, routed_db, monkeypatch
):
    # Suppression drops only the model's prose. An error event after the
    # presented answer must still reach the FE as an error frame, then done.
    upsert_run(routed_db)
    _script(monkeypatch, TURN_EVENTS + [
        ("text_delta", {"text": "this prose is dropped"}),
        ("error", {"message": "the model fell over"}),
    ])

    frames = _frames(client.post(
        CHAT_PATH, json={"message": "which runs need work orders?"},
        headers=PORTAL_HEADERS,
    ))
    assert [frame["type"] for frame in frames] == [
        "status", "tool_start", "tool_args", "tool_end", "tool_result",
        "answer_delta", "hits", "deeplink", "error", "done",
    ]
    assert frames[-2]["message"] == "the model fell over"
    assert "this prose is dropped" not in json.dumps(frames)


def test_hit_cards_carry_the_db_record_not_the_models_text(client, routed_db, monkeypatch):
    upsert_run(routed_db)
    _script(monkeypatch, TURN_EVENTS)

    frames = _frames(client.post(
        CHAT_PATH, json={"message": "which runs need work orders?"},
        headers=PORTAL_HEADERS,
    ))
    hits_frame = next(frame for frame in frames if frame["type"] == "hits")
    assert len(hits_frame["hits"]) == 1
    card = hits_frame["hits"][0]
    assert card["entity"] == "run"
    assert card["run_id"] == "TAS-88214"
    assert card["status"] == "awaiting_work_order"
    assert card["rig_id"] == "RIG-04"  # the DB's rig, not the model's RIG-99
    assert card["url"] == "/runs/TAS-88214"
    assert "RIG-99" not in json.dumps(hits_frame)


def test_every_frame_carries_one_stable_session_id_across_two_turns(
    client, routed_db, monkeypatch
):
    upsert_run(routed_db)
    captured = _script(monkeypatch, TURN_EVENTS)

    first = _frames(client.post(
        CHAT_PATH, json={"message": "which runs need work orders?"},
        headers=PORTAL_HEADERS,
    ))
    assert all(frame["session_id"] == STUB_SESSION for frame in first)
    assert captured["sessions_created"] == 1

    # A supplied session id is reused verbatim — the platform owns the
    # history, so no second session is created.
    second = _frames(client.post(
        CHAT_PATH,
        json={"message": "and today?", "session_id": STUB_SESSION},
        headers=PORTAL_HEADERS,
    ))
    assert captured["sessions_created"] == 1
    assert all(frame["session_id"] == STUB_SESSION for frame in second)
    assert second[-1] == {"type": "done", "session_id": STUB_SESSION}


def test_a_plain_text_turn_rides_the_stub_portal_sessions_pipe(
    client, routed_db, monkeypatch
):
    # The shared in-process stub Portal (tests/stub_portal.py) answers canned
    # text deltas: the assistant maps them exactly as the Explore chat does.
    upsert_run(routed_db)
    monkeypatch.setattr(
        ai_client, "TRANSPORT", httpx.ASGITransport(app=stub_portal.build_app())
    )
    response = client.post(
        CHAT_PATH, json={"message": "hello"}, headers=PORTAL_HEADERS
    )
    assert response.status_code == 200, response.text
    frames = _frames(response)
    types = [frame["type"] for frame in frames]
    assert types[0] == "status"
    assert "answer_delta" in types
    assert types[-1] == "done"
    for frame in frames:
        if frame["type"] != "ping":
            assert frame["session_id"] == stub_portal.STUB_SESSION_ID


# --- the upstream context is flat text, the shape the platform binds ---


def test_the_upstream_context_carries_only_text_values(client, routed_db, monkeypatch):
    # Quix.AI binds `context` to a dictionary of string to string; a number or
    # a nested object breaks the binding and the Portal answers 400 before the
    # chat starts. The registry context must arrive flat.
    upsert_run(routed_db)
    captured = _script(monkeypatch, TURN_EVENTS)

    response = client.post(
        CHAT_PATH, json={"message": "hello"}, headers=PORTAL_HEADERS
    )
    assert response.status_code == 200, response.text
    assert captured["messages"], "the route never posted to the upstream messages endpoint"

    context = captured["messages"][0]["context"]
    assert context["surface"] == "registry-sidebar"
    bad = {k: v for k, v in context.items() if not isinstance(v, str)}
    assert not bad, f"non-text context values break the upstream binding: {bad}"


# --- request validation mirrors the explore chat ---


def test_an_unknown_body_field_returns_422(client, routed_db):
    response = client.post(
        CHAT_PATH, json={"message": "hi", "run_id": "TAS-88214"},
        headers=PORTAL_HEADERS,
    )
    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


# --- mid-stream failures become frames, never exceptions ---


def test_an_upstream_error_streams_an_error_frame_then_done(client, routed_db, monkeypatch):
    upsert_run(routed_db)
    _script(monkeypatch, TURN_EVENTS, message_status=500)

    response = client.post(
        CHAT_PATH, json={"message": "hello"}, headers=PORTAL_HEADERS
    )
    assert response.status_code == 200, response.text
    frames = _frames(response)
    assert [frame["type"] for frame in frames] == ["status", "error", "done"]
    assert frames[1]["message"] == "upstream 500"


def test_malformed_present_answer_args_error_then_the_stream_continues(
    client, routed_db, monkeypatch
):
    # A present_answer whose arguments do not parse must not kill the turn:
    # the parse failure becomes an error frame and the stream carries on to
    # its honest done.
    upsert_run(routed_db)
    _script(monkeypatch, [
        ("tool_call_start", {"toolCallId": "tc-9", "toolName": "present_answer",
                             "displayName": "Present answer"}),
        ("tool_call_delta", {"toolCallId": "tc-9", "argumentsDelta": "{not json"}),
        ("tool_call_end", {"toolCallId": "tc-9"}),
        ("tool_result", {"toolCallId": "tc-9", "userSummary": "delivered",
                         "isError": False}),
        ("text_delta", {"text": "still streaming"}),
    ])

    response = client.post(
        CHAT_PATH, json={"message": "hello"}, headers=PORTAL_HEADERS
    )
    assert response.status_code == 200, response.text
    frames = _frames(response)
    assert [frame["type"] for frame in frames] == [
        "status", "error", "answer_delta", "done",
    ]
    assert "present_answer arguments unreadable" in frames[1]["message"]
    assert frames[2]["text"] == "still streaming"
