# Auth is real logic. These tests came before the implementation.

import logging

import pytest

from api import quix_identity
from tests.conftest import TEST_TOKEN


def test_missing_token_returns_contract_401(bare_client):
    response = bare_client.get("/api/v1/test-runs")
    assert response.status_code == 401
    assert response.json() == {
        "detail": "invalid or missing token",
        "code": "unauthorized",
        "errors": [],
    }


def test_wrong_token_returns_401(bare_client):
    response = bare_client.get(
        "/api/v1/test-runs", headers={"Authorization": "Bearer wrong-token"}
    )
    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


def test_wrong_scheme_returns_401(bare_client):
    response = bare_client.get(
        "/api/v1/test-runs", headers={"Authorization": f"Basic {TEST_TOKEN}"}
    )
    assert response.status_code == 401


def test_good_token_passes(client, routed_db):
    # The route reads Mongo, so a 200 needs a database behind it.
    response = client.get("/api/v1/test-runs")
    assert response.status_code == 200


def test_health_is_open(bare_client):
    response = bare_client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ready_is_open(bare_client):
    # Ready answers without a token. Mongo may be up or down on this machine,
    # so accept both results and check the body shape for each.
    response = bare_client.get("/ready")
    assert response.status_code in (200, 503)
    body = response.json()
    if response.status_code == 200:
        assert body["status"] == "ready"
        assert body["mongo"] == "ok"
        assert body["planning_api"] in ("ok", "offline")
    else:
        assert body["code"] == "not_ready"
        assert body["errors"] == []


# --- every refusal leaves one record -----------------------------------------
#
# FR-DM-055, NFR-DM-049, UC-006. The security review found that a refused
# request wrote nothing at all, so nobody could count the refusals or see a
# route being probed. The line names the route and the reason. It never names
# the token, and never a prefix of it.

AUTH_LOGGER = "api.auth"


def _refusals(caplog) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if record.name == AUTH_LOGGER and record.levelno == logging.WARNING
    ]


def test_a_missing_token_writes_one_refusal_line(bare_client, caplog):
    with caplog.at_level(logging.WARNING, logger=AUTH_LOGGER):
        bare_client.get("/api/v1/test-runs")

    records = _refusals(caplog)
    assert len(records) == 1
    message = records[0].getMessage()
    assert "/api/v1/test-runs" in message
    assert "no bearer credential" in message


def test_a_wrong_scheme_writes_a_refusal_and_never_the_token(bare_client, caplog):
    """A Basic header carries a credential too, and none of it may land."""
    with caplog.at_level(logging.WARNING, logger=AUTH_LOGGER):
        bare_client.get(
            "/api/v1/test-runs", headers={"Authorization": f"Basic {TEST_TOKEN}"}
        )

    records = _refusals(caplog)
    assert len(records) == 1
    message = records[0].getMessage()
    assert "no bearer credential" in message
    assert TEST_TOKEN not in message


def test_a_wrong_token_writes_a_refusal_and_never_the_token(bare_client, caplog):
    secret = "wrong-token-nobody-may-read"
    with caplog.at_level(logging.WARNING, logger=AUTH_LOGGER):
        bare_client.get(
            "/api/v1/test-runs", headers={"Authorization": f"Bearer {secret}"}
        )

    records = _refusals(caplog)
    assert len(records) == 1
    message = records[0].getMessage()
    assert "not the static token" in message
    # Neither the token nor any prefix of it. A prefix shortens a guess.
    assert secret not in message
    for length in range(4, len(secret) + 1):
        assert secret[:length] not in message


def test_a_platform_refusal_writes_the_platform_reason(bare_client, caplog, monkeypatch):
    def refuse(token: str):
        raise quix_identity.PlatformRefused("the caller may not use this workspace")

    monkeypatch.setattr(quix_identity, "enabled", lambda: True)
    monkeypatch.setattr(quix_identity, "identify", refuse)

    with caplog.at_level(logging.WARNING, logger=AUTH_LOGGER):
        response = bare_client.get(
            "/api/v1/test-runs", headers={"Authorization": "Bearer a-quix-token"}
        )

    assert response.status_code == 401
    records = _refusals(caplog)
    assert len(records) == 1
    message = records[0].getMessage()
    assert "the caller may not use this workspace" in message
    assert "a-quix-token" not in message


def test_an_unreachable_platform_answers_503_and_is_no_refusal(
    bare_client, caplog, monkeypatch
):
    """A 503 is an outage, not a refusal. It must not count as one."""

    def fail(token: str):
        raise quix_identity.PlatformUnreachable("the Quix platform did not answer")

    monkeypatch.setattr(quix_identity, "enabled", lambda: True)
    monkeypatch.setattr(quix_identity, "identify", fail)

    with caplog.at_level(logging.WARNING, logger=AUTH_LOGGER):
        response = bare_client.get(
            "/api/v1/test-runs", headers={"Authorization": "Bearer a-quix-token"}
        )

    assert response.status_code == 503
    assert _refusals(caplog) == []


def test_a_good_token_writes_no_refusal(client, routed_db, caplog):
    with caplog.at_level(logging.WARNING, logger=AUTH_LOGGER):
        assert client.get("/api/v1/test-runs").status_code == 200

    assert _refusals(caplog) == []


@pytest.mark.parametrize("route", ["/health", "/ready"])
def test_an_open_route_writes_no_refusal(bare_client, caplog, route):
    with caplog.at_level(logging.WARNING, logger=AUTH_LOGGER):
        bare_client.get(route)

    assert _refusals(caplog) == []
