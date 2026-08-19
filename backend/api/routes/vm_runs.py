"""V-model test run and trace endpoints.

A run reaches this list one of two ways, and ``RunSummary.origin`` says which:

* **seeded** - *derived*. The fixture ingest writes no run document at all; a seeded run
  exists only as the ``run_id`` side of the ``vm_run_traces`` join, with verdict counts
  aggregated from ``vm_results``. This is why a newly created run could not appear in the
  list until the union below existed.
* **planned** - *stored*. ``POST /runs`` writes a ``tests`` document carrying a ``vmodel``
  sub-document, which is the entity the domain model designates for a Test Run. It has no
  traces and no verdicts until the execution step (owned by Tomas / QuixLab) runs.

``GET /runs`` returns the union, newest first, so a run created from the Add Test Run dialog
is the first row on the Test Results page.
"""

import re
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from pymongo.database import Database

from ..auth import read_permission, update_permission
from ..models import PaginatedResponse, Test, TestStatus, VModelRun, VModelRunStatus
from ..models_vmodel_chain import RunCreate, RunOrigin, RunSummary, Trace
from ..mongo import get_mongo
from ..utils import now
from ..vm_run_summary import (
    RunDetailSummary,
    RunStatusUpdate,
    VerdictRollup,
    build_run_detail,
    summary_verdicts,
    verdict_rollup,
)

router = APIRouter()

#: Run ids are ``TR-`` plus a zero-padded counter, shared by seeded and created runs so the
#: two families cannot collide.
RUN_ID_PREFIX = "TR-"
RUN_ID_PATTERN = re.compile(r"^TR-(\d+)$")


def _stored_run_summaries(
    mongo: Database[dict[str, Any]],
    rollup: VerdictRollup,
    run_id: str | None = None,
) -> list[RunSummary]:
    """Summaries for runs stored as ``tests`` documents with a ``vmodel`` sub-document.

    These are the runs the Add Test Run dialog creates. They carry their planned test cases,
    their execution status and their optional MF4 attachments; the verdict counts stay empty
    until something evaluates them, which is what makes a not-yet-run run legible in the list
    rather than looking broken.
    """
    query: dict[str, Any] = {"vmodel": {"$ne": None}}
    if run_id:
        query["_id"] = run_id

    summaries = []
    for doc in mongo.tests.find(query):
        vmodel = doc.get("vmodel") or {}
        key = str(doc["_id"])
        planned_tc_ids = list(vmodel.get("planned_tc_ids") or [])
        verdicts = summary_verdicts(rollup, key, planned_tc_ids, vmodel.get("status"))
        summaries.append(
            RunSummary(
                run_id=key,
                baseline_id=vmodel.get("baseline_id"),
                label=vmodel.get("label") or key,
                scenario=vmodel.get("selector"),
                origin=RunOrigin.PLANNED,
                trace_keys=list(vmodel.get("trace_keys") or []),
                planned_tc_ids=planned_tc_ids,
                tc_uploads=list(vmodel.get("tc_uploads") or []),
                created_utc=vmodel.get("created_utc") or doc.get("created_at"),
                started_utc=vmodel.get("started_utc"),
                evaluated_utc=vmodel.get("evaluated_utc") or rollup.evaluated.get(key),
                status=verdicts.status,
                counts=verdicts.counts,
                tc_counts=verdicts.tc_counts,
                success_rate=verdicts.success_rate,
            )
        )
    return summaries


def _run_summaries(mongo: Database[dict[str, Any]], run_id: str | None = None) -> list[RunSummary]:
    """Every run, stored and derived, newest first."""
    rollup = verdict_rollup(mongo)
    stored = _stored_run_summaries(mongo, rollup, run_id)
    derived = _derived_run_summaries(mongo, rollup, run_id)
    stored_ids = {summary.run_id for summary in stored}

    # A stored run wins over a derived one of the same id: the document is authoritative
    # about its planned cases, its status and its uploads, the join only knows trace keys.
    merged = stored + [summary for summary in derived if summary.run_id not in stored_ids]
    return sorted(merged, key=_run_sort_key, reverse=True)


