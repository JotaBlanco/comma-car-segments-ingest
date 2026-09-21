"""Verdict rollups and the per-run summary payload for the Test Run stage.

Split out of ``routes/vm_runs.py``: the route file is HTTP plumbing, this is the arithmetic
that answers the only three questions a finished run has to answer - *did each planned test
case pass*, *which requirements did it cover*, and *what is the success rate*. Keeping it here
also keeps both files inside the ~500-line ceiling.

Two rules govern every number below and are deliberately stated once:

* **Worst verdict wins.** A test case evaluated over several traces is FAIL if any trace
  failed, however many passed. Same precedence as the coverage matrix in
  ``routes/vm_results.py`` - duplicated as a four-element tuple rather than imported, so the
  two endpoints stay independently readable.
* **Nothing evaluated is not zero per cent.** ``success_rate`` is ``None``, never ``0.0``,
  when no planned case has a verdict, so "not run yet" can never render as "everything
  failed".
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field
from pymongo.database import Database

from .models import VModelRunStatus
from .models_vmodel_chain import RunSummary, VerdictStatus

#: Worst case first. Mirrors ``routes/vm_results.py`` VERDICT_PRECEDENCE.
VERDICT_PRECEDENCE = ("FAIL", "PASS", "INCONCLUSIVE", "NOT_RUN")

#: Verdicts that count as "this case was actually evaluated" for the success rate.
EVALUATED_VERDICTS = ("PASS", "FAIL", "INCONCLUSIVE")


class RunStatusUpdate(BaseModel):
    """Body of ``POST /vmodel/runs/{run_id}/status``.

    The only write the Run action performs. Execution itself is not triggered here - the
    QuixLab step owns that - so this endpoint moves the state and nothing else. One field,
    because a field the endpoint would not act on is a field that invents data.
    """

    status: VModelRunStatus


class RunTestCaseSummary(BaseModel):
    """One planned test case of a run, with its verdict and what it covers."""

    tc_id: str
    title: str = ""
    status: VerdictStatus = Field(
        VerdictStatus.NOT_RUN, description="Worst verdict across this case's traces"
    )
    req_ids: list[str] = Field(
        default_factory=list, description="Requirements this case verifies - its coverage share"
    )
    result_count: int = Field(0, description="Verdict documents behind this row")
    trace_keys: list[str] = Field(default_factory=list)
    reason: str = Field("", description="Verbatim from the verdict; populated even on PASS")
    evaluated_utc: datetime | None = None


class RunRequirementCoverage(BaseModel):
    """What this run's planned test cases prove about the requirement register."""

    baseline_id: str | None = None
    requirements_total: int = 0
    covered: int = Field(0, description="Requirements reachable from this run's planned cases")
    passed: int = 0
    failed: int = 0
    inconclusive: int = 0
    not_run: int = Field(0, description="Covered by this run but with no verdict yet")
    coverage_pct: float = Field(0.0, description="covered / requirements_total, 0-100")
    covered_req_ids: list[str] = Field(default_factory=list)


class RunDetailSummary(BaseModel):
    """Everything the Test Run detail pane renders, in one call.

    ``run`` is the same ``RunSummary`` the list returns - status, counts and success rate are
    read from there rather than restated, so a row and its detail can never disagree.
    """

    run: RunSummary
    test_cases: list[RunTestCaseSummary] = Field(default_factory=list)
    coverage: RunRequirementCoverage = Field(default_factory=RunRequirementCoverage)


@dataclass
class VerdictRollup:
    """One pass over ``vm_results``, indexed three ways.

    Results are appended per trace and never rolled up into the run document, so every one of
    these is a read-time aggregate. One aggregation feeds the list *and* the detail, which is
    what stops the two from computing the success rate differently.
    """

    #: run_id -> verdict -> number of result documents.
    counts: dict[str, dict[str, int]] = field(default_factory=dict)
    #: run_id -> tc_id -> worst verdict across that case's traces.
    tc_verdicts: dict[str, dict[str, str]] = field(default_factory=dict)
    #: run_id -> latest evaluated_utc seen.
    evaluated: dict[str, datetime] = field(default_factory=dict)


def aggregate_verdict(verdicts: list[str]) -> str:
    """Reduce several verdicts to one, worst case first."""
    for candidate in VERDICT_PRECEDENCE:
        if candidate in verdicts:
            return candidate
    return VerdictStatus.NOT_RUN.value


