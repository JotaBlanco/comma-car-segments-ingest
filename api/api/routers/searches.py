"""Saved and shared searches — the server half of FR-DM-017.

`frontend/lib/saved-searches.ts` keeps a saved search in one browser. That
half stays, and it loses nothing: a person who stores nothing here still saves
on the device, and the two lists never fight, because they never share a
store.

This module adds what a browser cannot do. It stores a search once, and it
hands a **team** search to every colleague this registry serves. The
requirement row names that model and no other: a personal search, or a team
one. So there is no per-person grant, no role and no share list here.

**Who the caller is.** `api/api/auth.py` owns that rule and this module never
writes a second one. `journal_actor_or_id` returns the proven Portal identity
on the platform path, and the claimed name on the demo path. The placeholder
check stands untouched: a caller who states "unknown", "system" or "quix
user" answers 422 through the `Actor` type, and a proven caller whose Portal
profile carries such a name owns their rows under the Portal user id.

**One weakness stays, and it is the registry's, not this module's.** Five
deployments hold one static token today, so on the demo path the owner is the
name the caller typed. Anybody who holds that token can type any name.
`api/api/auth.py` states the same limit for the journal, and it closes the
same way for both: the platform path proves the person. This module must
never trade that away for a check of its own.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pymongo import DESCENDING, ReturnDocument
from pymongo.database import Database

from api.auth import journal_actor_or_id, require_token
from api.db import get_db
from api.errors import ApiError
from api.models.common import Pagination, pagination_params
from api.models.journal import Actor
from api.models.searches import (
    SavedSearch,
    SavedSearchCreateRequest,
    SavedSearchDeleteRequest,
    SavedSearchPage,
    SavedSearchScope,
)
from api.provenance import actor_id
from api.quix_identity import Identity

router = APIRouter(tags=["saved-searches"])

COLLECTION = "saved_searches"


def _now() -> datetime:
    return datetime.now(UTC)


def _writer(identity: Identity, claimed: str) -> str:
    """Name the caller of a write, by the one rule `api/api/auth.py` states.

    A proven Portal identity beats the claim, always. The demo path keeps the
    claim, because the static token proves a token holder and never a person.
    """
    if identity.source != "platform":
        return claimed
    # The platform proved this caller, so the claim only reaches the log line.
    return journal_actor_or_id(identity, claimed or identity.display_name)


def _reader(identity: Identity, claimed: str | None) -> str | None:
    """Name the caller of a read. Answer `None` when nobody is named.

    A read may name nobody: the demo path proves no person, and the parameter
    is optional. The read then serves the team searches alone. It never serves
    another person's personal rows.
    """
    if claimed is None and identity.source != "platform":
        return None
    return _writer(identity, claimed or "")


def _description(value: str | None) -> str | None:
    """Trim the description, and read a blank one as no description.

    The field is optional, so "nobody wrote one" must carry one value and not
    two. The name follows the same rule with `strip()`.
    """
    cleaned = (value or "").strip()
    return cleaned or None


def _owner_key(owner: str) -> str:
    """The value that ties a row to one person for ever.

    A display name does not point at one person for ever: a person renames a
    Portal profile, and two people can carry one name. The Portal `userId`
    never changes, so a proven caller keys on the id. The demo path proves no
    id, so it keys on the name it claimed.

    `api.auth.VerifiedActor` carries the id on the string itself, so
    `provenance.actor_id` reads it back with no second parameter.
    """
    return actor_id(owner) or owner


@router.post("/saved-searches", status_code=201)
def save_search(
    body: SavedSearchCreateRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> SavedSearch:
    """Store one search, personal or shared with the team.

    A second save under the same scope and the same name **replaces** the
    stored row and keeps its id. The device store states the same rule, and
    the reason is the same: two rows under one name help nobody. The match
    ignores letter case, so "Cold soak" replaces "cold soak". The replacement
    writes the whole row, so a save with no description clears the old one.

    `description` is optional, and a blank one stores as null.

    `visibility: "team"` is how a person hands a search to a colleague. Every
    caller this registry serves then reads that row. `personal` is the
    default, so nobody shares a search by forgetting a field.

    Errors: `422 validation_error` — an actor that names nobody, a name over
    60 characters, a description over 200 characters, or a query string that
    starts with neither nothing nor `?`.
    """
    owner = _writer(identity, body.actor)
    stored = db[COLLECTION].find_one_and_update(
        {
            "scope": body.scope.value,
            "owner_key": _owner_key(owner),
            "name_key": body.name.strip().lower(),
        },
        {
            "$set": {
                "name": body.name.strip(),
                "description": _description(body.description),
                "query": body.query,
                "visibility": body.visibility.value,
                "owner": str(owner),
                "owner_id": actor_id(owner),
                "saved_at": _now(),
            },
            "$setOnInsert": {"_id": f"ss-{uuid.uuid4()}"},
        },
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return SavedSearch.model_validate(stored)


@router.get("/saved-searches")
def list_saved_searches(
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
    pagination: Annotated[Pagination, Depends(pagination_params(50))],
    scope: Annotated[SavedSearchScope | None, Query()] = None,
    actor: Annotated[Actor | None, Query()] = None,
) -> SavedSearchPage:
    """Read the searches this caller may see, newest first.

    The answer holds every **team** search, plus the caller's own **personal**
    ones. It never holds another person's personal row, on either path.

    `actor` names the caller on the demo path, where no platform proves one.
    On the platform path the proven identity wins and this parameter only
    reaches the log line. A read that names nobody serves the team searches
    alone, which is the honest answer: with no name there is no "mine".

    `scope` narrows the answer to one list screen. A caller that names none
    reads all three.
    """
    owner = _reader(identity, actor)

    visible: list[dict] = [{"visibility": "team"}]
    if owner is not None:
        visible.append({"owner_key": _owner_key(owner)})
    clauses: list[dict] = [{"$or": visible}]
    if scope is not None:
        clauses.append({"scope": scope.value})
    query = {"$and": clauses}

    total = db[COLLECTION].count_documents(query)
    cursor = (
        db[COLLECTION]
        .find(query)
        .sort("saved_at", DESCENDING)
        .skip((pagination.page - 1) * pagination.page_size)
        .limit(pagination.page_size)
    )
    items = [SavedSearch.model_validate(row) for row in cursor]
    return SavedSearchPage.model_validate(pagination.envelope(items, total))


@router.delete("/saved-searches/{search_id}", status_code=204)
def delete_saved_search(
    search_id: str,
    body: SavedSearchDeleteRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> None:
    """Delete one saved search. The owner alone may do it.

    A team search is readable by everybody and deletable by its owner only.
    Sharing a search must never hand the delete away with it, or one colleague
    could empty another person's list.

    `DELETE /files/{file_id}` already takes a body with an actor, so this
    route copies it rather than inventing a query parameter.

    Errors:

    * `404 saved_search_not_found` — the id names no saved search.
    * `403 not_the_owner` — the caller does not own this search.
    """
    stored = db[COLLECTION].find_one({"_id": search_id})
    if stored is None:
        raise ApiError(404, f"Saved search {search_id} not found", "saved_search_not_found")

    owner = _writer(identity, body.actor)
    if stored.get("owner_key") != _owner_key(owner):
        raise ApiError(403, "A saved search may be deleted by its owner alone.", "not_the_owner")

    db[COLLECTION].delete_one({"_id": search_id})
