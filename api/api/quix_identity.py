"""Ask the Quix platform who the caller is.

The static token proves that somebody holds a string. It names nobody. This
module turns a Quix bearer token into a real person, so the journal records an
actor the platform verified.

**This module reads `Quix__Portal__Api`, the name the platform injects.** Unset,
this module does nothing and `auth.py` keeps the static-token behavior exactly.
Set, the API also accepts a live Quix token and learns the caller's identity
from it.

The platform injects the name into every deployment, always, as a plain
variable (`DeploymentService.cs:2173`). So a deployed API takes the platform
path, and it takes it in every environment.

## Why the name changed on 19 Aug 2026

This module read our own name, `TM_QUIX_PORTAL_URL`, until 19 Aug 2026. That
name was a deliberate switch. The reasoning ran like this: the platform injects
`Quix__Portal__Api` into every deployment, so a direct read would turn token
checking on with nobody deciding. An operator set our name, normally to the same
value, when the team was ready.

The backend lead ended that argument on 19 Aug 2026. Two reasons stand:

- **The switch became a trap.** Nobody set it. Meanwhile the front-end proxy
  started to prefer the viewer's own Portal token for `Authorization`, and this
  module refused every such token. A signed-in viewer would then get 401 on
  every screen. See `plans/design/DEPLOYED-AUTH-DIAGNOSIS.md` section 9.
- **One value under two names drifts.** The platform already names this URL, so
  a second name only adds one more way to be wrong.

The history stays here on purpose. Do not build the switch again.

## The pattern this copies

.NET services do this through `Quix.Auth.Middleware` plus `Quix.Auth.Client`:

- `QuixAuthClient` posts the token to `{QuixAuth:BasePath}/tokens/query` with
  header `X-Version: 3.0` and a 5 second timeout
  (`Quix.Users\\Auth\\Quix.Auth.Client\\QuixAuthClient.cs:212-214,:494-501`).
- The answer is a `QuixTokenV3`. The user id is `OwnerId`
  (`Quix.Users\\Auth\\Quix.Auth.Api.Contract\\Responses\\QuixTokenV3.cs:28`).
  The handler writes it as the claim `https://quix.ai/owner_id`
  (`Quix.Auth.Middleware\\QuixToken\\QuixTokenAuthHandler.cs:141,:151`;
  `Quix.Auth.Middleware\\Constants.cs:5`).
- It caches the result in `IMemoryCache` under `...-token:{token}` for
  `QuixAuth:CacheExpiration`, default 60000 ms
  (`QuixAuthClient.cs:525-528`; `ServiceCollectionExtensions.cs:135-138`).
- A token the platform does not know gives 401. An outage gives 503. No branch
  lets the caller in (`QuixTokenAuthHandler.cs:125-138`).
- A workspace scope is data, not an attribute: the scope string is
  `Workspace:{workspaceId}` and `AccessService.HasAccessAsync` matches it
  (`Quix.Auth.Client\\Common\\Scopes.cs:48-56`; `Common\\AccessService.cs:113-138`).

`/tokens/query` belongs to the internal Auth API. A workspace deployment reaches
the **public** Portal API only, so this module uses the two public routes that
the Python services already use:

- `GET /auth/permissions/query` for the workspace scope. QuixLake and the first
  Test Manager both send this call through `quixportal.auth.Auth`
  (`Quix.DataLake.Timeseries\\quix-ts-datalake-api\\auth.py:26-42,:67-69`;
  `Quix.TestManager\\backend\\api\\auth.py:50-55`), and the DevSessions gateway
  sends it by hand (`Quix.DevSessions\\gateway\\token_handler.py:384-393`).
- `GET /profile` for the identity. It answers a `User`
  (`Quix.Portal.Api.Contract\\User.cs:6-39`), and we read `userId`, `email`,
  `firstName` and `lastName`. `Quix.Auth`'s own handler reads the same route for
  the same reason and keeps only `UserId`
  (`Quix.Portal.Api.Client\\AuthClient\\Auth\\QuixAuthenticationHandler.cs:87,:97`).
  The first Test Manager read it
  (`Quix.TestManager\\backend\\api\\routes\\user.py:56-80`) and our own front
  end reads it today (`frontend\\lib\\portal\\client.ts:77`).

## Two traps in the permission call, both found in the Portal source

1. **The parameter is `permission`, singular.** The action signature is
   `QueryPermission(ResourceType resourceType, string resourceId,
   PermissionType permission)`
   (`Quix.Portal.Api\\Controllers\\AuthController.cs:59-66`). `quixportal` sends
   `permissions`, plural (`quixportal\\auth\\__init__.py:83-87`). That name binds
   to nothing, so the action reads the default enum value. Never copy it.
2. **A denial answers 200, not 403.** The action returns `Task<bool>`, so the
   answer is the body `true` or `false` (`AuthController.cs:63-66`).
   `quixportal` reads the status code alone
   (`quixportal\\auth\\__init__.py:91`), so it grants every authenticated caller.
   The .NET client reads the body
   (`Quix.Portal.Api.Client\\AuthClient\\QuixPortalApiService.cs:298-299`). We
   read the body too.

We call both with `httpx`, which the API already depends on. `quixportal` would
serve the first call, but it sits in the `ingest` dependency group and it pulls
`fsspec` and `s3fs` with it, so the API image would grow for fifteen lines of
HTTP.

## Failing closed

Every failure raises. Nothing here returns an identity it could not prove.
`PlatformRefused` becomes 401 and `PlatformUnreachable` becomes 503, which is
what the .NET middleware answers for the same two cases. No message repeats a
token, a header or a host.
"""

