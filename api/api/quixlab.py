"""Where QuixLab is: the URL shapes, and the list the Portal knows.

Two jobs live here, and the router serves both.

**The URL shapes.** One configured site root turns into three values: the root
itself, the address an iframe loads, and the origin a parent posts messages to.
They live here and not in the router, because the Portal listing below builds
the same three values for every instance it finds. One spelling, one place.

**The list.** An operator's single `TM_QUIXLAB_URL` cannot fill a dropdown, so
this module asks the Portal for every QuixLab in the workspace: the shared
deployments and the personal dev sessions. A person picking from that list must
be able to tell the two apart, so every entry names its `kind`.

**Two platform rules this module keeps.**

1. It reads the canonical injected names through `quix_identity`:
   `Quix__Portal__Api` and `Quix__Workspace__Id`. It never defines a second
   name for a value the platform already injects.
2. It reads the Portal's **response body**, never the status. The Portal
   answers a denial with 200 and a body of `false`, so a status check would
   pass every authenticated caller.

**Whose token.** The viewer's. A list of dev sessions is personal, so a shared
service token would answer the wrong question as well as being the wrong
credential. The caller hands the viewer's Portal token in, and the route reads
it from the `x-portal-token` header, the way `routers/explore_chat.py:95`
already does.
"""

import logging
from urllib.parse import quote, urlsplit

import httpx

from api import quix_identity
from api.quix_identity import PlatformRefused, PlatformUnreachable

logger = logging.getLogger(__name__)

# The one query QuixLab reads on an embedded page. It compares the value to the
# string "true" (`quixlab/src/quixlab/server/ai/iframe_config.py:184`), so the
# spelling is exact. It names a display mode. It is not a credential and it is
# not a permission.
EMBED_QUERY = "isIframe=true"

# The library item every QuixLab application is built from. The Portal stamps
# it on the deployment, so this is how a client tells a QuixLab from any other
# deployment in the workspace.
QUIXLAB_LIBRARY_ITEM_ID = "quixlab"

# What a caller may pick. A deployment is shared and stable. A dev session
# belongs to one person and it stops. The two must never read alike in a list.
KIND_DEPLOYMENT = "deployment"
KIND_DEVSESSION = "devsession"

_ALLOWED_SCHEMES = frozenset({"http", "https"})


def embed_url(base: str) -> str:
    """Return the address an iframe loads: the site root plus the embed flag.

    Every caller of this function passes a value that `checked_base` accepted,
    so the value carries no query and the separator is always `?`, never `&`.
    """
    return f"{base}?{EMBED_QUERY}"


def origin(base: str) -> str:
    """Return `scheme://host[:port]`, the origin of *base*.

    The parent posts the auth token to the frame with this exact value as the
    `targetOrigin`, and it drops any message whose `event.origin` does not
    match. A `postMessage` sent to `"*"` hands the token to whatever page the
    frame navigated to, so this value is what keeps the credential inside the
    frame.

    A host name is case-insensitive and a browser reports the origin in lower
    case, so this lowers the case too and the comparison holds. `checked_base`
    already refused userinfo, so `netloc` is host and port only.
    """
    parts = urlsplit(base)
    return f"{parts.scheme.lower()}://{parts.netloc.lower()}"


def usable_site_root(value: str) -> str | None:
    """Return the site root of *value*, or None when a browser must not open it.

    This is the same four-part proof `routers/integrations.py` applies to the
    configured variable, in the shape the Portal listing needs: a bad entry is
    dropped from the list rather than failing the whole call. One bad row in
    the Portal must not hide every good one.
    """
    candidate = (value or "").strip()
    if not candidate:
        return None
    parts = urlsplit(candidate)
    if parts.scheme not in _ALLOWED_SCHEMES or not parts.hostname:
        return None
    if parts.query or parts.fragment or parts.username or parts.password:
        return None
    return candidate


