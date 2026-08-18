"""Page 2 - Test Specification (spec 1.2).

Per test case: description, preconditions (prose **and** machine gates), test steps,
verification method, and ``pass_criteria`` as a table - one row per criterion with
its window, reduction, rule, unit and tolerance spelled out in words. With a run
selected the same table gains the actual value, the bound after tolerance and the
per-criterion verdict, so "why did this fail" is answered in one place.

Links out: each covered requirement onto page 1, the implementation onto page 3,
and the run onto pages 4 and 5.
"""

import pandas as pd
import streamlit as st

import api_client
from ui import criteria as criteria_ui
from ui import errors, graph, nav, render, state

st.title("Test Specification")
context = state.read_context()


def _upload_panel() -> None:
    with st.expander("Upload test specifications (JSON)", expanded=False):
        st.markdown(
            "One upload mints one immutable `test_specs` version. Door validation "
            "includes the static pass-criteria checks, so a criterion naming an "
            "unknown signal or an inconsistent unit is caught before any run."
        )
        upload = st.file_uploader(
            "Test-case JSON (one item, a list, or a set file)",
            type=["json"],
            key="tc_upload",
        )
        left, right = st.columns(2)
        uploaded_by = left.text_input("Uploaded by", key="tc_upload_by")
        notes = right.text_input("Notes", key="tc_upload_notes")
        if st.button("Upload", type="primary", disabled=upload is None, key="tc_upload_go"):
            result, ok = errors.guarded(
                lambda: api_client.upload_test_specs(
                    upload.name, upload.getvalue(), uploaded_by, notes
                ),
                "store the upload",
            )
            if ok:
                errors.success(
                    f"Minted `{result.get('version')}` with "
                    f"{result.get('item_count')} test case(s). Publish a baseline "
                    "pinning it to make it visible below."
                )


def _signal_catalog_upload() -> None:
    """The catalogue lives here because it is what makes a criterion checkable.

    A baseline pins four sets, so without a signal-catalogue version no baseline can
    be published at all - and the static pass-criteria checks (signal exists, group
    matches, unit algebra resolves) are exactly what the catalogue is for.
    """
    with st.expander("Upload the signal catalogue (JSON)", expanded=False):
        st.markdown(
            "Maps every signal to its channel group, table, unit, dtype and role. A "
            "baseline pins one catalogue version, and criteria are validated against "
            "it before any run exists."
        )
        upload = st.file_uploader("Signal-catalogue JSON", type=["json"], key="sig_upload")
        left, right = st.columns(2)
        uploaded_by = left.text_input("Uploaded by", key="sig_upload_by")
        notes = right.text_input("Notes", key="sig_upload_notes")
        if st.button("Upload", type="primary", disabled=upload is None, key="sig_upload_go"):
            result, ok = errors.guarded(
                lambda: api_client.upload_signal_catalog(
                    upload.name, upload.getvalue(), uploaded_by, notes
                ),
                "store the signal catalogue",
            )
            if ok:
                errors.success(
                    f"Minted `{result.get('version')}` with "
                    f"{result.get('item_count')} signal(s)."
                )


def _list_rows(items: list[dict]) -> list[dict]:
    return [
        {
            "tc_id": item.get("tc_id"),
            "mnemonic": item.get("mnemonic"),
            "title": item.get("title"),
            "technique": item.get("technique"),
            "priority": item.get("priority"),
            "covers": render.joined(item.get("covers_req_ids"), "–"),
            "implementation": "✓" if item.get("has_implementation") else "✗",
            "criteria": item.get("criteria_count"),
            "traces attached": render.joined(item.get("attached_traces"), "–"),
            "latest verdict": str(item.get("latest_verdict") or "–"),
        }
        for item in items
    ]