import hashlib
import logging
import os
import time
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)

# The Portal base URL. The platform injects this name on every deployment
# (`DeploymentService.cs:2173`). Empty or unset keeps the static-token
# behavior, which is the local path and the test path.
PORTAL_URL_VAR = "Quix__Portal__Api"

# The workspace this API serves. Set it and the platform check also proves the
# caller may touch this workspace. Unset, the check proves identity only.
# The platform injects this name (`DeploymentService.cs:2173`).
WORKSPACE_VAR = "Quix__Workspace__Id"

# The two public Portal routes.
PROFILE_PATH = "/profile"
PERMISSIONS_PATH = "/auth/permissions/query"

# The Portal reads the version from this header. It defaults to 2.0 when the
# header is absent (`Quix.Portal.Api\Startup.cs:260-263`), and both routes we
# call declare `[ApiVersion("2.0")]`. We send it, as every Quix client does.
PORTAL_API_VERSION = "2.0"

# `QuixAuthClient.cs:212` uses five seconds per attempt. We use the same.
TIMEOUT_SECONDS = 5.0

# How long a proven identity is served without asking the Portal again.
#
# The .NET middleware's own default is one minute
# (`ServiceCollectionExtensions.cs:135-138`), and one minute made every screen
# pay a Portal round trip a minute: the runs list polls every ten seconds, each
# API replica holds its own cache, and a token the Portal refreshes is a new
# cache key. Five minutes takes most of that cost off the request path, which
# is the whole of this change: the two Portal calls themselves stay as they were.
#
# It is also the longest a token the platform has revoked keeps working here,
# which is why it is not longer than this, and why nothing is served past it:
# `test_a_token_that_expires_after_a_good_call_stops_working` holds that line.
CACHE_SECONDS = 300.0

# The permission the caller needs on the workspace. QuixLake asks for "All" and
# the first Test Manager asked for "Read". A registry API reads and writes, so
# "Read" is the floor every caller must clear.
WORKSPACE_PERMISSION = "Read"

# The tests set a transport here, so no unit test opens a socket. Production
# leaves it None and `httpx` builds its own.
TRANSPORT: httpx.BaseTransport | None = None