# --- The Portal's own embedded view of a deployment ---------------------------
#
# A launch control must land a person INSIDE the Portal, framed, and not on the
# raw deployment host. The Portal route that does it is
# `/pipeline/deployments/{deploymentId}/embedded?workspace={workspaceId}`
# (`Quix.Portal.Frontend .../shared/utils/quix-utils.ts:809`, matched by
# `.../workspace/deployments/deployments.routes.ts:9-15`). That page frames the
# deployment, sets `isIframe=true` itself, and copies EVERY extra query
# parameter of its own URL into the frame's URL
# (`.../plugins/pages/plugins-detail-page/plugins-detail-page.component.ts:163-168`).
# So a deep link appended here reaches QuixLab unchanged.
#
# THE ONE ASSUMPTION IN THIS FILE, AND IT IS NAMED ON PURPOSE.
# The platform injects the Portal *API* host and nothing else. It injects NO
# name for the Portal *web* host, and the two differ: `portal-api.dev.quix.io`
# answers the API, `portal.dev.quix.io` serves the page. So we derive the web
# host: drop `-api` from the FIRST label. The Portal builds both hosts from one
# suffix with that exact pair of spellings, which is why the rule holds:
#   - `Quix__Portal__Api` is `EnvironmentConfiguration.SiteUri`
#     (`Quix.Portal.Application/Deployments/DeploymentService.cs:2173`), built as
#     `https://portal-api.{subdomain}`
#     (`Quix.Portal.Domain/Shared/EnvironmentConfiguration.cs:37-40`);
#   - the web host is the same expression with the other label,
#     `https://portal.{subdomain}`
#     (`Quix.Portal.Infrastructure/Shared/NotificationApiAlertingService.cs:47-49`);
#   - the Portal recovers the suffix from the API host by removing this exact
#     literal: `env.Replace("portal-api.", "")`
#     (`Quix.Portal.Application/CliAnalytics/CliMetricsService.cs:96`);
#   - the platform chart feeds one domain to both:
#     `portalBaseUrl: https://portal.{{ zoneDomain }}` and
#     `longFormSubdomain: {{ zoneDomain }}`
#     (`Infrastructure.BYOC2000/values/platform/services/portal-api.yaml.gotmpl:8,:20`).
# It is a convention, not a compiled rule. `General:PortalBasePath` is a free
# Helm string, so an operator could break the pair. That is the risk we take,
# and the fallback below is what we take it against.
#
# We do NOT invent a variable for this. A name nobody sets is a trap, and this
# workspace already paid for that one with `TM_QUIX_PORTAL_URL`. When the rule
# does not match, this returns an empty string and every caller keeps today's
# direct link. It fails to the old behavior, and never to a guessed host.
PORTAL_API_LABEL = "portal-api"
PORTAL_WEB_LABEL = "portal"
EMBEDDED_PATH = "/pipeline/deployments/{deployment_id}/embedded"


def portal_web_base() -> str:
    """Return the Portal *web* site root, or an empty string.

    An empty answer is an ordinary state: no `Quix__Portal__Api`, which is the
    local stack and the test path, or a host whose first label is not
    `portal-api`. A caller then keeps the direct deployment URL.
    """
    parts = urlsplit(quix_identity.portal_url())
    host = (parts.hostname or "").lower()
    if parts.scheme not in _ALLOWED_SCHEMES or not host:
        return ""
    if not host.startswith(f"{PORTAL_API_LABEL}."):
        return ""
    web_host = PORTAL_WEB_LABEL + host[len(PORTAL_API_LABEL) :]
    port = f":{parts.port}" if parts.port else ""
    return f"{parts.scheme.lower()}://{web_host}{port}"


def portal_embedded_url(deployment_id: str, workspace: str) -> str:
    """Return the Portal page that frames *deployment_id*, or an empty string.

    Both ids are quoted, so neither can add a query parameter and neither can
    climb the path. Neither id is a credential.
    """
    base = portal_web_base()
    if not base or not deployment_id or not workspace:
        return ""
    path = EMBEDDED_PATH.format(deployment_id=quote(deployment_id, safe=""))
    return f"{base}{path}?workspace={quote(workspace, safe='')}"


LAKEHOUSE_PATH = "/lakehouse"


def portal_lakehouse_url() -> str:
    """Return the Portal's Lakehouse page for this workspace, or an empty string.

    The Portal serves `/lakehouse?workspace={workspaceId}` as a page of its own
    (`Quix.Portal.Frontend .../app.routes.ts:137-141`). That page resolves the
    Lakehouse itself and runs its own token handshake, so this link needs no
    deployment id and carries no credential. This function reads only the two
    injected names this module already reads, and it calls no Portal route.

    Empty when `portal_web_base` derives no web host, or when this process
    knows no workspace. The front end then shows no Lakehouse link.
    """
    base = portal_web_base()
    workspace = quix_identity.workspace_id()
    if not base or not workspace:
        return ""
    return f"{base}{LAKEHOUSE_PATH}?workspace={quote(workspace, safe='')}"


