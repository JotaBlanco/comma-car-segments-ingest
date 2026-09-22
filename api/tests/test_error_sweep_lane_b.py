# B-18: the error-model sweep over every Lane B 4xx path.
#
# The contract gives every non-2xx response the same body (§A):
#   { "detail": "<human string>", "code": "<snake_case>", "errors": [] }
# `errors` carries the raw Pydantic list on 422 and is empty otherwise.
#
# This file owns one parametrised sweep. It hits every Lane B 4xx path and
# asserts the shape, the code and a friendly detail. A 422 detail must name
# the failing field. It must never be a raw Pydantic dump.

import pytest

from api.routers import results as results_router

HERO = "HV_Batt_Cell_Temp_Max"
MISSING_SIGNAL = "No_Such_Signal"
MISSING_RUN = "TAS-99999"
MISSING_FILE = "f-00000000-0000-0000-0000-000000000000"

PROVENANCE_KEYS = (
    "tool",
    "tool_version",
    "parameters",
    "input_file_ids",
    "produced_by",
    "produced_at",
)


def provenance(**overrides) -> dict:
    """A complete provenance block. Every key is present."""
    block = {
        "tool": "bat-post",
        "tool_version": "2.3.1",
        "parameters": "--cycles all --dt 0.1",
        "input_file_ids": [],
        "produced_by": "e.lindqvist",
        "produced_at": "2026-08-14T12:02:00Z",
    }
    block.update(overrides)
    return block


def result_body(**overrides) -> dict:
    """A valid POST /results body. Every sweep case starts from this shape."""
    body = {
        "run_id": "TAS-88214",
        "name": "thermal_summary_v1.parquet",
        "result_key": "thermal_summary",
        "description": "Cycle-level aggregates",
        "storage_ref": "blob://results/thermal_summary_v1.parquet",
        "provenance": provenance(),
    }
    body.update(overrides)
    return body


def file_body(**overrides) -> dict:
    """A valid POST /files body."""
    body = {
        "filename": "sweep_20260817_0900.mf4",
        "run_id": "TAS-88214",
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 1024,
        "checksum_sha256": "a" * 64,
        "checksum_state": "verified",
    }
    body.update(overrides)
    return body


def patch_body(**overrides) -> dict:
    """A valid PATCH /signals/{name} body."""
    body = {"unit": "K", "actor": "a.bergstrom"}
    body.update(overrides)
    return body


@pytest.fixture(autouse=True)
def stats_lake(stub_lake):
    """Answer the statistics from the stub lake. The sweep runs no real lake."""


@pytest.fixture
def sweep_db(seeded_db):
    """The seeded database with every index, routed into the app."""
    from api.db import ensure_indexes

    ensure_indexes(seeded_db)
    return seeded_db