# The Portal answers these when the token is not good enough.
_REFUSED = (401, 403)


class PlatformRefused(Exception):
    """The platform answered, and it said no. The caller gets 401."""


class PlatformUnreachable(Exception):
    """The platform did not answer. The caller gets 503, never a pass."""


@dataclass(frozen=True)
class Identity:
    """Who the caller is.

    `source` is "platform" when the platform proved the identity, and "static"
    when the caller sent the shared token. A journal entry that carries a
    "static" actor names a token holder, not a person.
    """

    user_id: str
    display_name: str
    email: str
    source: str


# The cache key is the hash of the token, never the token itself. A memory dump
# or a debugger then shows no credential. `quixportal` hashes the same way
# (`quixportal\auth\__init__.py:62`).
_cache: dict[str, tuple[Identity, float]] = {}


# The no-workspace warning goes out once, not once per request.
_warned_no_workspace = False


def portal_url() -> str:
    """Return the Portal API base URL. Return an empty string when it is unset."""
    return os.environ.get(PORTAL_URL_VAR, "").strip().rstrip("/")


def workspace_id() -> str:
    """Return the workspace this API serves, or an empty string."""
    return os.environ.get(WORKSPACE_VAR, "").strip()


def enabled() -> bool:
    """Report whether this process checks tokens against the platform."""
    return bool(portal_url())


def reset_cache() -> None:
    """Empty the identity cache. The test harness calls this between cases."""
    global _warned_no_workspace
    _cache.clear()
    _warned_no_workspace = False


def _cache_key(token: str) -> str:
    """Hash the token together with everything the answer depends on.

    The workspace and the Portal belong in the key. Without them an identity
    proven with no workspace check would satisfy a later call that needs one.
    """
    material = f"{token}\n{portal_url()}\n{workspace_id()}"
    return hashlib.sha256(material.encode()).hexdigest()


def _warn_no_workspace() -> None:
    """Say once that this process proves identity but not workspace reach.

    Without a workspace, any live Quix token on the whole platform passes. That
    is a real widening, and an operator must be able to see it in the log.
    """
    global _warned_no_workspace
    if _warned_no_workspace:
        return
    _warned_no_workspace = True
    logger.warning(
        "%s is set but %s is not, so the platform check proves who the caller is "
        "and not that the caller may use this workspace",
        PORTAL_URL_VAR,
        WORKSPACE_VAR,
    )


def _prove(token: str, transport: httpx.BaseTransport | None) -> Identity:
    """Ask the Portal who holds this token.

    The two calls stay in this order, and stay sequential: a caller who may not
    use this workspace is refused BEFORE their profile is read, so the Portal is
    never asked who someone is when the answer cannot be used
    (`test_a_caller_outside_the_workspace_is_refused_before_the_profile_call`).
    """
    with httpx.Client(
        base_url=portal_url(), transport=transport or TRANSPORT, timeout=TIMEOUT_SECONDS
    ) as client:
        _check_workspace(client, token)
        return _read_profile(client, token)


def _drop_expired(now: float) -> None:
    """Remove the entries that timed out. A long-lived process then stays flat."""
    for key in [key for key, (_, until) in _cache.items() if until <= now]:
        _cache.pop(key, None)


def _get(client: httpx.Client, path: str, token: str, params: dict | None = None):
    """Send one Portal request. Raise on a refusal and on an outage."""
    try:
        response = client.get(
            path,
            params=params,
            headers={
                "Authorization": f"Bearer {token}",
                "X-Version": PORTAL_API_VERSION,
            },
        )
    except httpx.HTTPError as error:
        # A refused connection and a timeout both land here. Neither one is a
        # decision about the caller, so neither one may let the caller in.
        raise PlatformUnreachable(
            f"the Quix platform did not answer: {type(error).__name__}"
        ) from error

    if response.status_code in _REFUSED:
        # An expired token and an unknown token both arrive as 401. The Portal
        # makes that decision, so this module reports it and adds nothing.
        raise PlatformRefused("the Quix platform refused the token")
    if response.status_code >= 400:
        # A 500 is the platform's problem, not the caller's. It fails closed as
        # an outage, the way `HttpRetryHelper.cs:144-166` does.
        raise PlatformUnreachable(f"the Quix platform answered {response.status_code}")
    return response


