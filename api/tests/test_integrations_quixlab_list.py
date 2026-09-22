"""GET /integrations/quixlabs — the dropdown of every QuixLab in the workspace.

Three rules carry this route, and each one has a test below.

1. **The body decides, never the status.** The Portal answers a denial with
   200 and a body of `false`. A status check would read that as a grant.
2. **One source failing must not hide the other.** A viewer with no dev-session
   reach still needs the shared deployments, which is the common case.
3. **An outage is not "there are none".** An empty dropdown that really means
   "the platform is down" sends a person looking for a QuixLab that exists.
"""

import httpx
import pytest

from api import quix_identity, quixlab

PATH = "/api/v1/integrations/quixlabs"
WORKSPACE = "ws-demo"
PORTAL = "https://portal-api.dev.quix.io"
VIEWER = {"x-portal-token": "viewer-token"}

DEPLOYMENT_ROW = {
    "deploymentId": "dep-1",
    "name": "QuixLab shared",
    "libraryItemId": "quixlab",
    "status": "Running",
    "publicUrl": "https://quixlab-dep1.dev.quix.io",
}
SESSION_ROW = {
    "id": "sess-1",
    "name": "QuixLab of Ana",
    "descriptorId": "quixlab",
    "workspaceId": WORKSPACE,
    "status": "Running",
    "publicUrl": "https://quixlab-sess1.dev.quix.io",
}


@pytest.fixture
def portal(monkeypatch):
    """Answer the two Portal routes from a dict the test writes.

    A key is "deployments" or "sessions". A value is either a body to return or
    an `httpx.Response` the test built, so a case can hand back `false`, a 403
    or a broken body without opening a socket.
    """
    monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, PORTAL)
    monkeypatch.setenv(quix_identity.WORKSPACE_VAR, WORKSPACE)
    answers: dict[str, object] = {"deployments": [], "sessions": []}

    def handler(request: httpx.Request) -> httpx.Response:
        key = "sessions" if "/dev-sessions" in request.url.path else "deployments"
        answer = answers[key]
        if isinstance(answer, httpx.Response):
            return answer
        return httpx.Response(200, json=answer)

    quix_identity.TRANSPORT = httpx.MockTransport(handler)
    yield answers
    quix_identity.TRANSPORT = None


def test_both_kinds_arrive_and_every_row_names_its_kind(client, portal):
    portal["deployments"] = [DEPLOYMENT_ROW]
    portal["sessions"] = [SESSION_ROW]

    body = client.get(PATH, headers=VIEWER).json()

    kinds = {item["id"]: item["kind"] for item in body["items"]}
    assert kinds == {"dep-1": "deployment", "sess-1": "devsession"}


def test_a_deployment_sorts_before_a_dev_session(client, portal):
    """The shared, stable choice comes first, whatever order the Portal used."""
    portal["deployments"] = [DEPLOYMENT_ROW]
    portal["sessions"] = [SESSION_ROW]

    items = client.get(PATH, headers=VIEWER).json()["items"]

    assert [item["kind"] for item in items] == ["deployment", "devsession"]


def test_every_row_carries_the_embed_url_and_the_origin(client, portal):
    portal["deployments"] = [DEPLOYMENT_ROW]

    item = client.get(PATH, headers=VIEWER).json()["items"][0]

    assert item["url"] == "https://quixlab-dep1.dev.quix.io"
    assert item["embed_url"] == f"https://quixlab-dep1.dev.quix.io?{quixlab.EMBED_QUERY}"
    assert item["origin"] == "https://quixlab-dep1.dev.quix.io"


def test_a_denial_of_200_with_a_body_of_false_yields_no_rows(client, portal):
    """**The rule this route exists to keep.** The Portal answers a denial with
    200 and the body `false`. A status check would pass every caller."""
    portal["deployments"] = httpx.Response(200, json=False)
    portal["sessions"] = httpx.Response(200, json=False)

    response = client.get(PATH, headers=VIEWER)

    assert response.status_code == 200, response.text
    assert response.json()["items"] == []


