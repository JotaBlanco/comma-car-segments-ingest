"""In-process stub of the Portal /ai/api surface for Ask-AI chat tests.

A TEST DOUBLE only. It mirrors the lakehouse ``test/stub_portal.py`` shape,
ported to FastAPI so a test can drive it in-process through
``httpx.ASGITransport`` (no socket, no live Quix.AI). It exposes the three
endpoints ``ai_client`` calls and streams a canned SSE answer about the run.

Never point production at this. It authenticates nothing and answers a fixed
reply — it exists so the Ask-AI pipe is buildable and demoable offline.
"""

import json

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

# The agent name the stub advertises. It matches ``ai_client``'s default so a
# test exercises the agent-resolution path and gets a non-null id.
STUB_AGENT_NAME = "test-manager-agent"
STUB_SESSION_ID = "stub-session"


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def build_app() -> FastAPI:
    app = FastAPI()

    @app.get("/ai/api/org/agents")
    def agents() -> list[dict]:
        return [{"id": "stub-agent-1", "name": STUB_AGENT_NAME, "isEnabled": True}]

    @app.post("/ai/api/sessions")
    def create_session() -> dict:
        return {"id": STUB_SESSION_ID}

    @app.post("/ai/api/sessions/{session_id}/messages")
    async def messages(session_id: str, request: Request) -> StreamingResponse:
        body = await request.json()
        context = body.get("context") or {}
        signal_count = context.get("signal_count", 0)

        async def stream():
            yield _sse("status", {"status": "generating"})
            yield _sse("text_delta", {"text": "Looking at this run. "})
            yield _sse(
                "text_delta",
                {"text": f"It carries {signal_count} signal(s). "},
            )
            yield _sse("text_delta", {"text": "The data looks healthy."})
            yield "data: [DONE]\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream")

    return app
