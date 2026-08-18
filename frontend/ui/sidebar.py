"""The sidebar: one version selector, visible on every page.

This is where the never-mix rule of spec 5.3 is enforced *in the UI*. The backend
already refuses a mixed pair, but a user must not be able to construct one either,
so:

* selecting a **test run** rewrites the baseline selection to that run's baseline
  and disables the baseline control - a run's baseline is immutable, so the only
  honest thing the selector can show is the run's own pin;
* every page reads the baseline through :func:`ui.state.read_context`, so no page
  can pass a different one;
* the badge states which baseline resolved the artifacts on screen.

Baseline publishing lives here too, and not on page 1, for a structural reason:
every artifact read resolves through a baseline, so a freshly uploaded
requirements version is invisible until a baseline pins it. Putting the pin next
to the selector keeps that cause and effect in one place.

Order matters inside :func:`render`: query parameters and queued link targets are
applied *before* any widget is built, because Streamlit refuses to modify a
widget-bound session key after its widget exists.
"""

import streamlit as st

import api_client
from ui import errors, state

SET_LABELS = {
    "requirements": "Requirements version",
    "test_specs": "Test-spec version",
    "test_impl": "Test-impl version",
    "signal_catalog": "Signal-catalogue version",
}


def render() -> None:
    """Draw the selector. Pages then read the selection with ``state.read_context``."""
    state.adopt_query_params()
    state.apply_pending()

    snapshot = errors.health_snapshot()

    with st.sidebar:
        st.markdown("### Version selector")
        errors.storage_banner(snapshot)

        runs = _run_options()
        _run_selector(runs)
        forced_baseline = _forced_baseline(runs)

        baselines, baseline_error = _baseline_options()
        _baseline_selector(baselines, baseline_error, forced_baseline)
        _device_selector()
        _config_selector()
        _run_version_selector(runs)
        _badge(forced_baseline)

        with st.expander("Publish a baseline", expanded=False):
            _baseline_publisher()

    state.publish_query_params()


def _forced_baseline(runs: dict[str, dict]) -> str | None:
    """The baseline the selected run pins, if any.

    Resolved from the run document when the run is not in the filtered list (a
    deep link can name one), because leaving it unresolved is the one way a user
    could still put a run and a foreign baseline on screen together.
    """
    run_id = state.test_run_id()
    if not run_id:
        return None
    listed = runs.get(run_id) or {}
    if listed.get("baseline_id"):
        return str(listed["baseline_id"])
    try:
        run = api_client.get_test_run(run_id)
    except api_client.ApiError:
        return None
    return str(run.get("baseline_id")) if run.get("baseline_id") else None


def _baseline_options() -> tuple[list[str], object]:
    """Newest first, so index 0 is the default the spec asks for."""
    try:
        payload = api_client.list_baselines()
    except api_client.ApiError as exc:
        return [], exc
    items = payload.get("items") or []
    return [str(item["baseline_id"]) for item in reversed(items)], None


def _baseline_selector(options: list[str], error: object, forced: str | None) -> None:
    if forced:
        # A run pins its baseline. Writing it here (before the widget exists) is
        # what makes a mixed selection unreachable rather than merely rejected.
        state.set_value("baseline", forced)
        if forced not in options:
            options = [forced, *options]
    if not options:
        if isinstance(error, api_client.ApiError):
            st.caption(f"Baseline: cannot be listed - {error.message}")
        else:
            st.caption("Baseline: none exists yet - publish one below.")
        return
    state.coerce_choice("baseline", options, default=options[0])
    st.selectbox(
        "Baseline",
        options,
        key=state.skey("baseline"),
        disabled=bool(forced),
        help=(
            "Pinned by the selected test run; clear the run to choose freely."
            if forced
            else "Pins one version of requirements, test specs, test impl and the "
            "signal catalogue for every view."
        ),
    )


def _device_selector() -> None:
    try:
        payload = api_client.list_devices()
    except api_client.ApiError:
        st.caption("Device: registry unavailable.")
        return
    options = [state.ANY_DEVICE] + [str(item["device_id"]) for item in payload.get("items") or []]
    state.coerce_choice("device", options, default=state.ANY_DEVICE)
    st.selectbox("Device", options, key=state.skey("device"), help="Filters traces and runs.")


def _config_selector() -> None:
    try:
        payload = api_client.list_parameter_sets()
    except api_client.ApiError:
        st.caption("Parameter set: registry unavailable.")
        return
    options = [state.ANY_CONFIG] + [
        state.config_token(str(item["config_id"]), int(item["config_version"]))
        for item in payload.get("items") or []
    ]
    state.coerce_choice("config", options, default=state.ANY_CONFIG)
    st.selectbox(
        "Parameter set", options, key=state.skey("config"), help="Filters runs and traces."
    )