def test_a_refused_dev_session_list_still_answers_the_deployments(client, portal):
    """A viewer who may not list dev sessions still needs the shared QuixLabs."""
    portal["deployments"] = [DEPLOYMENT_ROW]
    portal["sessions"] = httpx.Response(403, json={"detail": "no"})

    items = client.get(PATH, headers=VIEWER).json()["items"]

    assert [item["id"] for item in items] == ["dep-1"]


def test_a_refused_deployment_list_still_answers_the_dev_sessions(client, portal):
    portal["deployments"] = httpx.Response(403, json={"detail": "no"})
    portal["sessions"] = [SESSION_ROW]

    items = client.get(PATH, headers=VIEWER).json()["items"]

    assert [item["id"] for item in items] == ["sess-1"]


def test_an_outage_on_both_lists_answers_503_and_never_an_empty_list(client, portal):
    portal["deployments"] = httpx.Response(500)
    portal["sessions"] = httpx.Response(500)

    response = client.get(PATH, headers=VIEWER)

    assert response.status_code == 503, response.text
    assert response.json()["code"] == "platform_unavailable"


def test_a_refusal_on_both_lists_is_not_an_outage(client, portal):
    """403 is a decision about the viewer. It answers an empty list, not 503."""
    portal["deployments"] = httpx.Response(403, json={"detail": "no"})
    portal["sessions"] = httpx.Response(403, json={"detail": "no"})

    response = client.get(PATH, headers=VIEWER)

    assert response.status_code == 200, response.text
    assert response.json()["items"] == []


def test_a_dev_session_of_another_workspace_never_appears(client, portal):
    """`GET /dev-sessions` is the whole user list, so this API narrows it."""
    portal["sessions"] = [{**SESSION_ROW, "workspaceId": "ws-other"}]

    assert client.get(PATH, headers=VIEWER).json()["items"] == []


def test_a_descriptor_of_another_kind_never_appears(client, portal):
    portal["sessions"] = [{**SESSION_ROW, "descriptorId": "vscode"}]
    portal["deployments"] = [{**DEPLOYMENT_ROW, "libraryItemId": "quixstreams"}]

    assert client.get(PATH, headers=VIEWER).json()["items"] == []


@pytest.mark.parametrize("value", ["quixlab", "QuixLab", "QUIXLAB"])
def test_the_kind_match_ignores_case(client, portal, value):
    """`DevSessionsController.cs:376` lowercases before it matches, which proves
    the stored value may be mixed case."""
    portal["sessions"] = [{**SESSION_ROW, "descriptorId": value}]

    assert len(client.get(PATH, headers=VIEWER).json()["items"]) == 1


BAD_URLS = [
    ("", "a stopped session has no address"),
    ("   ", "blank"),
    ("javascript:alert(1)", "no javascript scheme"),
    ("quixlab.dev.quix.io", "no scheme"),
    ("https://", "no host"),
    ("https://quixlab.dev.quix.io?token=super-secret", "a credential in a query"),
    ("https://user:pw@quixlab.dev.quix.io", "a credential in userinfo"),
]


@pytest.mark.parametrize(
    ("value", "fault"), BAD_URLS, ids=[fault for _, fault in BAD_URLS]
)
def test_a_row_a_browser_must_not_open_is_dropped_not_offered(
    client, portal, value, fault
):
    """One bad row must not hide every good one, and must never be offered."""
    portal["deployments"] = [
        DEPLOYMENT_ROW,
        {**DEPLOYMENT_ROW, "deploymentId": "dep-2", "publicUrl": value},
    ]

    items = client.get(PATH, headers=VIEWER).json()["items"]

    assert [item["id"] for item in items] == ["dep-1"]


