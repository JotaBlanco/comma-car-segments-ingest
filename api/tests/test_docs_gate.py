# The schema docs are OPEN, in every environment.
#
# A `TM_ENV` switch closed them until 20 Aug 2026. Luis removed it: a reviewer
# who reads the live contract serves the traceability story. The schema names
# routes and shapes. It carries no host, no credential and no data.
#
# So this file guards two things that must never drift apart: the docs answer
# everywhere, and the bearer token still guards every `/api/v1` route.

from fastapi.testclient import TestClient


def _fresh_app(monkeypatch, env: str | None):
    """Build a new app after the env change, because docs wire at creation."""
    if env is None:
        monkeypatch.delenv("TM_ENV", raising=False)
    else:
        monkeypatch.setenv("TM_ENV", env)
    from api.main import create_app

    return create_app()


def test_docs_are_open_by_default(monkeypatch):
    client = TestClient(_fresh_app(monkeypatch, None))
    assert client.get("/docs").status_code == 200
    assert client.get("/openapi.json").status_code == 200
    assert client.get("/redoc").status_code == 200


def test_docs_stay_open_in_production(monkeypatch):
    """No environment name closes them. `TM_ENV` is a dead name now."""
    client = TestClient(_fresh_app(monkeypatch, "production"))
    assert client.get("/docs").status_code == 200
    assert client.get("/openapi.json").status_code == 200


def test_docs_are_open_in_development(monkeypatch):
    client = TestClient(_fresh_app(monkeypatch, "development"))
    assert client.get("/docs").status_code == 200
    assert client.get("/openapi.json").status_code == 200


def test_api_routes_stay_guarded(monkeypatch):
    # Open docs must not loosen the token check on /api/v1.
    client = TestClient(_fresh_app(monkeypatch, None))
    assert client.get("/api/v1/test-runs").status_code == 401


def test_the_open_schema_carries_no_host_and_no_credential(monkeypatch):
    """The reason the docs may open. A default that names a host would break it.

    The schema declares routes, shapes and one security scheme. It must never
    grow a `servers` block naming a real host, or an example carrying a token,
    a password or a connection string.
    """
    client = TestClient(_fresh_app(monkeypatch, None))
    schema = client.get("/openapi.json").json()

    assert "servers" not in schema
    body = client.get("/openapi.json").text.lower()
    for leak in ("mongodb://", "password", "secretkey", "authtoken"):
        assert leak not in body, f"the open schema carries {leak}"
