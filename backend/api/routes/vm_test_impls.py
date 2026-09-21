"""V-model test implementation endpoints.

List and detail responses deliberately omit the source text - nine modules with their two
shared helpers is a few hundred kilobytes - and ``/source`` serves one declared file at a
time as ``text/plain``. ``path`` must be one of the implementation's own ``files[].path``,
so no request can read a file the artifact does not declare.
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pymongo.database import Database

from ..auth import read_permission
from ..models import PaginatedResponse
from ..models_vmodel_chain import TestImpl, TestImplQuery
from ..mongo import get_mongo
from .vm_test_specs import resolve_baseline_version

router = APIRouter()


def _find_impl(mongo: Database[dict[str, Any]], key: str) -> dict[str, Any]:
    """Resolve ``key`` (``impl_id@version``, a bare ``impl_id`` or a ``tc_id``) to one document."""
    doc = mongo.vm_test_impls.find_one({"_id": key})
    if doc is not None:
        return doc

    matches = sorted(
        mongo.vm_test_impls.find({"$or": [{"impl_id": key}, {"tc_id": key}]}),
        key=lambda item: item["artifact_version"],
    )
    if not matches:
        raise HTTPException(status_code=404, detail=f"Test implementation '{key}' not found")
    return matches[-1]


@router.get(
    "/test-impls",
    response_model=PaginatedResponse[TestImpl],
    response_model_by_alias=False,
)
def list_test_impls(
    query_params: TestImplQuery = Depends(),
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> PaginatedResponse[TestImpl]:
    """List test implementations with their declared bound, without the source text."""
    query: dict[str, Any] = {}
    if query_params.impl_id:
        query["impl_id"] = query_params.impl_id
    if query_params.tc_id:
        query["tc_id"] = query_params.tc_id
    if query_params.language:
        query["language"] = query_params.language
    if query_params.artifact_version:
        query["artifact_version"] = query_params.artifact_version
    if query_params.baseline:
        query["artifact_version"] = resolve_baseline_version(
            mongo, query_params.baseline, "test_impl_version"
        )

    total = mongo.vm_test_impls.count_documents(query)
    skip = (query_params.page - 1) * query_params.page_size
    cursor = (
        mongo.vm_test_impls.find(query, {"source": 0})
        .sort([("impl_id", 1), ("artifact_version", 1)])
        .skip(skip)
        .limit(query_params.page_size)
    )
    return PaginatedResponse.create(
        items=[TestImpl(**doc) for doc in cursor],
        total=total,
        page=query_params.page,
        page_size=query_params.page_size,
    )


@router.get("/test-impls/{key}", response_model=TestImpl, response_model_by_alias=False)
def get_test_impl(
    key: str,
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> TestImpl:
    """Get one implementation: metadata, file digests and the declared ``check_spec``."""
    doc = _find_impl(mongo, key)
    doc.pop("source", None)
    return TestImpl(**doc)


@router.get("/test-impls/{key}/source", response_class=PlainTextResponse)
def get_test_impl_source(
    key: str,
    path: str | None = Query(None, description="One of the implementation's files[].path"),
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> PlainTextResponse:
    """Serve one declared source file as text. Defaults to the implementation's own module."""
    doc = _find_impl(mongo, key)
    source: dict[str, str] = doc.get("source") or {}
    declared = [str(entry["path"]) for entry in doc.get("files") or []]

    selected = path or (declared[0] if declared else None)
    if selected is None or selected not in declared or selected not in source:
        raise HTTPException(
            status_code=404,
            detail=f"'{path}' is not a declared file of {doc.get('impl_id')}",
        )

    return PlainTextResponse(content=source[selected], media_type="text/plain; charset=utf-8")
