"""V-model test run and trace endpoints (read-only in this phase).

A *run* is one evaluation of the pinned test implementations over one trace. Runs are not a
collection: they are the ``run_id`` side of the ``vm_run_traces`` join, with verdict counts
aggregated from ``vm_results``. Materialising them as ``tests`` documents is what the
optional ``Test.vmodel`` sub-document is for, and that write path is deliberately not part
of this phase - the seed must not change what ``GET /api/v1/tests`` returns.
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pymongo.database import Database

from ..auth import read_permission
from ..models import PaginatedResponse
from ..models_vmodel_chain import RunSummary, Trace
from ..mongo import get_mongo

router = APIRouter()


def _verdict_counts(mongo: Database[dict[str, Any]]) -> dict[str, dict[str, int]]:
    """run_id -> {PASS: n, FAIL: n, ...}, in one aggregation rather than one query per run."""
    counts: dict[str, dict[str, int]] = {}
    pipeline = [{"$group": {"_id": {"run_id": "$run_id", "status": "$status"}, "n": {"$sum": 1}}}]
    for row in mongo.vm_results.aggregate(pipeline):
        run_id = str(row["_id"]["run_id"])
        counts.setdefault(run_id, {})[str(row["_id"]["status"])] = int(row["n"])
    return counts


def _run_summaries(mongo: Database[dict[str, Any]], run_id: str | None = None) -> list[RunSummary]:
    """Build run summaries from the run/trace join plus the aggregated verdict counts."""
    match: dict[str, Any] = {"run_id": run_id} if run_id else {}
    counts = _verdict_counts(mongo)
    scenarios = {
        str(trace["_id"]): trace.get("scenario")
        for trace in mongo.vm_traces.find({}, {"scenario": 1})
    }

    grouped: dict[str, list[str]] = {}
    for link in mongo.vm_run_traces.find(match).sort("run_id", 1):
        grouped.setdefault(str(link["run_id"]), []).append(str(link["trace_key"]))

    baseline = mongo.vm_baselines.find_one({}, sort=[("_id", 1)])
    req_links: dict[str, list[str]] = baseline.get("req_links", {}) if baseline else {}
    planned_tc_ids = sorted({tc_id for group in req_links.values() for tc_id in group})

    summaries = []
    for key in sorted(grouped):
        trace_keys = sorted(grouped[key])
        scenario = next((scenarios.get(trace) for trace in trace_keys if scenarios.get(trace)), None)
        summaries.append(
            RunSummary(
                run_id=key,
                baseline_id=str(baseline["_id"]) if baseline else None,
                label=f"{scenario} · {key}" if scenario else key,
                scenario=scenario,
                trace_keys=trace_keys,
                planned_tc_ids=planned_tc_ids,
                counts=counts.get(key, {}),
            )
        )
    return summaries


@router.get("/runs", response_model=PaginatedResponse[RunSummary])
def list_runs(
    page: int = 1,
    page_size: int = 100,
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> PaginatedResponse[RunSummary]:
    """List V-model runs with their traces and verdict counts."""
    summaries = _run_summaries(mongo)
    start = (page - 1) * page_size
    return PaginatedResponse.create(
        items=summaries[start : start + page_size],
        total=len(summaries),
        page=page,
        page_size=page_size,
    )


@router.get("/runs/{run_id}", response_model=RunSummary)
def get_run(
    run_id: str,
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> RunSummary:
    """Get one run: its traces, its pinned baseline and its verdict counts."""
    summaries = _run_summaries(mongo, run_id)
    if not summaries:
        raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")
    return summaries[0]


@router.get(
    "/runs/{run_id}/traces",
    response_model=list[Trace],
    response_model_by_alias=False,
)
def list_run_traces(
    run_id: str,
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> list[Trace]:
    """List the traces attached to a run. The join is many-to-many and append-only."""
    keys = [str(link["trace_key"]) for link in mongo.vm_run_traces.find({"run_id": run_id})]
    if not keys:
        raise HTTPException(status_code=404, detail=f"Run '{run_id}' has no attached traces")
    return [Trace(**doc) for doc in mongo.vm_traces.find({"_id": {"$in": keys}}).sort("_id", 1)]


@router.get(
    "/traces",
    response_model=PaginatedResponse[Trace],
    response_model_by_alias=False,
)
def list_traces(
    scenario: str | None = None,
    ingest_status: str | None = None,
    page: int = 1,
    page_size: int = 100,
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> PaginatedResponse[Trace]:
    """List measurement traces. Metadata only - no MF4 is parsed in this phase."""
    query: dict[str, Any] = {}
    if scenario:
        query["scenario"] = scenario
    if ingest_status:
        query["ingest_status"] = ingest_status

    total = mongo.vm_traces.count_documents(query)
    cursor = (
        mongo.vm_traces.find(query).sort("_id", 1).skip((page - 1) * page_size).limit(page_size)
    )
    return PaginatedResponse.create(
        items=[Trace(**doc) for doc in cursor], total=total, page=page, page_size=page_size
    )


@router.get("/traces/{trace_key}", response_model=Trace, response_model_by_alias=False)
def get_trace(
    trace_key: str,
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> Trace:
    """Get one trace's metadata and digest."""
    doc = mongo.vm_traces.find_one({"_id": trace_key})
    if doc is None:
        raise HTTPException(status_code=404, detail=f"Trace '{trace_key}' not found")
    return Trace(**doc)
