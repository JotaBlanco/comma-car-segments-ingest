"""Page 3 - Test Implementation, deliberately thin (spec 1.3).

Metadata, a first-200-line preview, a fetch button and an upload panel. No editor,
no syntax validation, and no execution control: the unit-test runner is deferred, so
a case with ``trace_required: false`` resolves to
``not_run / manual_verdict_pending`` and is closed from page 5 instead.

The download goes through ``GET /test-impl/{tc_id}/code``, which streams the object
from blob - the frontend never receives a blob credential or a blob URL.
"""

import streamlit as st

import api_client
from ui import errors, nav, render, state

st.title("Test Implementation")
context = state.read_context()


def _upload_panel(default_tc_id: str | None) -> None:
    with st.expander("Upload an implementation", expanded=False):
        st.markdown(
            "One `.py` plus an optional `requirements.txt`, or a `.zip` with a "
            "declared entrypoint. The archive is retained immutably in `source/` and "
            "expanded into `code/`; the previous version's other implementations are "
            "carried forward, so one upload never orphans the rest."
        )
        upload = st.file_uploader(
            "Implementation file", type=["py", "zip"], key="impl_upload"
        )
        extra = st.file_uploader(
            "requirements.txt (optional)", type=["txt"], key="impl_upload_req"
        )
        row = st.columns(3)
        tc_id = row[0].text_input(
            "Test case id", value=default_tc_id or "", key="impl_upload_tc"
        )
        entrypoint = row[1].text_input(
            "Entrypoint",
            key="impl_upload_entry",
            placeholder="test_prf_020.py",
            help="Path inside the archive, or the file name for a bare .py upload.",
        )
        language = row[2].selectbox("Language", ["python", "capl", "etas"], key="impl_upload_lang")
        row2 = st.columns(3)
        timeout_s = row2[0].number_input(
            "Timeout (s)", min_value=1, max_value=900, value=120, key="impl_upload_timeout"
        )
        trace_required = row2[1].checkbox(
            "Trace required", value=True, key="impl_upload_trace_required"
        )
        uploaded_by = row2[2].text_input("Uploaded by", key="impl_upload_by")
        description = st.text_input("Description", key="impl_upload_desc")

        ready = upload is not None and bool(tc_id) and bool(entrypoint)
        if st.button("Upload", type="primary", disabled=not ready, key="impl_upload_go"):
            result, ok = errors.guarded(
                lambda: api_client.upload_test_impl(
                    upload.name,
                    upload.getvalue(),
                    tc_id=tc_id,
                    entrypoint=entrypoint,
                    language=language,
                    requirements_txt=(
                        (extra.name, extra.getvalue()) if extra is not None else None
                    ),
                    timeout_s=int(timeout_s),
                    trace_required=bool(trace_required),
                    description=description,
                    uploaded_by=uploaded_by,
                ),
                "store the implementation",
            )
            if ok:
                errors.success(
                    f"Minted `{result.get('version')}` carrying "
                    f"{result.get('item_count')} implementation(s). Publish a "
                    "baseline pinning it to make it visible below."
                )


def _panel(tc_id: str) -> None:
    payload, ok = errors.guarded(
        lambda: api_client.get_test_impl(tc_id, baseline=context["baseline"]),
        f"load the implementation of {tc_id}",
    )
    if not ok:
        return

    impl = payload.get("impl") or {}
    st.subheader(f"{tc_id} — {impl.get('entrypoint')}")
    files = impl.get("files") or []
    render.key_values(
        {
            "Language": impl.get("language"),
            "Entrypoint": impl.get("entrypoint"),
            "Test-impl version": payload.get("test_impl_version"),
            "Timeout (s)": impl.get("timeout_s"),
            "Trace required": impl.get("trace_required"),
            "requirements.txt": "present" if impl.get("requirements_txt") else "absent",
            "Uploaded": impl.get("uploaded_utc"),
            "Uploaded by": impl.get("uploaded_by") or "–",
            "Code directory": payload.get("code_dir"),
        }
    )
    if impl.get("description"):
        st.markdown(impl["description"])

    render.table(
        [
            {
                "path": record.get("path"),
                "size_bytes": record.get("size_bytes"),
                "lines": record.get("lines"),
                "sha256": str(record.get("sha256") or "")[:12],
            }
            for record in files
        ],
        "no file recorded for this implementation",
    )

    _preview(tc_id, impl)
    _fetch(tc_id, impl, files)

    slots = st.columns(2)
    with slots[0]:
        nav.link_button(
            "Test Specification",
            nav.TEST_SPECIFICATION,
            key=f"impl_spec_{tc_id}",
            container_width=True,
            tc_id=tc_id,
        )
    with slots[1]:
        nav.link_button(
            "Test Run",
            nav.TEST_RUN,
            key=f"impl_run_{tc_id}",
            container_width=True,
            tc_id=tc_id,
        )


