"""Explore routes: the run's Explore context. Owner: Chris.

The route is a read, so no journal entry and no actor (decision D-E5).
Auth comes from the /api/v1 parent router, the same as every other router.

`POST /explore/query` lived here until 24 Aug 2026. The workbench now posts
its SQL straight to QuixLake through the frontend's own route
(`frontend/app/api/lake/query/route.ts`). See
`plans/design/EXPLORE-DIRECT-LAKE.md` and the retirement note in
`plans/API-CONTRACT.md` §D-Explore.
"""

from typing import Annotated

from fastapi import APIRouter, Depends
from pymongo.database import Database

from api.db import get_db
from api.errors import ApiError
from api.models.explore import ExploreContextResponse
from api.services import explore_query, queries_stats

router = APIRouter(tags=["explore"])


def _require_run(db: Database, run_id: str) -> None:
    """404 when the data does not know this run (the signals.py precedent)."""
    if not queries_stats.run_exists(db, run_id):
        raise ApiError(404, f"Run {run_id} not found", "run_not_found")


@router.get("/test-runs/{run_id}/explore/context")
def get_explore_context(
    run_id: str,
    db: Annotated[Database, Depends(get_db)],
) -> ExploreContextResponse:
    """Describe the run's Explore surface: the table, its columns, the counts."""
    _require_run(db, run_id)
    return explore_query.run_context(db, run_id)
