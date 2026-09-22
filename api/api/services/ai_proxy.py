"""SSE->NDJSON chat proxy: the frame mapping plus the streaming orchestrator.

A port of the lakehouse ``chat_proxy.py``. It parses the Portal's SSE events and
yields one JSON object per line. The wire contract (every content frame carries
``session_id``) — both sides of the app must match this exactly:

    {"type":"status","session_id":S,"message":...}
    {"type":"answer_delta","session_id":S,"text":...}
    {"type":"tool_start","session_id":S,"tool_call_id":...,"tool_name":...,"display_name":...}
    {"type":"tool_args","session_id":S,"tool_call_id":...,"delta":...}
    {"type":"tool_end","session_id":S,"tool_call_id":...}
    {"type":"tool_result","session_id":S,"tool_call_id":...,"result":...,"summary":...,"is_error":bool}
    {"type":"clarify","session_id":S,"question":...,"options":[...]}
    {"type":"ping"}
    {"type":"error","session_id":S,"message":...}
    {"type":"done","session_id":S}

    This shape matches frontend/types/explore.ts (ExploreChatFrame) exactly,
    which itself mirrors the lakehouse chat_proxy vocabulary. Keep the two in
    step — the FE renders per-call tool cards keyed on ``tool_call_id``.

When a caller passes a ``presenter`` (the registry assistant does; the Explore
tab does not, and its stream is byte-identical without one), the agent's final
``present_answer`` tool call is INTERCEPTED: its raw tool_* frames are
suppressed and the presenter's server-hydrated frames take their place —
matching frontend/types/assistant.ts (AssistantFrame):

    {"type":"answer_delta","session_id":S,"text":...}
    {"type":"hits","session_id":S,"hits":[{"entity":"run","run_id":...,
        "status":...,"rig_id":...,"project":...,"first_data_at":...,
        "url":...,"reason":{"text":...,"actor":...,"at":...,"journal_id":...}|null}]}
    {"type":"chain","session_id":S,"nodes":[{"kind":...,"id":...,"label":...,"url":...|null}]}
    {"type":"deeplink","session_id":S,"label":...,"url":...}

The orchestrator never raises mid-stream: the HTTP status of the response is
already sent by the time the generator runs, so an upstream failure becomes an
``error`` frame followed by ``done``, never an exception the caller must catch.
"""

import json
import logging
from collections.abc import AsyncIterator, Callable, Iterable, Iterator

import httpx
from fastapi.concurrency import run_in_threadpool

from api.services import ai_client

logger = logging.getLogger(__name__)

# The agent tool whose call the presenter replaces. Named by AI-SIDEBAR §10:
# the model's final call carries only ids and a link proposal; the presenter
# hydrates the frames the user actually sees.
PRESENT_TOOL = "present_answer"


def _ndjson(obj: dict) -> str:
    return json.dumps(obj) + "\n"


def _error_frame(session_id: str | None, message: str) -> dict:
    return {"type": "error", "session_id": session_id, "message": message}


def _done_frame(session_id: str | None) -> dict:
    return {"type": "done", "session_id": session_id}


class _SseParser:
    """Line-at-a-time SSE state machine, shared by the sync and async paths.

    ``feed`` maps one SSE line to at most one event dict. A leading ':' is a
    Portal keepalive comment and yields a ``heartbeat`` sentinel. ``[DONE]`` or
    an ``event: done`` sets ``done`` so the caller stops.
    """

    def __init__(self) -> None:
        self._type = ""
        self.done = False

    def feed(self, line: str) -> dict | None:
        if line.startswith(":"):
            return {"type": "heartbeat"}
        if line.startswith("event: "):
            self._type = line[7:].strip()
            return None
        if not line.startswith("data: "):
            return None
        payload = line[6:]
        if payload == "[DONE]" or self._type == "done":
            self.done = True
            return None
        try:
            evt = json.loads(payload)
        except json.JSONDecodeError:
            return None
        if self._type:
            evt["type"] = self._type
        self._type = ""
        return evt