#: Public name for the summary builder. The Run execution endpoint
#: (``routes/vm_execute.py``) needs exactly the same union - stored runs and derived ones,
#: with the same effective status - and reaching for the underscored name from another
#: module would make that shared contract look accidental.
run_summaries = _run_summaries


def _run_sort_key(summary: RunSummary) -> tuple[int, str]:
    """Newest first: created runs (which have a timestamp) ahead of seeded ones, then by id.

    Run ids are zero-padded, so a plain string sort orders TR-0038 after TR-0009 correctly.
    """
    return (1 if summary.created_utc else 0, summary.run_id)


def _derived_run_summaries(
    mongo: Database[dict[str, Any]],
    rollup: VerdictRollup,
    run_id: str | None = None,
) -> list[RunSummary]:
    """Build run summaries from the run/trace join plus the aggregated verdict counts."""
    match: dict[str, Any] = {"run_id": run_id} if run_id else {}
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
        verdicts = summary_verdicts(rollup, key, planned_tc_ids, None)
        summaries.append(
            RunSummary(
                run_id=key,
                baseline_id=str(baseline["_id"]) if baseline else None,
                label=f"{scenario} · {key}" if scenario else key,
                scenario=scenario,
                origin=RunOrigin.SEEDED,
                trace_keys=trace_keys,
                planned_tc_ids=planned_tc_ids,
                evaluated_utc=rollup.evaluated.get(key),
                # A seeded run has no document, so it has no stored status: its verdicts are
                # the only evidence, and they make it 'completed'.
                status=verdicts.status,
                counts=verdicts.counts,
                tc_counts=verdicts.tc_counts,
                success_rate=verdicts.success_rate,
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


def _next_run_id(mongo: Database[dict[str, Any]]) -> str:
    """The next free ``TR-nnnn``, counting seeded and stored runs together.

    Seeded runs live only in ``vm_run_traces``, created runs only in ``tests``, so both have
    to be scanned or a created run would reuse a seeded id and silently merge with it.
    """
    highest = 0
    seen = list(mongo.vm_run_traces.distinct("run_id"))
    seen += [str(doc["_id"]) for doc in mongo.tests.find({"vmodel": {"$ne": None}}, {"_id": 1})]
    for candidate in seen:
        match = RUN_ID_PATTERN.match(str(candidate))
        if match:
            highest = max(highest, int(match.group(1)))
    return f"{RUN_ID_PREFIX}{highest + 1:04d}"


@router.post("/runs", response_model=RunSummary)
def create_run(
    payload: RunCreate = Body(...),
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(update_permission),
) -> RunSummary:
    """Create a Test Run from selected test cases and the MF4 uploaded for each.

    The run is stored as a ``tests`` document with a ``vmodel`` sub-document - the entity the
    domain model designates for a Test Run - so it appears in both ``GET /vmodel/runs`` and
    ``GET /api/v1/tests?has_vmodel=true``. Deliberately *not* routed through ``POST /tests``:
    that endpoint requires a campaign, an environment, an operator, a sensor map and at least
    one existing Device, and calls the Configuration Service. None of those exist for a run
    planned from test cases alone, and inventing them is exactly the placeholder noise this
    dialog removes.

    Execution is not triggered here. A created run has no traces and no verdicts until the
    QuixLab execution step (see the frontend ``run-test-run-button``) is implemented.
    """
    known_tc_ids = set(mongo.vm_test_specs.distinct("tc_id"))
    unknown = sorted({upload.tc_id for upload in payload.tc_uploads} - known_tc_ids)
    if unknown:
        raise HTTPException(
            status_code=404, detail=f"Unknown test case ids: {', '.join(unknown)}"
        )

    baseline = (
        mongo.vm_baselines.find_one({"_id": payload.baseline_id})
        if payload.baseline_id
        else mongo.vm_baselines.find_one({}, sort=[("_id", -1)])
    )
    if baseline is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "No baseline available to pin the run to. "
                "Seed the V-model register first (POST /api/v1/vmodel/seed)."
            ),
        )

    run_id = _next_run_id(mongo)
    if mongo.tests.find_one({"_id": run_id}, {"_id": 1}):
        raise HTTPException(
            status_code=409,
            detail=f"Run id '{run_id}' is already taken; retry to get the next one",
        )
    created = now()
    planned_tc_ids = sorted({upload.tc_id for upload in payload.tc_uploads})
    label = payload.label or f"{len(planned_tc_ids)} test cases · {run_id}"

    vmodel = VModelRun(
        baseline_id=str(baseline["_id"]),
        # Creation never implies execution: the run starts 'planned' and only the Run action
        # (POST /runs/{run_id}/status) moves it on.
        status=VModelRunStatus.PLANNED,
        label=label,
        # "manual" records how the case list was chosen: picked in the dialog, not expanded
        # from a chapter selector. planned_tc_ids is therefore already the frozen list.
        selector="manual",
        planned_tc_ids=planned_tc_ids,
        tc_uploads=payload.tc_uploads,
        created_utc=created,
    )
    # A V-model run has no Device Under Test, no campaign, no environment and no sensor map at
    # plan time. They are left empty rather than filled with invented values; Test tolerates
    # that (see the comment on Test.devices), and no 422 is reachable from the dialog.
    run = Test(
        _id=run_id,
        campaign_id="",
        devices=[],
        environment_id="",
        operator="",
        sensors={},
        config_id="",
        status=TestStatus.DRAFT,
        created_at=created,
        updated_at=created,
        vmodel=vmodel,
    )
    mongo.tests.insert_one(run.model_dump(by_alias=True))

    summaries = _run_summaries(mongo, run_id)
    if not summaries:  # pragma: no cover - the document was just inserted
        raise HTTPException(status_code=500, detail=f"Run '{run_id}' was not stored")
    return summaries[0]


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


