# The MCP tool surface: tools/list mirrors the whitelist, tools/call runs it.
# Transport behavior (auth, framing, notifications) lives in test_mcp_surface.py.

import json

from api.services import assistant_tools
from tests.test_mcp_surface import mcp_enabled, post_mcp, rpc  # noqa: F401

# Every name the registry whitelists, plus the presenter. tools/list must be
# exactly this set: one extra name would widen the agent's reach.
EXPECTED_TOOLS = set(assistant_tools._REGISTRY) | {"present_answer"}

# Write-shaped names that must never appear (AI-SIDEBAR §5.2, "never weaken").
WRITE_WORDS = ("create", "update", "delete", "patch", "post", "upload", "write")


def call_tool(client, name, arguments=None, id=1):
    params = {"name": name, "arguments": arguments or {}}
    return post_mcp(client, rpc("tools/call", params, id=id))


def test_tools_list_is_the_whitelist_plus_present_answer(bare_client, mcp_enabled):  # noqa: F811
    response = post_mcp(bare_client, rpc("tools/list"))
    tools = response.json()["result"]["tools"]
    names = {tool["name"] for tool in tools}
    assert names == EXPECTED_TOOLS
    for tool in tools:
        assert tool["description"]
        assert tool["inputSchema"]["type"] == "object"
        for word in WRITE_WORDS:
            assert word not in tool["name"]


def test_present_answer_declaration_carries_the_presenter_schema(bare_client, mcp_enabled):  # noqa: F811
    tools = post_mcp(bare_client, rpc("tools/list")).json()["result"]["tools"]
    presenter = next(tool for tool in tools if tool["name"] == "present_answer")
    schema = presenter["inputSchema"]
    assert set(schema["properties"]) == {"text", "hits", "link", "chain_run_id"}
    assert schema["required"] == ["text"]
    assert schema["properties"]["hits"]["items"]["required"] == ["run_id"]
    assert schema["properties"]["link"]["required"] == ["screen"]


def test_tools_call_list_runs_returns_registry_data(bare_client, mcp_enabled, seeded_db):  # noqa: F811
    response = call_tool(bare_client, "list_runs", {"page_size": 10})
    result = response.json()["result"]
    assert result["isError"] is False
    (block,) = result["content"]
    assert block["type"] == "text"
    envelope = json.loads(block["text"])
    assert envelope["total"] == 128  # the seeded demo cast
    assert len(envelope["items"]) == 10
    assert envelope["items"][0]["_id"]  # the raw registry row, as the tool serves it


def test_tools_call_get_run_reads_the_hero_run(bare_client, mcp_enabled, seeded_db):  # noqa: F811
    response = call_tool(bare_client, "get_run", {"run_id": "TAS-88214"})
    result = response.json()["result"]
    assert result["isError"] is False
    run = json.loads(result["content"][0]["text"])
    assert run["_id"] == "TAS-88214"


def test_tools_call_present_answer_only_acknowledges(bare_client, mcp_enabled, routed_db):  # noqa: F811
    response = call_tool(bare_client, "present_answer", {"text": "the answer"})
    result = response.json()["result"]
    assert result == {
        "content": [{"type": "text", "text": "presented"}],
        "isError": False,
    }


def test_unknown_tool_is_an_error_result_not_a_rpc_error(bare_client, mcp_enabled, routed_db):  # noqa: F811
    response = call_tool(bare_client, "drop_database")
    body = response.json()
    assert "error" not in body  # per spec, a tool failure is a RESULT
    result = body["result"]
    assert result["isError"] is True
    assert "whitelist" in result["content"][0]["text"]


def test_tool_exception_is_an_error_result(bare_client, mcp_enabled, routed_db):  # noqa: F811
    # An empty database knows no run, so the tool raises; the caller must see
    # an isError result it can read, never a 500 or a JSON-RPC error.
    response = call_tool(bare_client, "get_run", {"run_id": "NO-SUCH-RUN"})
    result = response.json()["result"]
    assert result["isError"] is True
    assert result["content"][0]["text"]


def test_tools_call_without_a_name_answers_invalid_params(bare_client, mcp_enabled):  # noqa: F811
    response = post_mcp(bare_client, rpc("tools/call", {"arguments": {}}))
    assert response.json()["error"]["code"] == -32602


def test_batch_of_two_tool_calls_answers_both(bare_client, mcp_enabled, seeded_db):  # noqa: F811
    response = post_mcp(bare_client, [
        rpc("tools/call", {"name": "home_summary", "arguments": {}}, id=1),
        rpc("tools/call", {"name": "list_runs", "arguments": {"page_size": 5}}, id=2),
    ])
    body = response.json()
    assert isinstance(body, list) and len(body) == 2
    by_id = {answer["id"]: answer for answer in body}
    summary = json.loads(by_id[1]["result"]["content"][0]["text"])
    assert summary["counts"]["test_runs"] == 128
    runs = json.loads(by_id[2]["result"]["content"][0]["text"])
    assert len(runs["items"]) == 5
