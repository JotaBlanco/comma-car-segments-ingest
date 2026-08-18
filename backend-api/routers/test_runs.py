"""Test runs: create, submit, attach, watch readiness, trigger evaluation, report.

Nothing in this router evaluates anything. ``POST /test-runs/{id}/evaluate``
publishes one ``evaluation-requests`` message and returns; the evaluator picks it
up, finds its input by ``trace_key``, and hands results back through
``/internal/evaluations``. That separation is decision D8 and it is why uploads can
arrive from different places at different times.
"""

from fastapi import APIRouter, Depends, Query

import deps
import mongo_schema
import report_service
import run_service
from api_models import (
    AttachRequest,
    EvaluateRequest,
    LessonsUpdate,
    ManualVerdict,
    ReportRequest,
    TestRunCreate,
)

router = APIRouter(prefix="/test-runs", tags=["test-runs"])


@router.get("")
def list_runs(
    baseline: str | None = Query(None),
    device_id: str | None = Query(None),
    config_id: str | None = Query(None),
    status: str | None = Query(None),
    limit: int = Query(200, ge=1, le=2000),
    db=Depends(deps.get_db),
) -> dict:
    query: dict = {}
    if baseline:
        query["baseline_id"] = baseline
    if device_id:
        query["device_id"] = device_id
    if config_id:
        query["config_id"] = config_id
    if status:
        query["status"] = status
    documents = list(db[mongo_schema.TEST_RUNS].find(query).sort("created_utc", -1).limit(limit))
    return {
        "count": len(documents),
        "items": [
            {
                "test_run_id": doc["test_run_id"],
                "run_version": doc["latest_run_version"],
                "version_descriptor": doc.get("version_descriptor"),
                "baseline_id": doc.get("baseline_id"),
                "device_id": doc.get("device_id"),
                "config_id": doc.get("config_id"),
                "config_version": doc.get("config_version"),
                "status": doc.get("status"),
                "planned_count": len(doc.get("scope", {}).get("planned_tc_ids") or []),
                "created_utc": doc.get("created_utc"),
                "submitted_utc": doc.get("submitted_utc"),
                "report_ref": doc.get("report_ref"),
            }
            for doc in documents
        ],
    }


@router.post("", status_code=201)
def create_run(body: TestRunCreate, db=Depends(deps.get_db)) -> dict:
    """Creates a draft run with ``scope.planned_tc_ids`` already persisted."""
    deps.require_blob()
    return mongo_schema.serialize(run_service.create_run(db, body))


@router.get("/{test_run_id}")
def get_run(test_run_id: str, db=Depends(deps.get_db)) -> dict:
    return mongo_schema.serialize(run_service.get_run(db, test_run_id))


@router.post("/{test_run_id}/submit")
def submit_run(test_run_id: str, db=Depends(deps.get_db)) -> dict:
    """Freezes the plan. It is the denominator of every outcome metric."""
    return mongo_schema.serialize(run_service.submit_run(db, test_run_id))


@router.post("/{test_run_id}/attachments")
def attach(test_run_id: str, body: AttachRequest, db=Depends(deps.get_db)) -> dict:
    """Many-to-many attach with the page-4 required-signal pre-flight."""
    deps.require_blob()
    return run_service.attach(
        db, test_run_id, body.tc_ids, body.trace_keys, body.attached_by
    )


@router.get("/{test_run_id}/attachments")
def get_attachments(
    test_run_id: str, run_version: int | None = Query(None), db=Depends(deps.get_db)
) -> dict:
    return run_service.attachments(db, test_run_id, run_version)


@router.get("/{test_run_id}/readiness")
def get_readiness(
    test_run_id: str, run_version: int | None = Query(None), db=Depends(deps.get_db)
) -> dict:
    """Live ``stored -> vectorised -> linked`` per trace, plus per-case readiness."""
    deps.require_blob()
    return run_service.readiness(db, test_run_id, run_version)


@router.post("/{test_run_id}/evaluate", status_code=202)
def evaluate(
    test_run_id: str,
    body: EvaluateRequest,
    db=Depends(deps.get_db),
    bus=Depends(deps.get_bus),
) -> dict:
    """Publish an evaluation request. Returns 202; nothing is evaluated inline."""
    return run_service.request_evaluation(
        db, bus, test_run_id, body.trigger, body.requested_by, body.new_run_version
    )


@router.post("/{test_run_id}/manual-verdict")
def manual_verdict(
    test_run_id: str,
    body: ManualVerdict,
    db=Depends(deps.get_db),
    bus=Depends(deps.get_bus),
) -> dict:
    """Record a human verdict for an Inspection/Demonstration case."""
    return run_service.record_manual_verdict(db, bus, test_run_id, body)


@router.post("/{test_run_id}/report")
def generate_report(
    test_run_id: str,
    body: ReportRequest,
    db=Depends(deps.get_db),
    bus=Depends(deps.get_bus),
) -> dict:
    """Render a new report revision. Never overwrites an earlier one."""
    deps.require_blob()
    return report_service.generate(
        db, bus, test_run_id, body.run_version, body.requested_by, body.lessons_learned
    )


@router.put("/{test_run_id}/lessons-learned")
def set_lessons(
    test_run_id: str, body: LessonsUpdate, db=Depends(deps.get_db)
) -> dict:
    """Free text for report clause 7.4.10. Not versioned; the report revision is."""
    run_service.get_run(db, test_run_id)
    db[mongo_schema.TEST_RUNS].update_one(
        {"test_run_id": test_run_id}, {"$set": {"lessons_learned": body.lessons_learned}}
    )
    return {"test_run_id": test_run_id, "lessons_learned": body.lessons_learned}
