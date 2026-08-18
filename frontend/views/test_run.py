"""Page 4 - Test Run: create, attach, watch readiness, evaluate (spec 1.4).

Four selections then attachments then submit. Two things are deliberate:

* **The scope expansion is the backend's, not ours.** Creating the run is what
  expands chapters and requirement ids into ``scope.planned_tc_ids``; the draft is
  shown for review and only ``Submit`` freezes it. There is no scope dry-run
  endpoint, so previewing the expansion before creation would mean expanding the
  coverage graph in the browser - a client-side join, which spec 2.6 forbids.
* **No "run the unit test now" control.** The unit-test runner is deferred, so a
  case with ``trace_required: false`` resolves to ``not_run /
  manual_verdict_pending``; page 5's manual-verdict form is how it gets closed.

Attachment is many-to-many in both directions: ``POST /test-runs/{id}/attachments``
takes a list of cases and a list of traces and links every pair, and one MF4 upload
can name several ``tc_ids`` in the same submit.
"""

import streamlit as st

import api_client
from ui import errors, nav, render, run_create, state

st.title("Test Run")
context = state.read_context()

create_tab, attach_tab, list_tab = st.tabs(
    ["Create a run", "Attach data and evaluate", "All runs"]
)


def _draft_review(run: dict) -> None:
    scope = run.get("scope") or {}
    planned = list(scope.get("planned_tc_ids") or [])
    st.markdown("### Scope as expanded by the backend")
    st.caption(scope.get("expansion_note") or "")
    st.markdown(f"{len(planned)} planned test case(s): {render.joined(planned, '–')}")
    if run.get("status") == "draft":
        st.warning(
            "Submitting freezes `planned_tc_ids`. It is the denominator of every "
            "outcome metric, so adding a case afterwards requires a new run.",
            icon=":material/ac_unit:",
        )
        if st.button("Submit (freeze the plan)", type="primary", key="run_submit"):
            _, ok = errors.guarded(
                lambda: api_client.submit_test_run(str(run["test_run_id"])), "submit the run"
            )
            if ok:
                errors.success("Plan frozen.")
                st.rerun()


def _attach_existing(run_id: str, planned: list[str], device_id: str | None) -> None:
    st.markdown("### Attach traces already ingested")
    traces, ok = errors.guarded(
        lambda: api_client.list_traces(device_id=device_id), "load the trace registry"
    )
    if not ok:
        return
    items = traces.get("items") or []
    if not items:
        st.caption(
            "No trace is registered for this device yet. Upload MF4 below - ingest "
            "does not require the run to exist."
        )
        return
    labels = {
        f"{item.get('trace_key')} · {item.get('ingest_status')} · "
        f"{(item.get('mf4') or {}).get('scenario_name') or '?'}": str(item["trace_key"])
        for item in items
    }
    chosen_traces = st.multiselect("Traces", list(labels), key="run_attach_traces")
    chosen_cases = st.multiselect("Test cases", planned, key="run_attach_cases")
    st.caption(
        "Every selected trace is linked to every selected case: many traces to one "
        "case and one trace to many cases in a single call."
    )
    attached_by = st.text_input("Attached by", key="run_attach_by")
    disabled = not (chosen_traces and chosen_cases)
    if st.button("Attach", type="primary", disabled=disabled, key="run_attach_go"):
        result, ok = errors.guarded(
            lambda: api_client.attach_traces(
                run_id,
                chosen_cases,
                [labels[label] for label in chosen_traces],
                attached_by,
            ),
            "attach the traces",
        )
        if ok:
            errors.success(f"{result.get('links')} link(s) written.")
            _preflight(result.get("preflight") or [])


def _preflight(rows: list[dict]) -> None:
    st.markdown("**Pre-flight: required signals against the trace's extracted signals**")
    render.table(
        [
            {
                "tc_id": row.get("tc_id"),
                "trace_key": row.get("trace_key"),
                "missing signals": render.joined(row.get("missing_signals"), "none"),
                "pre-classification": row.get("pre_classification"),
            }
            for row in rows
        ],
        "nothing to check",
    )


