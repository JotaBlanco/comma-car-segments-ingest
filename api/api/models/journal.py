"""Journal entry models. The shape is frozen — contract §A.

Neither lane writes journal documents by hand. Only the provenance helper does.
"""

from typing import Annotated, Literal

from pydantic import AfterValidator, Field, StringConstraints

from api.models.common import ApiModel, RequestModel, Source, UtcDatetime

# Every entity the registry journals. `test_definition` joined the set on
# 21 Aug 2026, with the mirror journal in `api/planning_sync.py`: the mirror
# wrote a definition row and said nothing, so a legal entity type had to exist
# before the write could name one.
#
# `export` joined it on 25 Aug 2026, with the server-side export
# (`api/api/services/exports.py`). A whole-list export is a data egress, so it
# writes an audit row the way a file download does. It names no stored
# document: the `entity_id` is the list a person exported — `test-runs`,
# `files` or `signals` — so an `export` row carries no detail screen and the
# Audit table states the id as plain text.
#
# A caller may name every member but `export` in a write body, so the two
# request models below take `WritableEntityType` and never this type. The
# export routes write their own row through the provenance helper, and
# `_ENTITIES` in `api/api/routers/journal.py` holds no collection to check an
# export against. A body that names `export` therefore answers 422, and the
# routes keep the one table they check against.
WritableEntityType = Literal[
    "run", "file", "signal", "work_order", "result", "test_definition"
]
EntityType = Literal[WritableEntityType, "export"]
JournalKind = Literal["change", "event", "note"]

# Display-string conventions produced server-side. Never invent new ones.
EMPTY = "(empty)"
MISSING = "(missing)"

# An actor names a person or a service. These strings name nobody.
# api/provenance.py holds the same set. A model must not import it from there,
# because provenance imports this module.
# "quix user" is the portal client's last-resort display name. A browser sends
# it when the profile carries no name and no email, so nobody types it.
PLACEHOLDER_ACTORS = frozenset(
    {"current-user", "unknown", "system", "null", "none", "user", "quix user"}
)


def _check_actor(value: str) -> str:
    """Reject an actor that names nobody. Return the clean name."""
    cleaned = value.strip()
    if not cleaned or cleaned.lower() in PLACEHOLDER_ACTORS:
        raise ValueError("must name a person or a service")
    return cleaned


# Every write body that carries an actor uses this type. A bad actor is a
# caller error, so it answers 422 and never reaches the provenance helper.
Actor = Annotated[str, AfterValidator(_check_actor)]


class JournalEntry(ApiModel):
    # The collection stores the entry id in _id. The wire keeps "id".
    id: str = Field(validation_alias="_id")
    entity_type: EntityType
    entity_id: str
    field: str | None
    kind: JournalKind
    old: str | None
    new: str | None
    source: Source
    actor: str
    note: str | None
    at: UtcDatetime
    # `at` is the caller's statement of when the step happened, and it is the
    # sort key. `received_at` is the server clock at the moment the entry
    # arrived. A row written before the second stamp existed reads null.
    received_at: UtcDatetime | None = None
    # `actor` is a display name, and a name is not a person. `actor_id` is the
    # stable Portal user id. A non-null value means the platform proved the
    # actor. Null means the actor is a claim from the caller or a service name,
    # so the demo path and every old row read null.
    actor_id: str | None = None


class NoteCreateRequest(RequestModel):
    """Body of POST /test-runs/{run_id}/journal (appendix ★)."""

    note: str
    actor: Actor


class JournalEventRequest(RequestModel):
    """Body of POST /journal (appendix ★). The caller sets eight keys.

    The caller sends `at`, and the server keeps it. It is the moment the step
    happened, never the moment of the call.
    """

    entity_type: WritableEntityType
    entity_id: str
    field: str = Field(min_length=1)
    # An event is the one kind a caller can state honestly. A note has its own
    # route. A change comes from a field write.
    kind: Literal["event"]
    note: str | None = None
    source: Source
    actor: Actor
    at: UtcDatetime


class AccessRequestCreate(RequestModel):
    """Body of POST /access-requests (appendix D-Access).

    A person found a record they cannot use and asks for access. The Test
    Manager grants nothing: it records the ask in the journal, and a person
    acts on it outside this system.

    `reason` is why the caller needs the entity. It is the only part a human
    reviewer can act on, so the route refuses an empty one.
    """

    entity_type: WritableEntityType
    entity_id: str
    reason: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)
    ]
    actor: Actor
