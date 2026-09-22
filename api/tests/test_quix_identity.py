# The platform identity check (api/quix_identity.py) and the auth switch.
#
# No test here reaches the network. httpx.MockTransport answers every call.
#
# Five branches must stay covered: a good token, a refused token, an expired
# token, an unreachable platform, and the static fallback. Each one has a named
# test below and the name says which branch it guards.

import httpx
import pytest
from fastapi.security import HTTPAuthorizationCredentials
from starlette.requests import Request

from api import auth, quix_identity
from api.errors import ApiError
from tests.conftest import TEST_TOKEN

PORTAL = "https://portal-api.test.quix.io"
WORKSPACE = "acme-testmanager"

# Test-only values. Neither one is a real credential.
LIVE_TOKEN = "live-platform-token-not-a-secret"
DEAD_TOKEN = "expired-platform-token-not-a-secret"

PROFILE = {
    "userId": "auth0|64f0c1",
    "email": "emanuel@volvo.test",
    "firstName": "Emanuel",
    "lastName": "Nilsson",
}


# The `no_platform_check` fixture in conftest.py owns the switch, the transport
# and the cache for the whole suite. This file adds no second mechanism for any
# of the three.


@pytest.fixture(autouse=True)
def no_workspace(monkeypatch):
    """Start every test with no workspace, whatever the developer's shell holds.

    conftest.py leaves this name alone, because the blob store reads it too.
    These tests are the ones that care, so they clear it here. A test that wants
    a workspace sets it, and monkeypatch puts it back.
    """
    monkeypatch.delenv(quix_identity.WORKSPACE_VAR, raising=False)


@pytest.fixture
def platform_on(monkeypatch):
    """Turn the platform check on. One variable does it."""
    monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, PORTAL)


def _portal(
    seen: list,
    profile=PROFILE,
    profile_status=200,
    permission_status=200,
    granted=True,
):
    """A fake Portal. It records every request it answers.

    The permission route answers a bare `true` or `false` with status 200, the
    way the real one does (`Quix.Portal.Api\\Controllers\\AuthController.cs:63-66`).
    """

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == quix_identity.PERMISSIONS_PATH:
            return httpx.Response(permission_status, json=granted)
        if profile_status == 204:
            return httpx.Response(204)
        return httpx.Response(profile_status, json=profile)

    return httpx.MockTransport(handler)


def _dead_portal() -> httpx.MockTransport:
    """A Portal that never answers. The connection is refused."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    return httpx.MockTransport(handler)


# --- the switch -------------------------------------------------------------


def test_an_unset_platform_url_leaves_the_check_off():
    assert quix_identity.enabled() is False


def test_the_one_variable_turns_the_check_on(platform_on):
    assert quix_identity.enabled() is True
    assert quix_identity.portal_url() == PORTAL


def test_a_trailing_slash_never_doubles_in_the_real_request(monkeypatch):
    monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, f"{PORTAL}/")
    seen: list = []
    quix_identity.identify(LIVE_TOKEN, transport=_portal(seen))
    assert str(seen[-1].url) == f"{PORTAL}{quix_identity.PROFILE_PATH}"


# --- branch 1: a good token -------------------------------------------------


def test_a_good_token_gives_the_platform_user_id(platform_on):
    seen: list = []
    identity = quix_identity.identify(LIVE_TOKEN, transport=_portal(seen))

    assert identity.user_id == "auth0|64f0c1"
    assert identity.display_name == "Emanuel Nilsson"
    assert identity.email == "emanuel@volvo.test"
    assert identity.source == "platform"


def test_the_good_token_call_names_the_profile_route_and_sends_the_bearer(platform_on):
    seen: list = []
    quix_identity.identify(LIVE_TOKEN, transport=_portal(seen))

    request = seen[-1]
    assert request.method == "GET"
    assert request.url.path == quix_identity.PROFILE_PATH
    assert request.headers["Authorization"] == f"Bearer {LIVE_TOKEN}"
    assert request.headers["X-Version"] == quix_identity.PORTAL_API_VERSION


def test_a_profile_without_a_name_falls_back_to_the_email(platform_on):
    seen: list = []
    profile = {"userId": "u-1", "email": "person@volvo.test"}
    identity = quix_identity.identify(LIVE_TOKEN, transport=_portal(seen, profile=profile))
    assert identity.display_name == "person@volvo.test"


def test_a_profile_with_no_user_id_is_refused(platform_on):
    seen: list = []
    profile = {"email": "person@volvo.test"}
    with pytest.raises(quix_identity.PlatformRefused):
        quix_identity.identify(LIVE_TOKEN, transport=_portal(seen, profile=profile))


@pytest.mark.parametrize("body", ["not json at all", "[1, 2, 3]", '"a string"'])
def test_a_profile_body_we_cannot_read_fails_closed(platform_on, body):
    """A broken profile answer never becomes an identity."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=body)

    with pytest.raises(quix_identity.PlatformUnreachable):
        quix_identity.identify(LIVE_TOKEN, transport=httpx.MockTransport(handler))


