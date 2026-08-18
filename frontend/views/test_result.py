"""Page 5 - Test Result: header, metrics, per-case, per-requirement, report (spec 1.5).

The header mirrors the report header and leads with the **device id** plus its sw/hw
version, because that is what identifies the plant version a verdict belongs to.

Metrics come from ``GET /metrics/{run}/{version}``, which answers from Mongo
``run_metrics`` when the sink has caught up and recomputes from the same inputs
otherwise; the response says which, and both coverage denominators and both
pass-rate denominators are shown side by side because quoting one alone is how a
pass rate hides unexecuted cases. ``not run`` is a first-class outcome, not an
absence: it is computable only because the plan was frozen at submit.

Plots are the report's own SVGs, fetched from the report revision so the page and
the report show the identical artifact. With no revision yet, the decimated series
stored inside each result document is drawn instead, and the page says so.
"""

import json

import streamlit as st

import api_client
from ui import criteria as criteria_ui
from ui import errors, nav, render, result_metrics, state

st.title("Test Result")
context = state.read_context()

run_id = context["test_run_id"]
if not run_id:
    st.info(
        "Select a test run in the sidebar. Metrics, verdicts and the report all "
        "belong to one `(test_run_id, run_version)` pair.",
        icon=":material/analytics:",
    )
    st.stop()

run, run_ok = errors.guarded(lambda: api_client.get_test_run(run_id), f"load {run_id}")
if not run_ok:
    st.stop()

run_version = context["run_version"] or int(run.get("latest_run_version") or 1)

metrics, metrics_ok = errors.guarded(
    lambda: api_client.get_metrics(run_id, run_version), "load the run metrics"
)
results_payload, results_ok = errors.guarded(
    lambda: api_client.list_results(run_id, run_version), "load the per-case results"
)
results = (results_payload or {}).get("items") or []

revisions_payload, revisions_ok = errors.guarded(
    lambda: api_client.list_report_revisions(run_id, run_version),
    "list report revisions",
    quiet=True,
)
revisions = list((revisions_payload or {}).get("revisions") or [])
latest_revision = revisions[-1] if revisions else None

report_body: dict = {}
if latest_revision:
    fetched, ok = errors.guarded(
        lambda: api_client.report_json(run_id, run_version, str(latest_revision)),
        "load the stored report",
        quiet=True,
    )
    report_body = fetched or {}


def _header() -> None:
    parameter_set = {}
    if run.get("config_id") and run.get("config_version") is not None:
        parameter_set, _ = errors.guarded(
            lambda: api_client.get_parameter_set(
                str(run["config_id"]), int(run["config_version"])
            ),
            "load the pinned parameter set",
            quiet=True,
        )
        parameter_set = parameter_set or {}

    render.key_values(
        {
            "Device id": run.get("device_id"),
            "Device sw / hw": f"{run.get('device_sw_version')} / {run.get('device_hw_version')}",
            "Parameter set": (
                f"{run.get('config_id')}@v{run.get('config_version')}"
                if run.get("config_id")
                else "none pinned"
            ),
            "config_hash12": parameter_set.get("config_hash12") or "–",
            "Baseline": run.get("baseline_id"),
            "Run": f"{run_id} v{run_version}",
            "Status": run.get("status"),
            "Evaluator version": (metrics or {}).get("evaluator_version") or "–",
            "inputs_digest": str(report_body.get("inputs_digest") or "not generated yet")[:16],
        },
        columns=3,
    )
    if run.get("allow_provenance_mismatch"):
        st.warning(
            "This run carries `allow_provenance_mismatch: true`. A trace whose MF4 "
            "`config_hash12` differs from the pinned parameter set was accepted by "
            "explicit human override, and the report prints that in its header.",
            icon=":material/warning:",
        )
    st.caption(f"Version descriptor: `{run.get('version_descriptor') or '–'}`")


