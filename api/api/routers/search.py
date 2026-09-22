"""Contract #19. Owner: Lane A."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pymongo.database import Database

from api.db import get_db
from api.models.common import SearchResponse
from api.services import queries_runs

router = APIRouter(tags=["search"])


@router.get("/search")
def search(
    db: Annotated[Database, Depends(get_db)],
    q: Annotated[str, Query(min_length=1)],
    limit_per_group: Annotated[int, Query(ge=1, le=10)] = 5,
) -> SearchResponse:
    """Search runs, work orders, files, signals, definitions and results.

    The query is treated as text, so a regex character finds itself. Groups with
    no hits are left out.
    """
    return queries_runs.search(db, q, limit_per_group)