def test_identify_refuses_when_the_switch_is_off():
    """A direct call with the switch off must raise, never reach the network."""
    with pytest.raises(quix_identity.PlatformUnreachable) as error:
        quix_identity.identify(LIVE_TOKEN, transport=_dead_portal())
    assert quix_identity.PORTAL_URL_VAR in str(error.value)


def test_an_empty_profile_is_refused(platform_on):
    seen: list = []
    with pytest.raises(quix_identity.PlatformRefused):
        quix_identity.identify(LIVE_TOKEN, transport=_portal(seen, profile_status=204))


# --- branch 2: a refused token ----------------------------------------------


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_token_raises_and_returns_no_identity(platform_on, status):
    seen: list = []
    with pytest.raises(quix_identity.PlatformRefused):
        quix_identity.identify(LIVE_TOKEN, transport=_portal(seen, profile_status=status))


def _refusal_transports(seen: list):
    """One transport for every branch that raises PlatformRefused."""
    return {
        "the portal says no": _portal(seen, profile_status=401),
        "the workspace says no": _portal(seen, granted=False),
        "the profile is empty": _portal(seen, profile_status=204),
        "the profile names nobody": _portal(seen, profile={"email": "x@y.test"}),
    }


@pytest.mark.parametrize("branch", list(_refusal_transports([])))
def test_no_refusal_message_ever_repeats_the_token(platform_on, monkeypatch, branch):
    """Every refusal branch, not only the first one.

    One branch that interpolates the token would leak it into the 401 body.
    """
    monkeypatch.setenv(quix_identity.WORKSPACE_VAR, WORKSPACE)
    seen: list = []
    with pytest.raises(quix_identity.PlatformRefused) as error:
        quix_identity.identify(LIVE_TOKEN, transport=_refusal_transports(seen)[branch])
    message = str(error.value)
    assert LIVE_TOKEN not in message
    assert PORTAL not in message
    assert WORKSPACE not in message


def test_a_refused_token_never_enters_the_cache(platform_on):
    seen: list = []
    transport = _portal(seen, profile_status=401)
    for _ in range(2):
        with pytest.raises(quix_identity.PlatformRefused):
            quix_identity.identify(LIVE_TOKEN, transport=transport)
    # Both calls reached the Portal. A cached refusal would have hidden one.
    assert len(seen) == 2


# --- branch 3: an expired token ---------------------------------------------


def test_an_expired_token_is_refused(platform_on):
    # The Portal reports an expired token as 401, the same as an unknown one
    # (`QuixTokenAuthHandler.cs:135-138` answers 401 for both).
    seen: list = []
    with pytest.raises(quix_identity.PlatformRefused):
        quix_identity.identify(DEAD_TOKEN, transport=_portal(seen, profile_status=401))


def test_a_token_that_expires_after_a_good_call_stops_working(platform_on, monkeypatch):
    """The cache must never keep a dead token alive past its minute."""
    clock = {"now": 1000.0}
    monkeypatch.setattr(quix_identity.time, "monotonic", lambda: clock["now"])

    seen: list = []
    live = _portal(seen)
    assert quix_identity.identify(DEAD_TOKEN, transport=live).user_id == "auth0|64f0c1"

    # Inside the minute the cache answers and the Portal sees nothing new.
    quix_identity.identify(DEAD_TOKEN, transport=live)
    assert len(seen) == 1

    # The token expires on the platform. The cache entry must expire too.
    clock["now"] += quix_identity.CACHE_SECONDS + 1
    with pytest.raises(quix_identity.PlatformRefused):
        quix_identity.identify(DEAD_TOKEN, transport=_portal(seen, profile_status=401))


