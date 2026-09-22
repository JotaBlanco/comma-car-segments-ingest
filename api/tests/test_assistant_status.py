# GET /assistant/status — the FE's gate for the Ask control. The route is
# always registered; availability follows the platform (Quix__Portal__Api
# injected — the Explore-chat rule, D-E3), and the answer is a pure
# configuration read, never a live probe. The sessions path runs on the
# viewer's Portal token, so no proxy key is part of the definition any more.

import pytest

STATUS_PATH = "/api/v1/assistant/status"

PORTAL_URL_VAR = "Quix__Portal__Api"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Start every test off-platform: no Portal, no leftover proxy key."""
    monkeypatch.delenv("TM_AI_PROXY_KEY", raising=False)
    monkeypatch.delenv(PORTAL_URL_VAR, raising=False)


def test_off_platform_answers_disabled_and_unreachable(client):
    response = client.get(STATUS_PATH)
    assert response.status_code == 200, response.text
    assert response.json() == {"enabled": False, "reachable": False}


def test_the_injected_portal_name_turns_the_assistant_on(client, monkeypatch):
    # A deployment sets nothing by hand: the platform injects Quix__Portal__Api
    # (plans/reference/QUIX-INJECTED-VARIABLES.md), and that presence is the
    # whole condition — the former TM_ASSISTANT flag left on 21 Aug 2026.
    monkeypatch.setenv(PORTAL_URL_VAR, "http://portal.stub")
    response = client.get(STATUS_PATH)
    assert response.status_code == 200, response.text
    assert response.json() == {"enabled": True, "reachable": True}


def test_a_proxy_key_is_no_longer_part_of_reachable(client, monkeypatch):
    # The llm-proxy loop died with U-4; a leftover key must not fake
    # availability when no Portal is configured.
    monkeypatch.setenv("TM_AI_PROXY_KEY", "proxy-key-not-a-secret")
    response = client.get(STATUS_PATH)
    assert response.json() == {"enabled": False, "reachable": False}


def test_status_requires_the_bearer_token(bare_client):
    response = bare_client.get(STATUS_PATH)
    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"