def _run_options() -> dict[str, dict]:
    """Runs keyed by id.

    Deliberately **not** filtered by baseline: the baseline is derived from the run,
    so filtering the list by the baseline the run then overrides is circular. The
    run's own baseline is shown in the option label instead, and device/parameter
    filters still apply.
    """
    config_id, _ = state.config()
    try:
        payload = api_client.list_test_runs(device_id=state.device(), config_id=config_id)
    except api_client.ApiError:
        return {}
    return {str(item["test_run_id"]): item for item in payload.get("items") or []}


def _run_selector(runs: dict[str, dict]) -> None:
    options = [state.NO_RUN, *runs]
    requested = state.test_run_id()
    if requested and requested not in options:
        # A link or a URL named a run the current filters exclude; keep it
        # reachable instead of silently dropping the selection.
        options.insert(1, requested)
    state.coerce_choice("test_run_id", options, default=state.NO_RUN)

    def _label(option: str) -> str:
        if option == state.NO_RUN:
            return option
        item = runs.get(option) or {}
        parts = [option]
        if item.get("baseline_id"):
            parts.append(str(item["baseline_id"]))
        if item.get("status"):
            parts.append(str(item["status"]))
        return " · ".join(parts)

    st.selectbox(
        "Test run",
        options,
        key=state.skey("test_run_id"),
        format_func=_label,
        help=(
            "Selecting a run decorates Requirements and Test Specification with its "
            "verdicts and pins the baseline. With no run selected those pages show "
            "static coverage only, never a verdict."
        ),
    )


def _run_version_selector(runs: dict[str, dict]) -> None:
    run_id = state.test_run_id()
    if not run_id:
        state.set_value("run_version", None)
        return
    known = (runs.get(run_id) or {}).get("run_version")
    # A run reached by link may be outside the filtered list; do not clamp a
    # deep-linked revision down to 1 just because its run was not listed.
    latest = max(int(known or 1), state.run_version() or 1)
    current = state.run_version() or latest
    current = max(1, min(current, latest))
    state.set_value("run_version", current)
    chosen = st.number_input(
        "Evaluation revision (run_version)",
        min_value=1,
        max_value=latest,
        value=current,
        step=1,
        help="Results and reports are immutable per run_version; latest is the default.",
    )
    state.set_value("run_version", int(chosen))


def _badge(forced: str | None) -> None:
    baseline = state.baseline()
    if baseline:
        st.info(
            f"**Strict versions:** artifacts resolved through `{baseline}`"
            + ("  \n(pinned by the selected run)" if forced else ""),
            icon=":material/lock:",
        )
    else:
        st.caption("No baseline resolved - artifact pages cannot render.")


def _baseline_publisher() -> None:
    """Pin four artifact-set versions into one immutable baseline."""
    payload, ok = errors.guarded(api_client.list_artifact_sets, "list artifact-set versions")
    if not ok:
        return

    chosen: dict[str, str] = {}
    for set_name, label in SET_LABELS.items():
        versions = list(reversed((payload.get(set_name) or {}).get("versions") or []))
        if not versions:
            st.caption(f"{label}: no version uploaded yet.")
            return
        chosen[set_name] = st.selectbox(label, versions, key=f"tm_pin_{set_name}")

    label_text = st.text_input("Label", key="tm_pin_label", placeholder="e.g. sprint-12 pin")
    created_by = st.text_input("Created by", key="tm_pin_author")

    left, right = st.columns(2)
    if left.button("Check pin", use_container_width=True, key="tm_pin_dry_run"):
        result, dry_ok = errors.guarded(
            lambda: api_client.dry_run_baseline(
                chosen["requirements"],
                chosen["test_specs"],
                chosen["test_impl"],
                chosen["signal_catalog"],
            ),
            "check the pin",
        )
        if dry_ok:
            if result.get("would_be_accepted"):
                errors.success(
                    f"Accepted: {result.get('covered_requirements')} of "
                    f"{result.get('requirements')} requirements covered, "
                    f"{result.get('warning_count')} warning(s)."
                )
            else:
                st.error(f"Rejected: {result.get('error_count')} error finding(s).")
            st.dataframe(result.get("findings") or [], use_container_width=True, hide_index=True)

    if right.button("Publish", type="primary", use_container_width=True, key="tm_pin_create"):
        result, created = errors.guarded(
            lambda: api_client.create_baseline(
                chosen["requirements"],
                chosen["test_specs"],
                chosen["test_impl"],
                chosen["signal_catalog"],
                label=label_text,
                created_by=created_by,
            ),
            "publish the baseline",
        )
        if created:
            new_id = result.get("baseline_id")
            errors.success(f"Published `{new_id}`.")
            state.request("test_run_id", None)
            state.request("baseline", new_id)
            st.rerun()
