"""V-model fixture ingest and figure serving.

``POST /vmodel/seed`` is the only write endpoint in this phase. It is deliberately separate
from ``POST /api/v1/admin/seed-demo-data``, which seeds the Phase 2 Devices/Tests demo data:
the two domains stay independent so seeding one never disturbs the other.
"""

import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pymongo.database import Database

from ..auth import read_permission, update_permission
from ..models_vmodel import SeedResult
from ..mongo import get_mongo
from ..vmodel_ingest import IngestError, figure_path
from ..vmodel_seed import seed_vmodel

logger = logging.getLogger(__name__)

router = APIRouter()

FIGURE_ID_PATTERN = re.compile(r"^F[1-6]$")


@router.post("/seed", response_model=SeedResult, status_code=200)
def seed_vmodel_fixtures(
    reset: bool = Query(False, description="Drop the vm_* collections before ingesting"),
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(update_permission),
) -> SeedResult:
    """Ingest the committed acc_project fixtures into the ``vm_*`` collections.

    Idempotent: each set is rewritten in place at its fixed version, so a second call
    returns the same counts rather than minting duplicate versions or failing on a
    duplicate key. Fixture edits are picked up, and items dropped from a fixture are pruned.
    ``?reset=true`` drops the V-model collections first - it never touches ``tests`` or
    ``devices``. Same code path as the startup seed.
    """
    try:
        counts = seed_vmodel(mongo, reset=reset)
    except IngestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return SeedResult(reset=reset, counts=counts)


@router.get("/figures/{figure_id}", name="get_vmodel_figure")
def get_vmodel_figure(
    figure_id: str,
    _: None = Depends(read_permission),
) -> Response:
    """Serve one requirement figure (SVG) from the committed fixtures.

    ``figure_id`` is matched against ``^F[1-6]$`` before it reaches the filesystem, so no
    request can traverse out of the fixtures directory.
    """
    if not FIGURE_ID_PATTERN.match(figure_id):
        raise HTTPException(status_code=404, detail=f"Figure '{figure_id}' not found")

    path = figure_path(figure_id)
    if path is None or not path.exists():
        raise HTTPException(status_code=404, detail=f"Figure '{figure_id}' not found")

    return Response(
        content=path.read_bytes(),
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=3600"},
    )