#: Which execution states a run may move to from the one it is in. A run is re-runnable, so
#: both terminal states go back to ``running``; nothing may skip ``running`` to reach a
#: terminal state, because that would claim an execution that never happened.
ALLOWED_TRANSITIONS: dict[VModelRunStatus, set[VModelRunStatus]] = {
    VModelRunStatus.PLANNED: {VModelRunStatus.RUNNING},
    VModelRunStatus.RUNNING: {VModelRunStatus.COMPLETED, VModelRunStatus.ERROR},
    VModelRunStatus.COMPLETED: {VModelRunStatus.RUNNING},
    VModelRunStatus.ERROR: {VModelRunStatus.RUNNING},
}

#: Phase 2 ``TestStatus`` equivalent of each execution state. The run *is* a ``tests``
#: document, so leaving its lifecycle field on ``draft`` while the run executes would make the
#: legacy tests table contradict the run list.
TEST_STATUS_FOR: dict[VModelRunStatus, TestStatus] = {
    VModelRunStatus.PLANNED: TestStatus.DRAFT,
    VModelRunStatus.RUNNING: TestStatus.IN_PROGRESS,
    VModelRunStatus.COMPLETED: TestStatus.FINISHED,
    VModelRunStatus.ERROR: TestStatus.FINISHED,
}


def require_stored_run(mongo: Database[dict[str, Any]], run_id: str) -> dict[str, Any]:
    """The ``tests`` document of a V-model run, or the 404/409 that explains its absence.

    Only *stored* runs have an execution state. A seeded run has no document - it exists
    only as the ``run_id`` side of the ``vm_run_traces`` join - so there is nothing to move,
    and saying so with a 409 is more useful than inventing a document to hold the state.
    """
    doc = mongo.tests.find_one({"_id": run_id})
    if doc is None:
        raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")
    if not doc.get("vmodel"):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Test '{run_id}' is not a V-model run: it carries no vmodel sub-document and "
                "has no test cases to execute."
            ),
        )
    return doc


