"""GET /integrations/fts-url — where the Flight Test Station is.

The route answers a place and nothing else. `test_no_answer_carries_a_token`
holds the line the QuixLab resolver holds: no answer of this route may carry a
credential, whatever an operator configured. The station's token arrives over
postMessage, relayed by the Test Manager.
"""

import pytest

from api.routers.integrations import FTS_URL_VAR

PATH = "/api/v1/integrations/fts-url"
BASE = "https://va-flight-test-station.dev.quix.io"


@pytest.fixture(autouse=True)
def no_station(monkeypatch):
    """Start every test from an unconfigured deployment.

    The route reads the environment at call time, so a developer shell holding
    the name would make the refusal tests pass on nothing.
    """
    monkeypatch.delenv(FTS_URL_VAR, raising=False)


def test_a_configured_url_answers_the_site_root_and_its_origin(client, monkeypatch):
    monkeypatch.setenv(FTS_URL_VAR, BASE)

    response = client.get(PATH)

    assert response.status_code == 200, response.text
    assert response.json() == {"url": BASE, "origin": BASE}


def test_the_answer_keeps_a_configured_path(client, monkeypatch):
    """A caller appends `?run=...` to `url`, so the path has to survive."""
    monkeypatch.setenv(FTS_URL_VAR, f"{BASE}/station")

    body = client.get(PATH).json()

    assert body["url"] == f"{BASE}/station"
    assert body["origin"] == BASE


def test_the_origin_drops_the_path_and_lowers_the_case(client, monkeypatch):
    monkeypatch.setenv(FTS_URL_VAR, "https://VA-Flight-Test-Station.DEV.quix.io/x")

    assert client.get(PATH).json()["origin"] == "https://va-flight-test-station.dev.quix.io"


def test_the_origin_keeps_a_port(client, monkeypatch):
    monkeypatch.setenv(FTS_URL_VAR, "http://localhost:5173")

    assert client.get(PATH).json()["origin"] == "http://localhost:5173"


def test_the_route_reads_the_variable_at_call_time(client, monkeypatch):
    """A redeploy changes the answer, with no rebuild of this process."""
    assert client.get(PATH).status_code == 409

    monkeypatch.setenv(FTS_URL_VAR, BASE)

    assert client.get(PATH).json()["url"] == BASE


def test_surrounding_space_never_reaches_the_answer(client, monkeypatch):
    monkeypatch.setenv(FTS_URL_VAR, f"  {BASE}  ")

    assert client.get(PATH).json()["url"] == BASE


def test_an_unset_variable_answers_409_and_names_the_variable(client):
    response = client.get(PATH)

    assert response.status_code == 409, response.text
    body = response.json()
    assert body["code"] == "fts_not_configured"
    assert FTS_URL_VAR in body["detail"]
    assert body["errors"] == []


def test_a_blank_variable_reads_as_unset(client, monkeypatch):
    monkeypatch.setenv(FTS_URL_VAR, "   ")

    response = client.get(PATH)

    assert response.status_code == 409
    assert response.json()["code"] == "fts_not_configured"


# A bad value must never reach the browser. One row, one fault.
BAD_VALUES = [
    ("javascript:alert(1)", "no javascript scheme"),
    ("va-flight-test-station.dev.quix.io", "no scheme at all"),
    ("https://", "no host"),
    ("ftp://va-flight-test-station.dev.quix.io", "wrong scheme"),
    (f"{BASE}?token=super-secret", "a token in the query"),
    (f"{BASE}?run=sn003", "any query, so the caller can append its own"),
    (f"{BASE}#token=super-secret", "a token in the fragment"),
    ("https://user:super-secret@va-fts.dev.quix.io", "a credential in userinfo"),
]


@pytest.mark.parametrize(("value", "fault"), BAD_VALUES, ids=[fault for _, fault in BAD_VALUES])
def test_a_value_the_browser_must_not_open_answers_409(client, monkeypatch, value, fault):
    monkeypatch.setenv(FTS_URL_VAR, value)

    response = client.get(PATH)

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "fts_url_invalid"


def test_a_refusal_names_the_station_variable_and_not_quixlab(client, monkeypatch):
    """The two resolvers share one check, so the message must name the right one."""
    monkeypatch.setenv(FTS_URL_VAR, "not-a-url")

    detail = client.get(PATH).json()["detail"]

    assert FTS_URL_VAR in detail
    assert "TM_QUIXLAB_URL" not in detail


@pytest.mark.parametrize("value", [BASE] + [value for value, _ in BAD_VALUES], ids=repr)
def test_no_answer_carries_a_token(client, monkeypatch, value):
    """No 200 body of this route holds a credential, whatever is configured."""
    monkeypatch.setenv(FTS_URL_VAR, value)

    response = client.get(PATH)

    if response.status_code != 200:
        return
    body = response.json()
    for field in (body["url"], body["origin"]):
        assert "?" not in field and "#" not in field and "@" not in field
        for secret in ("token", "secret", "password", "Bearer"):
            assert secret.lower() not in field.lower()


def test_the_route_refuses_a_call_with_no_token(bare_client):
    response = bare_client.get(PATH)

    assert response.status_code == 401, response.text
    assert response.json()["code"] == "unauthorized"
