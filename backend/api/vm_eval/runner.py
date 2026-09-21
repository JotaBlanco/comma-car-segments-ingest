"""Execute a Test Run: evaluate its planned test cases and write the evidence back.

One entry point, :func:`execute_run`. For every planned test case that this backend can
evaluate it loads the signal series, runs the criteria, and writes four documents:

``vm_traces``       the measurement it was evaluated over, one per test case
``vm_run_traces``   the run -> trace join, so ``GET /runs/{id}/traces`` finds it
``vm_results``      the verdict, in the exact ``TestResult`` shape the seeded fixtures used
``vm_result_series``  the plot data - the one new collection, see the note below

Nothing here invents a parallel verdict store: ``GET /vmodel/runs/{id}/summary``,
``GET /vmodel/results`` and the coverage matrix all read what this writes, unchanged.
``vm_result_series`` is separate because the alternative is worse - the samples are tens of
thousands of numbers per case and putting them on the ``TestResult`` would drag them
through every list endpoint that pages verdicts.

A re-run replaces its own verdicts rather than appending: the results for the test cases
about to be evaluated are deleted first, so pressing Run twice leaves one verdict per case,
not two.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, computed_field
from pymongo.database import Database

from ..models_vmodel_chain import IngestStatus, ResultCriterion, TestResult, Trace, VerdictStatus
from ..settings import Settings
from ..utils import now
from .catalog import CaseEvaluator, CaseOutcome, evaluator_for
from .charts import CaseSeries
from .criteria import CriterionOutcome
from .signals import LoadedSignals, SignalSourceError, load_frame

logger = logging.getLogger(__name__)

#: Plot payloads. Keyed ``'{run_id}::{tc_id}'``, one document per charted test case.
SERIES_COLLECTION = "vm_result_series"

COMPARISON = {"le": "<=", "ge": ">=", "eq": "=="}


class CaseExecution(BaseModel):
    """What happened to one planned test case during a run."""

    tc_id: str
    status: str
    source: str = Field(..., description="lake | fixture - where the samples were read from")
    trace_key: str
    measured: float | None = None
    bound: float | None = None
    unit: str = ""
    n_samples: int = 0
    reason: str = ""
    note: str = ""


class ExecutionReport(BaseModel):
    """The outcome of one Run action."""

    run_id: str
    executed: list[CaseExecution] = Field(default_factory=list)
    skipped: list[str] = Field(
        default_factory=list,
        description="Planned test cases with no implementation here; they stay NOT_RUN",
    )
    failures: list[str] = Field(
        default_factory=list, description="Cases whose signals could not be read at all"
    )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def sources(self) -> list[str]:
        return sorted({item.source for item in self.executed})


def _digest(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _result_criteria(outcome: CaseOutcome) -> list[ResultCriterion]:
    """Pass criteria first, then the precondition gates - both are evidence."""
    return [
        ResultCriterion(
            criterion_id=item.criterion_id,
            actual=item.measured,
            bound=item.bound,
            unit=item.unit,
            tolerance=item.tolerance,
            verdict=item.verdict,
        )
        for item in [*outcome.criteria, *outcome.gates]
    ]


def _spec_facts(mongo: Database[dict[str, Any]], evaluator: CaseEvaluator) -> tuple[list[str], str]:
    """Requirements covered and the display title, read from the register, not invented.

    Falls back to the evaluator's own constants when the V-model fixtures have not been
    seeded, so a run can still be executed against an empty register.
    """
    spec = mongo.vm_test_specs.find_one({"tc_id": evaluator.tc_id}, sort=[("artifact_version", -1)])
    req_ids = [str(item) for item in (spec or {}).get("covers_req_ids") or []]
    title = str((spec or {}).get("title") or evaluator.title)
    return (req_ids or [evaluator.requirement_id]), title


def _trace_document(
    evaluator: CaseEvaluator, loaded: LoadedSignals, stamped: datetime
) -> Trace:
    """The measurement, catalogued.

    ``content_sha256`` is the digest of the exact series that was evaluated, not of an MF4
    file: the lake is the measurement here, and hashing what was read is what makes a
    verdict reproducible. ``size_bytes`` follows it - the byte length of that canonical
    series - rather than being left at a meaningless zero.
    """
    canonical = json.dumps(
        {
            "locator": evaluator.partition.locator,
            "signals": {
                name: [
                    [frame_ts, value]
                    for frame_ts, value in zip(loaded.frame.ts_ms, loaded.frame.values[name], strict=True)
                    if value is not None
                ]
                for name in sorted(evaluator.signals)
                if name in loaded.frame.values
            },
        },
        separators=(",", ":"),
    ).encode("utf-8")

    return Trace(
        _id=evaluator.partition.trace_key,
        scenario=evaluator.partition.scenario,
        source_path=f"{evaluator.partition.locator} ({loaded.source})",
        content_sha256=hashlib.sha256(canonical).hexdigest(),
        size_bytes=len(canonical),
        uploaded_utc=stamped,
        uploaded_by="vm-eval",
        device_id=evaluator.partition.device,
        ingest_status=IngestStatus.VECTORISED,
        mf4={
            "table": "mf4_signals_v4",
            "platform": evaluator.partition.platform,
            "device": evaluator.partition.device,
            "route": evaluator.partition.route,
            "segment": evaluator.partition.segment,
            "source": loaded.source,
            "sample_rows": loaded.row_count,
            "duration_s": round(loaded.duration_s, 3),
        },
        signals=list(evaluator.signals),
    )


def _result_document(
    evaluator: CaseEvaluator,
    outcome: CaseOutcome,
    loaded: LoadedSignals,
    run_id: str,
    baseline_id: str | None,
    req_ids: list[str],
    title: str,
    stamped: datetime,
) -> TestResult:
    """One verdict, in the shape ``models_vmodel_chain.TestResult`` already defines."""
    binding: CriterionOutcome | None = outcome.binding
    status = VerdictStatus(outcome.verdict)
    # INCONCLUSIVE means nothing was measured; the model refuses a measured value on it and
    # nothing downstream may read a zero that was never observed.
    measured = None if status is VerdictStatus.INCONCLUSIVE or binding is None else binding.measured

    notes = list(outcome.notes)
    if loaded.note:
        notes.append(loaded.note)
    notes.append(
        f"Signals read from the {loaded.source}: {loaded.row_count} rows over "
        f"{loaded.duration_s:.1f} s at {evaluator.partition.locator}."
    )
    for key, value in outcome.derived.items():
        notes.append(f"derived {key} = {value}")

    payload: dict[str, Any] = {
        "run_id": run_id,
        "tc_id": evaluator.tc_id,
        "impl_id": evaluator.impl_id,
        "trace_key": evaluator.partition.trace_key,
        "status": status.value,
        "measured": measured,
        "criteria": [
            [item.criterion_id, item.measured, item.bound, item.verdict]
            for item in [*outcome.criteria, *outcome.gates]
        ],
    }

    return TestResult(
        _id=f"{run_id}::{evaluator.tc_id}::{evaluator.partition.trace_key}",
        run_id=run_id,
        tc_id=evaluator.tc_id,
        impl_id=evaluator.impl_id,
        trace_key=evaluator.partition.trace_key,
        req_ids=req_ids,
        verification_tag=evaluator.verification_tag,
        title=title,
        status=status,
        measured=measured,
        bound=None if binding is None else binding.bound,
        comparison=None if binding is None else COMPARISON.get(binding.op, binding.op),
        margin=None if binding is None else binding.margin,
        tolerance=0.0 if binding is None or binding.tolerance is None else binding.tolerance,
        unit="" if binding is None else binding.unit,
        window=evaluator.window,
        scope=evaluator.scope,
        samples_in_scope=0 if binding is None else binding.n_samples,
        signals=list(evaluator.signals),
        reason=outcome.reason,
        notes=notes,
        criteria=_result_criteria(outcome),
        baseline_id=baseline_id,
        evaluated_utc=stamped,
        result_sha256=_digest(payload),
    )


def _series_document(
    evaluator: CaseEvaluator, outcome: CaseOutcome, loaded: LoadedSignals, run_id: str, title: str
) -> CaseSeries:
    return CaseSeries(
        _id=f"{run_id}::{evaluator.tc_id}",
        run_id=run_id,
        tc_id=evaluator.tc_id,
        title=title,
        verdict=outcome.verdict,
        source=loaded.source,
        source_note=loaded.note,
        scenario=evaluator.partition.scenario,
        trace_key=evaluator.partition.trace_key,
        sample_count=loaded.row_count,
        duration_s=round(loaded.duration_s, 3),
        charts=outcome.charts,
    )


def execute_run(
    mongo: Database[dict[str, Any]],
    settings: Settings,
    run_id: str,
    planned_tc_ids: list[str],
    baseline_id: str | None,
) -> ExecutionReport:
    """Evaluate every planned test case that has an implementation, and persist the result."""
    stamped = now()
    executable = [tc_id for tc_id in planned_tc_ids if evaluator_for(tc_id)]
    skipped = [tc_id for tc_id in planned_tc_ids if not evaluator_for(tc_id)]

    if executable:
        # A re-run replaces its own verdicts. Only the cases about to be re-evaluated are
        # cleared, so a verdict this execution cannot reproduce is never silently dropped.
        mongo.vm_results.delete_many({"run_id": run_id, "tc_id": {"$in": executable}})

    executed: list[CaseExecution] = []
    failures: list[str] = []

    for tc_id in executable:
        evaluator = evaluator_for(tc_id)
        if evaluator is None:  # pragma: no cover - filtered above
            continue
        try:
            loaded = load_frame(settings, evaluator.partition, evaluator.signals)
        except SignalSourceError as exc:
            logger.warning("%s: no signals for %s (%s)", run_id, tc_id, exc)
            failures.append(f"{tc_id}: {exc}")
            continue

        outcome = evaluator.run(loaded.frame)
        req_ids, title = _spec_facts(mongo, evaluator)

        trace = _trace_document(evaluator, loaded, stamped)
        mongo.vm_traces.replace_one(
            {"_id": trace.trace_key}, trace.model_dump(by_alias=True), upsert=True
        )
        link_id = f"{run_id}::{trace.trace_key}"
        mongo.vm_run_traces.replace_one(
            {"_id": link_id},
            {
                "_id": link_id,
                "run_id": run_id,
                "trace_key": trace.trace_key,
                "attached_utc": stamped,
                "attached_by": "vm-eval",
            },
            upsert=True,
        )

        result = _result_document(
            evaluator, outcome, loaded, run_id, baseline_id, req_ids, title, stamped
        )
        mongo.vm_results.replace_one(
            {"_id": result.result_id}, result.model_dump(by_alias=True), upsert=True
        )

        series = _series_document(evaluator, outcome, loaded, run_id, title)
        mongo[SERIES_COLLECTION].replace_one(
            {"_id": series.key}, series.model_dump(by_alias=True), upsert=True
        )

        binding = outcome.binding
        executed.append(
            CaseExecution(
                tc_id=tc_id,
                status=outcome.verdict,
                source=loaded.source,
                trace_key=trace.trace_key,
                measured=None if binding is None else binding.measured,
                bound=None if binding is None else binding.bound,
                unit="" if binding is None else binding.unit,
                n_samples=0 if binding is None else binding.n_samples,
                reason=outcome.reason,
                note=loaded.note,
            )
        )
        logger.info(
            "%s %s -> %s (%s, %d rows)", run_id, tc_id, outcome.verdict, loaded.source, loaded.row_count
        )

    return ExecutionReport(run_id=run_id, executed=executed, skipped=skipped, failures=failures)


def series_for_run(mongo: Database[dict[str, Any]], run_id: str) -> list[CaseSeries]:
    """Every charted test case of one run, in test case id order."""
    return [
        CaseSeries(**doc)
        for doc in mongo[SERIES_COLLECTION].find({"run_id": run_id}).sort("tc_id", 1)
    ]