# Each case is (id, method, path, request kwargs, status, code, detail token).
# The detail token is the string the message must name — the missing id, or
# the failing field.
CASES = [
    # --- 404 ---
    ("get_file_404", "GET", f"/api/v1/files/{MISSING_FILE}", {}, 404, "file_not_found", MISSING_FILE),
    (
        "delete_file_404",
        "DELETE",
        f"/api/v1/files/{MISSING_FILE}",
        {"json": {"actor": "a.bergstrom"}},
        404,
        "file_not_found",
        MISSING_FILE,
    ),
    (
        "archive_file_404",
        "POST",
        f"/api/v1/files/{MISSING_FILE}/archive",
        {"json": {"actor": "a.bergstrom"}},
        404,
        "file_not_found",
        MISSING_FILE,
    ),
    (
        "restore_file_404",
        "POST",
        f"/api/v1/files/{MISSING_FILE}/restore",
        {"json": {"actor": "a.bergstrom"}},
        404,
        "file_not_found",
        MISSING_FILE,
    ),
    ("get_signal_404", "GET", f"/api/v1/signals/{MISSING_SIGNAL}", {}, 404, "signal_not_found", MISSING_SIGNAL),
    (
        "get_signal_stats_404",
        "GET",
        f"/api/v1/signals/{MISSING_SIGNAL}/stats",
        {},
        404,
        "signal_not_found",
        MISSING_SIGNAL,
    ),
    (
        "patch_signal_404",
        "PATCH",
        f"/api/v1/signals/{MISSING_SIGNAL}",
        {"json": patch_body()},
        404,
        "signal_not_found",
        MISSING_SIGNAL,
    ),
    (
        "run_signals_404",
        "GET",
        f"/api/v1/test-runs/{MISSING_RUN}/signals",
        {},
        404,
        "run_not_found",
        MISSING_RUN,
    ),
    # --- 400 ---
    (
        "unsupported_window",
        "GET",
        f"/api/v1/signals/{HERO}/stats",
        {"params": {"window": "cycle"}},
        400,
        "unsupported_window",
        "cycle",
    ),
    (
        "no_fields_to_update",
        "PATCH",
        f"/api/v1/signals/{HERO}",
        {"json": {"actor": "a.bergstrom"}},
        400,
        "no_fields_to_update",
        "update",
    ),
    # --- 422: an unknown field on each write body ---
    (
        "post_files_unknown_field",
        "POST",
        "/api/v1/files",
        {"json": file_body(wrong_field=1)},
        422,
        "validation_error",
        "wrong_field",
    ),
    (
        "patch_signal_unknown_field",
        "PATCH",
        f"/api/v1/signals/{HERO}",
        {"json": patch_body(wrong_field=1)},
        422,
        "validation_error",
        "wrong_field",
    ),
    (
        "post_results_unknown_field",
        "POST",
        "/api/v1/results",
        {"json": result_body(wrong_field=1)},
        422,
        "validation_error",
        "wrong_field",
    ),
    (
        "patch_signal_catalogue_ref",
        "PATCH",
        f"/api/v1/signals/{HERO}",
        {"json": patch_body(catalogue_ref="TEMP-CELL-MAX")},
        422,
        "validation_error",
        "catalogue_ref",
    ),
    # --- 422: a missing required field on each write body ---
    (
        "post_files_missing_filename",
        "POST",
        "/api/v1/files",
        {"json": {key: value for key, value in file_body().items() if key != "filename"}},
        422,
        "validation_error",
        "filename",
    ),
    (
        "patch_signal_missing_actor",
        "PATCH",
        f"/api/v1/signals/{HERO}",
        {"json": {"unit": "K"}},
        422,
        "validation_error",
        "actor",
    ),
    (
        "post_results_missing_run_id",
        "POST",
        "/api/v1/results",
        {"json": {key: value for key, value in result_body().items() if key != "run_id"}},
        422,
        "validation_error",
        "run_id",
    ),
    # --- 422: the provenance gate ---
    (
        "post_results_no_provenance",
        "POST",
        "/api/v1/results",
        {"json": {key: value for key, value in result_body().items() if key != "provenance"}},
        422,
        "provenance_required",
        "provenance",
    ),
    # --- 422: a bad query parameter ---
    (
        "files_bad_page_size",
        "GET",
        "/api/v1/files",
        {"params": {"page_size": 7}},
        422,
        "validation_error",
        "page_size",
    ),
    (
        "signals_bad_page",
        "GET",
        "/api/v1/signals",
        {"params": {"page": 0}},
        422,
        "validation_error",
        "page",
    ),
    (
        "file_detail_bad_signals_limit",
        "GET",
        f"/api/v1/files/{MISSING_FILE}",
        {"params": {"signals_limit": 0}},
        422,
        "validation_error",
        "signals_limit",
    ),
    (
        "results_bad_page_size",
        "GET",
        "/api/v1/results",
        {"params": {"page_size": 7}},
        422,
        "validation_error",
        "page_size",
    ),
    (
        "run_signals_bad_page_size",
        "GET",
        f"/api/v1/test-runs/{MISSING_RUN}/signals",
        {"params": {"page_size": 7}},
        422,
        "validation_error",
        "page_size",
    ),
    (
        "signal_stats_bad_page_size",
        "GET",
        f"/api/v1/signals/{HERO}/stats",
        {"params": {"page_size": 7}},
        422,
        "validation_error",
        "page_size",
    ),
    (
        "files_bad_status_enum",
        "GET",
        "/api/v1/files",
        {"params": {"status": "deleted"}},
        422,
        "validation_error",
        "status",
    ),
    (
        "files_bad_source_system_enum",
        "GET",
        "/api/v1/files",
        {"params": {"source_system": "CANape"}},
        422,
        "validation_error",
        "source_system",
    ),
    (
        "files_bad_unlinked_bool",
        "GET",
        "/api/v1/files",
        {"params": {"unlinked": "maybe"}},
        422,
        "validation_error",
        "unlinked",
    ),
    (
        "signals_bad_rate_number",
        "GET",
        "/api/v1/signals",
        {"params": {"rate": "fast"}},
        422,
        "validation_error",
        "rate",
    ),
    (
        "signal_stats_bad_include_invalid",
        "GET",
        f"/api/v1/signals/{HERO}/stats",
        {"params": {"include_invalid": "maybe"}},
        422,
        "validation_error",
        "include_invalid",
    ),
    (
        "results_bad_latest_only",
        "GET",
        "/api/v1/results",
        {"params": {"latest_only": "maybe"}},
        422,
        "validation_error",
        "latest_only",
    ),
    # --- 422: a bad type or a bad enum inside a write body ---
    (
        "post_files_bad_size_bytes",
        "POST",
        "/api/v1/files",
        {"json": file_body(size_bytes="big")},
        422,
        "validation_error",
        "size_bytes",
    ),
    (
        "post_files_bad_checksum_state",
        "POST",
        "/api/v1/files",
        {"json": file_body(checksum_state="probably")},
        422,
        "validation_error",
        "checksum_state",
    ),
    (
        "post_files_nested_signal_unknown_field",
        "POST",
        "/api/v1/files",
        {
            "json": file_body(
                signals=[
                    {
                        "name": "Sweep_Signal",
                        "rate_hz": 10.0,
                        "dtype": "float64",
                        "wrong_field": 1,
                    }
                ]
            )
        },
        422,
        "validation_error",
        "wrong_field",
    ),
    (
        "post_files_nested_signal_missing_field",
        "POST",
        "/api/v1/files",
        {"json": file_body(signals=[{"name": "Sweep_Signal", "dtype": "float64"}])},
        422,
        "validation_error",
        "rate_hz",
    ),
    (
        "post_results_bad_provenance_type",
        "POST",
        "/api/v1/results",
        {"json": result_body(provenance="bat-post")},
        422,
        "provenance_required",
        "provenance",
    ),
    (
        "post_results_empty_body",
        "POST",
        "/api/v1/results",
        {"json": {}},
        422,
        "provenance_required",
        "provenance",
    ),
    (
        "post_files_empty_body",
        "POST",
        "/api/v1/files",
        {"json": {}},
        422,
        "validation_error",
        "filename",
    ),
    (
        "archive_file_empty_body",
        "POST",
        f"/api/v1/files/{MISSING_FILE}/archive",
        {"json": {}},
        422,
        "validation_error",
        "actor",
    ),
    # --- 405: a Lane B path that refuses the method ---
    (
        "delete_signal_405",
        "DELETE",
        f"/api/v1/signals/{HERO}",
        {},
        405,
        "method_not_allowed",
        "Method",
    ),
]


