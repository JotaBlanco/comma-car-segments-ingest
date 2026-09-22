"""The journal routes: contract #8, the ★ note POST, the ★ event POST, the
cross-entity read and the access-request POST.

Lane B took ownership of this file for ticket B-13 on 18 Aug 2026, because the
backend lead moved the whole ticket to Lane B. Lane A owned it before.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pymongo import DESCENDING
from pymongo.database import Database

from api.auth import journal_actor, journal_actor_or_id, require_token
from api.db import get_db
from api.errors import ApiError
from api.models.common import Page, Pagination, Source, UtcDatetime, pagination_params
from api.models.journal import (
    AccessRequestCreate,
    EntityType,
    JournalEntry,
    JournalEventRequest,
    JournalKind,
    NoteCreateRequest,
)
from api.provenance import add_event
from api.quix_identity import Identity
from api.services import queries_runs

router = APIRouter(tags=["journal"])


@router.get("/test-runs/{run_id}/journal")
def list_run_journal(
    run_id: str,
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params(50))],
    kind: Annotated[JournalKind | None, Query()] = None,
) -> Page[JournalEntry]:
    """Read one run's timeline, newest first.

    The list includes signal edits made in this run's context, so a unit change
    appears where the person made it.
    """
    return queries_runs.list_run_journal(db, run_id, pagination, kind=kind)


@router.post("/test-runs/{run_id}/journal", status_code=201)
def add_run_note(
    run_id: str,
    body: NoteCreateRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> JournalEntry:
    """Add a free-text note to a run (★)."""
    # The verified caller wins over the body actor. See auth.journal_actor.
    return queries_runs.add_run_note(
        db, run_id, note=body.note, actor=journal_actor(identity, body.actor)
    )


# Where each entity type lives, how to name it in the 404, and the error code
# the rest of the API already uses for it. Every type `WritableEntityType`
# allows has a row here: a journal entry against an entity nobody holds names
# nothing, and it can never be deleted. `EntityType` also allows `export`, and
# a write body may not name it — see `api/api/models/journal.py`.
_ENTITIES: dict[str, tuple[str, str, str]] = {
    "run": ("test_runs", "Run", "run_not_found"),
    "file": ("files", "File", "file_not_found"),
    "signal": ("signals", "Signal", "signal_not_found"),
    "work_order": ("work_orders", "Work order", "wo_not_found"),
    "result": ("processed_results", "Result", "result_not_found"),
    "test_definition": ("test_definitions", "Test definition", "td_not_found"),
    "requirement": ("requirements", "Requirement", "requirement_not_found"),
}


def _require_entity(db: Database, entity_type: str, entity_id: str) -> None:
    """Refuse an entry against an entity the registry does not hold."""
    collection, label, code = _ENTITIES[entity_type]
    if db[collection].find_one({"_id": entity_id}, {"_id": 1}) is None:
        raise ApiError(404, f"{label} {entity_id} not found", code)


# One read per journalled entity type. `run` has its own route above, because
# a run's timeline also unions the edits made in its context.
#
# Every route below serves the same shape as the run read: the same `kind`
# filter, the same default page size of 50, the same `at`-descending order and
# the same `Page[JournalEntry]` envelope. A journal read is one idea, so it
# keeps one shape.


def _page_entity_journal(
    db: Database,
    entity_type: str,
    entity_id: str,
    pagination: Pagination,
    kind: str | None,
) -> dict:
    """Page one entity's timeline, newest first.

    The entity must exist, so a mistyped id answers 404 and never an empty
    page. An empty page then means "nothing happened yet", and it means
    nothing else.

    The check reads `_ENTITIES`, the same table the event POST checks against,
    so a read and a write answer one 404 code per entity type. A second table
    held the same rows until 21 Aug 2026, and it named a helper that no module
    defined, so every read here raised `NameError` and answered 500.
    """
    _require_entity(db, entity_type, entity_id)

    clauses: list[dict] = [{"entity_type": entity_type, "entity_id": entity_id}]
    if kind:
        clauses.append({"kind": kind})
    return _page_journal(db, clauses, pagination)


def _page_journal(db: Database, clauses: list[dict], pagination: Pagination) -> dict:
    """Page the journal under the given clauses, newest first.

    Every journal read pages here, so one order and one envelope serve them
    all. An empty clause list reads the whole journal.
    """
    query = {"$and": clauses} if clauses else {}

    total = db["journal_entries"].count_documents(query)
    # The _id tiebreak `list_run_journal` already has: same-millisecond bursts
    # are the normal case, and without it a tied entry could render on two
    # pages or on neither, per Mongo's whim (25 Aug 2026).
    cursor = (
        db["journal_entries"]
        .find(query)
        .sort([("at", DESCENDING), ("_id", DESCENDING)])
        .skip((pagination.page - 1) * pagination.page_size)
        .limit(pagination.page_size)
    )
    return pagination.envelope(list(cursor), total)


@router.get("/files/{file_id}/journal")
def list_file_journal(
    file_id: str,
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params(50))],
    kind: Annotated[JournalKind | None, Query()] = None,
) -> Page[JournalEntry]:
    """Read one file's history, newest first.

    `GET /files/{file_id}` inlines the arrival story and hides the download
    event on purpose. This route hides nothing: the lifecycle steps, the
    version chain, the hand edits and every download read here.
    """
    return _page_entity_journal(db, "file", file_id, pagination, kind)


@router.get("/signals/{name}/journal")
def list_signal_journal(
    name: str,
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params(50))],
    kind: Annotated[JournalKind | None, Query()] = None,
) -> Page[JournalEntry]:
    """Read one signal's history, newest first.

    A unit edit made while looking at a run also joins that run's timeline. It
    belongs to both, so this route serves it as well.
    """
    return _page_entity_journal(db, "signal", name, pagination, kind)


@router.get("/work-orders/{wo_id}/journal")
def list_work_order_journal(
    wo_id: str,
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params(50))],
    kind: Annotated[JournalKind | None, Query()] = None,
) -> Page[JournalEntry]:
    """Read one work order's history, newest first."""
    return _page_entity_journal(db, "work_order", wo_id, pagination, kind)


