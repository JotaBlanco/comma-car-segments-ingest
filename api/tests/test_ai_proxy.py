# The SSE->NDJSON frame mapper. These tests feed known SSE lines to the pure
# `ai_proxy.sse_to_ndjson` core and assert the exact wire frames come out. No
# socket, no network — the orchestrator's session/stream wiring is tested in
# test_explore_chat_route.py against the stub Portal.

import json

from api.services import ai_proxy

SESSION = "sess-42"


def _frames(lines):
    """Parse the NDJSON strings the mapper yields back into dicts."""
    return [json.loads(line) for line in ai_proxy.sse_to_ndjson(lines, SESSION)]


def test_a_full_turn_maps_every_event_to_its_frame():
    lines = [
        "event: status",
        'data: {"status": "generating"}',
        "",
        "event: text_delta",
        'data: {"text": "Hello "}',
        "",
        "event: text_delta",
        'data: {"text": "world"}',
        "",
        "event: tool_call_start",
        'data: {"toolCallId": "t1", "toolName": "run_query", "displayName": "Query"}',
        "",
        "event: tool_call_delta",
        'data: {"toolCallId": "t1", "argumentsDelta": "{\\"sql\\":"}',
        "",
        "event: tool_call_end",
        'data: {"toolCallId": "t1"}',
        "",
        "event: tool_result",
        'data: {"toolCallId": "t1", "userSummary": "1 row", "isError": false}',
        "",
        "event: ask_user",
        'data: {"question": "Which run?"}',
        "",
        "data: [DONE]",
    ]
    assert _frames(lines) == [
        {"type": "status", "session_id": SESSION, "message": "generating"},
        {"type": "answer_delta", "session_id": SESSION, "text": "Hello "},
        {"type": "answer_delta", "session_id": SESSION, "text": "world"},
        {"type": "tool_start", "session_id": SESSION, "tool_call_id": "t1",
         "tool_name": "run_query", "display_name": "Query"},
        {"type": "tool_args", "session_id": SESSION, "tool_call_id": "t1",
         "delta": '{"sql":'},
        {"type": "tool_end", "session_id": SESSION, "tool_call_id": "t1"},
        {"type": "tool_result", "session_id": SESSION, "tool_call_id": "t1",
         "result": "1 row", "summary": "1 row", "is_error": False},
        {"type": "clarify", "session_id": SESSION, "question": "Which run?", "options": []},
        {"type": "done", "session_id": SESSION},
    ]


def test_every_content_frame_carries_the_session_id():
    lines = [
        "event: status",
        'data: {"status": "thinking"}',
        "",
        "event: text_delta",
        'data: {"text": "hi"}',
        "",
        "data: [DONE]",
    ]
    frames = _frames(lines)
    for frame in frames:
        # The `ping` frame is the only session-free one, and none appears here.
        assert frame["session_id"] == SESSION


def test_a_keepalive_comment_becomes_a_ping():
    lines = [
        ": keep-alive",
        "event: text_delta",
        'data: {"text": "hi"}',
        "",
        "data: [DONE]",
    ]
    assert _frames(lines) == [
        {"type": "ping"},
        {"type": "answer_delta", "session_id": SESSION, "text": "hi"},
        {"type": "done", "session_id": SESSION},
    ]


def test_an_error_event_mid_stream_yields_error_then_done_and_stops():
    lines = [
        "event: status",
        'data: {"status": "generating"}',
        "",
        "event: error",
        'data: {"message": "model exploded"}',
        "",
        # Anything after the error must never be emitted.
        "event: text_delta",
        'data: {"text": "unreachable"}',
        "",
        "data: [DONE]",
    ]
    assert _frames(lines) == [
        {"type": "status", "session_id": SESSION, "message": "generating"},
        {"type": "error", "session_id": SESSION, "message": "model exploded"},
        {"type": "done", "session_id": SESSION},
    ]


def test_a_bare_done_still_terminates_with_a_done_frame():
    assert _frames(["data: [DONE]"]) == [{"type": "done", "session_id": SESSION}]


def test_the_status_falls_back_to_message_for_older_fixtures():
    lines = ["event: status", 'data: {"message": "generating"}', "", "data: [DONE]"]
    assert _frames(lines)[0] == {
        "type": "status", "session_id": SESSION, "message": "generating"
    }


def test_unparsable_data_lines_are_dropped():
    lines = [
        "event: text_delta",
        "data: {not json}",
        "",
        "event: text_delta",
        'data: {"text": "ok"}',
        "",
        "data: [DONE]",
    ]
    assert _frames(lines) == [
        {"type": "answer_delta", "session_id": SESSION, "text": "ok"},
        {"type": "done", "session_id": SESSION},
    ]