def _upload_mf4(run_id: str, planned: list[str], run: dict) -> None:
    st.markdown("### Upload MF4 and attach in the same submit")
    st.caption(
        "The file is streamed to blob and one metadata message is produced; nothing "
        "is evaluated on arrival. Decoded-signal MF4 only - raw-CAN files are "
        "rejected at the door with `unsupported_raw_can`."
    )
    uploads = st.file_uploader(
        "MF4 files", type=["mf4"], accept_multiple_files=True, key="run_mf4"
    )
    cases = st.multiselect(
        "Attach each uploaded file to these cases", planned, key="run_mf4_cases"
    )
    uploaded_by = st.text_input("Uploaded by", key="run_mf4_by")
    disabled = not uploads
    if st.button("Upload", type="primary", disabled=disabled, key="run_mf4_go"):
        for upload in uploads or []:
            result, ok = errors.guarded(
                lambda item=upload: api_client.upload_trace(
                    item.name,
                    item.getvalue(),
                    device_id=str(run.get("device_id")),
                    sw_version=str(run.get("device_sw_version")),
                    hw_version=str(run.get("device_hw_version")),
                    test_run_id=run_id,
                    tc_ids=cases,
                    uploaded_by=uploaded_by,
                ),
                f"upload {upload.name}",
            )
            if ok:
                trace = result.get("trace") or {}
                errors.success(
                    f"{upload.name} → `{result.get('trace_key')}` "
                    f"({trace.get('ingest_status') or 'stored'})"
                )
                if not result.get("created"):
                    st.caption(
                        "Identical bytes were already stored, so the existing "
                        "content-addressed key was reused and no duplicate lake rows "
                        "can be produced."
                    )


def _readiness(run_id: str, run_version: int | None) -> None:
    st.markdown("### Readiness")
    payload, ok = errors.guarded(
        lambda: api_client.get_readiness(run_id, run_version), "load readiness"
    )
    if not ok:
        return
    st.caption(
        f"status `{payload.get('status')}` · auto-evaluate "
        f"{payload.get('auto_evaluate')} · ready: {payload.get('ready')}"
    )
    render.table(
        [
            {
                "trace_key": row.get("trace_key"),
                "stored": "✓" if row.get("stored") else "✗",
                "vectorised": "✓" if row.get("vectorised") else "✗",
                "linked": "✓" if row.get("linked") else "✗",
                "ingest status": row.get("ingest_status"),
                "lake rows": render.joined(
                    [f"{table}={count}" for table, count in (row.get("lake_rows") or {}).items()],
                    "–",
                ),
            }
            for row in payload.get("traces") or []
        ],
        "no trace attached to this run version yet",
    )
    render.table(
        [
            {
                "tc_id": row.get("tc_id"),
                "trace required": row.get("trace_required"),
                "min traces": row.get("min_traces"),
                "attached": render.joined(row.get("attached"), "–"),
                "vectorised": render.joined(row.get("vectorised"), "–"),
                "ready": "✓" if row.get("ready") else "✗",
            }
            for row in payload.get("per_test_case") or []
        ],
        "this run plans no case",
    )

    row = st.columns([2, 1, 1])
    requested_by = row[0].text_input("Requested by", key="run_eval_by")
    new_version = row[1].checkbox("New run_version", key="run_eval_newver", value=False)
    with row[2]:
        if st.button("Evaluate", type="primary", key="run_eval_go"):
            result, ok = errors.guarded(
                lambda: api_client.request_evaluation(
                    run_id,
                    trigger="manual",
                    requested_by=requested_by,
                    new_run_version=bool(new_version),
                ),
                "request evaluation",
            )
            if ok:
                errors.success(
                    f"Evaluation requested for v{result.get('run_version')}. Nothing is "
                    "evaluated inline; the evaluator picks the request up from the topic."
                )