def _detail(tc_id: str) -> None:
    payload, ok = errors.guarded(
        lambda: api_client.get_test_case(
            tc_id,
            baseline=context["baseline"],
            test_run_id=context["test_run_id"],
            run_version=context["run_version"],
        ),
        f"load {tc_id}",
    )
    if not ok:
        return

    test_case = payload.get("test_case") or {}
    results = payload.get("results") or []
    outcomes = criteria_ui.results_by_criterion(results)

    st.subheader(f"{tc_id} — {test_case.get('title')}")
    if test_case.get("mnemonic"):
        st.caption(f"Display mnemonic: `{test_case['mnemonic']}`")

    _links_out(tc_id, payload)

    st.markdown("### Description")
    st.markdown(f"**Objective.** {test_case.get('objective') or '–'}")
    if test_case.get("notes"):
        st.markdown(f"**Notes.** {test_case['notes']}")

    st.markdown("### Preconditions")
    preconditions = test_case.get("preconditions") or {}
    st.markdown(preconditions.get("prose") or "–")
    gates = preconditions.get("gates") or []
    st.markdown("**Machine gates** — an unmet gate yields `inconclusive`, never `fail`.")
    criteria_ui.render_criteria(gates, results_by_id=outcomes)

    st.markdown("### Test steps")
    steps = sorted(test_case.get("steps") or [], key=lambda step: step.get("step_no", 0))
    render.table(
        [
            {
                "#": step.get("step_no"),
                "action": step.get("action"),
                "expected": step.get("expected"),
            }
            for step in steps
        ],
        "no steps declared",
    )

    st.markdown("### Verification method")
    render.key_values(
        {
            "Verification method": test_case.get("verification_method"),
            "Technique": test_case.get("technique"),
            "Test environment": test_case.get("test_environment"),
            "Status": test_case.get("status"),
            "Revision": test_case.get("revision"),
            "Regression flag": test_case.get("regression_flag"),
        }
    )

    st.markdown("### Pass criteria")
    criteria_ui.render_criteria(
        test_case.get("pass_criteria") or [],
        logic=test_case.get("pass_criteria_logic"),
        results_by_id=outcomes,
        caption=(
            "Actual, bound and verdict columns come from the selected run. "
            "The bound shown is the bound after the declared tolerance; "
            "uncertainty is reported and never subtracted from a bound."
            if outcomes
            else "Select a run in the sidebar to see actual values against these bounds."
        ),
    )
    _signal_catalog(payload.get("signal_catalog_entries") or {})

    st.markdown("### Data requirements")
    data_requirements = test_case.get("data_requirements") or {}
    render.key_values(
        {
            "Trace required": data_requirements.get("trace_required"),
            "Minimum traces": data_requirements.get("min_traces"),
            "Required signals": render.joined(data_requirements.get("required_signals"), "–"),
            "Required channel groups": render.joined(
                data_requirements.get("required_channel_groups"), "–"
            ),
        }
    )

    st.markdown("### Entry / exit criteria and dependencies")
    render.key_values(
        {
            "Entry criteria": test_case.get("entry_criteria"),
            "Exit criteria": test_case.get("exit_criteria"),
            "Depends on": render.joined(test_case.get("depends_on"), "–"),
        }
    )

    if context["test_run_id"]:
        st.markdown("### In the selected run")
        render.table(
            [
                {
                    "trace_key": link.get("trace_key"),
                    "attached_utc": link.get("attached_utc"),
                    "attached_by": link.get("attached_by"),
                }
                for link in payload.get("attachments") or []
            ],
            "no trace attached to this case in this run",
        )
        for result in results:
            st.markdown(
                f"**Verdict:** {criteria_ui.verdict_label(result.get('verdict'))} "
                f"· reason `{result.get('reason_code') or '–'}`"
            )
            if result.get("note"):
                st.caption(result["note"])

    graph.render("test_case", tc_id, context["baseline"], key=f"tc_{tc_id}")
    render.json_expander("Canonical test-case document", test_case)


def _links_out(tc_id: str, payload: dict) -> None:
    st.markdown("**Covers requirements**")
    covers = payload.get("covers") or []
    render.table(
        [
            {
                "req_id": entry.get("req_id"),
                "title": entry.get("title"),
                "method": entry.get("verification_method"),
            }
            for entry in covers
        ],
        "this case covers nothing - it is listed as an orphan, not rejected",
    )
    nav.chip_links(
        [str(entry.get("req_id")) for entry in covers],
        nav.REQUIREMENTS,
        "req_id",
        key_prefix=f"tc_req_{tc_id}",
        empty_note="no covered requirement to open",
    )

    impl = payload.get("impl")
    slots = st.columns(3)
    with slots[0]:
        if impl:
            nav.link_button(
                f"Implementation: {impl.get('entrypoint')}",
                nav.TEST_IMPLEMENTATION,
                key=f"tc_impl_{tc_id}",
                container_width=True,
                tc_id=tc_id,
            )
        else:
            st.caption("no implementation in this baseline")
    with slots[1]:
        nav.link_button(
            "Run this case",
            nav.TEST_RUN,
            key=f"tc_run_{tc_id}",
            container_width=True,
            tc_id=tc_id,
        )
    with slots[2]:
        nav.link_button(
            "Test Result",
            nav.TEST_RESULT,
            key=f"tc_result_{tc_id}",
            container_width=True,
            tc_id=tc_id,
        )


def _signal_catalog(entries: dict) -> None:
    rows = [
        {
            "signal": signal,
            "channel_group": (entry or {}).get("channel_group"),
            "unit": (entry or {}).get("unit"),
            "dtype": (entry or {}).get("dtype"),
            "role": (entry or {}).get("role"),
            "table": (entry or {}).get("table"),
        }
        for signal, entry in sorted(entries.items())
    ]
    with st.expander("Signal catalogue entries behind these criteria"):
        render.table(rows, "no criterion names a signal")


_upload_panel()
_signal_catalog_upload()

if not errors.baseline_required(context["baseline"]):
    st.stop()

filter_req = st.text_input(
    "Filter by covered requirement id",
    key="tc_f_req",
    placeholder="ACC-SYS-PRF-020",
    help="Leave empty to list every case in the baseline.",
)

payload, ok = errors.guarded(
    lambda: api_client.list_test_cases(
        baseline=context["baseline"],
        test_run_id=context["test_run_id"],
        run_version=context["run_version"],
        req_id=filter_req or None,
    ),
    "load the test-case list",
)

if ok:
    items = payload.get("items") or []
    st.caption(f"{payload.get('count')} test case(s) in `{payload.get('baseline_id')}`")
    if not items:
        st.info("No test case matches this filter.", icon=":material/filter_alt:")
    else:
        clicked = render.select_row(
            pd.DataFrame(_list_rows(items)), key="tc_list", id_column="tc_id"
        )
        if clicked:
            state.set_value("tc_id", clicked)

    selected = state.tc_id()
    if selected:
        st.divider()
        _detail(selected)
    elif items:
        st.caption("Select a row to open the test case.")