def assert_problem(response, status: int, code: str, token: str) -> None:
    """Assert the contract error body of §A on one response."""
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"detail", "code", "errors"}, body
    assert body["code"] == code, body
    assert isinstance(body["detail"], str) and body["detail"].strip(), body
    # A friendly detail names the thing that failed. It is never a raw
    # Pydantic dump, which starts with a list or a dict bracket.
    assert not body["detail"].startswith(("[", "{")), body
    assert token in body["detail"], body
    if status == 422 and code == "validation_error":
        # The contract keeps the raw Pydantic list on a 422.
        assert isinstance(body["errors"], list) and body["errors"], body
    else:
        assert body["errors"] == [], body


@pytest.mark.parametrize(
    ("method", "path", "kwargs", "status", "code", "token"),
    [case[1:] for case in CASES],
    ids=[case[0] for case in CASES],
)
def test_every_lane_b_4xx_returns_the_contract_problem_shape(
    client, sweep_db, method, path, kwargs, status, code, token
):
    assert_problem(client.request(method, path, **kwargs), status, code, token)


@pytest.mark.parametrize("key", PROVENANCE_KEYS)
def test_a_missing_provenance_key_names_that_key(client, sweep_db, key):
    # The gate is mandatory. Every one of the six keys answers the same way.
    block = {name: value for name, value in provenance().items() if name != key}
    response = client.post("/api/v1/results", json=result_body(provenance=block))

    assert_problem(response, 422, "provenance_required", f"provenance.{key}")


