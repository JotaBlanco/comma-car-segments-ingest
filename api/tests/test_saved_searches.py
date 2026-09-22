"""Saved and shared searches — the server half of FR-DM-017.

The device store keeps a saved search in one browser, so nobody can hand one
to a colleague. These tests hold the three routes that close that gap, and
they hold the sharing model the requirement row names: a **personal** search
answers to its owner alone, and a **team** search answers to everybody.

Four lines matter here, and each one has its own block below:

* the three routes store, read and delete what they say they do;
* a personal search never reaches another person, on either path;
* a call with no token answers 401, like every `/api/v1` route;
* the placeholder-actor rule stands, on both paths.

No test opens a socket. `httpx.MockTransport` answers the Portal calls, and
`conftest.no_platform_check` clears the switch around every test.
"""

import httpx
import pytest

from api import quix_identity
from api.db import ensure_indexes
from tests.conftest import TEST_TOKEN

PATH = "/api/v1/saved-searches"

ANNA = "a.bergstrom"
BO = "b.lindqvist"

RUNS_QUERY = "?status=complete&rig=RIG-04"

PORTAL = "https://portal-api.test.quix.io"

# A test-only value. It is not a real credential.
LIVE_TOKEN = "live-platform-token-not-a-secret"

PROFILE = {
    "userId": "auth0|64f0c1",
    "email": "emanuel@volvo.test",
    "firstName": "Emanuel",
    "lastName": "Nilsson",
}

# The name the platform proves for that profile.
VERIFIED = "Emanuel Nilsson"


@pytest.fixture
def searches(routed_db):
    """A routed database with the saved-search indexes in place."""
    ensure_indexes(routed_db)
    return routed_db


@pytest.fixture(autouse=True)
def no_workspace(monkeypatch):
    """Ask the Portal for an identity only. The blob store reads the same name."""
    monkeypatch.delenv(quix_identity.WORKSPACE_VAR, raising=False)


