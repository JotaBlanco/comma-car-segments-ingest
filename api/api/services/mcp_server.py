"""The MCP surface: the registry's read-only tools, served as JSON-RPC (U-2).

**What MCP is.** MCP (Model Context Protocol) is an open protocol that lets an
AI platform discover and call a product's tools over a standard wire format —
JSON-RPC 2.0 messages carrying three methods that matter here: ``initialize``
(handshake), ``tools/list`` (discovery) and ``tools/call`` (execution). The
Quix.AI platform registers this server against the ``test-manager-agent``, and
the agent then calls the same read-only whitelist the sidebar assistant uses.
Nothing about the tools changes: they remain the plain functions in
``assistant_tools.py``, executed in-process with a request db handle.

**Decision D-8 — hand-rolled, no new dependency.** The official ``mcp`` python
SDK exists, but our surface is three JSON-RPC methods over one POST endpoint;
the SDK would bring a session layer, an SSE stack and a new dependency to
review for that. Precedent: the lakehouse's flight service hand-rolled its
protocol for the same reason. This module implements the MCP *streamable HTTP*
transport subset of the 2025-03-26 spec: JSON responses only (no
server-initiated SSE stream — the spec permits answering GET with 405), single
requests and JSON-RPC batch arrays.

The transport (auth, HTTP statuses) lives in ``routers/mcp.py``. This module
is pure protocol: a JSON payload in, a JSON-RPC response (or None for
notifications) out.
"""

import json

from pymongo.database import Database

from api.services import assistant_tools

PROTOCOL_VERSION = "2025-03-26"

SERVER_INFO = {"name": "test-manager-registry", "version": "1.0.0"}

# JSON-RPC 2.0 error codes (spec §5.1).
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602

# The presenter tool, declared here but EXECUTED nowhere real: calling it over
# MCP returns a fixed acknowledgment. The Test Manager chat proxy watches the
# agent's tool_call stream for `present_answer` and hydrates hits and the deep
# link from Mongo server-side (AI-SIDEBAR §10, ticket U-4) — the model never
# authors card content or URLs, so this surface must not either.
PRESENT_ANSWER_TOOL = {
    "name": "present_answer",
    "description": (
        "Present the final answer; the Test Manager backend hydrates and "
        "renders it. Always call this last for registry questions."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "text": {"type": "string"},
            "hits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "run_id": {"type": "string"},
                        "journal_id": {"type": "string"},
                    },
                    "required": ["run_id"],
                },
            },
            "link": {
                "type": "object",
                "properties": {
                    "screen": {"type": "string"},
                    "params": {"type": "object"},
                },
                "required": ["screen"],
            },
            "chain_run_id": {"type": "string"},
        },
        "required": ["text"],
    },
}


def tool_declarations() -> list[dict]:
    """The MCP tool list, derived mechanically from the assistant registry.

    ``assistant_tools.TOOL_SCHEMAS`` already carries JSON Schema inputs
    (Anthropic's tool shape uses plain JSON Schema); MCP only spells the key
    ``inputSchema``. Deriving instead of copying means a tool added to the
    whitelist appears here on the next deploy, and a tool that is not in the
    whitelist cannot appear at all.
    """
    tools = [
        {
            "name": schema["name"],
            "description": schema["description"],
            "inputSchema": schema["input_schema"],
        }
        for schema in assistant_tools.TOOL_SCHEMAS
    ]
    tools.append(PRESENT_ANSWER_TOOL)
    return tools


def handle_payload(db: Database, payload) -> object | None:
    """Answer one decoded POST body: a single message or a JSON-RPC batch.

    Returns the response body — a dict, a list for a batch — or None when
    nothing needs answering (all notifications), which the router turns into
    202 with an empty body per the streamable HTTP spec.
    """
    if isinstance(payload, list):
        if not payload:
            # JSON-RPC 2.0 §6: an empty batch is invalid.
            return jsonrpc_error(None, INVALID_REQUEST, "empty batch")
        responses = [_handle_message(db, message) for message in payload]
        answered = [response for response in responses if response is not None]
        return answered or None
    return _handle_message(db, payload)


def _handle_message(db: Database, message) -> dict | None:
    """Answer one JSON-RPC message; None for a notification (never answered)."""
    if not _is_valid_request(message):
        return jsonrpc_error(_safe_id(message), INVALID_REQUEST, "not a JSON-RPC 2.0 request")

    method = message["method"]
    if "id" not in message:
        # A notification. JSON-RPC 2.0 §4.1: the server MUST NOT reply — not
        # even to say the method is unknown. `notifications/initialized` is the
        # only one MCP sends here, and it needs no action from us.
        return None

    request_id = message["id"]
    params = message.get("params")
    if params is not None and not isinstance(params, dict):
        return jsonrpc_error(request_id, INVALID_REQUEST, "params must be an object")

    if method == "initialize":
        return _result(request_id, _initialize_result())
    if method == "tools/list":
        return _result(request_id, {"tools": tool_declarations()})
    if method == "tools/call":
        return _tools_call(db, request_id, params or {})
    return jsonrpc_error(request_id, METHOD_NOT_FOUND, f"method {method!r} is not supported")


def _initialize_result() -> dict:
    # MCP spec, "Lifecycle": the server answers with the version it supports.
    # We accept any client protocolVersion and echo ours; a client that cannot
    # speak 2025-03-26 disconnects, which is the spec's negotiation.
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {"tools": {}},
        "serverInfo": SERVER_INFO,
    }


def _tools_call(db: Database, request_id, params: dict) -> dict:
    """Run one tool. Tool failures are RESULTS, not JSON-RPC errors.

    MCP spec, "Tools/Error Handling": a tool that cannot run reports
    ``isError: true`` inside a normal result, so the model can read the
    failure and try again. JSON-RPC errors stay reserved for requests the
    server cannot even interpret.
    """
    name = params.get("name")
    if not isinstance(name, str) or not name:
        return jsonrpc_error(request_id, INVALID_PARAMS, "params.name must be a string")
    arguments = params.get("arguments") or {}
    if not isinstance(arguments, dict):
        return jsonrpc_error(request_id, INVALID_PARAMS, "params.arguments must be an object")

    if name == PRESENT_ANSWER_TOOL["name"]:
        # The real rendering happens in the chat proxy (U-4); over MCP the
        # call only acknowledges, so the agent's loop can end cleanly.
        return _result(request_id, _tool_text("presented"))

    try:
        result = assistant_tools.run_tool(db, name, arguments)
    except Exception as error:  # noqa: BLE001 — every tool failure is a result
        return _result(request_id, _tool_text(str(error), is_error=True))
    return _result(request_id, _tool_text(json.dumps(result)))


def _tool_text(text: str, is_error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def _is_valid_request(message) -> bool:
    return (
        isinstance(message, dict)
        and message.get("jsonrpc") == "2.0"
        and isinstance(message.get("method"), str)
    )


def _safe_id(message):
    """The id to echo on an invalid request, when one can be read at all."""
    if isinstance(message, dict):
        request_id = message.get("id")
        if isinstance(request_id, str | int) or request_id is None:
            return request_id
    return None


def _result(request_id, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def jsonrpc_error(request_id, code: int, message: str) -> dict:
    """A JSON-RPC error body. Public: the router answers auth refusals with it."""
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}