def map_event(evt: dict, session_id: str) -> dict | None:
    """Map one upstream SSE event to a wire frame; None drops it."""
    t = evt.get("type")
    if t == "text_delta":
        return {"type": "answer_delta", "session_id": session_id,
                "text": evt.get("text", "")}
    if t == "status":
        # Real Portal puts the value in `status`; older stub fixtures use `message`.
        return {"type": "status", "session_id": session_id,
                "message": evt.get("status") or evt.get("message", "")}
    if t == "tool_call_start":
        return {"type": "tool_start", "session_id": session_id,
                "tool_call_id": evt.get("toolCallId"),
                "tool_name": evt.get("toolName"),
                "display_name": evt.get("displayName")}
    if t == "tool_call_delta":
        return {"type": "tool_args", "session_id": session_id,
                "tool_call_id": evt.get("toolCallId"),
                "delta": evt.get("argumentsDelta", "")}
    if t == "tool_call_end":
        return {"type": "tool_end", "session_id": session_id,
                "tool_call_id": evt.get("toolCallId")}
    if t == "tool_result":
        return {"type": "tool_result", "session_id": session_id,
                "tool_call_id": evt.get("toolCallId"),
                "result": evt.get("result") or evt.get("userSummary"),
                "summary": evt.get("userSummary"),
                "is_error": bool(evt.get("isError", False))}
    if t == "ask_user":
        return {"type": "clarify", "session_id": session_id,
                "question": evt.get("question", ""),
                "options": evt.get("options") or []}
    return None


def _event_frames(evt: dict, session_id: str) -> tuple[list[str], bool]:
    """Render one parsed event to NDJSON lines and say whether to stop.

    Stops after an ``error`` event, emitting the error frame then ``done`` — the
    same shape the orchestrator emits when the transport itself fails.
    """
    t = evt.get("type")
    if t == "heartbeat":
        return [_ndjson({"type": "ping"})], False
    if t == "error":
        message = evt.get("message") or f"upstream {evt.get('status') or 'error'}"
        return [_ndjson(_error_frame(session_id, message)),
                _ndjson(_done_frame(session_id))], True
    frame = map_event(evt, session_id)
    return ([_ndjson(frame)] if frame is not None else []), False


def sse_to_ndjson(lines: Iterable[str], session_id: str) -> Iterator[str]:
    """Map raw SSE lines to NDJSON frame strings, terminating in ``done``.

    This is the pure, socket-free core the orchestrator wraps and the tests
    pin. An ``error`` event mid-stream yields ``error`` then ``done`` and stops.
    """
    parser = _SseParser()
    for line in lines:
        evt = parser.feed(line)
        if parser.done:
            break
        if evt is None:
            continue
        out, stop = _event_frames(evt, session_id)
        yield from out
        if stop:
            return
    yield _ndjson(_done_frame(session_id))


class _PresenterInterceptor:
    """Swallow the ``present_answer`` call; yield the presenter's frames instead.

    The trust design (AI-SIDEBAR §10): the model's final tool call proposes
    ids, never card content, so its raw tool_start/args/end/result frames must
    never reach the FE — the presenter re-fetches everything from the db and
    its frames take the call's place at the ``tool_result`` moment. Arguments
    stream as deltas, so they are accumulated per ``toolCallId``. Malformed
    arguments become an ``error`` frame naming the parse failure and the
    stream carries on — the never-raise discipline holds here too.
    """

    def __init__(self, presenter: Callable[[dict], list[dict]]) -> None:
        self._presenter = presenter
        self._args: dict[str, list[str]] = {}
        # True once presenter frames were emitted. Any model prose that
        # for it so it never glues onto the presented text ("invalid.Anything").
        self.presented = False

    async def intercept(self, evt: dict, session_id: str) -> list[str] | None:
        """Replacement NDJSON lines for one event, or None to pass it through.

        Async because the presenter is a plain function over blocking pymongo.
        It runs in the threadpool, so one Mongo round trip never freezes the
        event loop and the other requests on the server keep answering.
        """
        call_id = evt.get("toolCallId")
        evt_type = evt.get("type")
        # The platform namespaces MCP tools as ``mcp__<server>__<name>``
        # (measured 20 Aug 2026: ``mcp__test-manager-registry__present_answer``),
        # so match the bare name or any namespaced suffix.
        tool_name = evt.get("toolName") or ""
        is_present = tool_name == PRESENT_TOOL or tool_name.endswith(f"__{PRESENT_TOOL}")
        if evt_type == "tool_call_start" and is_present:
            self._args[call_id] = []
            return []
        if call_id not in self._args:
            return None  # not a present_answer call — pass through untouched
        if evt_type == "tool_call_delta":
            self._args[call_id].append(evt.get("argumentsDelta", ""))
            return []
        if evt_type == "tool_call_end":
            return []
        if evt_type == "tool_result":
            raw = "".join(self._args.pop(call_id))
            try:
                args = json.loads(raw) if raw.strip() else {}
            except ValueError as error:
                return [_ndjson(_error_frame(
                    session_id, f"present_answer arguments unreadable: {error}"
                ))]
            if not isinstance(args, dict):
                return [_ndjson(_error_frame(
                    session_id,
                    "present_answer arguments unreadable: not a JSON object",
                ))]
            try:
                frames = await run_in_threadpool(self._presenter, args)
            except Exception:
                logger.exception("Presenter failed (session=%s)", session_id)
                return [_ndjson(_error_frame(session_id, "presenting the answer failed"))]
            self.presented = True
            return [_ndjson({**frame, "session_id": session_id}) for frame in frames]
        return None


