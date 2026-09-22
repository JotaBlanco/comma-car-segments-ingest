"""POST /mcp: the MCP streamable HTTP endpoint for the Quix.AI platform (U-2).

This route lives OUTSIDE /api/v1 on purpose: the platform's agent runner is a
service, not a Portal user, so it authenticates with the workspace's
platform-injected ``Quix__Sdk__Token`` — and never with the registry bearer
token. On-platform the token is always injected; off-platform it is absent
and every call answers 403, the same off-platform shape as the assistant.

The protocol lives in ``services/mcp_server.py``; this router owns only the
transport — auth, JSON decoding and HTTP statuses:

- 403 while ``Quix__Sdk__Token`` is absent (surface disabled).
- 401 for a missing or wrong bearer token (constant-time compare).
- 202 with an empty body for notifications (they are never answered).
- 200 application/json otherwise — including JSON-RPC *error* bodies, which
  are answers, not transport failures. No SSE mode: this server never opens a
  server-initiated stream, so GET /mcp answers 405, which the 2025-03-26 spec
  permits ("MUST return 405 Method Not Allowed" when SSE is not offered).

The route is `async` because it awaits the raw request body, and the protocol
handler under it is synchronous and blocking. So the handler runs in the
threadpool. Never call it inline: one Mongo round trip would freeze every
other request on the server until Mongo answers.
"""

import json
import os
import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pymongo.database import Database

from api.db import get_db
from api.services import mcp_server

router = APIRouter(tags=["mcp"])

# Implementation-defined JSON-RPC error codes (-32000..-32099 is the server
# range the spec reserves for us). The HTTP status carries the real signal;
# these keep the body a valid JSON-RPC error for MCP clients that read it.
_AUTH_ERROR = -32001


@router.post(
    "/mcp",
    # The endpoint speaks JSON-RPC, not the /api/v1 contract; the snapshot
    # should say only that it answers JSON.
    responses={200: {"content": {"application/json": {}}}},
)
async def mcp_endpoint(
    request: Request, db: Annotated[Database, Depends(get_db)]
) -> Response:
    """Answer one MCP POST: a JSON-RPC message or batch, JSON response only."""
    refusal = _authorize(request.headers.get("authorization"))
    if refusal is not None:
        return refusal

    try:
        payload = json.loads(await request.body())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse(
            mcp_server.jsonrpc_error(None, mcp_server.PARSE_ERROR, "body is not valid JSON")
        )

    # `handle_payload` runs blocking pymongo (`assistant_tools.py`). This route
    # is `async`, so calling it inline would hold the event loop for the whole
    # Mongo round trip and every other request would wait behind one tool call.
    # The threadpool is where FastAPI runs a plain `def` route; the answer, the
    # status and the body are identical either way.
    answer = await run_in_threadpool(mcp_server.handle_payload, db, payload)
    if answer is None:
        # Notifications only. Streamable HTTP spec: accept with 202, no body.
        return Response(status_code=202)
    return JSONResponse(answer)


def _expected_token() -> str:
    """The bearer the platform must present: the workspace's
    platform-injected ``Quix__Sdk__Token``.

    The same trick the platform's own services use (the lakehouse API
    authenticates with the SDK token the same way): every deployment receives
    ``Quix__Sdk__Token`` automatically, so a workspace needs no hand-set
    secret for its own MCP registration — the registration simply stores the
    workspace token. Absent (off-platform) -> surface disabled.
    """
    return os.environ.get("Quix__Sdk__Token", "").strip()


def _authorize(header: str | None) -> JSONResponse | None:
    """Refuse the call unless it carries the MCP bearer token; None to admit.

    The refusal body is a JSON-RPC error so an MCP client can read it, but the
    HTTP status (403 disabled / 401 refused) is the contract.
    """
    expected = _expected_token()
    if not expected:
        return JSONResponse(
            mcp_server.jsonrpc_error(None, _AUTH_ERROR, "mcp surface disabled"),
            status_code=403,
        )
    scheme, _, token = (header or "").partition(" ")
    if scheme.lower() != "bearer" or not _matches(token.strip(), expected):
        return JSONResponse(
            mcp_server.jsonrpc_error(None, _AUTH_ERROR, "invalid or missing token"),
            status_code=401,
        )
    return None


def _matches(token: str, expected: str) -> bool:
    """Constant-time compare, the api/auth.py pattern.

    `secrets.compare_digest` raises on non-ASCII input; a caller may send
    anything, so that must read as "wrong token", never as a 500.
    """
    try:
        return secrets.compare_digest(token, expected)
    except TypeError:
        return False