def test_a_second_token_does_not_trip_over_the_first_entry(platform_on, monkeypatch):
    """Two cold lookups in a row. The second one sweeps the first one's entry.

    The sweep unpacks every cached entry, so an entry written in one shape and read
    in another fails here and nowhere else — which is exactly how a mismatch reached
    a deployment: every single-lookup test passed, and every request 500ed.
    """
    clock = {"now": 1000.0}
    monkeypatch.setattr(quix_identity.time, "monotonic", lambda: clock["now"])
    seen: list = []

    assert quix_identity.identify(LIVE_TOKEN, transport=_portal(seen)).user_id == "auth0|64f0c1"
    clock["now"] += quix_identity.CACHE_SECONDS + 1
    assert quix_identity.identify(DEAD_TOKEN, transport=_portal(seen)).user_id == "auth0|64f0c1"


# --- branch 4: the platform is unreachable ----------------------------------


def test_an_unreachable_platform_raises_and_never_returns_an_identity(platform_on):
    with pytest.raises(quix_identity.PlatformUnreachable):
        quix_identity.identify(LIVE_TOKEN, transport=_dead_portal())


def test_a_platform_server_error_fails_closed(platform_on):
    seen: list = []
    with pytest.raises(quix_identity.PlatformUnreachable):
        quix_identity.identify(LIVE_TOKEN, transport=_portal(seen, profile_status=500))


def test_an_unreachable_message_carries_no_token_and_no_host(platform_on):
    with pytest.raises(quix_identity.PlatformUnreachable) as error:
        quix_identity.identify(LIVE_TOKEN, transport=_dead_portal())
    message = str(error.value)
    assert LIVE_TOKEN not in message
    assert PORTAL not in message


def test_an_outage_never_enters_the_cache(platform_on):
    for _ in range(2):
        with pytest.raises(quix_identity.PlatformUnreachable):
            quix_identity.identify(LIVE_TOKEN, transport=_dead_portal())
    seen: list = []
    # The platform comes back. The caller must get in at once.
    assert quix_identity.identify(LIVE_TOKEN, transport=_portal(seen)).source == "platform"


# --- the workspace scope ----------------------------------------------------


def test_no_workspace_variable_sends_no_permission_call(platform_on):
    seen: list = []
    quix_identity.identify(LIVE_TOKEN, transport=_portal(seen))
    assert [request.url.path for request in seen] == [quix_identity.PROFILE_PATH]


def test_a_workspace_variable_adds_the_permission_call(platform_on, monkeypatch):
    monkeypatch.setenv(quix_identity.WORKSPACE_VAR, WORKSPACE)
    seen: list = []
    quix_identity.identify(LIVE_TOKEN, transport=_portal(seen))

    permission = seen[0]
    assert permission.url.path == quix_identity.PERMISSIONS_PATH
    # The name is singular. The Portal action binds `permission`
    # (`AuthController.cs:63`). `quixportal` sends `permissions`, which binds to
    # nothing, so this test also guards against copying that bug back in.
    assert dict(permission.url.params) == {
        "resourceType": "Workspace",
        "resourceId": WORKSPACE,
        "permission": quix_identity.WORKSPACE_PERMISSION,
    }


def test_a_caller_outside_the_workspace_is_refused_before_the_profile_call(
    platform_on, monkeypatch
):
    monkeypatch.setenv(quix_identity.WORKSPACE_VAR, WORKSPACE)
    seen: list = []
    with pytest.raises(quix_identity.PlatformRefused):
        quix_identity.identify(LIVE_TOKEN, transport=_portal(seen, permission_status=403))
    assert [request.url.path for request in seen] == [quix_identity.PERMISSIONS_PATH]


def test_a_denial_that_answers_200_with_false_still_refuses(platform_on, monkeypatch):
    """The Portal answers 200 for a denial. Only the body says no.

    `quixportal\\auth\\__init__.py:91` reads the status code alone, so it grants
    every authenticated caller. This test stops us copying that bug.
    """
    monkeypatch.setenv(quix_identity.WORKSPACE_VAR, WORKSPACE)
    seen: list = []
    with pytest.raises(quix_identity.PlatformRefused):
        quix_identity.identify(LIVE_TOKEN, transport=_portal(seen, granted=False))
    # The refusal stopped the run. The profile call never went out.
    assert [request.url.path for request in seen] == [quix_identity.PERMISSIONS_PATH]