async def chat_stream(
    portal_token: str,
    run_id: str,
    message: str,
    session_id: str | None,
    context: dict,
    *,
    presenter: Callable[[dict], list[dict]] | None = None,
) -> AsyncIterator[str]:
    """Yield NDJSON frames for one chat turn. Never raises to the caller.

    Opens a session when none is supplied, streams the message, and maps every
    upstream SSE event to a wire frame. ``run_id`` is carried for logging only;
    the run scope rides in ``context``. ``presenter``, when given, replaces the
    agent's ``present_answer`` tool call with server-hydrated frames (see the
    module docstring); without one the stream is unchanged.
    """
    if not ai_client.portal_base():
        yield _ndjson(_error_frame(session_id, "Portal API is not configured."))
        yield _ndjson(_done_frame(session_id))
        return

    if not session_id:
        try:
            agent_id = await ai_client.resolve_agent_id(portal_token)
            session_id = await ai_client.create_session(portal_token, agent_id)
        except httpx.HTTPError:
            logger.exception("Could not open Quix.AI session (run=%s)", run_id)
            yield _ndjson(_error_frame(None, "Could not open Quix.AI session."))
            yield _ndjson(_done_frame(None))
            return
        # Bind the registry MCP tools to the fresh session (measured 20 Aug
        # 2026: org-level registration alone attaches nothing — binding is
        # per-session). Failure degrades to a toolless chat, never an error.
        await ai_client.register_session_mcp(portal_token, session_id)

    # The key is ``message``, never ``text``: the module docstring above, the
    # contract (§ Explore chat) and frontend/types/explore.ts all say so, and
    # ``map_event`` already sends ``message`` for every later status frame.
    yield _ndjson({"type": "status", "session_id": session_id, "message": "generating"})

    interceptor = _PresenterInterceptor(presenter) if presenter is not None else None
    parser = _SseParser()
    try:
        async for line in ai_client.stream_message(
            portal_token, session_id, message, context
        ):
            evt = parser.feed(line)
            if parser.done:
                break
            if evt is None:
                continue
            if interceptor is not None:
                replaced = await interceptor.intercept(evt, session_id)
                if replaced is not None:
                    for frame in replaced:
                        yield frame
                    continue
                # present_answer IS the reply (AI-SIDEBAR §10). Models
                # restate it in prose anyway, so the duplicate is suppressed
                # mechanically: after the presented frames, further text
                # deltas in this turn are dropped.
                if interceptor.presented and evt.get("type") == "text_delta":
                    continue
            out, stop = _event_frames(evt, session_id)
            for frame in out:
                yield frame
            if stop:
                return
    except ai_client.UpstreamError as error:
        yield _ndjson(_error_frame(session_id, f"upstream {error.status}"))
        yield _ndjson(_done_frame(session_id))
        return
    except httpx.HTTPError as error:
        logger.exception("Upstream stream failed (session=%s)", session_id)
        yield _ndjson(_error_frame(session_id, f"Stream failed: {type(error).__name__}"))
        yield _ndjson(_done_frame(session_id))
        return

    yield _ndjson(_done_frame(session_id))