def _preview(tc_id: str, impl: dict) -> None:
    st.markdown("### Code preview")
    max_lines = st.slider("Lines", min_value=20, max_value=2000, value=200, step=20,
                          key=f"impl_lines_{tc_id}")
    preview, ok = errors.guarded(
        lambda: api_client.preview_test_impl(
            tc_id, baseline=context["baseline"], max_lines=int(max_lines)
        ),
        f"preview the code of {tc_id}",
    )
    if not ok:
        return
    st.caption(
        f"{preview.get('line_count')} line(s), {preview.get('size_bytes')} bytes, "
        f"sha256 {str(preview.get('sha256'))[:12]}"
        + (" — truncated" if preview.get("truncated") else "")
    )
    language = "python" if str(impl.get("language")) == "python" else "text"
    st.code(preview.get("preview") or "", language=language)


def _fetch(tc_id: str, impl: dict, files: list[dict]) -> None:
    st.markdown("### Fetch from blob")
    paths = [str(record.get("path")) for record in files] or [str(impl.get("entrypoint"))]
    wanted = st.selectbox("File", paths, key=f"impl_fetch_{tc_id}")
    if st.button("Fetch", key=f"impl_fetch_go_{tc_id}"):
        blob, ok = errors.guarded(
            lambda: api_client.download_test_impl(
                tc_id, baseline=context["baseline"], path=wanted
            ),
            f"fetch {wanted}",
        )
        if ok:
            st.download_button(
                f"Download {wanted.rsplit('/', 1)[-1]}",
                data=blob,
                file_name=wanted.rsplit("/", 1)[-1],
                mime="text/plain",
                key=f"impl_dl_{tc_id}",
            )


_upload_panel(state.tc_id())

if not errors.baseline_required(context["baseline"]):
    st.stop()

cases, ok = errors.guarded(
    lambda: api_client.list_test_cases(baseline=context["baseline"]),
    "load the test-case list",
)

if ok:
    items = cases.get("items") or []
    with_impl = [str(item["tc_id"]) for item in items if item.get("has_implementation")]
    without = [str(item["tc_id"]) for item in items if not item.get("has_implementation")]

    if not items:
        st.info("This baseline pins no test cases.", icon=":material/inbox:")
        st.stop()

    options = [str(item["tc_id"]) for item in items]
    current = state.tc_id()
    # Keyless on purpose: the selection lives in state (a link from page 2 or the
    # report must be able to move it), and a keyless selectbox re-reads ``index``
    # on every run instead of pinning the first value the user happened to pick.
    selected = st.selectbox(
        "Test case",
        options,
        index=options.index(current) if current in options else 0,
        format_func=lambda tc: f"{tc} {'✓' if tc in with_impl else '✗ no implementation'}",
    )
    if selected != current:
        state.set_value("tc_id", selected)
    st.caption(
        f"{len(with_impl)} of {len(items)} case(s) have an implementation in "
        f"`{context['baseline']}`."
    )
    if without:
        st.caption(f"Without an implementation: {render.joined(without)}")

    if selected in with_impl:
        st.divider()
        _panel(selected)
    else:
        st.info(
            f"`{selected}` has no implementation in this baseline. Upload one above, "
            "then publish a baseline pinning the new test-impl version.",
            icon=":material/code_off:",
        )