# The two Portal routes this module calls. Both declare `[ApiVersion("2.0")]`,
# which is the version `quix_identity.PORTAL_API_VERSION` already sends.
#   `Quix.Portal.Api/Controllers/DeploymentController.cs:206`
DEPLOYMENTS_PATH = "/workspaces/{workspace_id}/deployments"
# The dev-session route is the CURRENT USER's list, and that choice matters.
# `dev-sessions/workspace/{workspaceId}` (`DevSessionsController.cs:68`) exists
# and its own summary says "Manager+ access required", so it refuses exactly
# the viewer who wants the dropdown. `GET dev-sessions`
# (`DevSessionsController.cs:57`) needs no elevated role, and a dev session is
# personal anyway: showing a viewer only their own is correct behavior, not a
# limitation. This module filters that list to the workspace itself.
DEVSESSIONS_PATH = "/dev-sessions"


class QuixLabInstance:
    """One QuixLab a person may pick, from either kind.

    `kind` is the field that stops a person opening somebody else's machine by
    accident. A deployment is shared and it stays up. A dev session belongs to
    one person, it stops, and it is not a place to send a colleague.

    `portal_embedded_url` is where a launch control sends a person: the Portal
    page that frames this instance. It is empty for a dev session, because the
    Portal route names a DEPLOYMENT id and a dev session has none, and empty
    when `portal_web_base` could not derive the web host. Empty means "open the
    direct URL", which is what every control did before.
    """

    __slots__ = ("id", "kind", "name", "portal_embedded_url", "status", "url")

    def __init__(
        self,
        *,
        id: str,
        name: str,
        kind: str,
        status: str,
        url: str,
        portal_embedded_url: str = "",
    ) -> None:
        self.id = id
        self.name = name
        self.kind = kind
        self.status = status
        self.url = url
        self.portal_embedded_url = portal_embedded_url


def _text(row: dict, *names: str) -> str:
    """Read the first present name off a Portal row, as a stripped string.

    The Portal serializes camelCase. A name is passed explicitly rather than
    guessed, so a renamed field shows up as an empty value and never as a wrong
    one.
    """
    for name in names:
        value = row.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _rows(response: httpx.Response) -> list[dict]:
    """Read the Portal's answer body as a list of rows.

    **The body is the answer, never the status.** The Portal replies 200 with a
    body of `false` when it refuses, so a status check would read a denial as a
    grant. Anything that is not a list of objects is not a list of QuixLabs,
    and this returns nothing rather than guessing.
    """
    try:
        body = response.json()
    except ValueError as error:
        raise PlatformUnreachable(
            "the Quix platform returned a body we cannot read"
        ) from error
    if not isinstance(body, list):
        # `false` lands here, and so does any error object. Neither is a list.
        raise PlatformRefused("the Quix platform did not answer with a list")
    return [row for row in body if isinstance(row, dict)]


def _deployments(client: httpx.Client, token: str, workspace: str) -> list[QuixLabInstance]:
    """The shared QuixLab deployments of the workspace.

    A deployment carries `libraryItemId` (`Quix.Portal.Api.Contract/Deployment.cs:196`),
    and every QuixLab is built from the library item "quixlab"
    (`QuixLabDescriptorDefinition.cs:36`). That is the whole filter.
    """
    response = quix_identity.portal_get(
        client, DEPLOYMENTS_PATH.format(workspace_id=workspace), token
    )
    out: list[QuixLabInstance] = []
    for row in _rows(response):
        if _text(row, "libraryItemId").lower() != QUIXLAB_LIBRARY_ITEM_ID:
            continue
        url = usable_site_root(_text(row, "publicUrl"))
        if url is None:
            # A deployment with no public URL is not somewhere a browser can go.
            continue
        deployment_id = _text(row, "deploymentId")
        out.append(
            QuixLabInstance(
                id=deployment_id,
                name=_text(row, "name") or "QuixLab",
                kind=KIND_DEPLOYMENT,
                status=_text(row, "status"),
                url=url,
                # The Portal page that frames this deployment. Empty when we
                # could not derive the Portal web host, and the caller then
                # opens `url` exactly as it did before.
                portal_embedded_url=portal_embedded_url(deployment_id, workspace),
            )
        )
    return out


