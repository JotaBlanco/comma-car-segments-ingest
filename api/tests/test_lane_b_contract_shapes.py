# Contract-shape guard for the ten Lane B routes (ticket B-19).
#
# The eight demo endpoints (#7, #12-#18) and the two star routes (POST /files,
# POST /results) answer here against real Mongo. The test seeds through the API
# wherever a write route exists, then walks the committed snapshot
# api/docs/openapi.v1.json and compares each body with the declared schema.
#
# The checker uses the standard library only. It reads the snapshot; it never
# writes it. A disagreement between the snapshot and the code is drift, and the
# owner of the route fixes the drift.
#
# #7 and #16 read QuixLake. This suite runs no lake, so it installs the stub
# lake of api/tests/conftest.py. api/tests/test_signal_stats.py covers the
# real lake path.

import json
import pathlib

import pytest

from api.db import ensure_indexes
from tests import factories

SNAPSHOT = json.loads(
    (pathlib.Path(__file__).parent.parent / "docs" / "openapi.v1.json").read_text(
        encoding="utf-8"
    )
)

API = "/api/v1"
RUN = "TAS-88214"
SIGNAL = "HV_Batt_Cell_Temp_Max"

_JSON_TYPES = {
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "array": list,
    "object": dict,
}


# --- the checker ---------------------------------------------------------


def _fail(where: str, message: str) -> None:
    raise AssertionError(f"{where}: {message}")


def _resolve(schema: dict) -> dict:
    """Follow every $ref and merge every allOf branch into one flat schema."""
    while "$ref" in schema:
        name = schema["$ref"].rsplit("/", 1)[-1]
        schema = SNAPSHOT["components"]["schemas"][name]
    if "allOf" not in schema:
        return schema
    flat = {key: value for key, value in schema.items() if key != "allOf"}
    for branch in schema["allOf"]:
        branch = _resolve(branch)
        flat["properties"] = {**branch.get("properties", {}), **flat.get("properties", {})}
        flat["required"] = list(flat.get("required", [])) + list(branch.get("required", []))
        for key in ("type", "additionalProperties", "items", "enum", "const"):
            if key in branch and key not in flat:
                flat[key] = branch[key]
    return flat


def _check_object(schema: dict, value: dict, where: str) -> None:
    """Check the keys of one object. The snapshot models forbid extra keys.

    A property outside the declared set fails. The one exception is a declared
    map: additionalProperties then holds the schema of every value.
    """
    properties = schema.get("properties", {})
    extra = schema.get("additionalProperties")
    for name in schema.get("required", []):
        if name not in value:
            _fail(where, f"the required property '{name}' is missing")
    for name, item in value.items():
        if name in properties:
            check(properties[name], item, f"{where}.{name}")
        elif isinstance(extra, dict):
            check(extra, item, f"{where}.{name}")
        else:
            _fail(where, f"the property '{name}' is not in the contract")


def check(schema: dict, value, where: str = "body") -> None:
    """Assert one value matches one snapshot schema. Raise on the first fault."""
    schema = _resolve(schema)

    if "anyOf" in schema:
        faults = []
        for index, branch in enumerate(schema["anyOf"]):
            try:
                check(branch, value, where)
                return
            except AssertionError as fault:
                faults.append(f"branch {index}: {fault}")
        _fail(where, "no anyOf branch matches. " + " ".join(faults))

    declared = schema.get("type")
    if declared == "null":
        if value is not None:
            _fail(where, f"expected null, got {type(value).__name__}")
        return
    if declared is not None:
        # A bool is an int in Python. The JSON types stay apart here.
        wrong_bool = isinstance(value, bool) and declared != "boolean"
        if not isinstance(value, _JSON_TYPES[declared]) or wrong_bool:
            _fail(where, f"expected {declared}, got {type(value).__name__}")

    if "enum" in schema and value not in schema["enum"]:
        _fail(where, f"{value!r} is outside the enum {schema['enum']}")
    if "const" in schema and value != schema["const"]:
        _fail(where, f"{value!r} is not the const {schema['const']!r}")

    if declared == "array":
        for index, item in enumerate(value):
            check(schema.get("items", {}), item, f"{where}[{index}]")
    elif declared == "object":
        _check_object(schema, value, where)


