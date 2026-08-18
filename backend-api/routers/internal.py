"""Internal endpoints - the contract between the API and the stream workers.

Why the workers talk to the API rather than reading blob and Mongo themselves:
every Quix application is built from its own folder, so code cannot be shared
across deployments without duplicating it. Duplicating the metric formulas, the
requirement-verdict precedence, the canonicalisation rules or the blob seam would
let two copies disagree - and a metric block that disagrees with itself is worse
than a missing one. So the API stays the single authority for artifacts, the
registry and everything derived, and the evaluator owns exactly one thing the API
does not: the criteria engine and the lake queries.

These routes are not part of the frontend contract and are grouped under
``/internal`` so that is obvious.
"""

from fastapi import APIRouter, Depends, Query

import baseline_service
import deps
import mongo_schema
import run_service
import settings
from api_models import EvaluationSubmission

router = APIRouter(prefix="/internal", tags=["internal"])


@router.get("/evaluation-input/{test_run_id}")
def evaluation_input(
    test_run_id: str,
    run_version: int | None = Query(None),
    db=Depends(deps.get_db),
) -> dict:
    """Everything the evaluator needs, resolved through the run's one baseline.

    Includes the per-case trace list keyed by ``trace_key`` together with the
    partition columns (``device_id``, ``scenario``) the evaluator needs so its
    lake queries push down to an S3 prefix instead of scanning.
    """
    deps.require_blob()
    run = run_service.get_run(db, test_run_id)
    version = run_version or int(run["latest_run_version"])
    bundle = baseline_service.load_bundle(run["baseline_id"])
    planned = list(run["scope"]["planned_tc_ids"])

    links = list(
        db[mongo_schema.RUN_TRACE_LINKS].find(
            {"test_run_id": test_run_id, "run_version": version}
        )
    )
    trace_keys = sorted({link["trace_key"] for link in links})
    traces = {
        doc["trace_key"]: doc
        for doc in db[mongo_schema.TRACES].find({"trace_key": {"$in": trace_keys}})
    }

    by_case: dict[str, list[dict]] = {tc_id: [] for tc_id in planned}
    for link in links:
        trace = traces.get(link["trace_key"])
        if trace is None or link["tc_id"] not in by_case:
            continue
        by_case[link["tc_id"]].append(
            {
                "trace_key": trace["trace_key"],
                "device_id": trace.get("device_id"),
                "scenario": (trace.get("mf4") or {}).get("scenario_name"),
                "variant_id": (trace.get("mf4") or {}).get("variant_id"),
                "config_hash12": (trace.get("mf4") or {}).get("config_hash12"),
                "signals": sorted(trace.get("signals") or []),
                "ingest_status": trace.get("ingest_status"),
                "lake_rows": trace.get("lake_rows") or {},
                "content_sha256": trace.get("content_sha256"),
            }
        )

    parameter_set = None
    if run.get("config_id"):
        parameter_set = db[mongo_schema.PARAMETER_SETS].find_one(
            {"config_id": run["config_id"], "config_version": run.get("config_version")}
        )

    return {
        "test_run_id": test_run_id,
        "run_version": version,
        "baseline_id": run["baseline_id"],
        "device": {
            "device_id": run["device_id"],
            "sw_version": run["device_sw_version"],
            "hw_version": run["device_hw_version"],
        },
        "allow_provenance_mismatch": bool(run.get("allow_provenance_mismatch")),
        "expected_config_hash12": (parameter_set or {}).get("config_hash12"),
        "planned_tc_ids": planned,
        "test_cases": {
            tc_id: bundle["test_cases"][tc_id]
            for tc_id in planned
            if tc_id in bundle["test_cases"]
        },
        "signal_catalog": bundle["signal_catalog"],
        "traces_by_case": by_case,
        "group_tables": settings.GROUP_TABLES,
        "group_raster_hz": settings.GROUP_RASTER_HZ,
    }


@router.get("/trace-runs/{trace_key}")
def trace_runs(trace_key: str, db=Depends(deps.get_db)) -> dict:
    """Which runs and cases a completed trace belongs to.

    Consumed by the readiness worker: the completion event carries only a
    ``trace_key``, and the link rows that turn it into a run are in Mongo.
    """
    links = list(db[mongo_schema.RUN_TRACE_LINKS].find({"trace_key": trace_key}))
    runs: dict[str, dict] = {}
    for link in links:
        entry = runs.setdefault(
            f"{link['test_run_id']}#{link['run_version']}",
            {
                "test_run_id": link["test_run_id"],
                "run_version": link["run_version"],
                "tc_ids": [],
            },
        )
        entry["tc_ids"].append(link["tc_id"])
    for entry in runs.values():
        run = db[mongo_schema.TEST_RUNS].find_one({"test_run_id": entry["test_run_id"]})
        entry["tc_ids"] = sorted(set(entry["tc_ids"]))
        entry["status"] = (run or {}).get("status")
        entry["auto_evaluate"] = bool((run or {}).get("auto_evaluate"))
    return {"trace_key": trace_key, "count": len(runs), "items": list(runs.values())}


@router.post("/evaluations")
def submit_evaluation(
    body: EvaluationSubmission,
    db=Depends(deps.get_db),
    bus=Depends(deps.get_bus),
) -> dict:
    """The evaluator hands back per-case results; the API derives everything else."""
    deps.require_blob()
    return run_service.finalize_evaluation(db, bus, body)


@router.post("/traces/{trace_key}/completion")
def record_completion(trace_key: str, payload: dict, db=Depends(deps.get_db)) -> dict:
    """Fallback path for the extractor's completion report.

    The normal path is the ``trace-ingest-completed`` topic sunk into ``traces``
    by ``mongo-writer``. This endpoint exists for the case where the extractor
    ran but the sink is down: it is idempotent and writes the same fields.
    """
    update = {
        key: value
        for key, value in payload.items()
        if key in ("ingest_status", "lake_rows", "signals", "groups", "extraction",
                   "trace_epoch_ms", "epoch_source", "mf4", "attachments", "ingest_log")
    }
    if not update:
        return {"trace_key": trace_key, "updated": False}
    db[mongo_schema.TRACES].update_one({"trace_key": trace_key}, {"$set": update})
    return {"trace_key": trace_key, "updated": True, "fields": sorted(update)}
