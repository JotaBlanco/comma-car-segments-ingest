"""Run metrics and per-requirement verdicts (spec 6).

This replaces the old ``GET /evaluate``, which was a ``GROUP BY status`` tally
over ``results`` that never read requirements, test specs or runs and computed
none of these figures.

Two denominators are always reported side by side, deliberately:

* coverage over **all** requirements can never reach 1.0 (three requirements are
  Inspection/Demonstration/Analysis), and a permanently capped metric gets
  ignored - so the testable-only figure is the headline and the all-requirements
  figure is the honest floor;
* ``tc_pass_rate_planned`` and ``tc_pass_rate_executed`` answer different
  questions, and quoting one without the other is how "97 % pass" hides 40
  unexecuted cases.

``not_run`` is only computable because ``scope.planned_tc_ids`` is frozen at
submit, before any data arrives. Without that frozen plan there is no
denominator and no honest ``not_run`` count.
"""

from settings import EVALUATOR_VERSION, REQ_VERDICTS, VERDICTS

EXECUTED_VERDICTS = frozenset({"pass", "fail"})


def _ratio(numerator: int, denominator: int) -> float | None:
    """``None`` rather than 0.0 for an empty denominator - 0/0 is not 0 %."""
    if denominator == 0:
        return None
    return round(numerator / denominator, 6)


def compute(
    baseline: dict,
    requirements: dict[str, dict],
    test_cases: dict[str, dict],
    planned_tc_ids: list[str],
    results: list[dict],
) -> dict:
    """The full 6.1 + 6.2 metric block for one ``(test_run_id, run_version)``."""
    planned = list(dict.fromkeys(planned_tc_ids))
    verdict_by_tc = {result["tc_id"]: result.get("verdict", "not_run") for result in results}

    counts = {verdict: 0 for verdict in VERDICTS}
    for tc_id in planned:
        verdict = verdict_by_tc.get(tc_id, "not_run")
        counts[verdict] = counts.get(verdict, 0) + 1

    executed = [tc_id for tc_id in planned if verdict_by_tc.get(tc_id) in EXECUTED_VERDICTS]
    passed = [tc_id for tc_id in planned if verdict_by_tc.get(tc_id) == "pass"]

    covered: set[str] = set()
    verified: set[str] = set()
    for tc_id in executed:
        for req_id in (test_cases.get(tc_id) or {}).get("covers_req_ids") or []:
            if req_id in requirements:
                covered.add(req_id)
                if verdict_by_tc.get(tc_id) == "pass":
                    verified.add(req_id)

    all_reqs = set(requirements)
    testable = {
        req_id
        for req_id, requirement in requirements.items()
        if requirement.get("verification_method") == "Test"
    }
    by_chapter: dict[str, set[str]] = {}
    for req_id, requirement in requirements.items():
        by_chapter.setdefault(requirement.get("chapter", "unknown"), set()).add(req_id)

    sum_check = sum(counts[verdict] for verdict in VERDICTS) == len(planned)

    return {
        "requirement_coverage_all": _ratio(len(covered & all_reqs), len(all_reqs)),
        "requirement_coverage_testable": _ratio(len(covered & testable), len(testable)),
        "requirement_coverage_chapter": {
            chapter: _ratio(len(covered & members), len(members))
            for chapter, members in sorted(by_chapter.items())
        },
        "requirement_verification_coverage": _ratio(len(verified & all_reqs), len(all_reqs)),
        "baseline_coverage_static": baseline.get("baseline_coverage_static"),
        "denominators": {
            "requirements_all": len(all_reqs),
            "requirements_testable": len(testable),
            "requirements_by_chapter": {
                chapter: len(members) for chapter, members in sorted(by_chapter.items())
            },
            "planned_test_cases": len(planned),
            "executed_test_cases": len(executed),
        },
        "tc_passed": counts["pass"],
        "tc_failed": counts["fail"],
        "tc_not_run": counts["not_run"],
        "tc_error": counts["error"],
        "tc_inconclusive": counts["inconclusive"],
        "tc_pass_rate_planned": _ratio(len(passed), len(planned)),
        "tc_pass_rate_executed": _ratio(len(passed), len(executed)),
        "tc_execution_rate": _ratio(len(executed), len(planned)),
        "sum_check_ok": sum_check,
        "covered_req_ids": sorted(covered),
        "verified_req_ids": sorted(verified),
        "evaluator_version": EVALUATOR_VERSION,
    }


def requirement_verdicts(
    requirements: dict[str, dict],
    req_links: dict[str, list[str]],
    planned_tc_ids: list[str],
    results: list[dict],
) -> list[dict]:
    """Spec 6.3 precedence, evaluated top to bottom, one document per requirement."""
    planned = set(planned_tc_ids)
    verdict_by_tc = {result["tc_id"]: result.get("verdict", "not_run") for result in results}
    documents = []

    for req_id in sorted(requirements):
        covering = [tc_id for tc_id in (req_links.get(req_id) or []) if tc_id in planned]
        by_verdict: dict[str, list[str]] = {verdict: [] for verdict in VERDICTS}
        for tc_id in covering:
            by_verdict[verdict_by_tc.get(tc_id, "not_run")].append(tc_id)

        if not covering:
            verdict = "not_run"
        elif by_verdict["error"]:
            verdict = "error"
        elif by_verdict["fail"]:
            verdict = "fail"
        elif by_verdict["inconclusive"]:
            verdict = "inconclusive"
        elif len(by_verdict["pass"]) == len(covering):
            verdict = "pass"
        elif by_verdict["pass"]:
            verdict = "partial"
        else:
            verdict = "not_run"

        if verdict not in REQ_VERDICTS:
            raise ValueError(f"computed requirement verdict {verdict!r} is outside the vocabulary")
        documents.append(
            {
                "req_id": req_id,
                "verdict": verdict,
                "covering_tc_ids": covering,
                "passed_tc_ids": sorted(by_verdict["pass"]),
                "failed_tc_ids": sorted(by_verdict["fail"]),
                "not_run_tc_ids": sorted(by_verdict["not_run"]),
                "error_tc_ids": sorted(by_verdict["error"]),
                "inconclusive_tc_ids": sorted(by_verdict["inconclusive"]),
            }
        )
    return documents
