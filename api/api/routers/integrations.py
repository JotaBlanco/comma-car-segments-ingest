"""GET /integrations/quixlab-url — the one route the launch controls call.

**Why the route exists.** The launch controls and the embedded frame must not
guess a host. The operator names it once, on this deployment, and every caller
reads it here. That keeps ONE name for ONE value.

**Why the route does not ask the Portal.** It could. `GET
/workspaces/{id}/deployments` answers a DTO carrying `PublicUrl`
(`Quix.Portal.Api.Contract/Deployment.cs:82`) and `LibraryItemId` (`:196`), and
QuixLab's library item id is the literal "quixlab"
(`QuixLabDescriptorDefinition.cs:36`). The blocker is the credential: a Portal
call needs a Portal token, and this route's one caller
(`frontend/lib/quixlab-server.ts`) calls server-side with the static
`TM_API_TOKEN`. A Portal answer would serve a browser call and fail the layout
call, so the route would carry two paths and two more failure modes. The answer
shape below does not change if a later revision resolves it through the Portal.

**Why the answer still carries no run id.** QuixLab does take a named run now,
but never through a URL. The parent frames `embed_url`, answers
`REQUEST_AUTH_TOKEN` with `AUTH_TOKEN {token}`, then posts `TM_IMPORT {runId}`;
the frame POSTs the run id to its own `/api/import/run` with the session cookie
(`quixlab/src/quixlab/server/embed.py`). The run id therefore travels in memory,
after a session exists, and this route needs no field for it. Adding one would
put a run id back in a browser history and a proxy log for nothing.

The new-tab path stays, and it is the fallback. It opens `url` plus the constant
deep link `?open=analysis&kind=notebook`
(`quixlab/src/quixlab/server/static/js/pickers.js:16-24`), and that notebook
finds the newest run itself, because a tab has no parent to post `TM_IMPORT`.
So: the **tab** opens a notebook that guesses; the **frame** opens one named run.

**Why the answer carries `embed_url` and `origin`.** Both come from the same
proved value, so no caller repeats string work this route already did.
`embed_url` appends the one flag an embedded page reads. `origin` is the
`targetOrigin` the parent must post the token to; `"*"` would hand that token to
whatever the frame navigated to.

**Why the answer carries no token, ever.** The old Test Manager put a bearer in
the QuixLab query string (`Quix.TestManager/backend/api/routes/integrations.py:311`).
QuixLab reads no `?token=` on any route — it authenticates with the
`quix_session` cookie (`quixlab/src/quixlab/server/auth.py:53,57`) — so that
parameter bought nothing and leaked a credential into a browser history, a
proxy log and a referrer header. `_checked_base` below refuses any configured
value that carries a query, a fragment or userinfo, so no answer of this route
can hold a credential.
"""

import logging
import os
from urllib.parse import urlsplit

from fastapi import APIRouter, Request

from api import quix_identity, quixlab
from api.errors import ApiError
from api.models.integrations import (
    FlightTestStationUrl,
    LakehouseUrl,
    QuixLabInstance,
    QuixLabList,
    QuixLabUrl,
)

logger = logging.getLogger(__name__)

# The flag and the origin rule live in `api/quixlab.py`, because the Portal
# listing below builds the same values for every instance it finds. Re-exported
# here so a caller of this router keeps one import.
EMBED_QUERY = quixlab.EMBED_QUERY
_embed_url = quixlab.embed_url
_origin = quixlab.origin

router = APIRouter(tags=["integrations"])

# The one name an operator sets. The front end reads the value from this route,
# never from its own environment, so the name lives on one deployment only.
QUIXLAB_URL_VAR = "TM_QUIXLAB_URL"

# The station's PUBLIC root: an iframe src resolves in the browser.
FTS_URL_VAR = "TM_FTS_URL"

_ALLOWED_SCHEMES = frozenset({"http", "https"})


def _checked_base(value: str, variable: str, code: str) -> str:
    """Return the configured site root, or raise 409 naming the fault.

    A launch control hands this string to `window.open`, so the route proves
    four things before it answers:

    1. the scheme is http or https, so no `javascript:` URL reaches the browser;
    2. a host is present, so the value is an absolute address;
    3. no query and no fragment, so the caller can append its deep link and no
       credential can hide in the value;
    4. no userinfo, for the same reason as 3.

    Every integration this router resolves rests on the same four, so the
    variable name and the error code are arguments: a message must name the one
    variable an operator has to fix.
    """
    parts = urlsplit(value)
    if parts.scheme not in _ALLOWED_SCHEMES or not parts.hostname:
        raise ApiError(
            409,
            f"{variable} must be an absolute http or https URL",
            code,
        )
    if parts.query or parts.fragment or parts.username or parts.password:
        raise ApiError(
            409,
            f"{variable} must be the site root, with no query, no fragment and no credential",
            code,
        )
    return value


