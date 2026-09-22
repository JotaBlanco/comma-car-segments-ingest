"""Bearer authentication for every /api/v1 route.

Two paths live here, and one variable chooses between them.

**`Quix__Portal__Api` unset — the demo path.** The token is the value of
`TM_API_TOKEN` and the check is a string comparison. This is the behavior the
demo has always had, and nothing about it changes. The local stack and the test
suite run on this path.

**`Quix__Portal__Api` set — the platform path.** The static token still works
and it is still tried first, so the demo never breaks. A token that is not the
static one goes to the Quix platform, which names the caller. See
`api/quix_identity.py` for the platform calls and the services they copy.

**The name changed on 19 Aug 2026.** This module read our own
`TM_QUIX_PORTAL_URL` until then. The platform injects `Quix__Portal__Api` into
every deployment, so a deployed API now always takes the platform path.
`api/quix_identity.py` holds the full history of that decision.

The static token proves that somebody holds a string. The platform path proves
who the caller is, so a journal entry becomes an audit record instead of a
claim the client typed.

/health and /ready stay open on both paths.

**Every 401 this module raises writes one WARNING** (21 Aug 2026, FR-DM-055).
A refused request used to write nothing at all, so nobody could count the
refusals. The line names the route, the caller address and the reason, and it
never names the token. See `_refuse`.
"""

import logging
import secrets
from typing import Annotated, Self

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from api import quix_identity
from api.errors import ApiError
from api.models.journal import PLACEHOLDER_ACTORS
from api.settings import get_settings

logger = logging.getLogger(__name__)

_scheme = HTTPBearer(auto_error=False)

# One 401 body for every refusal, on both paths. The contract states this exact
# string (§A "Auth"). It is also the safer answer: "the caller may not use this
# workspace" would confirm that the token itself is good, and a caller learns
# nothing it may act on from that.
REFUSED_DETAIL = "invalid or missing token"

# The static token names a token holder and never a person. The journal must be
# able to say so, so the identity carries a name nobody can mistake for a user.
STATIC_IDENTITY = quix_identity.Identity(
    user_id="static-token",
    display_name="static token holder",
    email="",
    source="static",
)


class VerifiedActor(str):
    """The actor name, with the stable Portal user id attached.

    A display name does not point at one person for ever. A person renames it,
    and two people can carry the same one. The Portal `userId` never changes,
    so a journal row must keep it beside the name.

    This class **is** a `str`. It compares equal to the name, it hashes as the
    name, and Mongo stores it as the name. So every route, every service and
    every test that reads the actor keeps its behavior exactly.

    `provenance.actor_id` reads the id back off it. A plain string carries no
    id, which is the demo path and every caller that names a service.

    One trap: `str` methods return a plain `str`. `actor.strip()` drops the id.
    Read the id first, then clean the name. `provenance.set_field` does that.
    """

    actor_id: str | None

    def __new__(cls, name: str, actor_id: str | None) -> Self:
        actor = super().__new__(cls, name)
        actor.actor_id = actor_id
        return actor


def require_token(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_scheme)],
) -> quix_identity.Identity:
    """Prove the caller, and return the identity.

    The route dependency in `main.py` ignores the return value. A route that
    needs the caller adds `Depends(require_token)` and reads it.
    """
    # `HTTPBearer(auto_error=False)` answers None for a missing header AND for
    # a header that names another scheme, so the two cases share one reason.
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _refuse(request, "the request carries no bearer credential")

    if _matches_static(credentials.credentials):
        identity = STATIC_IDENTITY
    elif quix_identity.enabled():
        identity = _identify(request, credentials.credentials)
    else:
        raise _refuse(
            request,
            "the token is not the static token, and no platform can name the caller",
        )

    request.state.identity = identity
    return identity


def _refuse(request: Request, reason: str) -> ApiError:
    """Record one refusal, and build the 401 the caller reads.

    The security review found that a refused request wrote no record at all,
    so nobody could count the refusals or see a route being probed
    (FR-DM-055, NFR-DM-049, UC-006). Every 401 of this module now leaves one
    line.

    **The line never carries the credential, and never a prefix of it.** A
    prefix is credential material: it shortens a guess, and it names the
    holder to anybody who reads the log. The line names the route, the caller
    address and the reason, which is what an operator acts on.

    The reason is one of a fixed set this module writes itself. No caller
    string reaches it, so a header can never inject a line of its own.

    It is a warning, not an error: a refused call is a normal event on a
    public route, and the service is healthy. The body stays REFUSED_DETAIL
    for every reason, so the log tells the operator apart from the caller.
    """
    client = request.client.host if request.client else "unknown"
    logger.warning(
        "refused %s %s from %s: %s",
        request.method,
        request.url.path,
        client,
        reason,
    )
    return ApiError(401, REFUSED_DETAIL, "unauthorized")