def _per_case() -> None:
    st.markdown("### Per test case")
    if not results_ok:
        return
    if not results:
        st.info(
            "No result document exists for this run version yet. Trigger evaluation "
            "from the Test Run page; results arrive through the `test-results` topic.",
            icon=":material/hourglass_empty:",
        )
        return

    render.table(
        [
            {
                "tc_id": result.get("tc_id"),
                "verdict": criteria_ui.verdict_label(result.get("verdict")),
                "reason": result.get("reason_code") or "–",
                "evidence": (result.get("evidence") or {}).get("kind") or "–",
                "manual": "✓" if result.get("manual") else "",
                "traces": render.joined(result.get("trace_keys"), "–"),
                "requirements": render.joined(result.get("req_ids"), "–"),
                "criteria": len(result.get("criteria") or []),
                "max uncertainty s": (result.get("uncertainty") or {}).get("max_uncertainty_s"),
            }
            for result in results
        ],
        "no result",
    )

    for result in results:
        tc_id = str(result.get("tc_id"))
        with st.expander(
            f"{tc_id} — {criteria_ui.verdict_label(result.get('verdict'))} "
            f"({result.get('reason_code') or 'no reason code'})"
        ):
            if result.get("note"):
                st.caption(result["note"])
            criteria_ui.render_results(
                result.get("criteria") or [],
                caption=(
                    "`bound (after tolerance)` is the bound the comparison actually "
                    "used; `uncertainty s` is half the coarsest contributing raster "
                    "period and is reported, never subtracted from a bound. One row "
                    "per criterion per contributing trace."
                ),
            )
            alignment = result.get("alignment") or {}
            if alignment:
                st.caption(
                    f"Alignment: {alignment.get('method')} onto "
                    f"`{alignment.get('base_group')}`, forward-filled "
                    f"{render.joined(alignment.get('filled_groups'), 'nothing')}."
                )
            _case_links(tc_id, list(result.get("req_ids") or []))
            _case_plots(result)
            render.json_expander(f"Result document for {tc_id}", result)


def _case_links(tc_id: str, req_ids: list[str]) -> None:
    slots = st.columns(2)
    with slots[0]:
        nav.link_button(
            "Test Specification",
            nav.TEST_SPECIFICATION,
            key=f"res_spec_{tc_id}",
            container_width=True,
            tc_id=tc_id,
        )
    with slots[1]:
        nav.link_button(
            "Test Implementation",
            nav.TEST_IMPLEMENTATION,
            key=f"res_impl_{tc_id}",
            container_width=True,
            tc_id=tc_id,
        )
    st.caption("Covered requirements")
    nav.chip_links(
        req_ids,
        nav.REQUIREMENTS,
        "req_id",
        key_prefix=f"res_req_{tc_id}",
        empty_note="this case covers nothing",
    )


def _case_plots(result: dict) -> None:
    tc_id = str(result.get("tc_id"))
    blocks = [
        block
        for block in result.get("criteria") or []
        if (block.get("series_preview") or {}).get("t_s")
    ]
    if not blocks:
        return
    st.markdown("**Evaluated signal, bound and tolerance band**")
    if not latest_revision:
        st.caption(
            "No report revision exists yet, so the report's own SVG plots do not "
            "exist. The decimated series stored inside the result document is drawn "
            "instead; generate a report below to get the plotted artifact."
        )
    for block in blocks:
        filename = f"{tc_id}-{block.get('criterion_id')}-{block.get('signal')}.svg"
        if latest_revision:
            svg, ok = errors.guarded(
                lambda name=filename: api_client.report_plot(
                    run_id, run_version, str(latest_revision), name
                ),
                f"load plot {filename}",
                quiet=True,
            )
            if ok and svg:
                st.markdown(svg.decode("utf-8", errors="replace"), unsafe_allow_html=True)
                continue
        preview = block.get("series_preview") or {}
        st.caption(
            f"{block.get('criterion_id')} · {block.get('signal')} "
            f"[{block.get('unit') or '-'}] · decimated preview, x is the sample index"
        )
        st.line_chart({str(block.get("signal")): list(preview.get("values") or [])})


def _inputs() -> None:
    with st.expander("Input data: parameter set and traces"):
        if run.get("config_id"):
            parameter_set, ok = errors.guarded(
                lambda: api_client.get_parameter_set(
                    str(run["config_id"]), int(run["config_version"])
                ),
                "load the parameter set",
                quiet=True,
            )
            if ok:
                render.json_expander("Parameter set as stored", parameter_set)
        else:
            st.caption("No parameter set is pinned on this run.")

        traces, ok = errors.guarded(
            lambda: api_client.list_traces(test_run_id=run_id), "load the run's traces"
        )
        if ok:
            render.table(
                [
                    {
                        "trace_key": item.get("trace_key"),
                        "mf4 run_id": (item.get("mf4") or {}).get("run_id"),
                        "scenario": (item.get("mf4") or {}).get("scenario_name"),
                        "config_hash12": (item.get("mf4") or {}).get("config_hash12"),
                        "ingest status": item.get("ingest_status"),
                        "signals": len(item.get("signals") or []),
                        "lake rows": render.joined(
                            [
                                f"{table}={count}"
                                for table, count in (item.get("lake_rows") or {}).items()
                            ],
                            "–",
                        ),
                    }
                    for item in traces.get("items") or []
                ],
                "no trace is linked to this run",
            )


