"""Trace registry reads. The upload itself lives in ``routers/uploads.py``."""

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

import artifact_store
import blob_storage
import deps
import mongo_schema
import trace_service

router = APIRouter(prefix="/traces", tags=["traces"])


@router.get("")
def list_traces(
    device_id: str | None = Query(None),
    tc_id: str | None = Query(None),
    test_run_id: str | None = Query(None),
    ingest_status: str | None = Query(None),
    publish_state: str | None = Query(
        None,
        description=(
            "pending | published | failed. 'failed' lists traces whose bytes and registry "
            "row committed but whose extraction request never reached the broker; "
            "re-uploading the identical file republishes it."
        ),
    ),
    config_hash12: str | None = Query(None),
    limit: int = Query(500, ge=1, le=5000),
    db=Depends(deps.get_db),
) -> dict:
    """Filterable list. ``tc_id``/``test_run_id`` resolve through ``run_trace_links``."""
    query: dict = {}
    if device_id:
        query["device_id"] = device_id
    if ingest_status:
        query["ingest_status"] = ingest_status
    if publish_state:
        query["publish_state"] = publish_state
    if config_hash12:
        query["mf4.config_hash12"] = config_hash12
    if tc_id or test_run_id:
        link_query: dict = {}
        if tc_id:
            link_query["tc_id"] = tc_id
        if test_run_id:
            link_query["test_run_id"] = test_run_id
        keys = sorted(
            {
                link["trace_key"]
                for link in db[mongo_schema.RUN_TRACE_LINKS].find(link_query, {"trace_key": 1})
            }
        )
        query["trace_key"] = {"$in": keys}

    documents = list(db[mongo_schema.TRACES].find(query).sort("uploaded_utc", -1).limit(limit))
    return {"count": len(documents), "items": mongo_schema.serialize_all(documents)}


@router.get("/{trace_key}")
def get_trace(trace_key: str, db=Depends(deps.get_db)) -> dict:
    """The pre-resolved trace neighbourhood of spec 2.6."""
    try:
        return trace_service.trace_neighbourhood(db, trace_key)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{trace_key}/meta")
def get_trace_meta(trace_key: str, db=Depends(deps.get_db)) -> dict:
    """``trace.meta.json`` as written beside the MF4 - the blob record of truth."""
    deps.require_blob()
    trace = db[mongo_schema.TRACES].find_one({"trace_key": trace_key})
    if trace is None:
        raise HTTPException(status_code=404, detail=f"trace {trace_key} is not registered")
    return artifact_store.read_trace_meta(trace["device_id"], trace_key)


@router.get("/{trace_key}/object")
def download_trace(trace_key: str, db=Depends(deps.get_db)) -> Response:
    """Stream the raw MF4 back. The frontend never receives a blob URL."""
    deps.require_blob()
    trace = db[mongo_schema.TRACES].find_one({"trace_key": trace_key})
    if trace is None:
        raise HTTPException(status_code=404, detail=f"trace {trace_key} is not registered")
    blob = blob_storage.read_bytes(trace["blob_path"])
    return Response(
        content=blob,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{trace_key}.mf4"'},
    )
