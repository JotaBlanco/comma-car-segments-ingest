"""Run execution: the Run button's endpoint, and the plot data it produces.

``POST /vmodel/runs/{run_id}/execute`` is the whole Run action in one call. It moves the
run to ``running``, evaluates every planned test case that has an implementation in
:mod:`api.vm_eval.catalog`, writes the verdicts into ``vm_results`` (plus the measurement
into ``vm_traces`` and the join into ``vm_run_traces``), and moves the run to ``completed``.
The response carries both what was executed and the refreshed run summary, so the caller
needs no second read to render the result.

The status transitions are the same ones ``POST /runs/{run_id}/status`` enforces and go
through the same writer: nothing here can put a run into a state the map forbids, and a run
that is already ``running`` is refused rather than executed twice.

``GET /vmodel/runs/{run_id}/series`` returns the charts. It is separate from
``/summary`` on purpose - the verdicts are a few kilobytes and the series are a few hundred,
and a run list that pages summaries must never drag signal samples through with them.
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from pymongo.database import Database

from ..auth import read_permission, update_permission
from ..models import VModelRunStatus
from ..mongo import get_mongo
from ..settings import Settings, get_settings
from ..vm_eval.charts import CaseSeries
from ..vm_eval.runner import ExecutionReport, execute_run, series_for_run
from ..vm_run_summary import RunDetailSummary, build_run_detail
from .vm_runs import apply_run_status, assert_transition, require_stored_run, run_summaries

router = APIRouter()


class RunExecutionResponse(BaseModel):
    """What one Run action did, and the run as it now reads."""

    report: ExecutionReport
    summary: RunDetailSummary = Field(
        ..., description="The refreshed per-run summary, identical to GET /runs/{id}/summary"
    )


@router.post("/runs/{run_id}/execute", response_model=RunExecutionResponse)
def execute(
    run_id: str,
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    settings: Settings = Depends(get_settings),
    _: None = Depends(update_permission),
) -> RunExecutionResponse:
    """Execute a run: planned -> running -> evaluate -> completed.

    A planned test case with no implementation is *skipped*, not failed: it stays NOT_RUN in
    the summary and is listed in ``report.skipped``. Inventing a verdict for a test case
    nobody implemented is the one thing a verification tool must never do.

    If not one case could be evaluated - every signal source unreachable - the run is left
    in ``error`` and this returns 502, because a ``completed`` run with no evidence would be
    a lie the rest of the system would then repeat.
    """
    require_stored_run(mongo, run_id)
    summaries = run_summaries(mongo, run_id)
    if not summaries:  # pragma: no cover - require_stored_run already proved it exists
        raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")

    current = summaries[0]
    # A run already in `running` is re-executed in place. Asserting running -> running
    # would 409 and leave it stuck there forever, which is exactly the state an
    # interrupted execution leaves behind; the only way out has to be running it again.
    if current.status is not VModelRunStatus.RUNNING:
        assert_transition(run_id, current.status, VModelRunStatus.RUNNING)
        apply_run_status(mongo, run_id, VModelRunStatus.RUNNING)

    try:
        report = execute_run(
            mongo,
            settings,
            run_id,
            list(current.planned_tc_ids),
            current.baseline_id,
        )
    except Exception as exc:  # noqa: BLE001 - a failed execution must leave a legible state
        apply_run_status(mongo, run_id, VModelRunStatus.ERROR)
        raise HTTPException(
            status_code=500, detail=f"Execution of '{run_id}' failed: {exc}"
        ) from exc

    if report.failures and not report.executed:
        apply_run_status(mongo, run_id, VModelRunStatus.ERROR)
        raise HTTPException(
            status_code=502,
            detail=(
                f"No test case of '{run_id}' could be evaluated: "
                + "; ".join(report.failures)
            ),
        )

    summary = apply_run_status(mongo, run_id, VModelRunStatus.COMPLETED)
    return RunExecutionResponse(report=report, summary=build_run_detail(mongo, summary))


@router.get(
    "/runs/{run_id}/series",
    response_model=list[CaseSeries],
    response_model_by_alias=False,
)
def list_run_series(
    run_id: str,
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> list[CaseSeries]:
    """The plot data for one run, one entry per charted test case.

    An empty list is a valid answer and the normal state of a run that has not been
    executed: the report then shows verdicts without charts rather than an error.
    """
    return series_for_run(mongo, run_id)
