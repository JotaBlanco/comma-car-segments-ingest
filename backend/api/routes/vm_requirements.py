"""V-model requirements endpoints.

The Requirements page has no version selector by design, so ``GET /vmodel/requirements``
returns every requirement across every artifact version and the rich filtering (does not
contain / is empty / OR) is applied client-side. Items with status ``Obsolete`` or
``Rejected`` are returned like any other - they must stay visible and findable.

Storage: the queryable projection lives in MongoDB (``vm_requirements``,
``vm_artifact_sets``, ``vm_baselines``). See ``api/vmodel_ingest.py`` for how it gets there.
"""

import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pymongo.database import Database

from ..auth import read_permission
from ..models import PaginatedResponse
from ..models_vmodel import (
    FigureReference,
    Requirement,
    RequirementDetail,
    RequirementQuery,
    RelatedRequirement,
)
from ..mongo import get_mongo
from ..vmodel_ingest import figure_catalogue

logger = logging.getLogger(__name__)

router = APIRouter()


def figure_references(figure_refs: list[str]) -> list[FigureReference]:
    """Resolve figure ids to servable references. Unknown ids are dropped."""
    catalogue = figure_catalogue()
    references = []
    for figure_id in figure_refs:
        if entry := catalogue.get(figure_id):
            references.append(
                FigureReference(
                    figure_id=figure_id,
                    title=entry["title"],
                    url=f"/api/v1/vmodel/figures/{figure_id}",
                )
            )
    return references


@router.get(
    "/requirements",
    response_model=PaginatedResponse[Requirement],
    response_model_by_alias=False,
)
def list_requirements(
    query_params: RequirementQuery = Depends(),
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> PaginatedResponse[Requirement]:
    """List requirements across every artifact version.

    Query parameters are a convenience for direct API consumers; the UI loads the whole set
    and filters client-side. There is no baseline fallback and no "latest version wins"
    collapse - if two versions of the same requirement differ, both are returned.
    """
    query: dict[str, Any] = {}
    if query_params.req_id:
        query["req_id"] = query_params.req_id
    if query_params.chapter:
        query["chapter"] = query_params.chapter
    if query_params.status:
        query["status"] = query_params.status.value
    if query_params.revision:
        query["revision"] = query_params.revision
    if query_params.verification_tag:
        query["verification_tag"] = query_params.verification_tag
    if query_params.verification_method:
        query["verification_method"] = query_params.verification_method
    if query_params.artifact_version:
        query["artifact_version"] = query_params.artifact_version
    if query_params.baseline:
        baseline = mongo.vm_baselines.find_one({"_id": query_params.baseline})
        if baseline is None:
            raise HTTPException(
                status_code=404, detail=f"Baseline '{query_params.baseline}' not found"
            )
        query["artifact_version"] = baseline["requirements_version"]
    if query_params.q:
        pattern = {"$regex": re.escape(query_params.q.strip()), "$options": "i"}
        query["$or"] = [
            {"req_id": pattern},
            {"title": pattern},
            {"text": pattern},
        ]

    total = mongo.vm_requirements.count_documents(query)
    skip = (query_params.page - 1) * query_params.page_size
    cursor = (
        mongo.vm_requirements.find(query)
        .sort([("req_id", 1), ("artifact_version", 1)])
        .skip(skip)
        .limit(query_params.page_size)
    )

    return PaginatedResponse.create(
        items=[Requirement(**doc) for doc in cursor],
        total=total,
        page=query_params.page,
        page_size=query_params.page_size,
    )


@router.get(
    "/requirements/{req_key}",
    response_model=RequirementDetail,
    response_model_by_alias=False,
)
def get_requirement(
    req_key: str,
    version: str | None = None,
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> RequirementDetail:
    """Get one requirement in full, with its figures, versions, relations and coverage.

    ``req_key`` accepts either an exact key (``ACC-SYS-PRF-020@v0001``) or a bare requirement
    id. With a bare id the highest artifact version is returned and every version the
    requirement exists in is listed in ``available_versions``, so nothing is hidden by the
    choice; ``?version=`` selects one explicitly.
    """
    if "@" in req_key:
        req_id, requested_version = req_key.split("@", 1)
    else:
        req_id = req_key
        requested_version = version or ""

    versions = sorted(
        str(doc["artifact_version"]) for doc in mongo.vm_requirements.find({"req_id": req_id})
    )
    if not versions:
        raise HTTPException(status_code=404, detail=f"Requirement '{req_id}' not found")

    if requested_version:
        if requested_version not in versions:
            raise HTTPException(
                status_code=404,
                detail=f"Requirement '{req_id}' does not exist at version '{requested_version}'",
            )
        selected_version = requested_version
    else:
        selected_version = versions[-1]

    doc = mongo.vm_requirements.find_one({"_id": f"{req_id}@{selected_version}"})
    if doc is None:
        raise HTTPException(status_code=404, detail=f"Requirement '{req_key}' not found")

    baseline_ids: list[str] = []
    covering: list[str] = []
    for baseline in mongo.vm_baselines.find({"requirements_version": selected_version}):
        baseline_ids.append(str(baseline["_id"]))
        covering.extend(baseline.get("req_links", {}).get(req_id, []))

    related: list[RelatedRequirement] = []
    for other_id in doc.get("related_reqs") or []:
        other = mongo.vm_requirements.find_one({"_id": f"{other_id}@{selected_version}"})
        related.append(
            RelatedRequirement(
                req_id=other_id,
                title=str(other["title"]) if other else "",
                status=str(other["status"]) if other else None,
                key=str(other["_id"]) if other else None,
            )
        )

    return RequirementDetail(
        **doc,
        figures=figure_references(list(doc.get("figure_refs") or [])),
        available_versions=versions,
        baseline_ids=sorted(baseline_ids),
        covering_tc_ids=sorted(set(covering)),
        related=related,
    )