def _attach_and_evaluate() -> None:
    run_id = context["test_run_id"]
    if not run_id:
        st.info(
            "Select a test run in the sidebar, or create one on the first tab.",
            icon=":material/playlist_add:",
        )
        return
    run, ok = errors.guarded(lambda: api_client.get_test_run(run_id), f"load {run_id}")
    if not ok:
        return

    render.key_values(
        {
            "Run": run.get("test_run_id"),
            "Status": run.get("status"),
            "Baseline": run.get("baseline_id"),
            "Device": f"{run.get('device_id')} sw {run.get('device_sw_version')} "
            f"/ hw {run.get('device_hw_version')}",
            "Parameter set": (
                f"{run.get('config_id')}@v{run.get('config_version')}"
                if run.get("config_id")
                else "none pinned"
            ),
            "Version descriptor": run.get("version_descriptor"),
            "Latest run_version": run.get("latest_run_version"),
            "Provenance override": run.get("allow_provenance_mismatch"),
            "Created": run.get("created_utc"),
        }
    )

    _draft_review(run)
    planned = list((run.get("scope") or {}).get("planned_tc_ids") or [])

    st.divider()
    _attach_existing(run_id, planned, run.get("device_id"))
    st.divider()
    _upload_mf4(run_id, planned, run)

    st.divider()
    attachments, ok = errors.guarded(
        lambda: api_client.get_attachments(run_id, context["run_version"]), "load attachments"
    )
    if ok:
        st.markdown("### Attachments per test case")
        render.table(
            [
                {"tc_id": tc_id, "traces": render.joined(keys)}
                for tc_id, keys in (attachments.get("by_test_case") or {}).items()
            ],
            "nothing attached to this run version",
        )

    st.divider()
    _readiness(run_id, context["run_version"])

    st.divider()
    slots = st.columns(3)
    with slots[0]:
        nav.link_button(
            "Test Result", nav.TEST_RESULT, key="run_to_result", container_width=True
        )
    with slots[1]:
        nav.link_button(
            "Test Specification",
            nav.TEST_SPECIFICATION,
            key="run_to_spec",
            container_width=True,
            tc_id=planned[0] if planned else None,
        )
    with slots[2]:
        nav.link_button(
            "Test Implementation",
            nav.TEST_IMPLEMENTATION,
            key="run_to_impl",
            container_width=True,
            tc_id=planned[0] if planned else None,
        )


def _run_list() -> None:
    config_id, _ = state.config()
    payload, ok = errors.guarded(
        lambda: api_client.list_test_runs(
            baseline=context["baseline"], device_id=state.device(), config_id=config_id
        ),
        "load the run list",
    )
    if not ok:
        return
    items = payload.get("items") or []
    st.caption(f"{payload.get('count')} run(s) matching the sidebar filters")
    render.table(
        [
            {
                "test_run_id": item.get("test_run_id"),
                "run_version": item.get("run_version"),
                "version_descriptor": item.get("version_descriptor"),
                "status": item.get("status"),
                "baseline": item.get("baseline_id"),
                "device": item.get("device_id"),
                "config": (
                    f"{item.get('config_id')}@v{item.get('config_version')}"
                    if item.get("config_id")
                    else "–"
                ),
                "planned": item.get("planned_count"),
                "created": item.get("created_utc"),
                "submitted": item.get("submitted_utc") or "–",
                "report": (item.get("report_ref") or {}).get("revision") or "–",
            }
            for item in items
        ],
        "no run matches these filters",
    )
    if items:
        options = [str(item["test_run_id"]) for item in items]
        chosen = st.selectbox("Open a run", options, key="run_list_pick")
        if st.button("Select this run", key="run_list_go"):
            state.request("test_run_id", chosen)
            st.rerun()


with create_tab:
    run_create.create_form(context["baseline"])

with attach_tab:
    _attach_and_evaluate()

with list_tab:
    _run_list()