@pytest.mark.parametrize("body", [0, "true", {}, []])
def test_a_permission_body_that_is_not_true_never_grants(platform_on, monkeypatch, body):
    monkeypatch.setenv(quix_identity.WORKSPACE_VAR, WORKSPACE)
    seen: list = []
    with pytest.raises(quix_identity.PlatformRefused):
        quix_identity.identify(LIVE_TOKEN, transport=_portal(seen, granted=body))


def test_an_unreadable_permission_body_fails_closed(platform_on, monkeypatch):
    """An empty answer is a broken platform, not a decision. It never grants."""
    monkeypatch.setenv(quix_identity.WORKSPACE_VAR, WORKSPACE)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="")

    with pytest.raises(quix_identity.PlatformUnreachable):
        quix_identity.identify(LIVE_TOKEN, transport=httpx.MockTransport(handler))


def test_a_granted_workspace_call_reaches_the_profile(platform_on, monkeypatch):
    monkeypatch.setenv(quix_identity.WORKSPACE_VAR, WORKSPACE)
    seen: list = []
    identity = quix_identity.identify(LIVE_TOKEN, transport=_portal(seen))
    assert identity.user_id == "auth0|64f0c1"
    assert [request.url.path for request in seen] == [
        quix_identity.PERMISSIONS_PATH,
        quix_identity.PROFILE_PATH,
    ]


# --- the cache --------------------------------------------------------------


def test_a_second_call_reads_the_cache_and_sends_nothing(platform_on):
    seen: list = []
    transport = _portal(seen)
    first = quix_identity.identify(LIVE_TOKEN, transport=transport)
    second = quix_identity.identify(LIVE_TOKEN, transport=transport)
    assert first == second
    assert len(seen) == 1


def test_two_tokens_never_share_a_cache_entry(platform_on):
    seen: list = []
    transport = _portal(seen)
    quix_identity.identify(LIVE_TOKEN, transport=transport)
    quix_identity.identify(DEAD_TOKEN, transport=transport)
    assert len(seen) == 2


def test_a_cached_identity_never_satisfies_a_different_workspace(platform_on, monkeypatch):
    """The workspace belongs in the key, or a cache hit skips the scope check."""
    seen: list = []
    transport = _portal(seen)
    quix_identity.identify(LIVE_TOKEN, transport=transport)
    assert len(seen) == 1

    monkeypatch.setenv(quix_identity.WORKSPACE_VAR, WORKSPACE)
    quix_identity.identify(LIVE_TOKEN, transport=transport)
    # The workspace check really ran. A shared entry would have skipped it.
    assert quix_identity.PERMISSIONS_PATH in [request.url.path for request in seen]


def test_an_expired_entry_leaves_the_cache(platform_on, monkeypatch):
    """A long-lived process must not grow one entry per token, forever."""
    clock = {"now": 1000.0}
    monkeypatch.setattr(quix_identity.time, "monotonic", lambda: clock["now"])

    transport = _portal([])
    quix_identity.identify(LIVE_TOKEN, transport=transport)
    clock["now"] += quix_identity.CACHE_SECONDS + 1
    quix_identity.identify(DEAD_TOKEN, transport=transport)
    assert len(quix_identity._cache) == 1


def test_a_missing_workspace_warns_once(platform_on, caplog):
    """The silent widening must reach the log, and only once."""
    transport = _portal([])
    with caplog.at_level("WARNING"):
        quix_identity.identify(LIVE_TOKEN, transport=transport)
        quix_identity.identify(DEAD_TOKEN, transport=transport)

    warnings = [record for record in caplog.records if record.levelname == "WARNING"]
    assert len(warnings) == 1
    message = warnings[0].getMessage()
    assert quix_identity.WORKSPACE_VAR in message
    assert LIVE_TOKEN not in message


def test_a_set_workspace_warns_about_nothing(platform_on, monkeypatch, caplog):
    monkeypatch.setenv(quix_identity.WORKSPACE_VAR, WORKSPACE)
    with caplog.at_level("WARNING"):
        quix_identity.identify(LIVE_TOKEN, transport=_portal([]))
    assert [r for r in caplog.records if r.levelname == "WARNING"] == []


# --- the dependency: what the caller sees ------------------------------------


