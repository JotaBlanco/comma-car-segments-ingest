"""The create-run form of page 4 (spec 1.4, steps 1-3).

Split out of ``views/test_run.py`` because that page holds two unrelated jobs -
constructing a run, and feeding an existing one - and the construction half is the
part with all the registry lookups in it.

The four selections are: parameter configuration, device (which forces a device
*version*), and a test scope that is either by requirement/chapter or by individual
test cases. The scope is sent as-is; the **backend** expands it into
``scope.planned_tc_ids``, which is what a later ``Submit`` freezes.
"""

import streamlit as st

import api_client
from ui import errors, render, state

CHAPTERS = ("Functional-HMI", "Performance", "Safety-Fault-Handling")


def device_block(key_prefix: str) -> tuple[str | None, str | None, str | None]:
    """A device id plus the ``(sw, hw)`` pair its versions force."""
    payload, ok = errors.guarded(api_client.list_devices, "load the device registry")
    if not ok:
        return None, None, None
    devices = [str(item["device_id"]) for item in payload.get("items") or []]
    if not devices:
        st.warning(
            "No device is registered. Register one through `POST /devices` and a "
            "version through `POST /devices/{device_id}/versions` before creating a run.",
            icon=":material/devices:",
        )
        return None, None, None
    preselect = state.device()
    device_id = st.selectbox(
        "Device",
        devices,
        index=devices.index(preselect) if preselect in devices else 0,
        key=f"{key_prefix}_device",
        help="Identifies the version of the dummy plant. Uploader-asserted (spec 5.5).",
    )
    detail, ok = errors.guarded(
        lambda: api_client.get_device(device_id), f"load versions of {device_id}"
    )
    if not ok:
        return device_id, None, None
    versions = detail.get("versions") or []
    if not versions:
        st.warning(
            f"`{device_id}` has no registered `(sw_version, hw_version)` pair, and a "
            "run must pin one. Register a device version first.",
            icon=":material/warning:",
        )
        return device_id, None, None
    labels = {
        f"sw {entry.get('sw_version')} / hw {entry.get('hw_version')}": entry
        for entry in versions
    }
    chosen = st.selectbox("Device version", list(labels), key=f"{key_prefix}_device_version")
    entry = labels[chosen]
    return device_id, str(entry.get("sw_version")), str(entry.get("hw_version"))


def parameter_block(key_prefix: str) -> tuple[str | None, int | None]:
    """One immutable ``(config_id, config_version)``, with a diff against a sibling."""
    payload, ok = errors.guarded(
        api_client.list_parameter_sets, "load the parameter-set registry"
    )
    if not ok:
        return None, None
    items = payload.get("items") or []
    if not items:
        st.info(
            "No parameter set is registered yet. A run may be created without one, "
            "but then no provenance check against the MF4 `config_hash12` is possible.",
            icon=":material/tune:",
        )
        return None, None
    labels = {
        f"{item.get('config_id')}@v{item.get('config_version')} · "
        f"{str(item.get('canonical_sha256') or '')[:12]} · {item.get('created_at')}": item
        for item in items
    }
    chosen = st.selectbox("Parameter configuration", list(labels), key=f"{key_prefix}_config")
    selected = labels[chosen]
    config_id = str(selected.get("config_id"))
    config_version = int(selected.get("config_version"))

    siblings = [
        int(item["config_version"])
        for item in items
        if str(item.get("config_id")) == config_id
        and int(item["config_version"]) != config_version
    ]
    if siblings:
        other = st.selectbox(
            "Diff against version", sorted(siblings), key=f"{key_prefix}_config_diff"
        )
        diff, ok = errors.guarded(
            lambda: api_client.diff_parameter_sets(config_id, config_version, int(other)),
            "diff the parameter sets",
        )
        if ok:
            render.table(
                [
                    {"parameter": name, "from": change.get("from"), "to": change.get("to")}
                    for name, change in (diff.get("changed") or {}).items()
                ],
                "identical parameters",
            )
    render.json_expander("Parameter set as stored", selected)
    return config_id, config_version