@router.get("/results/{result_id}/journal")
def list_result_journal(
    result_id: str,
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params(50))],
    kind: Annotated[JournalKind | None, Query()] = None,
) -> Page[JournalEntry]:
    """Read one result's history, newest first."""
    return _page_entity_journal(db, "result", result_id, pagination, kind)


@router.get("/test-definitions/{td_id}/journal")
def list_test_definition_journal(
    td_id: str,
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params(50))],
    kind: Annotated[JournalKind | None, Query()] = None,
) -> Page[JournalEntry]:
    """Read one test definition's history, newest first.

    The planning mirror writes here: one `test_definition.mirrored` event when
    the definition first arrives, and one `change` entry per field planning
    moved afterwards. The registry never writes a definition field itself, so
    this timeline reads as planning changing its mind.
    """
    return _page_entity_journal(db, "test_definition", td_id, pagination, kind)


@router.get("/requirements/{req_id}/journal")
def list_requirement_journal(
    req_id: str,
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params(50))],
    kind: Annotated[JournalKind | None, Query()] = None,
) -> Page[JournalEntry]:
    """Read one requirement's history, newest first.

    A planning mirror pass writes one `requirement.mirrored` event when the
    row first arrives, and one `change` entry per field planning moves
    afterwards; an authored create, edit or retire writes its own entries the
    same way.
    """
    return _page_entity_journal(db, "requirement", req_id, pagination, kind)