def verdict_rollup(mongo: Database[dict[str, Any]]) -> VerdictRollup:
    """Aggregate ``vm_results`` by run, test case and verdict in a single pipeline."""
    rollup = VerdictRollup()
    grouped: dict[str, dict[str, list[str]]] = {}
    pipeline = [
        {
            "$group": {
                "_id": {"run_id": "$run_id", "tc_id": "$tc_id", "status": "$status"},
                "n": {"$sum": 1},
                "last": {"$max": "$evaluated_utc"},
            }
        }
    ]
    for row in mongo.vm_results.aggregate(pipeline):
        run_id = str(row["_id"]["run_id"])
        tc_id = str(row["_id"]["tc_id"])
        status = str(row["_id"]["status"])

        counts = rollup.counts.setdefault(run_id, {})
        counts[status] = counts.get(status, 0) + int(row["n"])
        grouped.setdefault(run_id, {}).setdefault(tc_id, []).append(status)

        last = row.get("last")
        if isinstance(last, datetime) and (
            run_id not in rollup.evaluated or last > rollup.evaluated[run_id]
        ):
            rollup.evaluated[run_id] = last

    for run_id, cases in grouped.items():
        rollup.tc_verdicts[run_id] = {
            tc_id: aggregate_verdict(statuses) for tc_id, statuses in cases.items()
        }
    return rollup


def test_case_counts(planned_tc_ids: list[str], verdicts: dict[str, str]) -> dict[str, int]:
    """Verdict tally over *planned test cases*, so it always sums to the planned count.

    A planned case with no verdict is NOT_RUN rather than absent: the difference between
    "9 cases, 2 evaluated" and "2 cases" is the whole point of the summary. If a run has
    verdicts for cases it never planned - only possible for the seeded fixtures, whose planned
    list is derived - those are counted too rather than silently dropped.
    """
    tc_ids = list(planned_tc_ids) or sorted(verdicts)
    counts: dict[str, int] = {}
    for tc_id in {*tc_ids, *verdicts}:
        verdict = verdicts.get(tc_id, VerdictStatus.NOT_RUN.value)
        counts[verdict] = counts.get(verdict, 0) + 1
    return counts


def success_rate(counts: dict[str, int]) -> float | None:
    """PASS as a percentage of the *evaluated* planned cases; ``None`` when none were."""
    evaluated = sum(counts.get(verdict, 0) for verdict in EVALUATED_VERDICTS)
    if evaluated == 0:
        return None
    return round(100.0 * counts.get(VerdictStatus.PASS.value, 0) / evaluated, 1)


def effective_status(stored: str | None, has_verdicts: bool) -> VModelRunStatus:
    """Reconcile the stored execution state with the evidence in ``vm_results``.

    The stored value wins whenever it was actually set, so a run someone just started reads
    ``running`` even though no verdict exists yet. A run with verdicts but no stored state is
    ``completed`` - that is how every seeded run reports, since the fixture ingest writes no
    run document at all.
    """
    if stored:
        try:
            status = VModelRunStatus(stored)
        except ValueError:
            status = VModelRunStatus.PLANNED
        if status is not VModelRunStatus.PLANNED:
            return status
    return VModelRunStatus.COMPLETED if has_verdicts else VModelRunStatus.PLANNED


@dataclass
class RunVerdictFields:
    """The four verdict-derived fields of a ``RunSummary``, computed one way only.

    Both summary builders in ``routes/vm_runs.py`` go through this, so a stored run and a
    seeded run can never disagree about how a success rate is defined.
    """

    counts: dict[str, int]
    tc_counts: dict[str, int]
    success_rate: float | None
    status: VModelRunStatus


def summary_verdicts(
    rollup: VerdictRollup,
    run_id: str,
    planned_tc_ids: list[str],
    stored_status: str | None,
) -> RunVerdictFields:
    """Verdict counts, per-case counts, success rate and effective status for one run."""
    counts = rollup.counts.get(run_id, {})
    tc_counts = test_case_counts(planned_tc_ids, rollup.tc_verdicts.get(run_id, {}))
    return RunVerdictFields(
        counts=counts,
        tc_counts=tc_counts,
        success_rate=success_rate(tc_counts),
        status=effective_status(stored_status, bool(counts)),
    )


def _spec_index(
    mongo: Database[dict[str, Any]], tc_ids: list[str]
) -> dict[str, dict[str, Any]]:
    """Newest artifact version of each requested test spec, keyed by ``tc_id``."""
    index: dict[str, dict[str, Any]] = {}
    if not tc_ids:
        return index
    for doc in mongo.vm_test_specs.find({"tc_id": {"$in": tc_ids}}).sort("artifact_version", 1):
        index[str(doc["tc_id"])] = doc
    return index


