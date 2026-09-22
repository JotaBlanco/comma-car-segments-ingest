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
    chapter: Annotated[list[str] | None, Query()] = None,
    status: Annotated[list[str] | None, Query()] = None,
    state: Annotated[list[str] | None, Query()] = None,
    method: Annotated[list[str] | None, Query()] = None,
    q: str | None = None,
) -> RequirementPage:
    """List the mirrored requirements, `req_id` ascending — no sort param.

    `chapter`, `status`, `state` (`verification_state`) and `method`
    (`verification_method`) take repeated params, like `GET /test-runs`.
    `q` searches `req_id`, `title` and `text`. `view_counts` is whole-table
    and filter-independent.
    """
    return queries_requirements.list_requirements(
        db, pagination, chapter=chapter, status=status, state=state, method=method, q=q
    )


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