def journal_actor(identity: quix_identity.Identity, claimed: str) -> str:
    """Return the actor a journal entry must carry.

    A proven identity wins over the body, always. The body holds a string the
    client typed, and a typed string is a claim. An audit record that repeats a
    claim proves nothing, so the verified name replaces it.

    With the platform check off the identity is the static token holder, and
    the body stays the actor. That is the demo path.

    **This half changed on 19 Aug 2026 and changed back the same day.** The
    security review raised H1: a token holder writes an audit line under any
    name. The fix returned the static display name here. It closed H1 and it
    emptied the demo: every provenance row then read "static token holder", so
    no screen named a person, and per-field provenance lost its point on stage.

    **H1 closes through the platform path, not by deleting the name.**
    `quix_identity.py` already turns a Quix bearer token into a real person.
    Two things had to land, and both did. The front end forwards the viewer's
    own Quix token instead of one shared `TM_API_TOKEN`, and this module reads
    `Quix__Portal__Api`, which the platform injects everywhere. A shared token
    names one person for everybody, so it closed nothing on its own. On the
    demo path, where no Portal URL exists, this path keeps the claim.

    A disagreement is normal on `POST /results`: `produced_by` names the tool
    that made the data, and the bearer names the person who called the API.
    So the route logs the difference and goes on. A 422 would refuse that
    correct write. The log line lets an operator see the two names.

    **The return value carries the Portal user id too.** It is a
    `VerifiedActor`, which is a `str` holding one extra attribute. The
    provenance helper stamps that id beside the name, so a journal row still
    points at one person after a rename. The demo path returns a plain string,
    because the static token proves no person and has no id to give.
    """
    if identity.source != "platform":
        return claimed
    verified = VerifiedActor(identity.display_name, identity.user_id)
    if claimed.strip() != verified:
        logger.info(
            "the body claimed the actor %r, the journal records the verified actor %r",
            claimed.strip(),
            verified,
        )
    return verified


def journal_actor_or_id(identity: quix_identity.Identity, claimed: str) -> str:
    """Name the caller for the journal, and never write a name that names nobody.

    :func:`journal_actor` owns the rule: a proven identity beats the body, and
    the demo path keeps the body. This helper adds one guard on top of it.

    A Portal display name is free text. A person really called "Quix User", or
    a profile that carries the last-resort name "user", matches the placeholder
    list, and the provenance helper refuses that name with a `ValueError`. The
    refusal answered **500** on a legal call (21 Aug 2026). The Portal user id
    names exactly one person and it never changes, so it stands in.

    **The placeholder check itself is untouched.** It still stops every caller
    who states a name that names nobody. Only the proven identity gets the
    stand-in, because the platform already proved who that caller is.

    The files router and the results router both call this, so one actor rule
    guards every journal row a route writes.
    """
    actor = journal_actor(identity, claimed)
    if identity.source != "platform" or actor.strip().lower() not in PLACEHOLDER_ACTORS:
        return actor
    # The id carries itself, so a journal row still points at one person.
    return VerifiedActor(identity.user_id, identity.user_id)


def _matches_static(token: str) -> bool:
    """Compare the token with the static one in constant time.

    `secrets.compare_digest` raises on a string that is not ASCII. A caller may
    send anything, so a non-ASCII token must read as "not the static token" and
    go on to the platform path. Before the platform path it reached the same
    401, so this changes no old behavior.
    """
    expected = get_settings().api_token
    if expected is None:
        return False
    try:
        return secrets.compare_digest(token, expected)
    except TypeError:
        return False


def _identify(request: Request, token: str) -> quix_identity.Identity:
    """Ask the platform who holds this token. Never let a failure through."""
    try:
        return quix_identity.identify(token)
    except quix_identity.PlatformRefused as error:
        # The reason stays out of the BODY on purpose. See REFUSED_DETAIL.
        # It reaches the log, where an operator may read it. The exception
        # text of quix_identity carries no token and no host, which
        # `test_no_refusal_message_ever_repeats_the_token` holds.
        raise _refuse(request, f"the Quix platform refused the token: {error}") from error
    except quix_identity.PlatformUnreachable as error:
        # The platform did not decide, so this service must not decide for it.
        # `Quix.Auth.Middleware` answers 503 for the same case
        # (`QuixTokenAuthHandler.cs:125-128`). A 401 would tell the caller the
        # token is bad, and a 200 would let an unproven caller write.
        raise ApiError(503, str(error), "platform_unavailable") from error
