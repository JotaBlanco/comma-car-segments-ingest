"""Page 1 - Requirements: upload, register, coverage, detail drawer (spec 1.1).

Upload accepts ReqIF (``.reqif``/``.reqifz``) **or** canonical JSON; both paths mint
one immutable version and the panel then shows the door-validation outcome, the
diff against the parent version and the minted token.

The register is one call to ``GET /requirements`` - the backend pre-resolves
coverage and the run verdict, so this page never joins entities itself (spec 2.6).
Selecting a row opens the detail drawer; the covering test-case chips are real
links onto page 2 filtered to that case.
"""

import pandas as pd
import streamlit as st

import api_client
from ui import errors, graph, nav, render, state

CHAPTERS = ("Functional-HMI", "Performance", "Safety-Fault-Handling")
METHODS = ("Test", "Analysis", "Inspection", "Demonstration")
TAGS = ("VERIFIED-PRIMARY", "VERIFIED-SECONDARY", "UNVERIFIED-2018", "DERIVED")

st.title("Requirements")
context = state.read_context()

if context["test_run_id"]:
    st.caption(
        f"Verdicts below come from run `{context['test_run_id']}` "
        f"v{context['run_version']}. Clear the run in the sidebar for static coverage only."
    )
else:
    st.caption("No run selected: coverage is static and no verdict is shown.")


def _upload_panel() -> None:
    with st.expander("Upload requirements (ReqIF or JSON)", expanded=False):
        st.markdown(
            "One upload mints one immutable `requirements` version. Validation is "
            "atomic: a single bad requirement rejects the whole file and no partial "
            "version is written. The new version becomes visible once a baseline "
            "pins it - publish one from the sidebar."
        )
        upload = st.file_uploader(
            "ReqIF or canonical JSON",
            type=["reqif", "reqifz", "json"],
            key="req_upload",
            help=".reqifz also carries the figures; .json must already use the array shapes.",
        )
        left, right = st.columns(2)
        uploaded_by = left.text_input("Uploaded by", key="req_upload_by")
        notes = right.text_input("Notes", key="req_upload_notes")

        if st.button("Upload", type="primary", disabled=upload is None, key="req_upload_go"):
            result, ok = errors.guarded(
                lambda: api_client.upload_requirements(
                    upload.name, upload.getvalue(), uploaded_by, notes
                ),
                "store the upload",
            )
            if ok:
                errors.success(
                    f"Minted `{result.get('version')}` with "
                    f"{result.get('item_count')} requirement(s)."
                )
                render.key_values(
                    {
                        "Version": result.get("version"),
                        "Parent": result.get("parent_version") or "none (first version)",
                        "Set hash": str(result.get("set_canonical_sha256"))[:12],
                    }
                )
                for warning in result.get("warnings") or []:
                    st.warning(warning)
                _render_diff(str(result.get("version")))


def _convergence_panel() -> None:
    """Prove the ReqIF and JSON paths converge, without minting a version.

    Surfaced here because it is the one operation that can prove the two upload
    paths of this page agree byte for byte; a ``converged: false`` answer is a
    release blocker, not a warning, and it should not need a shell to obtain.
    """
    with st.expander("Check that the ReqIF and JSON upload paths converge", expanded=False):
        left, right = st.columns(2)
        reqif = left.file_uploader("ReqIF", type=["reqif", "reqifz"], key="conv_reqif")
        canonical = right.file_uploader("Canonical JSON", type=["json"], key="conv_json")
        ready = reqif is not None and canonical is not None
        if st.button("Compare", disabled=not ready, key="conv_go"):
            result, ok = errors.guarded(
                lambda: api_client.convergence_check(
                    reqif.name, reqif.getvalue(), canonical.name, canonical.getvalue()
                ),
                "compare the two upload paths",
            )
            if ok:
                if result.get("converged"):
                    errors.success("The two paths produce byte-identical canonical output.")
                else:
                    st.error(
                        "**The two paths diverge.** This is a release blocker: the same "
                        "37 requirements must hash identically whichever door they came "
                        "through."
                    )
                render.json_expander("Comparison detail", result)


def _render_diff(version: str) -> None:
    diff, ok = errors.guarded(
        lambda: api_client.version_diff("requirements", version),
        "diff the new version against its parent",
    )
    if not ok:
        return
    added = list(diff.get("added") or [])
    removed = list(diff.get("removed") or [])
    changed = list(diff.get("changed") or [])
    st.markdown(
        f"**Diff against `{diff.get('from_version') or 'nothing - this is the first version'}`**"
    )
    columns = st.columns(4)
    columns[0].metric("added", len(added))
    columns[0].caption(render.joined(added, "–"))
    columns[1].metric("changed", len(changed))
    columns[1].caption(render.joined([entry.get("id") for entry in changed], "–"))
    columns[2].metric("removed", len(removed))
    columns[2].caption(render.joined(removed, "–"))
    columns[3].metric("unchanged", diff.get("unchanged_count"))
    for entry in changed:
        with st.expander(f"{entry.get('id')} — {len(entry.get('fields') or {})} field(s) changed"):
            render.table(
                [
                    {"field": field, "from": change.get("from"), "to": change.get("to")}
                    for field, change in (entry.get("fields") or {}).items()
                ],
                "no field changed",
            )