# The public name for the request above. `api/quixlab.py` lists the Portal's
# QuixLabs and must refuse exactly the way this module does: 401 and 403 are a
# decision about the caller, and anything else at 400 or above is an outage.
# One implementation keeps those two rules identical on every Portal call.
portal_get = _get


def _check_workspace(client: httpx.Client, token: str) -> None:
    """Prove the caller may touch this workspace. Skip it when none is set.

    The Portal answers 200 for a denial as well as for a grant, so this reads
    the body. A status check alone would let every authenticated caller in.
    """
    scope = workspace_id()
    if not scope:
        _warn_no_workspace()
        return
    response = _get(
        client,
        PERMISSIONS_PATH,
        token,
        params={
            "resourceType": "Workspace",
            "resourceId": scope,
            "permission": WORKSPACE_PERMISSION,
        },
    )
    try:
        granted = response.json()
    except ValueError as error:
        raise PlatformUnreachable("the Quix platform returned a body we cannot read") from error
    if granted is not True:
        raise PlatformRefused("the caller may not use this workspace")


def _read_profile(client: httpx.Client, token: str) -> Identity:
    """Read the caller's profile and build the identity."""
    response = _get(client, PROFILE_PATH, token)
    if response.status_code == 204:
        # An empty profile proves nothing about who called.
        raise PlatformRefused("the Quix platform returned an empty profile")
    try:
        data = response.json()
    except ValueError as error:
        raise PlatformUnreachable("the Quix platform returned a body we cannot read") from error
    if not isinstance(data, dict):
        raise PlatformUnreachable("the Quix platform returned a body we cannot read")

    user_id = (data.get("userId") or "").strip()
    if not user_id:
        # `QuixTokenAuthHandler.cs:141` rejects an empty owner id too. An
        # identity without an id is the client's claim again, so it fails.
        raise PlatformRefused("the Quix platform named no user")

    email = (data.get("email") or "").strip()
    first = (data.get("firstName") or "").strip()
    last = (data.get("lastName") or "").strip()
    display_name = " ".join(part for part in (first, last) if part) or email or user_id
    return Identity(user_id=user_id, display_name=display_name, email=email, source="platform")


def identify(token: str, transport: httpx.BaseTransport | None = None) -> Identity:
    """Prove who holds this token, and return that person.

    Raise `PlatformRefused` when the platform says no. Raise
    `PlatformUnreachable` when the platform does not answer. Never return an
    identity this module could not prove.
    """
    if not portal_url():
        raise PlatformUnreachable(f"{PORTAL_URL_VAR} is not set")
    if not token.isascii():
        # A header value must encode to latin-1, so a non-ASCII token cannot
        # even leave this process. `httpx` raises a UnicodeEncodeError, which is
        # not an `httpx.HTTPError` and would escape as a 500. The caller writes
        # this string, so it is a bad token and it answers 401. Every Quix token
        # is a JWT or hexadecimal, and both are ASCII.
        raise PlatformRefused("the token is not a Quix token")

    now = time.monotonic()
    key = _cache_key(token)
    cached = _cache.get(key)
    if cached is not None and cached[1] > now:
        return cached[0]

    identity = _prove(token, transport)

    # Only a proven identity enters the cache. A refusal and an outage stay
    # out, so a timeout never poisons the next requests.
    _drop_expired(now)
    _cache[key] = (identity, time.monotonic() + CACHE_SECONDS)
    return identity
