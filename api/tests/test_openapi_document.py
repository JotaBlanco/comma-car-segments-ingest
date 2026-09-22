"""The OpenAPI document must describe the code, never a friendlier version.

`/docs` is open in every environment (§A), so a reader outside the team reads
this document and believes it. These tests hold four lines:

* every error the customisation declares is an error the code really raises,
* every route that needs a bearer token says so,
* the three allow-lists in the document are the three the routes enforce,
* a route that streams says which bytes it streams.

`api/main.py` holds the customisation itself.
"""

import ast
import pathlib

import pytest

from api.main import AUTH_ERRORS, REPLAY_200_ROUTES, ROUTE_ERRORS, STREAMING_MEDIA_TYPES

SOURCE_ROOT = pathlib.Path(__file__).parent.parent / "api"

ERROR_REF = {"$ref": "#/components/schemas/ErrorResponse"}
VALIDATION_ERROR_REF = {"$ref": "#/components/schemas/ValidationErrorResponse"}


def _source_facts() -> tuple[set[tuple[int, str]], set[int], set[str]]:
    """Read three sets out of the source: the literal `ApiError` pairs, every
    status it raises, and every string the source holds.

    A few raises build the code in a variable — the file lifecycle 409 picks
    `file_deleted` or `file_archived`, and the link 422 reads a map. The pair
    is real and the syntax tree cannot pair it, so the code string and the
    status are checked apart for those.
    """
    pairs: set[tuple[int, str]] = set()
    statuses: set[int] = set()
    strings: set[str] = set()
    for path in SOURCE_ROOT.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                strings.add(node.value)
            if not isinstance(node, ast.Call):
                continue
            called = node.func
            name = called.id if isinstance(called, ast.Name) else None
            if name != "ApiError" or not node.args:
                continue
            status = node.args[0]
            if not isinstance(status, ast.Constant):
                continue
            statuses.add(status.value)
            code = node.args[2] if len(node.args) >= 3 else None
            if isinstance(code, ast.Constant):
                pairs.add((status.value, code.value))
    return pairs, statuses, strings


def _operations(schema: dict):
    for path, methods in schema["paths"].items():
        for method, operation in methods.items():
            yield f"{method.upper()} {path}", operation


@pytest.fixture(scope="module")
def schema(app) -> dict:
    return app.openapi()


def test_every_declared_error_is_an_error_the_code_raises():
    # A code nobody raises is a promise the API cannot keep, so a rename in a
    # router must break this test.
    pairs, statuses, strings = _source_facts()
    declared = {pair for values in ROUTE_ERRORS.values() for pair in values}
    declared |= set(AUTH_ERRORS)
    unpaired = declared - pairs
    assert {status for status, _ in declared} <= statuses
    assert {code for _, code in unpaired} <= strings


def test_every_declared_route_exists(schema):
    keys = {key for key, _ in _operations(schema)}
    assert set(ROUTE_ERRORS) <= keys
    assert set(REPLAY_200_ROUTES) <= keys
    assert set(STREAMING_MEDIA_TYPES) <= keys


def test_every_api_route_declares_the_bearer_refusal(schema):
    for key, operation in _operations(schema):
        if not key.split(" ")[1].startswith("/api/v1/"):
            continue
        assert "401" in operation["responses"], key
        content = operation["responses"]["401"]["content"]
        assert content["application/json"]["schema"] == ERROR_REF, key


def test_mcp_declares_its_own_bearer_scheme(schema):
    # Without this a generated client sends no token and every call gets 401.
    operation = schema["paths"]["/mcp"]["post"]
    assert operation["security"] == [{"HTTPBearer": []}]
    assert {"202", "401", "403"} <= set(operation["responses"])


def test_the_error_body_replaces_the_default_validation_schema(schema):
    # The app never sends FastAPI's `HTTPValidationError`. It sends
    # `{detail, code, errors}` (api/errors.py).
    assert "HTTPValidationError" not in schema["components"]["schemas"]
    for key, operation in _operations(schema):
        response = operation["responses"].get("422")
        if response is None:
            continue
        assert response["content"]["application/json"]["schema"] == VALIDATION_ERROR_REF, key


def test_a_streaming_route_names_the_bytes_it_streams(schema):
    for key, media_type in STREAMING_MEDIA_TYPES.items():
        method, path = key.split(" ")
        content = schema["paths"][path][method.lower()]["responses"]["200"]["content"]
        assert list(content) == [media_type], key


def test_a_replay_write_declares_both_of_its_statuses(schema):
    for key in REPLAY_200_ROUTES:
        method, path = key.split(" ")
        responses = schema["paths"][path][method.lower()]["responses"]
        assert responses["200"]["content"] == responses["201"]["content"], key


@pytest.mark.parametrize(
    "path,expected",
    [
        ("/api/v1/test-runs", ["first_data_at"]),
        ("/api/v1/files", ["registered_at", "size_bytes"]),
        ("/api/v1/signals", ["name", "typical_rate_hz", "run_count", "last_seen"]),
    ],
)
def test_the_document_states_the_sort_allow_list(schema, path, expected):
    parameters = {p["name"]: p for p in schema["paths"][path]["get"]["parameters"]}
    assert parameters["sort"]["schema"]["anyOf"][0]["enum"] == expected
    assert parameters["order"]["schema"]["anyOf"][0]["enum"] == ["asc", "desc"]


@pytest.mark.parametrize(
    "path", ["/api/v1/test-runs", "/api/v1/files", "/api/v1/signals"]
)
def test_the_stated_sort_values_are_the_values_the_route_takes(
    client, seeded_db, schema, path
):
    # The document and the router must never state two different allow-lists.
    parameters = {p["name"]: p for p in schema["paths"][path]["get"]["parameters"]}
    for value in parameters["sort"]["schema"]["anyOf"][0]["enum"]:
        assert client.get(path, params={"sort": value}).status_code == 200, value
    assert client.get(path, params={"sort": "no_such_field"}).status_code == 422


def test_the_page_size_allow_list_is_the_one_the_route_takes(client, seeded_db, schema):
    parameters = {
        p["name"]: p for p in schema["paths"]["/api/v1/files"]["get"]["parameters"]
    }
    allowed = parameters["page_size"]["schema"]["enum"]
    for value in allowed:
        assert client.get("/api/v1/files", params={"page_size": value}).status_code == 200
    assert 25 not in allowed
    assert client.get("/api/v1/files", params={"page_size": 25}).status_code == 422


def test_work_orders_says_it_takes_no_sort(client, seeded_db, schema):
    parameters = {
        p["name"]: p for p in schema["paths"]["/api/v1/work-orders"]["get"]["parameters"]
    }
    for name in ("sort", "order"):
        assert "Not accepted" in parameters[name]["description"]
        assert (
            client.get("/api/v1/work-orders", params={name: "anything"}).status_code
            == 422
        )