def success_schema(openapi_path: str, method: str, status: int) -> dict:
    """Read the success-response schema of one route out of the snapshot."""
    operation = SNAPSHOT["paths"][openapi_path][method]
    response = operation["responses"][str(status)]
    return response["content"]["application/json"]["schema"]


# --- the data ------------------------------------------------------------

FILE_BODY = {
    "filename": "bat_cyc_20260814_0941.mf4",
    "run_id": RUN,
    "source_system": "TAS",
    "format": "MDF 4.10",
    "size_bytes": 2048,
    "checksum_sha256": "a" * 64,
    "checksum_state": "verified",
    "storage_ref": "blob://test/bat_cyc_20260814_0941.mf4",
    "ingestion_job_id": "job-0417",
    "time_start": "2026-08-14T09:41:00Z",
    "time_end": "2026-08-14T10:12:00Z",
    "signals": [
        {
            "name": SIGNAL,
            "unit": "°C",
            "rate_hz": 10.0,
            "dtype": "float64",
            "stats": {"min": 21.4, "max": 58.9, "mean": 41.2, "std": 8.3},
        },
        # A null unit and a null stats block exercise both null branches.
        {"name": "Coolant_Inlet_Temp", "unit": None, "rate_hz": 1.0, "dtype": "float64"},
    ],
}

PATCH_BODY = {
    "description": "Highest cell temperature of the pack",
    "sensor_ref": "PT100-B4-07",
    "actor": "a.bergstrom",
    "context_run_id": RUN,
}


@pytest.fixture(autouse=True)
def stats_lake(stub_lake):
    """Answer the statistics from the stub lake. This suite runs no real lake."""


@pytest.fixture
def contract_db(routed_db):
    """The fresh per-test database, indexed and routed into the app."""
    ensure_indexes(routed_db)
    return routed_db


@pytest.fixture
def seed(client, contract_db):
    """Seed the run, then write through the API and keep the answers.

    Lane A owns the run document, so the factory writes it. Every Lane B
    record goes in through a Lane B route.
    """
    factories.upsert_run(contract_db)

    file_response = client.post(f"{API}/files", json=FILE_BODY)
    assert file_response.status_code == 201, file_response.text
    file_id = file_response.json()["file_id"]

    result_response = client.post(
        f"{API}/results",
        json={
            "run_id": RUN,
            "name": "thermal_summary_v1.parquet",
            "result_key": "thermal_summary",
            "description": "Cycle-level aggregates",
            "storage_ref": "blob://results/thermal_summary_v1.parquet",
            "provenance": {
                "tool": "bat-post",
                "tool_version": "2.3.1",
                "parameters": "--cycles all --dt 0.1",
                "input_file_ids": [file_id],
                "produced_by": "e.lindqvist",
                "produced_at": "2026-08-14T12:02:00Z",
            },
        },
    )
    assert result_response.status_code == 201, result_response.text

    patch_response = client.patch(f"{API}/signals/{SIGNAL}", json=PATCH_BODY)
    assert patch_response.status_code == 200, patch_response.text

    return {
        "file_id": file_id,
        "file_response": file_response,
        "result_response": result_response,
        "patch_response": patch_response,
    }


# --- the ten routes ------------------------------------------------------