def scope_block(baseline: str) -> dict | None:
    """Either scope selector. Returns the request body fragment, or None if empty."""
    kind = st.radio(
        "Test scope",
        ["By requirement (feature / chapter)", "By test case"],
        key="run_scope_kind",
        horizontal=True,
    )
    if kind == "By requirement (feature / chapter)":
        requirements, ok = errors.guarded(
            lambda: api_client.list_requirements(baseline=baseline),
            "load the requirements of this baseline",
        )
        if not ok:
            return None
        items = requirements.get("items") or []
        chapters = st.multiselect("Chapters", list(CHAPTERS), key="run_scope_chapters")
        req_ids = st.multiselect(
            "Requirement ids",
            [str(item["id"]) for item in items],
            key="run_scope_reqs",
        )
        in_scope = [
            item
            for item in items
            if str(item["id"]) in req_ids or str(item.get("chapter")) in chapters
        ]
        uncovered = [
            str(item["id"])
            for item in in_scope
            if not (item.get("coverage") or {}).get("covered")
        ]
        if in_scope:
            st.caption(
                f"{len(in_scope)} requirement(s) in scope; the backend expands them to "
                "the union of covering test cases when the run is created."
            )
        if uncovered:
            st.warning(
                "In scope but covered by no test case in this baseline, so they will "
                f"count against coverage: {render.joined(uncovered)}",
                icon=":material/report:",
            )
        if not chapters and not req_ids:
            return None
        return {"kind": "by_requirement", "chapters": chapters, "req_ids": req_ids}

    cases, ok = errors.guarded(
        lambda: api_client.list_test_cases(baseline=baseline),
        "load the test cases of this baseline",
    )
    if not ok:
        return None
    options = [str(item["tc_id"]) for item in cases.get("items") or []]
    preselect = [state.tc_id()] if state.tc_id() in options else []
    tc_ids = st.multiselect(
        "Test cases", options, default=preselect, key="run_scope_tcs"
    )
    if not tc_ids:
        return None
    return {"kind": "by_test_case", "tc_ids": tc_ids}


def create_form(baseline: str | None) -> None:
    """Steps 1-3 of spec 1.4, then create the draft whose plan Submit will freeze."""
    if not errors.baseline_required(baseline):
        st.caption("A run must reference exactly one baseline, so creation is blocked.")
        return
    st.info(
        f"This run will be pinned to `{baseline}`. Its baseline is immutable "
        "afterwards, which is what makes version mixing unrepresentable (spec 5.3).",
        icon=":material/lock:",
    )

    config_id, config_version = parameter_block("run_new")
    device_id, sw_version, hw_version = device_block("run_new")
    scope = scope_block(baseline)

    row = st.columns(3)
    label = row[0].text_input("Label", key="run_new_label")
    created_by = row[1].text_input("Created by", key="run_new_by")
    auto_evaluate = row[2].checkbox(
        "Evaluate automatically when ready", key="run_new_auto", value=False
    )
    allow_mismatch = st.checkbox(
        "Allow a provenance mismatch (recorded on the run and printed in the report)",
        key="run_new_allow_mismatch",
        value=False,
        help=(
            "Without this, a trace whose MF4 config_hash12 differs from the run's "
            "parameter set yields inconclusive / provenance_mismatch."
        ),
    )

    ready = bool(device_id and sw_version and hw_version and scope)
    if not ready:
        st.caption("Pick a device with a registered version and a non-empty scope.")
    if st.button("Create draft run", type="primary", disabled=not ready, key="run_new_go"):
        body = {
            "baseline_id": baseline,
            "device_id": device_id,
            "device_sw_version": sw_version,
            "device_hw_version": hw_version,
            "scope": scope,
            "auto_evaluate": bool(auto_evaluate),
            "allow_provenance_mismatch": bool(allow_mismatch),
            "label": label,
            "created_by": created_by,
        }
        if config_id and config_version:
            body["config_id"] = config_id
            body["config_version"] = config_version
        result, ok = errors.guarded(lambda: api_client.create_test_run(body), "create the run")
        if ok:
            run_id = str(result.get("test_run_id"))
            errors.success(
                f"Created draft `{run_id}` with "
                f"{len((result.get('scope') or {}).get('planned_tc_ids') or [])} planned case(s)."
            )
            state.request("test_run_id", run_id)
            st.rerun()