def _call(token: str | None, scheme: str = "Bearer"):
    """Run the route dependency the way FastAPI runs it.

    It also proves that the dependency puts the identity on the request. A
    route reads it from there, so a silent drop must fail a test.
    """
    request = Request({"type": "http", "headers": [], "method": "GET", "path": "/"})
    credentials = (
        None if token is None else HTTPAuthorizationCredentials(scheme=scheme, credentials=token)
    )
    identity = auth.require_token(request, credentials)
    assert request.state.identity is identity
    return identity


# branch 5: the static fallback.
def test_the_static_token_still_works_when_the_platform_check_is_on(platform_on):
    quix_identity.TRANSPORT = _dead_portal()
    identity = _call(TEST_TOKEN)
    assert identity.source == "static"
    assert identity is auth.STATIC_IDENTITY


def test_the_static_token_never_reaches_the_platform(platform_on):
    seen: list = []
    quix_identity.TRANSPORT = _portal(seen)
    _call(TEST_TOKEN)
    assert seen == []


def test_the_static_token_still_works_with_the_platform_check_off():
    assert _call(TEST_TOKEN).source == "static"


def test_an_unset_platform_url_keeps_the_old_behavior():
    # The old behavior: anything that is not the static token gets 401, and
    # this process asks nobody.
    with pytest.raises(ApiError) as error:
        _call("wrong-token")
    assert error.value.status_code == 401
    assert error.value.code == "unauthorized"
    assert error.value.detail == "invalid or missing token"


def test_a_missing_token_stays_401_on_both_paths(platform_on):
    with pytest.raises(ApiError) as error:
        _call(None)
    assert error.value.status_code == 401


def test_a_wrong_scheme_stays_401_on_both_paths(platform_on):
    with pytest.raises(ApiError) as error:
        _call(TEST_TOKEN, scheme="Basic")
    assert error.value.status_code == 401


@pytest.mark.parametrize("switch", ["off", "on"])
def test_a_non_ascii_token_answers_401_and_never_500(monkeypatch, switch):
    # Two library calls raise on a string that is not ASCII:
    # `secrets.compare_digest` and the httpx header builder. The caller writes
    # that string, so neither one may become a server error.
    if switch == "on":
        monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, PORTAL)
        seen: list = []
        quix_identity.TRANSPORT = _portal(seen)
    with pytest.raises(ApiError) as error:
        _call("tökén-é")
    assert error.value.status_code == 401
    if switch == "on":
        # The token could never leave this process, so no call went out.
        assert seen == []


@pytest.mark.parametrize("switch", ["off", "on"])
def test_an_unset_static_token_refuses_the_static_path(monkeypatch, switch):
    """An unset TM_API_TOKEN must never turn every token into a key."""
    monkeypatch.delenv("TM_API_TOKEN", raising=False)
    if switch == "on":
        monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, PORTAL)
        quix_identity.TRANSPORT = _portal([], profile_status=401)
    with pytest.raises(ApiError) as error:
        _call(TEST_TOKEN)
    assert error.value.status_code == 401


def test_an_unset_static_token_still_lets_a_platform_token_in(monkeypatch, platform_on):
    monkeypatch.delenv("TM_API_TOKEN", raising=False)
    quix_identity.TRANSPORT = _portal([])
    assert _call(LIVE_TOKEN).user_id == "auth0|64f0c1"


def test_a_good_platform_token_passes_and_names_the_person(platform_on):
    quix_identity.TRANSPORT = _portal([])
    identity = _call(LIVE_TOKEN)
    assert identity.source == "platform"
    assert identity.user_id == "auth0|64f0c1"
    assert identity.display_name == "Emanuel Nilsson"


@pytest.mark.parametrize("branch", list(_refusal_transports([])))
def test_every_refusal_answers_the_one_contract_401_body(platform_on, monkeypatch, branch):
    """The 401 detail never varies, and it never names the reason.

    A detail such as "the caller may not use this workspace" would confirm the
    token is good and only the scope is wrong. The contract also states this
    one string, so a varying detail is drift.
    """
    monkeypatch.setenv(quix_identity.WORKSPACE_VAR, WORKSPACE)
    quix_identity.TRANSPORT = _refusal_transports([])[branch]
    with pytest.raises(ApiError) as error:
        _call(LIVE_TOKEN)
    assert error.value.status_code == 401
    assert error.value.code == "unauthorized"
    assert error.value.detail == auth.REFUSED_DETAIL == "invalid or missing token"