def _dev_sessions(client: httpx.Client, token: str, workspace: str) -> list[QuixLabInstance]:
    """This viewer's own QuixLab dev sessions, narrowed to this workspace.

    **A dev session carries no `libraryItemId`.** The per-session contract model
    has no such field (`Quix.Portal.Api.Contract/DevSession.cs`). It carries
    `descriptorId` instead (`:54`), and a QuixLab session's value is the literal
    "quixlab": `DevSessionsController.cs:376-383` maps that string to
    `DevSessionDescriptorType.QuixLab`. That mapping calls `ToLowerInvariant()`
    first, which proves the stored value may be mixed case, so this compares
    case-insensitively too.

    **The Portal route answers the caller's own sessions**, so this function
    filters by `workspaceId` itself. The viewer's token is what makes the answer
    correct; a shared service token would list somebody else's machines.
    """
    response = quix_identity.portal_get(client, DEVSESSIONS_PATH, token)
    out: list[QuixLabInstance] = []
    for row in _rows(response):
        if _text(row, "descriptorId").lower() != QUIXLAB_LIBRARY_ITEM_ID:
            continue
        if _text(row, "workspaceId") != workspace:
            # The route is organization-wide for this user. Only this
            # workspace's sessions belong in this API's answer.
            continue
        url = usable_site_root(_text(row, "publicUrl"))
        if url is None:
            # A stopped session keeps its row and loses its address. It is not
            # offered, because a dead entry that looks live is worse than none.
            continue
        out.append(
            QuixLabInstance(
                id=_text(row, "id"),
                name=_text(row, "name") or "QuixLab dev session",
                kind=KIND_DEVSESSION,
                status=_text(row, "status"),
                url=url,
            )
        )
    return out


# `quixlab_provision` reads the same Portal rows this module reads, and it must
# read a renamed field the same way: as empty, never as a wrong value. One
# implementation keeps that true. The `portal_get = _get` line in
# `quix_identity` is the same move for the same reason.
read_text = _text
read_rows = _rows


def list_instances(token: str) -> list[QuixLabInstance]:
    """Every QuixLab in the workspace this viewer may open, both kinds.

    Returns an empty list when this deployment cannot ask: no
    `Quix__Portal__Api`, no `Quix__Workspace__Id`, or no viewer token. Those are
    the local path and the demo path, and the caller falls back to the one
    configured URL. Each of them logs its reason once per call, so an operator
    who expected a list can see why there is none.

    Raises `PlatformUnreachable` when the Portal is configured and it did not
    answer. That is an outage, and the caller must not read it as "none".
    """
    base = quix_identity.portal_url()
    workspace = quix_identity.workspace_id()
    if not base or not workspace or not token:
        logger.info(
            "quixlab discovery is off: portal=%s workspace=%s viewer_token=%s",
            bool(base),
            bool(workspace),
            bool(token),
        )
        return []
    if not token.isascii():
        # A header value must encode to latin-1, so a non-ASCII token cannot
        # leave this process. `quix_identity.identify` refuses the same way.
        raise PlatformRefused("the token is not a Quix token")

    found: list[QuixLabInstance] = []
    failures: list[Exception] = []
    with httpx.Client(
        base_url=base,
        transport=quix_identity.TRANSPORT,
        timeout=quix_identity.TIMEOUT_SECONDS,
    ) as client:
        # The two sources are independent on purpose. A viewer with no dev
        # sessions, or a Portal that refuses one call, still gets the other.
        # Refusing the whole list would hide the shared QuixLabs, which is the
        # common case and the one the demo needs.
        for source, fetch in (
            (KIND_DEPLOYMENT, _deployments),
            (KIND_DEVSESSION, _dev_sessions),
        ):
            try:
                found += fetch(client, token, workspace)
            except (PlatformRefused, PlatformUnreachable) as error:
                logger.info(
                    "the QuixLab %s list failed for this viewer: %s", source, error
                )
                failures.append(error)

    if len(failures) == 2 and any(
        isinstance(error, PlatformUnreachable) for error in failures
    ):
        # Both sources failed and at least one was an outage. "No QuixLabs" would
        # be a lie the front end shows as an empty dropdown, so this fails loud.
        raise PlatformUnreachable("the Quix platform did not answer for either list")

    # Deployments first: they are the shared, stable choice. Then by name, so
    # the order of a dropdown never depends on the Portal's row order.
    found.sort(key=lambda item: (item.kind != KIND_DEPLOYMENT, item.name.lower()))
    return found
