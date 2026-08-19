"""V-model baseline endpoints.

A baseline is an immutable pin of one version of each artifact kind, plus the materialised
reverse traceability index ``req_links`` (requirement id -> covering test case ids). Coverage
is read from that frozen index and is never recomputed by scanning test specs at request
time - that is what makes a report reproducible from its baseline alone.
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pymongo.database import Database

from ..auth import read_permission
from ..models_vmodel import Baseline
from ..mongo import get_mongo

router = APIRouter()


@router.get("/baselines", response_model=list[Baseline], response_model_by_alias=False)
def list_baselines(
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> list[Baseline]:
    """List published baselines with their frozen counts and static coverage."""
    cursor = mongo.vm_baselines.find().sort([("_id", 1)])
    return [Baseline(**doc) for doc in cursor]


@router.get(
    "/baselines/{baseline_id}",
    response_model=Baseline,
    response_model_by_alias=False,
)
def get_baseline(
    baseline_id: str,
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> Baseline:
    """Get one baseline in full, including the ``req_links`` reverse traceability index."""
    doc = mongo.vm_baselines.find_one({"_id": baseline_id})
    if doc is None:
        raise HTTPException(status_code=404, detail=f"Baseline '{baseline_id}' not found")
    return Baseline(**doc)