def _requirement_coverage(
    mongo: Database[dict[str, Any]],
    baseline_id: str | None,
    tc_ids: list[str],
    specs: dict[str, dict[str, Any]],
    req_verdicts: dict[str, list[str]],
) -> RunRequirementCoverage:
    """Coverage contributed by this run's planned cases, against its pinned baseline.

    Coverage comes from the baseline's frozen ``req_links`` - the same source the coverage
    matrix uses - so a run and the matrix cannot report different denominators. Only when the
    run has no baseline does this fall back to the forward ``covers_req_ids`` links on the
    test specs themselves.
    """
    baseline = mongo.vm_baselines.find_one({"_id": baseline_id}) if baseline_id else None
    planned = set(tc_ids)

    if baseline:
        req_links: dict[str, list[str]] = baseline.get("req_links", {}) or {}
        covered_ids = sorted(
            req_id for req_id, linked in req_links.items() if planned & set(linked or [])
        )
        version = str(baseline.get("requirements_version", ""))
        total = (
            mongo.vm_requirements.count_documents({"artifact_version": version}) if version else 0
        )
    else:
        covered_ids = sorted(
            {
                str(req_id)
                for tc_id in planned
                for req_id in (specs.get(tc_id, {}).get("covers_req_ids") or [])
            }
        )
        total = len(covered_ids)

    tally = {"PASS": 0, "FAIL": 0, "INCONCLUSIVE": 0, "NOT_RUN": 0}
    for req_id in covered_ids:
        verdict = aggregate_verdict(req_verdicts.get(req_id, []))
        tally[verdict] = tally.get(verdict, 0) + 1

    return RunRequirementCoverage(
        baseline_id=baseline_id,
        requirements_total=total,
        covered=len(covered_ids),
        passed=tally["PASS"],
        failed=tally["FAIL"],
        inconclusive=tally["INCONCLUSIVE"],
        not_run=tally["NOT_RUN"],
        coverage_pct=round(100.0 * len(covered_ids) / total, 1) if total else 0.0,
        covered_req_ids=covered_ids,
    )


def build_run_detail(
    mongo: Database[dict[str, Any]], summary: RunSummary
) -> RunDetailSummary:
    """The per-test-case verdict table and requirement coverage for one run."""
    tc_ids = list(summary.planned_tc_ids)
    specs = _spec_index(mongo, tc_ids)

    per_case: dict[str, list[dict[str, Any]]] = {}
    req_verdicts: dict[str, list[str]] = {}
    for result in mongo.vm_results.find({"run_id": summary.run_id}):
        per_case.setdefault(str(result["tc_id"]), []).append(result)
        for req_id in result.get("req_ids") or []:
            req_verdicts.setdefault(str(req_id), []).append(str(result["status"]))

    # A seeded run's planned list is derived from the baseline, so it can miss a case that
    # actually produced a verdict. Union, never intersect: a verdict is evidence and is never
    # dropped for not being on the plan.
    rows: list[RunTestCaseSummary] = []
    for tc_id in sorted({*tc_ids, *per_case}):
        results = per_case.get(tc_id, [])
        spec = specs.get(tc_id, {})
        statuses = [str(item["status"]) for item in results]
        verdict = aggregate_verdict(statuses)
        # Show the reason of the verdict that decided the row, not an arbitrary one.
        decisive = next((item for item in results if str(item["status"]) == verdict), None)
        evaluated = [
            item["evaluated_utc"]
            for item in results
            if isinstance(item.get("evaluated_utc"), datetime)
        ]
        rows.append(
            RunTestCaseSummary(
                tc_id=tc_id,
                title=str(spec.get("title") or (decisive or {}).get("title") or ""),
                status=VerdictStatus(verdict),
                req_ids=sorted(
                    {
                        str(req_id)
                        for req_id in (
                            spec.get("covers_req_ids")
                            or (decisive or {}).get("req_ids")
                            or []
                        )
                    }
                ),
                result_count=len(results),
                trace_keys=sorted(
                    {str(item["trace_key"]) for item in results if item.get("trace_key")}
                ),
                reason=str((decisive or {}).get("reason") or ""),
                evaluated_utc=max(evaluated) if evaluated else None,
            )
        )

    return RunDetailSummary(
        run=summary,
        test_cases=rows,
        coverage=_requirement_coverage(
            mongo, summary.baseline_id, [row.tc_id for row in rows], specs, req_verdicts
        ),
    )