# `require_token` guards every `/api/v1` route from `main.py`. The read below
# names it again, because an audit read must never lose its guard to an edit
# of another file.
@router.get("/journal", dependencies=[Depends(require_token)])
def list_journal(
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params(50))],
    entity_type: Annotated[EntityType | None, Query()] = None,
    entity_id: Annotated[str | None, Query()] = None,
    field: Annotated[str | None, Query()] = None,
    actor: Annotated[str | None, Query()] = None,
    source: Annotated[Source | None, Query()] = None,
    kind: Annotated[JournalKind | None, Query()] = None,
    since: Annotated[UtcDatetime | None, Query()] = None,
    until: Annotated[UtcDatetime | None, Query()] = None,
) -> Page[JournalEntry]:
    """Read the journal across every entity, newest first (FR-DM-055).

    The six routes above each read one entity. An auditor asks a different
    question: who changed this field, or what did this person do last week.
    Neither question names one entity, so neither has an answer until this
    route exists.

    Every filter is optional, and the filters combine with AND. A caller that
    names none reads the whole journal, 50 entries a page.

    `entity_type`, `entity_id`, `field`, `actor`, `source` and `kind` match
    the stored value exactly. An exact match keeps one question and one
    answer: a substring match would make `actor=a` name half the staff.
    `source` answers the data steward's question: show me every manual
    override. It takes the `Source` enum, so a typo answers 422.

    `since` and `until` bound `at`, and both bounds are inclusive. `at` is the
    moment the step happened, and it is the sort key, so the range reads the
    same order the page shows. The contract names `since` in §D; `until` is
    its pair, because an audit asks for a window and not only a start.

    The route checks no entity id. A read of the whole journal has nothing to
    check against, and an unknown id simply matches nothing.
    """
    clauses: list[dict] = []
    for name, value in (
        ("entity_type", entity_type),
        ("entity_id", entity_id),
        ("field", field),
        ("actor", actor),
        # The enum arrives as a member; the collection stores its string.
        ("source", None if source is None else source.value),
        ("kind", kind),
    ):
        if value is not None:
            clauses.append({name: value})

    bounds: dict = {}
    if since is not None:
        bounds["$gte"] = since
    if until is not None:
        bounds["$lte"] = until
    if bounds:
        clauses.append({"at": bounds})

    return _page_journal(db, clauses, pagination)


@router.post("/journal", status_code=201)
def add_journal_event(
    body: JournalEventRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> JournalEntry:
    """Add one journal event on any entity (★).

    The ingestion watcher narrates the file ingestion through this route.

    **Every entity type takes the existence check.** A file and a run were the
    only two checked until 21 Aug 2026, so an entry could name a signal, a
    work order or a result that never existed. A journal entry is append-only,
    so nobody could ever remove it — the check is the one chance to refuse it.

    The server keeps the caller's `at` and stamps its own `received_at` beside
    it. A reader then sees a caller date that lies. `at` stays the sort key.
    """
    _require_entity(db, body.entity_type, body.entity_id)

    # The helper owns the entry shape. It sets old and new to None, which is
    # what an event carries. The verified caller wins over the body actor.
    entry = add_event(
        body.entity_type,
        body.entity_id,
        body.field,
        body.source,
        journal_actor(identity, body.actor),
        note=body.note,
        at=body.at,
    )
    db["journal_entries"].insert_one(entry)
    return entry


# The one field name every access request carries. A reviewer reads the whole
# queue with `GET /journal?field=access.requested`, so the name must never
# change and no other write may use it.
ACCESS_REQUEST_FIELD = "access.requested"


@router.post("/access-requests", status_code=201)
def request_access(
    body: AccessRequestCreate,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> JournalEntry:
    """Record one request for access to one entity (UC-003 step 4).

    **This route grants nothing, and it must never claim to.** The Test
    Manager has no scoped access: the only check is workspace `Read` through
    the Quix Portal (`api/quix_identity.py`), and no role, no project and no
    classification exists in this code. So there is no permission to hand
    over, and an approval flow would be theatre.

    What a person really needs is a way to ask, and a record of the ask. This
    route is that, and nothing else. It writes one journal event on the named
    entity, with the field `access.requested`, the source `manual`, the
    caller as the actor and the stated reason as the note. A human reads the
    journal and acts outside this system.

    The entity must exist, so a stale id answers the entity's own 404 code —
    the same table and the same codes the event POST checks against. A
    journal entry is append-only, so the check is the one chance to refuse it.

    **On the actor.** With the platform check on, the Portal names the caller
    and the entry carries `actor_id`, the stable Portal user id. On the demo
    path the bearer is the shared static token, which names a token holder and
    never a person: the entry then keeps the name the body claimed and
    `actor_id` reads null. A reviewer must read `actor_id` before they treat
    the name as a person.

    Errors:

    * ``401 unauthorized`` — the bearer is missing or wrong, like every route.
    * ``404`` — the entity id names nothing. The code is the entity's own.
    * ``422 validation_error`` — a blank reason, a reason over 1000
      characters, an actor that names nobody, or an unknown entity type.
    """
    _require_entity(db, body.entity_type, body.entity_id)

    entry = add_event(
        body.entity_type,
        body.entity_id,
        ACCESS_REQUEST_FIELD,
        Source.MANUAL,
        journal_actor_or_id(identity, body.actor),
        note=body.reason,
    )
    db["journal_entries"].insert_one(entry)
    return entry