def assert_transition(run_id: str, current: VModelRunStatus, target: VModelRunStatus) -> None:
    """Refuse any move the transition map does not allow, naming what would be allowed."""
    reachable = ALLOWED_TRANSITIONS.get(current, set())
    if target not in reachable:
        allowed = ", ".join(sorted(status.value for status in reachable))
        raise HTTPException(
            status_code=409,
            detail=(
                f"Run '{run_id}' is '{current.value}' and cannot move to '{target.value}'. "
                f"Allowed from here: {allowed or 'nothing'}."
            ),
        )


def apply_run_status(
    mongo: Database[dict[str, Any]], run_id: str, target: VModelRunStatus
) -> RunSummary:
    """Persist one execution-state transition. The only writer of ``vmodel.status``.

    Both the status endpoint and the execute endpoint go through here, so the timestamps a
    run carries cannot depend on which one moved it.
    """
    stamped = now()
    updates: dict[str, Any] = {
        "vmodel.status": target.value,
        "status": TEST_STATUS_FOR[target].value,
        "updated_at": stamped,
    }
    if target is VModelRunStatus.RUNNING:
        updates["vmodel.started_utc"] = stamped
        updates["start"] = stamped
    else:
        # A terminal state means execution is over, whichever way it went.
        updates["vmodel.evaluated_utc"] = stamped
        updates["end"] = stamped
    mongo.tests.update_one({"_id": run_id}, {"$set": updates})
    return _run_summaries(mongo, run_id)[0]


@router.post("/runs/{run_id}/status", response_model=RunSummary)
def set_run_status(
    run_id: str,
    payload: RunStatusUpdate = Body(...),
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(update_permission),
) -> RunSummary:
    """Move a run through its execution states without evaluating anything.

    This endpoint moves state and does nothing else: no signals are read and no verdict is
    written. It exists so an out-of-band executor can report ``completed`` / ``error`` back,
    and so a stuck run can be corrected by hand. The Run button in the app uses
    ``POST /runs/{run_id}/execute`` instead, which does the whole cycle.
    """
    require_stored_run(mongo, run_id)
    summaries = _run_summaries(mongo, run_id)
    current = summaries[0].status if summaries else VModelRunStatus.PLANNED
    assert_transition(run_id, current, payload.status)
    return apply_run_status(mongo, run_id, payload.status)


@router.get("/runs/{run_id}/summary", response_model=RunDetailSummary)
def get_run_summary(
    run_id: str,
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> RunDetailSummary:
    """Everything a finished run has to answer, in one call.

    Per planned test case: its verdict (NOT_RUN when it has none), the requirements it
    verifies and the reason text of the verdict that decided it. Plus the requirement coverage
    the run contributes against its pinned baseline, and the success rate over evaluated
    cases. A run with no verdicts is a valid, fully-rendered response - every case NOT_RUN and
    ``success_rate`` null - not a 404.
    """
    summaries = _run_summaries(mongo, run_id)
    if not summaries:
        raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")
    return build_run_detail(mongo, summaries[0])


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
    """List the traces attached to a run. The join is many-to-many and append-only.

    A run created from the dialog has MF4 files attached to its test cases but no catalogued
    trace yet - decoding is a later pipeline stage. That is an empty list, not a 404: only an
    unknown run id is a 404, so a detail view can tell "nothing decoded yet" from "no such
    run".
    """
    keys = [str(link["trace_key"]) for link in mongo.vm_run_traces.find({"run_id": run_id})]
    if not keys:
        if mongo.tests.find_one({"_id": run_id, "vmodel": {"$ne": None}}, {"_id": 1}):
            return []
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