def test_a_contended_result_write_answers_409_version_conflict(
    client, sweep_db, monkeypatch
):
    # Hide the stored version from the route for good. The unique index on
    # (run_id, result_key, version) then catches every insert attempt.
    # The contended write answers 409 and never a 500 (contract §D).
    assert client.post("/api/v1/results", json=result_body()).status_code == 201
    monkeypatch.setattr(results_router, "_latest", lambda db, run, key: None)

    response = client.post("/api/v1/results", json=result_body(description="rerun"))

    assert_problem(response, 409, "version_conflict", "version")


# The B-18 sweep found this gap on 2026-08-17 and marked the test xfail.
# Lane B fixed it the same day: Provenance is a RequestModel now.
def test_an_unknown_key_inside_provenance_returns_422(client, sweep_db):
    block = provenance(wrong_field=1)
    response = client.post("/api/v1/results", json=result_body(provenance=block))

    assert_problem(response, 422, "validation_error", "wrong_field")


def signal_row(**overrides) -> dict:
    """One valid signal inventory row, with a full stats block."""
    row = {
        "name": "Sweep_Signal",
        "unit": "°C",
        "rate_hz": 10.0,
        "dtype": "float64",
        "stats": {"min": 18.2, "max": 47.9, "mean": 33.4, "std": 6.21},
    }
    row.update(overrides)
    return row


def test_an_unknown_key_inside_file_signal_stats_returns_422(client, sweep_db):
    # The stats block of a POST /files body is a request model. It forbids an
    # unknown key, the same as every other write body.
    stats = dict(signal_row()["stats"], wrong_field=1)
    body = file_body(signals=[signal_row(stats=stats)])

    response = client.post("/api/v1/files", json=body)

    assert_problem(response, 422, "validation_error", "wrong_field")


def test_an_unknown_key_on_a_file_signal_row_returns_422(client, sweep_db):
    # The outer row keeps its own gate. The stats fix must not weaken it.
    body = file_body(signals=[signal_row(wrong_field=1)])

    response = client.post("/api/v1/files", json=body)

    assert_problem(response, 422, "validation_error", "wrong_field")


# --- 503: the statistics provider is down (contract §A, #16) ---
#
# QuixLake serves the query routes. An unconfigured or unreachable lake used to
# answer 500 internal_error, which blames this service for a dependency. The
# contract settled it on 17 Aug 2026: 503 lake_unavailable, and the detail names
# the variable that configures the lake.
#
# CHANGED 21 Aug 2026. The run-signals list left this group. It reads the
# registry, so no lake state reaches it, and it holds a 200 in every case
# below. #16 is the route that asks, and it keeps every 503 it had.

LAKE_URL_VAR = "Quix__Lakehouse__Query__Url"

RUN_SIGNALS_PATH = "/api/v1/test-runs/TAS-88214/signals"

LAKE_STATS_PATHS = [
    ("signal_stats", f"/api/v1/signals/{HERO}/stats"),
]


@pytest.fixture
def unconfigured_lake(no_lake, monkeypatch):
    """Clear every lake variable. `no_lake` also puts the true client back."""
    monkeypatch.delenv("API_AUTH_TOKEN", raising=False)


def test_an_unconfigured_lake_answers_503_and_names_the_variable(
    client, sweep_db, unconfigured_lake
):
    # #16 only. It cannot prove its run list is complete without the lake, so
    # it still refuses. #7 lists the registry rows instead — see below.
    response = client.get(f"/api/v1/signals/{HERO}/stats")

    assert_problem(response, 503, "lake_unavailable", LAKE_URL_VAR)
    assert "not configured" in response.json()["detail"], response.text


