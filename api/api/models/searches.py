"""Saved and shared searches (FR-DM-017, the shared half).

The device-local store keeps a saved search in one browser
(`frontend/lib/saved-searches.ts`), so nobody can hand one to a colleague.
The requirement row names the gap in its own words: "a saved search cannot be
handed to another user by permission, and no screen distinguishes a personal
search from a team one."

So the sharing model has exactly two values, and this module names them both.
A **personal** search answers to its owner alone. A **team** search answers to
every caller this registry serves. There is no third state, no per-person
grant and no role. The row asks for none of that, and a permission system
nobody asked for is a permission system nobody maintains.

A saved search carries no measurement and no registry fact. It is a name plus
the canonical query string the list screens already keep in the URL
(`frontend/lib/table-state.ts`, `buildTableQuery`), so one string restores the
whole filter, sort, search and page state.
"""

from enum import Enum
from typing import Annotated

from pydantic import AfterValidator, Field

from api.models.common import ApiModel, Page, RequestModel, UtcDatetime
from api.models.journal import Actor


class SavedSearchScope(str, Enum):
    """The list screen a saved search belongs to.

    One scope per screen, exactly as the device-local store keys its storage
    (`frontend/lib/saved-searches.ts`). A runs filter can never restore on the
    files screen, because the two carry different filter keys and the second
    screen would drop every one of them in silence.
    """

    RUNS = "runs"
    FILES = "files"
    SIGNALS = "signals"
    WORK_ORDERS = "work-orders"


class SavedSearchVisibility(str, Enum):
    """Who reads one saved search. The row names these two states and no more."""

    PERSONAL = "personal"
    TEAM = "team"


# The device store caps a name at 60 characters, and a longer name only
# truncates the row. The server holds the same cap, so a name that saves on
# the device also saves here.
MAX_NAME_LENGTH = 60

# `buildTableQuery` writes a few hundred characters at the very most. The cap
# stops a caller from storing a document in this field.
MAX_QUERY_LENGTH = 2000

# A description says why a search exists, so it needs more room than the name.
# One or two sentences fit. The device store caps the field at the same number,
# so a description that saves on the device also saves here. The cap stops a
# caller from storing a document, exactly as the query cap does.
MAX_DESCRIPTION_LENGTH = 200


def _check_query(value: str) -> str:
    """Accept the canonical query string, and nothing else.

    `buildTableQuery` writes the empty string for a screen with no filter, and
    a string that starts with `?` for every other state. A value of another
    shape restores no screen, so the route refuses it with 422 instead of
    storing a row that can never apply.
    """
    if value != "" and not value.startswith("?"):
        raise ValueError("must be empty or start with '?'")
    return value


SearchQuery = Annotated[
    str,
    AfterValidator(_check_query),
    Field(max_length=MAX_QUERY_LENGTH),
]

SearchName = Annotated[str, Field(min_length=1, max_length=MAX_NAME_LENGTH)]

# The requirement row calls the description optional, so a blank one is legal
# and it stores as null. One state, one value.
SearchDescription = Annotated[str, Field(max_length=MAX_DESCRIPTION_LENGTH)]


class SavedSearch(ApiModel):
    """One stored search, as every route serves it."""

    # The collection stores the id in _id. The wire keeps "search_id".
    search_id: str = Field(validation_alias="_id")
    scope: SavedSearchScope
    name: str
    # Why this search exists, in the words of the person who saved it. Null
    # when nobody wrote one, and null on every row saved before 24 Aug 2026.
    description: str | None = None
    query: str
    visibility: SavedSearchVisibility
    owner: str
    # The stable Portal user id of the owner. Null when the platform proved
    # nobody, which is the demo path. `api/api/provenance.py` states the same
    # rule for a journal row, and this field follows it.
    owner_id: str | None = None
    saved_at: UtcDatetime


class SavedSearchPage(Page[SavedSearch]):
    """The `GET /saved-searches` envelope. Shape §A."""


class SavedSearchCreateRequest(RequestModel):
    """Body of `POST /saved-searches`.

    A person saves the search, so `actor` is required and it takes the same
    `Actor` type every write body uses. A name that names nobody answers 422
    before the route runs.

    `visibility` defaults to `personal`. A caller shares on purpose, never by
    forgetting a field.

    `description` is optional. A body that omits it saves exactly as it did
    before this field existed.
    """

    scope: SavedSearchScope
    name: SearchName
    description: SearchDescription | None = None
    query: SearchQuery
    visibility: SavedSearchVisibility = SavedSearchVisibility.PERSONAL
    actor: Actor


class SavedSearchDeleteRequest(RequestModel):
    """Body of `DELETE /saved-searches/{search_id}`.

    `DELETE /files/{file_id}` already takes a body with an actor, so this
    route copies it. The actor names the caller, and only the owner may
    delete.
    """

    actor: Actor