def _portal(profile: dict) -> httpx.MockTransport:
    """A Portal that names one person and grants every workspace."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == quix_identity.PERMISSIONS_PATH:
            return httpx.Response(200, json=True)
        return httpx.Response(200, json=profile)

    return httpx.MockTransport(handler)


@pytest.fixture
def platform(monkeypatch):
    """Turn the platform identity check on, with a Portal that names a person."""
    monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, PORTAL)
    quix_identity.TRANSPORT = _portal(PROFILE)


@pytest.fixture
def placeholder_person(monkeypatch):
    """A Portal that names a person whose display name names nobody."""
    monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, PORTAL)
    quix_identity.TRANSPORT = _portal({**PROFILE, "firstName": "Quix", "lastName": "User"})


def _save(client, actor: str, name: str, **extra) -> httpx.Response:
    body = {"scope": "runs", "name": name, "query": RUNS_QUERY, "actor": actor}
    body.update(extra)
    return client.post(PATH, json=body)


def _names(response) -> list[str]:
    return [item["name"] for item in response.json()["items"]]


# --- the three routes do what they say ---------------------------------------


def test_a_saved_search_stores_and_reads_back(client, searches) -> None:
    created = _save(client, ANNA, "Cold soak")

    assert created.status_code == 201, created.text
    body = created.json()
    assert body["scope"] == "runs"
    assert body["name"] == "Cold soak"
    assert body["query"] == RUNS_QUERY
    assert body["visibility"] == "personal"
    assert body["owner"] == ANNA
    assert body["search_id"].startswith("ss-")

    read = client.get(PATH, params={"actor": ANNA})
    assert read.status_code == 200
    assert _names(read) == ["Cold soak"]


def test_the_read_envelope_carries_the_contract_shape(client, searches) -> None:
    _save(client, ANNA, "Cold soak")

    body = client.get(PATH, params={"actor": ANNA}).json()

    assert body["total"] == 1
    assert body["page"] == 1
    assert body["page_size"] == 50
    assert body["total_pages"] == 1


def test_a_second_save_under_one_name_replaces_the_row(client, searches) -> None:
    """Two rows under one name help nobody. The device store states the same rule."""
    first = _save(client, ANNA, "Cold soak").json()
    second = _save(client, ANNA, "cold soak", query="?status=invalid").json()

    assert second["search_id"] == first["search_id"]
    assert second["query"] == "?status=invalid"
    read = client.get(PATH, params={"actor": ANNA})
    assert read.json()["total"] == 1


def test_the_scope_filter_narrows_the_read(client, searches) -> None:
    _save(client, ANNA, "Cold soak")
    client.post(
        PATH,
        json={
            "scope": "files",
            "name": "Quarantined",
            "query": "?status=quarantined",
            "actor": ANNA,
        },
    )

    body = client.get(PATH, params={"actor": ANNA, "scope": "files"})

    assert _names(body) == ["Quarantined"]


def test_the_owner_deletes_the_search(client, searches) -> None:
    created = _save(client, ANNA, "Cold soak").json()

    removed = client.request("DELETE", f"{PATH}/{created['search_id']}", json={"actor": ANNA})

    assert removed.status_code == 204
    assert client.get(PATH, params={"actor": ANNA}).json()["total"] == 0


def test_a_delete_of_an_unknown_id_answers_404(client, searches) -> None:
    response = client.request("DELETE", f"{PATH}/ss-nobody", json={"actor": ANNA})

    assert response.status_code == 404
    assert response.json()["code"] == "saved_search_not_found"


# --- the sharing model the row names -----------------------------------------


def test_a_team_search_reaches_a_colleague(client, searches) -> None:
    _save(client, ANNA, "Cold soak", visibility="team")

    body = client.get(PATH, params={"actor": BO})

    assert _names(body) == ["Cold soak"]
    assert body.json()["items"][0]["owner"] == ANNA


def test_a_personal_search_never_reaches_a_colleague(client, searches) -> None:
    _save(client, ANNA, "Cold soak")

    body = client.get(PATH, params={"actor": BO})

    assert body.json()["items"] == []
    assert body.json()["total"] == 0


def test_a_read_that_names_nobody_serves_the_team_searches_alone(client, searches) -> None:
    _save(client, ANNA, "Cold soak")
    _save(client, ANNA, "Winter cycle", visibility="team")

    body = client.get(PATH)

    assert _names(body) == ["Winter cycle"]


def test_a_colleague_may_not_delete_a_team_search(client, searches) -> None:
    """Sharing a search must never hand the delete away with it."""
    created = _save(client, ANNA, "Cold soak", visibility="team").json()

    refused = client.request("DELETE", f"{PATH}/{created['search_id']}", json={"actor": BO})

    assert refused.status_code == 403
    assert refused.json()["code"] == "not_the_owner"
    assert client.get(PATH, params={"actor": BO}).json()["total"] == 1


# --- the token guard ---------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("POST", PATH, {"scope": "runs", "name": "Cold soak", "query": "", "actor": ANNA}),
        ("GET", PATH, None),
        ("DELETE", f"{PATH}/ss-1", {"actor": ANNA}),
    ],
)
def test_every_route_refuses_a_call_with_no_token(bare_client, method, path, body) -> None:
    response = bare_client.request(method, path, json=body)

    assert response.status_code == 401
    assert response.json() == {
        "detail": "invalid or missing token",
        "code": "unauthorized",
        "errors": [],
    }


# --- the placeholder-actor rule ----------------------------------------------


@pytest.mark.parametrize("actor", ["", "  ", "unknown", "system", "  QUIX USER  "])
def test_an_actor_that_names_nobody_answers_422(client, searches, actor) -> None:
    """The `Actor` type guards this body, exactly as it guards every write body."""
    response = _save(client, actor, "Cold soak")

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


def test_a_placeholder_actor_on_the_read_answers_422(client, searches) -> None:
    response = client.get(PATH, params={"actor": "current-user"})

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


def test_a_proven_caller_owns_the_row_and_the_body_claim_loses(
    bare_client, searches, platform
) -> None:
    """A proven identity beats the claim. `api/api/auth.py` owns that rule."""
    headers = {"Authorization": f"Bearer {LIVE_TOKEN}"}
    created = bare_client.post(
        PATH,
        json={"scope": "runs", "name": "Cold soak", "query": RUNS_QUERY, "actor": BO},
        headers=headers,
    )

    assert created.status_code == 201, created.text
    assert created.json()["owner"] == VERIFIED
    assert created.json()["owner_id"] == PROFILE["userId"]
    # The claimed name owns nothing, so a static-token reader sees no row.
    static = bare_client.get(
        PATH, params={"actor": BO}, headers={"Authorization": f"Bearer {TEST_TOKEN}"}
    )
    assert static.json()["total"] == 0


def test_a_placeholder_display_name_owns_the_row_under_the_user_id(
    bare_client, searches, placeholder_person
) -> None:
    """A Portal profile is free text, so a real person may carry a placeholder name.

    The refusal must never answer 500 on a legal call, and the stable Portal
    user id stands in. `api/api/auth.py` states the rule and this route obeys it.
    """
    headers = {"Authorization": f"Bearer {LIVE_TOKEN}"}
    created = bare_client.post(
        PATH,
        json={"scope": "runs", "name": "Cold soak", "query": RUNS_QUERY, "actor": ANNA},
        headers=headers,
    )

    assert created.status_code == 201, created.text
    assert created.json()["owner"] == PROFILE["userId"]

    read = bare_client.get(PATH, headers=headers)
    assert _names(read) == ["Cold soak"]


def test_a_proven_caller_reads_their_own_rows_with_no_actor_parameter(
    bare_client, searches, platform
) -> None:
    headers = {"Authorization": f"Bearer {LIVE_TOKEN}"}
    bare_client.post(
        PATH,
        json={"scope": "runs", "name": "Cold soak", "query": RUNS_QUERY, "actor": VERIFIED},
        headers=headers,
    )
    # A static-token caller must not read that personal row.
    static = bare_client.get(PATH, headers={"Authorization": f"Bearer {TEST_TOKEN}"})

    assert _names(bare_client.get(PATH, headers=headers)) == ["Cold soak"]
    assert static.json()["items"] == []


# --- the stored query string -------------------------------------------------


def test_an_empty_query_string_is_a_legal_search(client, searches) -> None:
    """A screen with no filter saves too. `buildTableQuery` writes "" for it."""
    response = _save(client, ANNA, "Everything", query="")

    assert response.status_code == 201, response.text
    assert response.json()["query"] == ""


@pytest.mark.parametrize("query", ["status=complete", "/runs?status=complete"])
def test_a_query_string_of_another_shape_answers_422(client, searches, query) -> None:
    """A value `buildTableQuery` never writes restores no screen, so it stores none."""
    response = _save(client, ANNA, "Cold soak", query=query)

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


def test_a_name_over_the_cap_answers_422(client, searches) -> None:
    response = _save(client, ANNA, "n" * 61)

    assert response.status_code == 422


# --- the optional description ------------------------------------------------


def test_a_saved_search_keeps_the_description_a_person_wrote(client, searches) -> None:
    created = _save(client, ANNA, "Cold soak", description="Every complete run on rig 4.")

    assert created.status_code == 201, created.text
    assert created.json()["description"] == "Every complete run on rig 4."


def test_a_description_survives_a_list_read(client, searches) -> None:
    """The field must reach the screen that shows it, not the create answer alone."""
    _save(client, ANNA, "Cold soak", description="Every complete run on rig 4.")

    body = client.get(PATH, params={"actor": ANNA}).json()

    assert body["items"][0]["description"] == "Every complete run on rig 4."


def test_a_save_with_no_description_still_works(client, searches) -> None:
    """The word "optional" is the requirement's own, so this path must not change."""
    created = _save(client, ANNA, "Cold soak")

    assert created.status_code == 201, created.text
    assert created.json()["description"] is None
    read = client.get(PATH, params={"actor": ANNA}).json()
    assert read["items"][0]["description"] is None


@pytest.mark.parametrize("description", ["", "   "])
def test_a_blank_description_stores_as_null(client, searches, description) -> None:
    """One state carries one value. A blank description is no description."""
    created = _save(client, ANNA, "Cold soak", description=description)

    assert created.status_code == 201, created.text
    assert created.json()["description"] is None


def test_a_description_over_the_cap_answers_422(client, searches) -> None:
    response = _save(client, ANNA, "Cold soak", description="d" * 201)

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