def test_no_row_carries_a_credential(client, portal):
    portal["deployments"] = [DEPLOYMENT_ROW]
    portal["sessions"] = [SESSION_ROW]

    for item in client.get(PATH, headers=VIEWER).json()["items"]:
        for value in (item["url"], item["embed_url"], item["origin"]):
            for secret in ("token", "secret", "password", "bearer"):
                assert secret not in value.lower()


def test_no_viewer_token_answers_an_empty_list_and_never_a_500(client, portal):
    """The demo path holds no viewer token. It must answer, not fail."""
    portal["deployments"] = [DEPLOYMENT_ROW]

    response = client.get(PATH)

    assert response.status_code == 200, response.text
    assert response.json()["items"] == []


def test_no_portal_configured_answers_an_empty_list(client, monkeypatch):
    """The local path. The caller falls back to the configured single URL."""
    monkeypatch.delenv(quix_identity.PORTAL_URL_VAR, raising=False)

    response = client.get(PATH, headers=VIEWER)

    assert response.status_code == 200, response.text
    assert response.json()["items"] == []


def test_the_route_refuses_a_call_with_no_bearer(bare_client):
    response = bare_client.get(PATH, headers=VIEWER)

    assert response.status_code == 401, response.text
    assert response.json()["code"] == "unauthorized"


# --- The Portal's embedded view -----------------------------------------------
#
# Every launch control must land a person INSIDE the Portal. The route is
# `/pipeline/deployments/{deploymentId}/embedded?workspace={workspaceId}`, and
# only the Portal knows the deployment id: `TM_QUIXLAB_URL` carries the QuixLab
# HOST, and that host names a git commit, never the deployment.


def test_a_deployment_row_carries_the_portal_embedded_view(client, portal):
    """The one URL the demo must open."""
    portal["deployments"] = [DEPLOYMENT_ROW]

    item = client.get(PATH, headers=VIEWER).json()["items"][0]

    assert item["portal_embedded_url"] == (
        f"https://portal.dev.quix.io/pipeline/deployments/dep-1"
        f"/embedded?workspace={WORKSPACE}"
    )


def test_a_dev_session_carries_no_portal_embedded_view(client, portal):
    """A dev session is not a deployment, so the Portal route names nothing."""
    portal["sessions"] = [SESSION_ROW]

    item = client.get(PATH, headers=VIEWER).json()["items"][0]

    assert item["portal_embedded_url"] == ""


def test_an_underivable_portal_web_host_answers_an_empty_string(client, portal, monkeypatch):
    """A host we cannot derive is a plain empty value, and never a guess.

    The caller then opens the direct QuixLab URL, exactly as it did before.
    """
    monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, "https://someone-else.example.com")
    portal["deployments"] = [DEPLOYMENT_ROW]

    item = client.get(PATH, headers=VIEWER).json()["items"][0]

    assert item["portal_embedded_url"] == ""


def test_the_portal_web_host_drops_only_the_first_api_label(monkeypatch):
    """The derivation rule, on the three shapes the platform really uses."""
    for api_host, web_host in (
        ("https://portal-api.dev.quix.io", "https://portal.dev.quix.io"),
        ("https://portal-api.dev-1.dev.quix.io", "https://portal.dev-1.dev.quix.io"),
        ("https://portal-api.quix.ai", "https://portal.quix.ai"),
    ):
        monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, api_host)
        assert quixlab.portal_web_base() == web_host


def test_the_ids_are_quoted_so_neither_can_add_a_parameter(monkeypatch):
    """A deployment id and a workspace id reach a URL, so both are escaped."""
    monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, "https://portal-api.dev.quix.io")

    built = quixlab.portal_embedded_url("dep/1?x=2", "ws&y=3")

    assert built == (
        "https://portal.dev.quix.io/pipeline/deployments/dep%2F1%3Fx%3D2"
        "/embedded?workspace=ws%26y%3D3"
    )