def test_an_unconfigured_lake_still_lists_the_run_signals(
    client, sweep_db, unconfigured_lake
):
    # CHANGED 21 Aug 2026. #7 used to answer 503 here, and a person then lost
    # 261 registry rows because a variable was unset. The registry knows every
    # signal of a known run, and it holds the numbers the ingestion pipeline
    # measured, so the whole page survives with no lake at all.
    response = client.get(RUN_SIGNALS_PATH)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["items"], body
    assert body["total"] == len(body["items"]), body
    # The envelope names no lake variable. The blank numbers of this page are
    # a measurement state, and stating a configuration would be a wrong cause.
    assert LAKE_URL_VAR not in response.text, response.text
    reason = body["stats_unavailable"]
    if reason is not None:
        assert reason["reason"] in ("not_measured", "partly_measured"), body


def test_an_unreachable_lake_still_lists_the_run_signals(client, sweep_db, monkeypatch):
    # The other half of the same rule: a lake that IS configured and fails
    # never reaches this route either, so it cannot blank the page.
    from api.services import lake

    monkeypatch.setenv(LAKE_URL_VAR, "http://lake.internal.invalid:8080")
    monkeypatch.setenv("Quix__Sdk__Token", "token-not-a-secret")

    def refuse(sql, transport=None):
        raise lake.LakeError("QuixLake answered 502: lake.internal.invalid")

    monkeypatch.setattr(lake, "query", refuse)
    response = client.get(RUN_SIGNALS_PATH)

    assert response.status_code == 200, response.text
    assert response.json()["items"], response.text
    for leak in ("502", "lake.internal.invalid", "token-not-a-secret", "Traceback"):
        assert leak not in response.text, response.text


@pytest.mark.parametrize(
    "path", [path for _, path in LAKE_STATS_PATHS], ids=[name for name, _ in LAKE_STATS_PATHS]
)
def test_an_unreachable_lake_answers_503_and_leaks_no_exception_text(
    client, sweep_db, monkeypatch, path
):
    # The lake is configured and the call fails. The reader gets the same
    # status and the same code, and a detail that fits the other case.
    from api.services import lake

    monkeypatch.setenv(LAKE_URL_VAR, "http://lake.internal.invalid:8080")
    monkeypatch.setenv("Quix__Sdk__Token", "token-not-a-secret")

    def refuse(sql, transport=None):
        raise lake.LakeError("QuixLake answered 502: lake.internal.invalid token-not-a-secret")

    monkeypatch.setattr(lake, "query", refuse)
    response = client.get(path)

    assert_problem(response, 503, "lake_unavailable", LAKE_URL_VAR)
    detail = response.json()["detail"]
    assert "did not answer" in detail, detail
    # No exception text, no internal host, no token.
    for leak in ("502", "lake.internal.invalid", "token-not-a-secret", "Traceback"):
        assert leak not in response.text, response.text


@pytest.mark.parametrize(
    "path", [path for _, path in LAKE_STATS_PATHS], ids=[name for name, _ in LAKE_STATS_PATHS]
)
def test_a_refused_token_answers_503_and_names_the_token_variable(
    client, sweep_db, monkeypatch, path
):
    # The lake answers 403 when it rejects our credential. The status stays 503,
    # because the statistics still cannot be served. The detail changes: it
    # sends the operator to the token, not to the host.
    from api.services import lake

    monkeypatch.setenv(LAKE_URL_VAR, "http://lake.internal.invalid:8080")
    monkeypatch.setenv("Quix__Sdk__Token", "token-not-a-secret")

    def refuse(sql, transport=None):
        raise lake.LakeAuthError("QuixLake refused the token (403).")

    monkeypatch.setattr(lake, "query", refuse)
    response = client.get(path)

    assert_problem(response, 503, "lake_unavailable", lake.TOKEN_VAR)
    detail = response.json()["detail"]
    assert "refused" in detail, detail
    assert "did not answer" not in detail, detail
    for leak in ("403", "lake.internal.invalid", "token-not-a-secret", "Traceback"):
        assert leak not in response.text, response.text


LANE_B_ROUTES = [
    ("GET", "/api/v1/files"),
    ("GET", f"/api/v1/files/{MISSING_FILE}"),
    ("POST", "/api/v1/files"),
    ("GET", "/api/v1/signals"),
    ("GET", f"/api/v1/signals/{HERO}"),
    ("GET", f"/api/v1/signals/{HERO}/stats"),
    ("PATCH", f"/api/v1/signals/{HERO}"),
    ("GET", f"/api/v1/test-runs/{MISSING_RUN}/signals"),
    ("GET", "/api/v1/results"),
    ("POST", "/api/v1/results"),
]


