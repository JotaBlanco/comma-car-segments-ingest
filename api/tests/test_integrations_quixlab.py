"""GET /integrations/quixlab-url — the resolver the launch controls call.

The whole reason this route was rebuilt sits in `test_no_answer_carries_a_token`:
the old Test Manager put a bearer in the QuixLab query string
(`Quix.TestManager/backend/api/routes/integrations.py:311`). No answer of this
route may carry one.
"""

import pytest

from api import quix_identity
from api.routers.integrations import EMBED_QUERY, QUIXLAB_URL_VAR

PATH = "/api/v1/integrations/quixlab-url"
BASE = "https://quixlab-abc123.dev.quix.io"


@pytest.fixture(autouse=True)
def no_quixlab(monkeypatch):
    """Start every test from an unconfigured deployment.

    A developer shell may hold the name, and the route reads the environment at
    call time, so a leak here would make the refusal tests pass on nothing.
    """
    monkeypatch.delenv(QUIXLAB_URL_VAR, raising=False)


def test_a_configured_url_answers_the_site_root(client, monkeypatch):
    monkeypatch.setenv(QUIXLAB_URL_VAR, BASE)

    response = client.get(PATH)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "url": BASE,
        "embed_url": f"{BASE}?isIframe=true",
        "origin": BASE,
    }


def test_the_embed_url_uses_a_question_mark_and_never_an_ampersand(
    client, monkeypatch
):
    """The route refuses a configured query, so `?` is always the separator."""
    monkeypatch.setenv(QUIXLAB_URL_VAR, BASE)

    embed_url = client.get(PATH).json()["embed_url"]

    assert embed_url.count("?") == 1
    assert "&" not in embed_url
    assert embed_url.endswith(f"?{EMBED_QUERY}")


def test_the_embed_url_keeps_a_configured_path(client, monkeypatch):
    monkeypatch.setenv(QUIXLAB_URL_VAR, f"{BASE}/lab")

    assert client.get(PATH).json()["embed_url"] == f"{BASE}/lab?isIframe=true"


def test_the_origin_drops_the_path_and_lowers_the_case(client, monkeypatch):
    """The parent compares this to `event.origin`, which a browser lower-cases."""
    monkeypatch.setenv(QUIXLAB_URL_VAR, "https://QuixLab-ABC.dev.quix.io/lab")

    assert client.get(PATH).json()["origin"] == "https://quixlab-abc.dev.quix.io"


def test_the_origin_keeps_a_port(client, monkeypatch):
    monkeypatch.setenv(QUIXLAB_URL_VAR, "http://localhost:8080")

    assert client.get(PATH).json()["origin"] == "http://localhost:8080"


def test_the_route_reads_the_variable_at_call_time(client, monkeypatch):
    # A redeploy must change the answer with no rebuild, the settings.py rule.
    monkeypatch.setenv(QUIXLAB_URL_VAR, BASE)
    assert client.get(PATH).json()["url"] == BASE

    monkeypatch.setenv(QUIXLAB_URL_VAR, f"{BASE}/other")
    assert client.get(PATH).json()["url"] == f"{BASE}/other"


def test_surrounding_space_never_reaches_the_answer(client, monkeypatch):
    monkeypatch.setenv(QUIXLAB_URL_VAR, f"  {BASE}  ")

    body = client.get(PATH).json()

    assert body["url"] == BASE
    assert body["embed_url"] == f"{BASE}?{EMBED_QUERY}"
    assert body["origin"] == BASE


def test_an_unset_variable_answers_409_and_names_the_variable(client):
    response = client.get(PATH)

    assert response.status_code == 409, response.text
    body = response.json()
    assert body["code"] == "quixlab_not_configured"
    assert QUIXLAB_URL_VAR in body["detail"]
    assert body["errors"] == []


def test_a_blank_variable_reads_as_unset(client, monkeypatch):
    monkeypatch.setenv(QUIXLAB_URL_VAR, "   ")

    response = client.get(PATH)

    assert response.status_code == 409
    assert response.json()["code"] == "quixlab_not_configured"


# A control hands the answer to `window.open`, so a bad value must never reach
# the browser. Each row names one fault the route refuses.
BAD_VALUES = [
    ("javascript:alert(1)", "no javascript scheme"),
    ("quixlab.dev.quix.io", "no scheme at all"),
    ("https://", "no host"),
    ("ftp://quixlab.dev.quix.io", "wrong scheme"),
    (f"{BASE}?token=super-secret", "a token in the query"),
    (f"{BASE}?open=analysis", "any query, so the caller can append its own"),
    (f"{BASE}#token=super-secret", "a token in the fragment"),
    ("https://user:super-secret@quixlab.dev.quix.io", "a credential in userinfo"),
]


