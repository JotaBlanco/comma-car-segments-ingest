"""Results, metrics, requirement verdicts and report artifacts (pages 5).

``GET /metrics/{test_run_id}/{run_version}`` is what replaces the old
``GET /evaluate``. That endpoint counted ``results`` grouped by a ``status`` field
and reported nothing about coverage, requirements or the frozen plan; these
endpoints report the spec-6 metric block with both denominators, the sum-check
invariant and the per-requirement verdict precedence.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

import artifact_store
import baseline_service
import deps
import metrics as metrics_module
import mongo_schema
import report_service
import run_service

router = APIRouter(tags=["results"])


@router.get("/results")
def list_results(
    test_run_id: str = Query(...),
    run_version: int | None = Query(None),
    verdict: str | None = Query(None),
    tc_id: str | None = Query(None),
    req_id: str | None = Query(None),
    db=Depends(deps.get_db),
) -> dict:
    run = run_service.get_run(db, test_run_id)
    version = run_version or int(run["latest_run_version"])
    query: dict = {"test_run_id": test_run_id, "run_version": version}
    if verdict:
        query["verdict"] = verdict
    if tc_id:
        query["tc_id"] = tc_id
    if req_id:
        query["req_ids"] = req_id
    documents = list(db[mongo_schema.RESULTS].find(query).sort("tc_id", 1))
    return {
        "test_run_id": test_run_id,
        "run_version": version,
        "count": len(documents),
        "items": mongo_schema.serialize_all(documents),
    }


@router.get("/metrics/{test_run_id}/{run_version}")
def get_metrics(test_run_id: str, run_version: int, db=Depends(deps.get_db)) -> dict:
    """Stored metrics if the sink has caught up, recomputed from the same inputs otherwise."""
    stored = db[mongo_schema.RUN_METRICS].find_one(
        {"test_run_id": test_run_id, "run_version": run_version}
    )
    if stored is not None:
        return {"source": "run_metrics", **mongo_schema.serialize(stored)}

    deps.require_blob()
    run = run_service.get_run(db, test_run_id)
    bundle = baseline_service.load_bundle(run["baseline_id"])
    results = report_service.load_results(db, test_run_id, run_version)
    planned = list(run["scope"]["planned_tc_ids"])
    metric_block = metrics_module.compute(
        bundle["baseline"], bundle["requirements"], bundle["test_cases"], planned, results
    )
    return {
        "source": "recomputed",
        "test_run_id": test_run_id,
        "run_version": run_version,
        **metric_block,
    }


@router.get("/requirement-verdicts/{test_run_id}/{run_version}")
def get_requirement_verdicts(
    test_run_id: str, run_version: int, db=Depends(deps.get_db)
) -> dict:
    stored = list(
        db[mongo_schema.REQ_VERDICTS]
        .find({"test_run_id": test_run_id, "run_version": run_version})
        .sort("req_id", 1)
    )
    if stored:
        return {
            "source": "req_verdicts",
            "count": len(stored),
            "items": mongo_schema.serialize_all(stored),
        }

    deps.require_blob()
    run = run_service.get_run(db, test_run_id)
    bundle = baseline_service.load_bundle(run["baseline_id"])
    results = report_service.load_results(db, test_run_id, run_version)
    items = metrics_module.requirement_verdicts(
        bundle["requirements"],
        bundle["baseline"].get("req_links") or {},
        list(run["scope"]["planned_tc_ids"]),
        results,
    )
    return {"source": "recomputed", "count": len(items), "items": items}


reports_router = APIRouter(prefix="/reports", tags=["results"])


@reports_router.get("/{test_run_id}/{run_version}")
def list_revisions(test_run_id: str, run_version: int, db=Depends(deps.get_db)) -> dict:
    deps.require_blob()
    run = run_service.get_run(db, test_run_id)
    revisions = artifact_store.list_report_revisions(test_run_id, run_version)
    return {
        "test_run_id": test_run_id,
        "run_version": run_version,
        "revisions": revisions,
        "latest": revisions[-1] if revisions else None,
        "report_ref": run.get("report_ref"),
    }


@reports_router.get("/{test_run_id}/{run_version}/{revision}/report.json")
def get_report_json(test_run_id: str, run_version: int, revision: str) -> Response:
    deps.require_blob()
    body = artifact_store.read_report_file(test_run_id, run_version, revision, "report.json")
    return Response(content=body, media_type="application/json")


@reports_router.get("/{test_run_id}/{run_version}/{revision}/report.html")
def get_report_html(test_run_id: str, run_version: int, revision: str) -> Response:
    deps.require_blob()
    body = artifact_store.read_report_file(test_run_id, run_version, revision, "report.html")
    return Response(content=body, media_type="text/html; charset=utf-8")


@reports_router.get("/{test_run_id}/{run_version}/{revision}/plots/{filename}")
def get_report_plot(
    test_run_id: str, run_version: int, revision: str, filename: str
) -> Response:
    """The same SVG bytes the report embeds, so page 5 shows the identical artifact."""
    deps.require_blob()
    if not filename.endswith(".svg"):
        raise HTTPException(status_code=404, detail="only .svg plots are served")
    body = artifact_store.read_report_file(
        test_run_id, run_version, revision, f"plots/{filename}"
    )
    return Response(content=body, media_type="image/svg+xml")