def _filters() -> dict:
    row = st.columns(5)
    chapter = row[0].selectbox("Chapter", ["(all)", *CHAPTERS], key="req_f_chapter")
    coverage = row[1].selectbox("Coverage", ["(all)", "covered", "not_covered"], key="req_f_cov")
    method = row[2].selectbox("Method", ["(all)", *METHODS], key="req_f_method")
    tag = row[3].selectbox("Tag", ["(all)", *TAGS], key="req_f_tag")
    text = row[4].text_input("Free text", key="req_f_q")
    return {
        "chapter": None if chapter == "(all)" else chapter,
        "coverage": None if coverage == "(all)" else coverage,
        "verification_method": None if method == "(all)" else method,
        "verification_tag": None if tag == "(all)" else tag,
        "q": text or None,
    }


def _register_rows(items: list[dict]) -> list[dict]:
    return [
        {
            "id": item.get("id"),
            "title": item.get("title"),
            "chapter": item.get("chapter"),
            "ears_pattern": item.get("ears_pattern"),
            "method": item.get("verification_method"),
            "tag": item.get("verification_tag"),
            "measurand": render.measurand_label(item.get("measurand")),
            "coverage": render.coverage_label(item.get("coverage")),
            "test specifications": render.joined(item.get("verified_by"), "–"),
            "latest verdict": str(item.get("latest_verdict") or "–"),
        }
        for item in items
    ]


def _detail(req_id: str) -> None:
    payload, ok = errors.guarded(
        lambda: api_client.get_requirement(
            req_id,
            baseline=context["baseline"],
            test_run_id=context["test_run_id"],
            run_version=context["run_version"],
        ),
        f"load {req_id}",
    )
    if not ok:
        return

    requirement = payload.get("requirement") or {}
    coverage = payload.get("coverage") or {}
    verdict = payload.get("verdict") or {}

    st.subheader(f"{req_id} — {requirement.get('title')}")
    render.key_values(
        {
            "Chapter": requirement.get("chapter"),
            "EARS pattern": requirement.get("ears_pattern"),
            "Verification method": requirement.get("verification_method"),
            "Verification tag": requirement.get("verification_tag"),
            "Status": requirement.get("status"),
            "Revision": requirement.get("revision"),
            "Measurand": render.measurand_label(requirement.get("measurand")),
            "System states": render.joined(requirement.get("system_states"), "–"),
            "Coverage": render.coverage_label(
                {"state": "covered" if coverage.get("covered") else "not covered"}
            ),
        }
    )

    st.markdown("**Requirement text**")
    st.markdown(requirement.get("text") or "–")
    st.markdown("**Rationale**")
    st.markdown(requirement.get("rationale") or "–")
    st.markdown("**Source**")
    st.markdown(render.joined(requirement.get("source"), "–"))

    st.markdown("**Verified by (test specifications covering this requirement)**")
    nav.chip_links(
        list(payload.get("verified_by") or []),
        nav.TEST_SPECIFICATION,
        "tc_id",
        key_prefix=f"req_tc_{req_id}",
        empty_note=(
            "no test case covers this requirement in this baseline"
            if coverage.get("trace_coverable")
            else "not trace-coverable: verification method is not Test"
        ),
    )

    st.markdown("**Related requirements**")
    nav.chip_links(
        list(payload.get("related_reqs") or []),
        nav.REQUIREMENTS,
        "req_id",
        key_prefix=f"req_rel_{req_id}",
        empty_note="none",
    )

    if context["test_run_id"]:
        st.markdown(
            f"**Verdict in `{context['test_run_id']}` v{context['run_version']}:** "
            f"{verdict.get('value') or 'not_run'}"
        )
        render.table(
            [
                {
                    "tc_id": tc_id,
                    "verdict": result.get("verdict"),
                    "reason": result.get("reason_code"),
                    "traces": render.joined(result.get("trace_keys")),
                }
                for tc_id, result in (verdict.get("per_case") or {}).items()
            ],
            "no result for a covering case in this run",
        )
        nav.link_button(
            "Open in Test Result",
            nav.TEST_RESULT,
            key=f"req_to_result_{req_id}",
            req_id=req_id,
        )

    _figures(payload.get("figures") or [])
    graph.render("requirement", req_id, context["baseline"], key=f"req_{req_id}")
    render.json_expander("Canonical requirement document", requirement)


def _figures(figures: list[dict]) -> None:
    if not figures:
        return
    st.markdown("**Figures**")
    for figure in figures:
        if not figure.get("resolved"):
            st.caption(
                f"{figure.get('ref')}: not extracted - the upload was a bare "
                ".reqif/.json, so no figure file exists in this version."
            )
            continue
        blob, ok = errors.guarded(
            lambda url=figure["url"]: api_client.fetch_bytes(url),
            f"load figure {figure.get('ref')}",
        )
        if ok:
            st.markdown(blob.decode("utf-8", errors="replace"), unsafe_allow_html=True)


_upload_panel()
_convergence_panel()

if not errors.baseline_required(context["baseline"]):
    st.stop()

filters = _filters()
payload, ok = errors.guarded(
    lambda: api_client.list_requirements(
        baseline=context["baseline"],
        test_run_id=context["test_run_id"],
        run_version=context["run_version"],
        **filters,
    ),
    "load the requirements register",
)

if ok:
    items = payload.get("items") or []
    st.caption(f"{payload.get('count')} requirement(s) in `{payload.get('baseline_id')}`")
    if not items:
        st.info("No requirement matches these filters.", icon=":material/filter_alt:")
    else:
        clicked = render.select_row(
            pd.DataFrame(_register_rows(items)),
            key="req_register",
            id_column="id",
        )
        if clicked:
            state.set_value("req_id", clicked)

    selected = state.req_id()
    if selected:
        st.divider()
        _detail(selected)
    elif items:
        st.caption("Select a row to open its detail drawer.")