@pytest.mark.parametrize(
    ("value", "fault"), BAD_VALUES, ids=[fault for _, fault in BAD_VALUES]
)
def test_a_value_the_browser_must_not_open_answers_409(
    client, monkeypatch, value, fault
):
    monkeypatch.setenv(QUIXLAB_URL_VAR, value)

    response = client.get(PATH)

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "quixlab_url_invalid"


@pytest.mark.parametrize(
    "value", [BASE] + [value for value, _ in BAD_VALUES], ids=repr
)
def test_no_answer_carries_a_token(client, monkeypatch, value):
    """No 200 body of this route holds a credential, whatever is configured."""
    monkeypatch.setenv(QUIXLAB_URL_VAR, value)

    response = client.get(PATH)

    if response.status_code != 200:
        return
    body = response.json()
    url = body["url"]
    assert "?" not in url and "#" not in url and "@" not in url
    origin = body["origin"]
    assert "?" not in origin and "#" not in origin and "@" not in origin
    # `embed_url` is the one field allowed a query. It may hold that flag and
    # nothing else, so it is compared exactly rather than scanned.
    assert body["embed_url"] == f"{url}?{EMBED_QUERY}"
    for field in (url, body["embed_url"], origin):
        for secret in ("token", "secret", "password", "Bearer"):
            assert secret.lower() not in field.lower()


def test_the_route_refuses_a_call_with_no_token(bare_client):
    response = bare_client.get(PATH)

    assert response.status_code == 401, response.text
    assert response.json()["code"] == "unauthorized"


# --- GET /integrations/lakehouse-url ------------------------------------------
#
# The route derives the Portal's Lakehouse page from the two injected names the
# API already reads. It calls no Portal endpoint, so the only states are
# "derived" and "empty".

LAKEHOUSE_PATH = "/api/v1/integrations/lakehouse-url"
PORTAL_API = "https://portal-api.dev.quix.io"
WORKSPACE = "ws-demo"


@pytest.fixture
def lakehouse_env(monkeypatch):
    """Start from a deployment where the rule derives a Portal web host."""
    monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, PORTAL_API)
    monkeypatch.setenv(quix_identity.WORKSPACE_VAR, WORKSPACE)


def test_the_lakehouse_url_names_the_portal_web_host(client, lakehouse_env):
    response = client.get(LAKEHOUSE_PATH)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "url": f"https://portal.dev.quix.io/lakehouse?workspace={WORKSPACE}"
    }


def test_the_lakehouse_url_quotes_the_workspace_id(client, lakehouse_env, monkeypatch):
    """A workspace id cannot smuggle a second query parameter into the URL."""
    monkeypatch.setenv(quix_identity.WORKSPACE_VAR, "ws demo&x=1")

    url = client.get(LAKEHOUSE_PATH).json()["url"]

    assert url.endswith("/lakehouse?workspace=ws%20demo%26x%3D1")


def test_no_portal_means_an_empty_lakehouse_url(client, monkeypatch):
    monkeypatch.delenv(quix_identity.PORTAL_URL_VAR, raising=False)
    monkeypatch.setenv(quix_identity.WORKSPACE_VAR, WORKSPACE)

    response = client.get(LAKEHOUSE_PATH)

    assert response.status_code == 200, response.text
    assert response.json() == {"url": ""}


def test_no_workspace_means_an_empty_lakehouse_url(client, lakehouse_env, monkeypatch):
    monkeypatch.delenv(quix_identity.WORKSPACE_VAR, raising=False)

    assert client.get(LAKEHOUSE_PATH).json() == {"url": ""}


def test_an_underivable_host_means_an_empty_lakehouse_url(
    client, lakehouse_env, monkeypatch
):
    """A host with no `portal-api` label follows no rule we know. No guess."""
    monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, "https://portal.dev.quix.io")

    assert client.get(LAKEHOUSE_PATH).json() == {"url": ""}


def test_the_lakehouse_url_carries_no_credential(client, lakehouse_env):
    url = client.get(LAKEHOUSE_PATH).json()["url"]

    assert "@" not in url
    for secret in ("token", "secret", "password", "bearer"):
        assert secret not in url.lower()


def test_the_lakehouse_route_refuses_a_call_with_no_token(bare_client):
    response = bare_client.get(LAKEHOUSE_PATH)

    assert response.status_code == 401, response.text
    assert response.json()["code"] == "unauthorized"