CASES = [
    (
        "#7 GET /test-runs/{run_id}/signals",
        "/api/v1/test-runs/{run_id}/signals",
        "get",
        200,
        lambda client, seed: client.get(f"{API}/test-runs/{RUN}/signals"),
    ),
    (
        "#12 GET /files",
        "/api/v1/files",
        "get",
        200,
        lambda client, seed: client.get(f"{API}/files"),
    ),
    (
        "#13 GET /files/{file_id}",
        "/api/v1/files/{file_id}",
        "get",
        200,
        lambda client, seed: client.get(f"{API}/files/{seed['file_id']}"),
    ),
    (
        "#14 GET /signals",
        "/api/v1/signals",
        "get",
        200,
        lambda client, seed: client.get(f"{API}/signals"),
    ),
    (
        "#15 GET /signals/{name}",
        "/api/v1/signals/{name}",
        "get",
        200,
        lambda client, seed: client.get(f"{API}/signals/{SIGNAL}"),
    ),
    (
        "#16 GET /signals/{name}/stats?window=run",
        "/api/v1/signals/{name}/stats",
        "get",
        200,
        lambda client, seed: client.get(
            f"{API}/signals/{SIGNAL}/stats", params={"window": "run"}
        ),
    ),
    (
        "#17 PATCH /signals/{name}",
        "/api/v1/signals/{name}",
        "patch",
        200,
        lambda client, seed: seed["patch_response"],
    ),
    (
        "#18 GET /results",
        "/api/v1/results",
        "get",
        200,
        lambda client, seed: client.get(f"{API}/results"),
    ),
    (
        "star POST /files",
        "/api/v1/files",
        "post",
        201,
        lambda client, seed: seed["file_response"],
    ),
    (
        "star POST /results",
        "/api/v1/results",
        "post",
        201,
        lambda client, seed: seed["result_response"],
    ),
]


@pytest.mark.parametrize(
    ("openapi_path", "method", "status", "call"),
    [case[1:] for case in CASES],
    ids=[case[0] for case in CASES],
)
def test_the_route_answers_the_contract_shape(
    client, seed, openapi_path, method, status, call
):
    response = call(client, seed)

    assert response.status_code == status, response.text
    body = response.json()
    check(success_schema(openapi_path, method, status), body)
    if isinstance(body, dict) and "items" in body:
        # An empty page walks no row, so the shape check would prove nothing.
        assert body["items"], "the page holds no row, so the row shape stays unchecked"


def test_the_file_detail_carries_every_nested_block(client, seed):
    """The detail holds three blocks that no other route walks."""
    body = client.get(f"{API}/files/{seed['file_id']}").json()

    assert body["signals"], "no signal row, so FileSignal stays unchecked"
    assert body["ingestion_timeline"], "no journal row, so JournalEntry stays unchecked"
    assert body["field_sources"], "no field source, so FieldSource stays unchecked"


def test_the_checker_reports_a_missing_required_property():
    """The checker must bite. This proves the required rule fires."""
    schema = success_schema("/api/v1/files", "post", 201)
    body = dict(FILE_BODY)

    with pytest.raises(AssertionError, match="required property 'file_id' is missing"):
        check(schema, body)


def test_the_checker_reports_an_undeclared_property():
    """The checker must bite. This proves the closed-model rule fires."""
    schema = success_schema("/api/v1/signals/{name}/stats", "get", 200)
    body = {
        "name": SIGNAL,
        "unit": "°C",
        "window": "run",
        "items": [],
        "total": 0,
        "page": 1,
        "page_size": 50,
        "total_pages": 0,
        "stray": 1,
    }

    with pytest.raises(AssertionError, match="'stray' is not in the contract"):
        check(schema, body)


def test_the_checker_reports_a_wrong_type():
    """The checker must bite. This proves the type rule fires."""
    schema = success_schema("/api/v1/signals/{name}/stats", "get", 200)
    body = {
        "name": SIGNAL,
        "unit": "°C",
        "window": "run",
        "items": [],
        "total": "0",
        "page": 1,
        "page_size": 50,
        "total_pages": 0,
    }

    with pytest.raises(AssertionError, match=r"body\.total: expected integer, got str"):
        check(schema, body)