@router.get("/integrations/quixlab-url")
def get_quixlab_url() -> QuixLabUrl:
    """Answer where QuixLab is, so a control can open it or frame it.

    The variable is read at call time, the same rule `settings.py` follows, so a
    redeploy changes the answer without a rebuild.

    An unset variable is a plain configuration state and not a fault of the
    request, so the answer is **409** with the code `quixlab_not_configured` and
    a sentence a person can act on. It is never a bare 404, and it is never a
    guessed host. The front end reads that refusal as "no QuixLab", and every
    launch control then stays hidden.
    """
    configured = os.environ.get(QUIXLAB_URL_VAR, "").strip()
    if not configured:
        raise ApiError(
            409,
            f"no QuixLab is configured — set {QUIXLAB_URL_VAR} on this "
            "deployment to the QuixLab site root",
            "quixlab_not_configured",
        )
    base = _checked_base(configured, QUIXLAB_URL_VAR, "quixlab_url_invalid")
    return QuixLabUrl(url=base, embed_url=_embed_url(base), origin=_origin(base))


@router.get("/integrations/fts-url")
def get_fts_url() -> FlightTestStationUrl:
    """Answer where the Flight Test Station is, so a run can open in it.

    The value must be the station's PUBLIC url: an iframe `src` resolves in the
    browser, so `network.serviceName` cannot serve here. The answer names a
    place only — the caller appends the run and the picked signals itself — and
    it never carries a token, which reaches the station over postMessage
    because it is framed two deep and the plugin SDK reaches a direct child.

    An unset variable is configuration, not a fault: 409 `fts_not_configured`,
    which the front end reads as "no station" and the panel then hides.
    """
    configured = os.environ.get(FTS_URL_VAR, "").strip()
    if not configured:
        raise ApiError(
            409,
            f"no Flight Test Station is configured — set {FTS_URL_VAR} on "
            "this deployment to the station's public site root",
            "fts_not_configured",
        )
    base = _checked_base(configured, FTS_URL_VAR, "fts_url_invalid")
    return FlightTestStationUrl(url=base, origin=_origin(base))


@router.get("/integrations/lakehouse-url")
def get_lakehouse_url() -> LakehouseUrl:
    """Answer the Portal's Lakehouse page for this workspace, or an empty URL.

    The value comes from the two injected names the API already reads, and the
    route calls no Portal endpoint. So it answers at once, it needs no viewer
    token, and a Portal outage cannot break it.

    An empty `url` is a plain state, not a fault: the local stack has no
    `Quix__Portal__Api`, and a host the derivation rule cannot read gives the
    same answer. The front end then shows no Lakehouse link. This route does
    not ask the Portal whether a Lakehouse exists: a viewer who follows the
    link lands on the Portal's own Lakehouse page, and that page states its own
    state inside the Portal chrome.
    """
    return LakehouseUrl(url=quixlab.portal_lakehouse_url())


@router.get("/integrations/quixlabs")
def list_quixlabs(request: Request) -> QuixLabList:
    """List every QuixLab in the workspace, so a person can pick one.

    **Why this route exists.** One `TM_QUIXLAB_URL` names one QuixLab, and a
    dropdown needs many. This asks the Portal for both kinds: the shared
    deployments and the viewer's own dev sessions. Every row says which kind it
    is, because a dev session belongs to one person and a deployment does not.

    **Whose token, and why it is not the bearer.** The viewer's Portal token,
    read from `x-portal-token` — the same header
    `routers/explore_chat.py:95` reads, forwarded by the proxy
    (`frontend/app/api/proxy/[...path]/route.ts`). The bearer cannot serve:
    `api/auth.py` verifies it and keeps only an identity, and it never gives the
    token back. It is also the wrong token on the demo path, where the bearer is
    the shared `TM_API_TOKEN` and names no person. A dev-session list is
    personal, so the viewer's own token is what makes the answer correct.

    **An empty list is an ordinary answer.** No Portal, no workspace, no viewer
    token, or a workspace with no QuixLab all answer `{"items": []}`. Each one
    logs its reason. The caller then falls back to
    `GET /integrations/quixlab-url`, which is why that route stays.

    **Every deployment row carries `portal_embedded_url`.** That is the Portal
    page which frames the deployment, and it is where a launch control sends a
    person. `api/api/quixlab.py` builds it and names the one assumption it
    rests on. A dev session and an underivable Portal host both answer with an
    empty string, and the caller then opens `url` as it always did.

    **503 when the Portal is configured and it did not answer.** An outage must
    not read as "there are none", because the front end would quietly show an
    empty dropdown and nobody would know the platform was down.
    """
    token = (request.headers.get("x-portal-token") or "").strip()
    try:
        found = quixlab.list_instances(token)
    except quix_identity.PlatformRefused:
        # The Portal decided about this viewer. That is not an outage, and it
        # is not this API's decision to overturn. An empty dropdown plus the
        # configured fallback is the honest answer.
        logger.info("the Quix platform refused the QuixLab list for this viewer")
        found = []
    except quix_identity.PlatformUnreachable as error:
        raise ApiError(503, str(error), "platform_unavailable") from error

    return QuixLabList(
        items=[
            QuixLabInstance(
                id=item.id,
                name=item.name,
                kind=item.kind,
                status=item.status,
                url=item.url,
                embed_url=quixlab.embed_url(item.url),
                origin=quixlab.origin(item.url),
                portal_embedded_url=item.portal_embedded_url,
            )
            for item in found
        ]
    )
