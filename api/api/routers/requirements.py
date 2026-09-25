"""Requirement routes: the two reads (BL-22) and the three authored writes
(BL-35). Planning's own writes never land here — they arrive through
`POST /planning/sync` (`api/api/routers/planning_sync.py`).
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pymongo.database import Database

from api.auth import journal_actor, require_token
from api.db import get_db
from api.models.common import Pagination, pagination_params
from api.models.requirements import (
    RequirementCreateRequest,
    RequirementDetail,
    RequirementFacets,
    RequirementPage,
    RequirementPatchRequest,
    RequirementRetireRequest,
)
from api.quix_identity import Identity
from api.services import queries_requirements

router = APIRouter(tags=["requirements"])


@router.get("/requirements")
def list_requirements(
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params())],
    system: Annotated[list[str] | None, Query()] = None,
    chapter: Annotated[list[str] | None, Query()] = None,
    status: Annotated[list[str] | None, Query()] = None,
    state: Annotated[list[str] | None, Query()] = None,
    method: Annotated[list[str] | None, Query()] = None,
    ears_pattern: Annotated[list[str] | None, Query()] = None,
    system_state: Annotated[list[str] | None, Query()] = None,
    measurand: Annotated[list[str] | None, Query()] = None,
    source: Annotated[list[str] | None, Query()] = None,
    revision: str | None = None,
    related_req: str | None = None,
    has_verified_by: bool | None = None,
    has_latest_run: bool | None = None,
    q: str | None = None,
) -> RequirementPage:
    """List the mirrored requirements, `req_id` ascending — no sort param.

    `system`, `chapter`, `status`, `state` (`verification_state`), `method`
    (`verification_method`), `ears_pattern`, `system_state` (matches
    `system_states`), `measurand` (matches a measurand's `name`) and `source`
    take repeated params, like `GET /test-runs`. `revision` (exact) and
    `related_req` (membership in `related_reqs`) take one value. `has_verified_by`
    and `has_latest_run` are presence/absence booleans over the derived
    `verified_by`/`latest_run_id`. `q` searches `req_id`, `title` and `text`.
    `view_counts` is whole-table and filter-independent.
    """
    return queries_requirements.list_requirements(
        db,
        pagination,
        system=system,
        chapter=chapter,
        status=status,
        state=state,
        method=method,
        ears_pattern=ears_pattern,
        system_state=system_state,
        measurand=measurand,
        source=source,
        revision=revision,
        related_req=related_req,
        has_verified_by=has_verified_by,
        has_latest_run=has_latest_run,
        q=q,
    )


# This route must stay ABOVE ``GET /requirements/{req_id}``. FastAPI matches
# the routes in declaration order, so a later position would read "facets" as
# a requirement id and answer 404.
@router.get("/requirements/facets")
def get_requirement_facets(db: Annotated[Database, Depends(get_db)]) -> RequirementFacets:
    """The distinct filter values of the whole requirements table.

    The six dropdowns of the Requirements page read this one answer, so each
    offers every value the grid holds rather than the values of one page.
    """
    return queries_requirements.requirement_facets(db)


@router.get("/requirements/{req_id}")
def get_requirement(
    req_id: str,
    db: Annotated[Database, Depends(get_db)],
) -> RequirementDetail:
    """Read one requirement, its authored fields and its covering evidence.

    404 `requirement_not_found` when the mirror holds no such id.
    """
    return queries_requirements.get_requirement_detail(db, req_id)


@router.post("/requirements", status_code=201)
def create_requirement(
    body: RequirementCreateRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> RequirementDetail:
    """Create a manual requirement. Refuses `id_reuse` (409).

    The id is typed by the author and checked against the whole collection,
    any status: a retired id is never reused
    (`dev-planning/authoring-controls/spec.md` §5, §6).
    """
    return queries_requirements.create_requirement(
        db, body, actor=journal_actor(identity, body.actor)
    )


@router.patch("/requirements/{req_id}")
def patch_requirement(
    req_id: str,
    body: RequirementPatchRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> RequirementDetail:
    """Edit a requirement's authored fields.

    `parent_version` must match the stored `item_version` or the write is
    refused `stale_parent` (409). Bytes identical to what is stored are
    refused `no_op_mint` (409) — nothing is written, nothing is journalled.

    A stated `status` must be one the transition table allows from the stored
    status, or the write is refused `illegal_transition` (409)
    (`dev-planning/requirement-status-gates/spec.md` §4.1). `Implemented` and
    `Tested` are never accepted here: they are read off `verification_state`.
    """
    return queries_requirements.patch_requirement(
        db, req_id, body, actor=journal_actor(identity, body.actor)
    )


@router.post("/requirements/{req_id}/retire")
def retire_requirement(
    req_id: str,
    body: RequirementRetireRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> RequirementDetail:
    """Retire a requirement: `status` moves to `Obsolete`, the row is kept.

    Works on either origin (a planning-mirrored row or a manual one).
    Refuses `stale_parent` (409) and `already_obsolete` (409).
    """
    return queries_requirements.retire_requirement(
        db, req_id, body, actor=journal_actor(identity, body.actor)
    )