def _manual_verdict() -> None:
    planned = list((run.get("scope") or {}).get("planned_tc_ids") or [])
    with st.expander("Record a manual verdict (Inspection / Demonstration)"):
        st.caption(
            "Recorded as `evidence.kind = manual` with author and timestamp, and "
            "marked `manual` everywhere it appears, so a human decision is never "
            "mistaken for a measured one. The backend accepts an evidence "
            "*reference*, not a file."
        )
        if not planned:
            st.caption("This run plans no case.")
            return
        row = st.columns(3)
        tc_id = row[0].selectbox("Test case", planned, key="res_manual_tc")
        verdict = row[1].selectbox("Verdict", ["pass", "fail"], key="res_manual_verdict")
        author = row[2].text_input("Author", key="res_manual_author")
        note = st.text_area("Note", key="res_manual_note")
        evidence_ref = st.text_input(
            "Evidence reference", key="res_manual_evidence", placeholder="blob path, ticket, url"
        )
        if st.button(
            "Record", type="primary", disabled=not author, key="res_manual_go"
        ):
            _, ok = errors.guarded(
                lambda: api_client.record_manual_verdict(
                    run_id,
                    tc_id=tc_id,
                    verdict=verdict,
                    author=author,
                    note=note,
                    evidence_ref=evidence_ref or None,
                    run_version=run_version,
                ),
                "record the manual verdict",
            )
            if ok:
                errors.success(
                    f"Recorded {verdict} for {tc_id}. It reaches `results` through the "
                    "`test-results` topic, so the table above updates once the sink "
                    "has written it."
                )


def _report_panel() -> None:
    st.markdown("### Report")
    if not revisions_ok:
        st.caption(
            "Report revisions cannot be listed. Reports live in blob storage; the "
            "cause is shown in the sidebar."
        )
    elif not revisions:
        st.caption("No revision has been generated for this run version yet.")
    else:
        st.caption(f"Revisions: {render.joined(revisions)} · latest `{latest_revision}`")
        chosen = st.selectbox(
            "Revision", list(reversed(revisions)), key="res_report_revision"
        )
        row = st.columns(2)
        with row[0]:
            html, ok = errors.guarded(
                lambda: api_client.report_html(run_id, run_version, str(chosen)),
                "fetch report.html",
                quiet=True,
            )
            if ok:
                st.download_button(
                    "Download report.html",
                    data=html,
                    file_name=f"{run_id}-v{run_version}-{chosen}.html",
                    mime="text/html",
                    use_container_width=True,
                )
        with row[1]:
            body, ok = errors.guarded(
                lambda: api_client.report_json(run_id, run_version, str(chosen)),
                "fetch report.json",
                quiet=True,
            )
            if ok:
                st.download_button(
                    "Download report.json",
                    data=json.dumps(body, indent=2, sort_keys=True),
                    file_name=f"{run_id}-v{run_version}-{chosen}.json",
                    mime="application/json",
                    use_container_width=True,
                )
                if body.get("reproducible") is not None:
                    st.caption(
                        f"reproducible against the previous revision: "
                        f"{body.get('reproducible')}"
                    )

    lessons = st.text_area(
        "Lessons learned (report clause 7.4.10)",
        value=str(run.get("lessons_learned") or ""),
        key="res_lessons",
    )
    row = st.columns(2)
    requested_by = row[0].text_input("Requested by", key="res_report_by")
    with row[1]:
        if st.button("Regenerate report", type="primary", key="res_report_go"):
            result, ok = errors.guarded(
                lambda: api_client.generate_report(
                    run_id,
                    run_version=run_version,
                    requested_by=requested_by,
                    lessons_learned=lessons,
                ),
                "generate the report",
            )
            if ok:
                errors.success(
                    f"Wrote revision `{result.get('revision')}` to "
                    f"`{result.get('folder')}` (reproducible: {result.get('reproducible')})."
                )
                st.rerun()


_header()
st.divider()
result_metrics.render_cards(metrics if metrics_ok else None)
st.divider()
_per_case()
st.divider()
result_metrics.render_requirement_verdicts(run_id, run_version)
st.divider()
_inputs()
_manual_verdict()
st.divider()
_report_panel()
