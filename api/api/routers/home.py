"""Contract #1. Owner: Lane A."""

from typing import Annotated

from fastapi import APIRouter, Depends
from pymongo.database import Database

from api.db import get_db
from api.models.runs import HomeSummary
from api.services import queries_runs

router = APIRouter(tags=["home"])


@router.get("/home/summary")
def get_home_summary(db: Annotated[Database, Depends(get_db)]) -> HomeSummary:
    """Serve the whole Home screen in one call.

    Every count is live, so a flag or a sync shows up immediately.
    """
    return HomeSummary(**queries_runs.home_summary(db))