def test_an_unreachable_platform_answers_503_and_never_lets_the_caller_in(platform_on):
    quix_identity.TRANSPORT = _dead_portal()
    with pytest.raises(ApiError) as error:
        _call(LIVE_TOKEN)
    assert error.value.status_code == 503
    assert error.value.code == "platform_unavailable"


# --- end to end through the app ---------------------------------------------


def test_the_app_still_serves_the_static_token_with_the_platform_check_on(
    client, routed_db, platform_on
):
    quix_identity.TRANSPORT = _dead_portal()
    assert client.get("/api/v1/test-runs").status_code == 200


def test_the_app_lets_a_platform_token_through(bare_client, routed_db, platform_on):
    quix_identity.TRANSPORT = _portal([])
    response = bare_client.get(
        "/api/v1/test-runs", headers={"Authorization": f"Bearer {LIVE_TOKEN}"}
    )
    assert response.status_code == 200


def test_the_app_answers_the_contract_401_for_a_refused_platform_token(
    bare_client, routed_db, platform_on
):
    quix_identity.TRANSPORT = _portal([], profile_status=401)
    response = bare_client.get(
        "/api/v1/test-runs", headers={"Authorization": f"Bearer {LIVE_TOKEN}"}
    )
    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"
    assert response.json()["errors"] == []


def test_the_app_answers_503_when_the_platform_is_down(bare_client, routed_db, platform_on):
    quix_identity.TRANSPORT = _dead_portal()
    response = bare_client.get(
        "/api/v1/test-runs", headers={"Authorization": f"Bearer {LIVE_TOKEN}"}
    )
    assert response.status_code == 503
    assert response.json()["code"] == "platform_unavailable"


def test_the_app_refuses_a_platform_token_when_the_check_is_off(bare_client, routed_db):
    response = bare_client.get(
        "/api/v1/test-runs", headers={"Authorization": f"Bearer {LIVE_TOKEN}"}
    )
    assert response.status_code == 401


# --- the name itself ---------------------------------------------------------
#
# Every test above reads the name through `quix_identity.PORTAL_URL_VAR`, so a
# rename of the value would leave them all green. These four tests pin the
# literal string, because the string is the whole decision of 19 Aug 2026.


def test_the_portal_url_variable_is_the_injected_platform_name():
    """The platform injects this name on every deployment.

    `plans/reference/QUIX-INJECTED-VARIABLES.md` cites
    `DeploymentService.cs:2173`. We read the platform name and we invent none.
    """
    assert quix_identity.PORTAL_URL_VAR == "Quix__Portal__Api"


def test_the_injected_name_alone_turns_the_platform_check_on(monkeypatch):
    """One injected variable is the whole configuration. No second name."""
    monkeypatch.setenv("Quix__Portal__Api", PORTAL)

    assert quix_identity.enabled() is True
    assert quix_identity.portal_url() == PORTAL


def test_the_retired_test_manager_name_configures_nothing(monkeypatch):
    """`TM_QUIX_PORTAL_URL` was our own switch until 19 Aug 2026.

    It is dead now. A stale value in a shell or a deployment must change
    nothing, or the old name quietly comes back.
    """
    monkeypatch.delenv("Quix__Portal__Api", raising=False)
    monkeypatch.setenv("TM_QUIX_PORTAL_URL", PORTAL)

    assert quix_identity.enabled() is False
    assert quix_identity.portal_url() == ""


def test_the_app_takes_a_platform_token_on_the_injected_name(
    bare_client, routed_db, monkeypatch
):
    """The end-to-end proof, with the literal name and no constant.

    This is the trap `plans/design/DEPLOYED-AUTH-DIAGNOSIS.md` section 9 named.
    The proxy prefers the viewer's Portal token, and the API refused it while
    the switch stayed unset. The platform injects this name everywhere, so the
    API now accepts that token wherever the app runs.
    """
    monkeypatch.setenv("Quix__Portal__Api", PORTAL)
    quix_identity.TRANSPORT = _portal([])

    response = bare_client.get(
        "/api/v1/test-runs", headers={"Authorization": f"Bearer {LIVE_TOKEN}"}
    )

    assert response.status_code == 200


def test_the_static_token_still_serves_when_the_injected_name_is_absent(
    client, routed_db, monkeypatch
):
    """The local stack and the demo run with no Portal. Nothing there changes."""
    monkeypatch.delenv("Quix__Portal__Api", raising=False)

    assert quix_identity.enabled() is False
    assert client.get("/api/v1/test-runs").status_code == 200
