# The error model is real logic. These tests came before the implementation.

import pytest

from tests import factories_results
from tests.factories_results import RESULTS, provenance, result_body

# The assignment re-exports the fixture without shadowing an import.
results_db = factories_results.results_db

# An actor that names nobody. The contract answers 422, never 500.
# "Quix user" is the portal client's last-resort display name, so a browser
# can send it without anybody typing it.
NO_ONE = ["", "   ", "current-user", "Quix user"]
# A placeholder alone. A blank never reaches the check on POST /results.
# The last two prove the check strips the value and ignores the case.
PLACEHOLDERS = ["current-user", "unknown", "system", "  USER  ", "  QUIX USER  "]


def test_404_body_matches_the_contract(client, routed_db):
    response = client.get("/api/v1/test-runs/TAS-99999")
    assert response.status_code == 404
    assert response.json() == {
        "detail": "Run TAS-99999 not found",
        "code": "run_not_found",
        "errors": [],
    }


def test_unknown_path_returns_the_error_shape(client):
    response = client.get("/api/v1/no-such-route")
    assert response.status_code == 404
    body = response.json()
    assert set(body) == {"detail", "code", "errors"}
    assert body["code"] == "not_found"


def test_422_carries_the_pydantic_errors_list(client):
    # actor is required on the PATCH body.
    response = client.patch("/api/v1/test-runs/TAS-88214", json={"operator": "A. B"})
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert "actor" in body["detail"]
    assert isinstance(body["errors"], list) and body["errors"]


def test_unknown_field_on_a_write_body_returns_422(client):
    # Contract v1.1: a write body rejects an unknown field.
    response = client.patch(
        "/api/v1/test-runs/TAS-88214",
        json={"operator": "A. B", "actor": "a.bergstrom", "wrong_field": 1},
    )
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert "wrong_field" in body["detail"]
    # The detail is a friendly string, never a raw Pydantic dump.
    assert isinstance(body["detail"], str)
    assert not body["detail"].startswith("[")


def test_catalogue_ref_in_a_patch_body_returns_422(client):
    # catalogue_ref is not a field of SignalPatchRequest, so it is unknown.
    response = client.patch(
        "/api/v1/signals/HV_Batt_Cell_Temp_Max",
        json={"unit": "°C", "actor": "a.bergstrom", "catalogue_ref": "X"},
    )
    assert response.status_code == 422
    assert "catalogue_ref" in response.json()["detail"]


def test_400_unsupported_window(client):
    response = client.get(
        "/api/v1/signals/HV_Batt_Cell_Temp_Max/stats", params={"window": "cycle"}
    )
    assert response.status_code == 400
    body = response.json()
    assert body["code"] == "unsupported_window"
    assert body["errors"] == []


def test_unhandled_error_returns_the_contract_500_body():
    # The contract gives every non-2xx response the same body shape.
    # A crash must not fall through to the framework's plain-text page,
    # and it must not leak the exception text.
    from fastapi.testclient import TestClient

    from api.main import create_app

    app = create_app()

    @app.get("/boom")
    def boom():
        raise RuntimeError("private details")

    with TestClient(app, raise_server_exceptions=False) as bare:
        response = bare.get("/boom")
    assert response.status_code == 500
    assert response.json() == {
        "detail": "internal error",
        "code": "internal_error",
        "errors": [],
    }
    assert "private details" not in response.text


def test_422_reason_required_on_empty_reason(client):
    response = client.post(
        "/api/v1/test-runs/TAS-88214/invalid-flag",
        json={"reason": "   ", "actor": "e.lindqvist"},
    )
    assert response.status_code == 422
    assert response.json()["code"] == "reason_required"


# --- an actor that names nobody ---------------------------------------------
# A blank or placeholder actor is a caller error. Every write body that carries
# an actor answers 422 and names the field. None of them answers 500.


def _assert_bad_actor(response):
    assert response.status_code == 422, response.text
    body = response.json()
    assert body["code"] == "validation_error"
    assert "actor" in body["detail"]
    assert isinstance(body["detail"], str)
    assert not body["detail"].startswith("[")


@pytest.mark.parametrize("actor", NO_ONE)
def test_run_patch_rejects_an_actor_that_names_nobody(client, actor):
    response = client.patch(
        "/api/v1/test-runs/TAS-88214", json={"operator": "A. B", "actor": actor}
    )
    _assert_bad_actor(response)


@pytest.mark.parametrize("actor", NO_ONE)
def test_invalid_flag_rejects_an_actor_that_names_nobody(client, actor):
    response = client.post(
        "/api/v1/test-runs/TAS-88214/invalid-flag",
        json={"reason": "corrupt telemetry", "actor": actor},
    )
    _assert_bad_actor(response)


@pytest.mark.parametrize("actor", NO_ONE)
def test_a_note_rejects_an_actor_that_names_nobody(client, actor):
    response = client.post(
        "/api/v1/test-runs/TAS-88214/journal",
        json={"note": "checked the rig", "actor": actor},
    )
    _assert_bad_actor(response)


@pytest.mark.parametrize("actor", PLACEHOLDERS)
def test_result_provenance_rejects_a_produced_by_that_names_nobody(
    client, results_db, actor
):
    """A placeholder produced_by is a caller error, so it answers 422.

    A blank produced_by never reaches the actor check, because the
    provenance_required gate catches it first. A placeholder passes that
    gate, so only the field type stops it.
    """
    response = client.post(RESULTS, json=result_body(provenance=provenance(produced_by=actor)))

    assert response.status_code == 422, response.text
    body = response.json()
    assert body["code"] == "validation_error"
    assert "produced_by" in body["detail"]
    assert results_db["processed_results"].count_documents({}) == 0


def test_a_good_produced_by_still_stores_and_arrives_stripped(client, results_db):
    """The guard must not block a real name, and it strips the value."""
    response = client.post(
        RESULTS, json=result_body(provenance=provenance(produced_by="  e.lindqvist  "))
    )

    assert response.status_code == 201, response.text
    assert response.json()["provenance"]["produced_by"] == "e.lindqvist"


def test_a_good_actor_still_writes_and_arrives_stripped(client, seeded_db):
    patched = client.patch(
        "/api/v1/test-runs/TAS-88214",
        json={"operator": "A. Bergström", "actor": "  a.bergstrom  "},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["field_sources"]["operator"]["actor"] == "a.bergstrom"

    noted = client.post(
        "/api/v1/test-runs/TAS-88214/journal",
        json={"note": "checked the rig", "actor": "  a.bergstrom  "},
    )
    assert noted.status_code == 201, noted.text
    assert noted.json()["actor"] == "a.bergstrom"

    flagged = client.post(
        "/api/v1/test-runs/TAS-88214/invalid-flag",
        json={"reason": "corrupt telemetry", "actor": "  e.lindqvist  "},
    )
    assert flagged.status_code == 200, flagged.text
    assert flagged.json()["invalid"]["actor"] == "e.lindqvist"