@pytest.mark.parametrize(("method", "path"), LANE_B_ROUTES, ids=lambda value: str(value))
def test_every_lane_b_route_refuses_a_call_without_a_token(bare_client, method, path):
    # The token check runs before the route, so no seed is needed.
    assert_problem(bare_client.request(method, path), 401, "unauthorized", "token")


# --- the actor rule on the Lane B write body (contract A) ---
#
# The contract covers B #17, PATCH /signals/{name}. It names three refused
# cases: an empty actor, a whitespace-only actor and a placeholder name. These
# bodies used to answer 500, so the rule needs a test on this route.

PLACEHOLDER_ACTORS = ["current-user", "unknown", "system", "null", "none", "user"]
BLANK_ACTORS = ["", "   "]


@pytest.mark.parametrize("actor", BLANK_ACTORS + PLACEHOLDER_ACTORS + ["  Current-User  "])
def test_a_patch_actor_that_names_nobody_answers_422(client, sweep_db, actor):
    response = client.patch(f"/api/v1/signals/{HERO}", json=patch_body(actor=actor))

    assert_problem(response, 422, "validation_error", "actor")
    assert "must name a person or a service" in response.json()["detail"], response.text


def test_a_real_actor_still_passes_the_patch(client, sweep_db):
    # The guard must refuse a placeholder and never a real name.
    assert client.patch(f"/api/v1/signals/{HERO}", json=patch_body()).status_code == 200


# --- 500: an unexpected failure inside a Lane B route ---


def _blind_client(app):
    """A client that reads the 500 body instead of re-raising the exception."""
    from fastapi.testclient import TestClient

    from tests.conftest import TEST_TOKEN

    return TestClient(
        app,
        headers={"Authorization": f"Bearer {TEST_TOKEN}"},
        raise_server_exceptions=False,
    )


SECRETS = (
    "mongodb://tm:hunter2@mongo.internal:27017/tm",
    "mongo.internal",
    "hunter2",
    "Traceback",
    "RuntimeError",
)


def test_an_unexpected_failure_answers_500_and_leaks_nothing(app, sweep_db, monkeypatch):
    # A real crash inside the route, not a hand-made ApiError. The reader gets
    # the contract body and never the exception text, the host or the password.
    from api.services import queries_stats

    def crash(db, run_id, pagination):
        raise RuntimeError(
            "connect failed: mongodb://tm:hunter2@mongo.internal:27017/tm"
        )

    monkeypatch.setattr(queries_stats, "merge_run_signals", crash)
    with _blind_client(app) as blind:
        response = blind.get("/api/v1/test-runs/TAS-88214/signals")

    assert response.status_code == 500, response.text
    body = response.json()
    assert set(body) == {"detail", "code", "errors"}, body
    assert body["code"] == "internal_error", body
    assert body["errors"] == [], body
    assert isinstance(body["detail"], str) and body["detail"].strip(), body
    for leak in SECRETS:
        assert leak not in response.text, response.text


# --- 404 for an unknown path, 405 for a wrong method on a collection ---


def test_an_unknown_path_under_the_api_answers_the_contract_404(client):
    assert_problem(client.get("/api/v1/no-such-lane-b-route"), 404, "not_found", "Not Found")


# `PATCH /files/{file_id}` used to sit in this list. It is a real route since
# 19 Aug 2026: a person links an orphaned file to a run by hand. `PUT` takes its
# place, because no file route serves it.
WRONG_METHODS = [
    ("DELETE", "/api/v1/files"),
    ("PUT", "/api/v1/results"),
    ("POST", "/api/v1/signals"),
    ("PUT", f"/api/v1/files/{MISSING_FILE}"),
    ("POST", f"/api/v1/signals/{HERO}/stats"),
]


@pytest.mark.parametrize(("method", "path"), WRONG_METHODS, ids=lambda value: str(value))
def test_a_wrong_method_on_a_lane_b_path_answers_the_contract_405(client, method, path):
    assert_problem(client.request(method, path), 405, "method_not_allowed", "Method")
