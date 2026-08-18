"""Page 5's metric cards and per-requirement verdict table (spec 6).

Split out of ``views/test_result.py`` so the page keeps the per-case detail and the
report panel and this module keeps everything that is a metric.

Both coverage denominators and both pass-rate denominators are rendered side by
side on purpose: coverage over *all* requirements can never reach 100 % because
Inspection, Demonstration and Analysis requirements are not trace-coverable, and
quoting one pass rate without the other is how "97 % pass" hides 40 unexecuted
cases. ``None`` prints as ``n/a`` - an empty denominator is not 0 %.

The sum-check invariant is shown, not hidden: if the five verdict counts do not add
up to the frozen plan, that is a defect in evaluation finalisation and the page says
so in those words.
"""

import streamlit as st

import api_client
from ui import criteria as criteria_ui
from ui import errors, nav, render


def render_cards(metrics: dict | None) -> None:
    if not metrics:
        return
    st.markdown("### Requirement coverage")
    st.caption(
        f"source: {metrics.get('source')} — "
        "`recomputed` means the metrics sink has not caught up yet; the figures are "
        "computed from the same stored inputs."
    )
    denominators = metrics.get("denominators") or {}
    row = st.columns(4)
    row[0].metric(
        "Testable requirements",
        render.percent(metrics.get("requirement_coverage_testable")),
        help=f"denominator: {denominators.get('requirements_testable')} with method Test",
    )
    row[1].metric(
        "All requirements",
        render.percent(metrics.get("requirement_coverage_all")),
        help=(
            f"denominator: {denominators.get('requirements_all')}. This can never "
            "reach 100 % - Inspection, Demonstration and Analysis requirements are "
            "not trace-coverable."
        ),
    )
    row[2].metric(
        "Verified (covered and passing)",
        render.percent(metrics.get("requirement_verification_coverage")),
    )
    row[3].metric(
        "Static baseline coverage",
        render.percent(metrics.get("baseline_coverage_static")),
        help="Run-independent: covered by any case in the baseline.",
    )

    st.markdown("**Per chapter**")
    per_chapter = metrics.get("requirement_coverage_chapter") or {}
    chapter_denominators = denominators.get("requirements_by_chapter") or {}
    render.table(
        [
            {
                "chapter": chapter,
                "coverage": render.percent(value),
                "requirements": chapter_denominators.get(chapter),
            }
            for chapter, value in sorted(per_chapter.items())
        ],
        "no chapter in this baseline",
    )

    st.markdown("### Test-case outcomes")
    row = st.columns(5)
    row[0].metric("Passed", metrics.get("tc_passed"))
    row[1].metric("Failed", metrics.get("tc_failed"))
    row[2].metric("Not run", metrics.get("tc_not_run"))
    row[3].metric("Error", metrics.get("tc_error"))
    row[4].metric("Inconclusive", metrics.get("tc_inconclusive"))

    row = st.columns(3)
    planned_total = denominators.get("planned_test_cases")
    executed_total = denominators.get("executed_test_cases")
    row[0].metric(
        "Pass rate (planned)",
        render.percent(metrics.get("tc_pass_rate_planned")),
        help=f"denominator: {planned_total} planned cases, frozen at submit",
    )
    row[1].metric(
        "Pass rate (executed)",
        render.percent(metrics.get("tc_pass_rate_executed")),
        help=f"denominator: {executed_total} cases that passed or failed",
    )
    row[2].metric("Execution rate", render.percent(metrics.get("tc_execution_rate")))

    total = sum(
        int(metrics.get(field) or 0)
        for field in ("tc_passed", "tc_failed", "tc_not_run", "tc_error", "tc_inconclusive")
    )
    planned_count = denominators.get("planned_test_cases")
    if metrics.get("sum_check_ok"):
        st.caption(
            f"Sum check holds: {total} verdicts == {planned_count} planned cases."
        )
    else:
        st.error(
            f"**Sum check failed:** {total} verdicts against {planned_count} planned "
            "cases. The metric block and the frozen plan disagree, which is a defect "
            "in evaluation finalisation, not a rounding artefact."
        )


def render_requirement_verdicts(run_id: str, run_version: int) -> None:
    st.markdown("### Per requirement")
    payload, ok = errors.guarded(
        lambda: api_client.get_requirement_verdicts(run_id, run_version),
        "load the per-requirement verdicts",
    )
    if not ok:
        return
    items = payload.get("items") or []
    st.caption(f"source: {payload.get('source')}")
    render.table(
        [
            {
                "req_id": item.get("req_id"),
                "verdict": criteria_ui.verdict_label(item.get("verdict")),
                "covering": render.joined(item.get("covering_tc_ids"), "–"),
                "passed": render.joined(item.get("passed_tc_ids"), "–"),
                "failed": render.joined(item.get("failed_tc_ids"), "–"),
                "not run": render.joined(item.get("not_run_tc_ids"), "–"),
            }
            for item in items
        ],
        "no requirement verdict for this run version",
    )
    if items:
        options = [str(item["req_id"]) for item in items]
        chosen = st.selectbox("Open a requirement", options, key="res_req_pick")
        nav.link_button(
            f"Open {chosen} on Requirements",
            nav.REQUIREMENTS,
            key="res_req_go",
            req_id=chosen,
        )
