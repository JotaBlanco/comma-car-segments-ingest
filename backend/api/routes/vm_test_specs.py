"""V-model test specification endpoints.

The detail response resolves every ``pass_criteria[].signal`` against the signal catalogue
and inlines the unit, raster, role and enum map, so the criteria table renders from one call
and an enum-valued rule reads as ``ACC_Status == 4 (Active-Hold)`` rather than a bare 4.
"""

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pymongo.database import Database

from ..auth import read_permission
from ..models import PaginatedResponse
from ..models_vmodel_chain import (
    SignalCatalogEntry,
    SignalQuery,
    TestSpec,
    TestSpecQuery,
)
from ..mongo import get_mongo

router = APIRouter()


def resolve_baseline_version(
    mongo: Database[dict[str, Any]], baseline_id: str, field: str
) -> str:
    """The artifact version a baseline pins for one kind, or 404 if the baseline is unknown."""
    baseline = mongo.vm_baselines.find_one({"_id": baseline_id})
    if baseline is None:
        raise HTTPException(status_code=404, detail=f"Baseline '{baseline_id}' not found")
    return str(baseline[field])


@router.get(
    "/test-specs",
    response_model=PaginatedResponse[TestSpec],
    response_model_by_alias=False,
)
def list_test_specs(
    query_params: TestSpecQuery = Depends(),
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> PaginatedResponse[TestSpec]:
    """List test specifications across every artifact version."""
    query: dict[str, Any] = {}
    if query_params.tc_id:
        query["tc_id"] = query_params.tc_id
    if query_params.covers_req_id:
        query["covers_req_ids"] = query_params.covers_req_id
    if query_params.artifact_version:
        query["artifact_version"] = query_params.artifact_version
    if query_params.baseline:
        query["artifact_version"] = resolve_baseline_version(
            mongo, query_params.baseline, "test_specs_version"
        )
    if query_params.q:
        pattern = {"$regex": re.escape(query_params.q.strip()), "$options": "i"}
        query["$or"] = [{"tc_id": pattern}, {"title": pattern}, {"objective": pattern}]

    total = mongo.vm_test_specs.count_documents(query)
    skip = (query_params.page - 1) * query_params.page_size
    cursor = (
        mongo.vm_test_specs.find(query)
        .sort([("tc_id", 1), ("artifact_version", 1)])
        .skip(skip)
        .limit(query_params.page_size)
    )
    return PaginatedResponse.create(
        items=[TestSpec(**doc) for doc in cursor],
        total=total,
        page=query_params.page,
        page_size=query_params.page_size,
    )


@router.get("/test-specs/{key}", response_model=TestSpec, response_model_by_alias=False)
def get_test_spec(
    key: str,
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> TestSpec:
    """Get one test specification with every criterion's signal resolved.

    ``key`` is ``"{tc_id}@{artifact_version}"``; a bare ``tc_id`` selects the highest version.
    """
    doc = mongo.vm_test_specs.find_one({"_id": key})
    if doc is None:
        matches = sorted(
            mongo.vm_test_specs.find({"tc_id": key}), key=lambda item: item["artifact_version"]
        )
        if not matches:
            raise HTTPException(status_code=404, detail=f"Test specification '{key}' not found")
        doc = matches[-1]

    version = str(doc["artifact_version"])
    for criterion in doc.get("pass_criteria") or []:
        signal_name = criterion.get("signal")
        if not signal_name:
            continue
        entry = mongo.vm_signals.find_one({"_id": f"{signal_name}@{version}"}) or (
            mongo.vm_signals.find_one({"signal": signal_name})
        )
        if entry is not None:
            criterion["resolved_signal"] = {
                "unit": entry.get("unit"),
                "raster_hz": entry.get("raster_hz"),
                "role": entry.get("role"),
                "channel_group": entry.get("channel_group"),
                "enum_map": entry.get("enum_map"),
            }

    return TestSpec(**doc)


@router.get(
    "/signals",
    response_model=PaginatedResponse[SignalCatalogEntry],
    response_model_by_alias=False,
)
def list_signals(
    query_params: SignalQuery = Depends(),
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> PaginatedResponse[SignalCatalogEntry]:
    """List the signal catalogue. Read-only lookup data, one version per artifact set."""
    query: dict[str, Any] = {}
    if query_params.signal:
        query["signal"] = query_params.signal
    if query_params.channel_group:
        query["channel_group"] = query_params.channel_group
    if query_params.role:
        query["role"] = query_params.role
    if query_params.artifact_version:
        query["artifact_version"] = query_params.artifact_version

    total = mongo.vm_signals.count_documents(query)
    skip = (query_params.page - 1) * query_params.page_size
    cursor = mongo.vm_signals.find(query).sort("signal", 1).skip(skip).limit(query_params.page_size)
    return PaginatedResponse.create(
        items=[SignalCatalogEntry(**doc) for doc in cursor],
        total=total,
        page=query_params.page,
        page_size=query_params.page_size,
    )
