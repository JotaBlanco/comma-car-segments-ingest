"""Registering the three records a run must pin (spec 1.4, steps 1-2).

Page 4 pins a device, one of that device's ``(sw_version, hw_version)`` pairs and -
optionally - a ``(config_id, config_version)`` parameter set. Until this module
existed the page could only *select* them: against an empty registry it printed
"register one through ``POST /devices``" and left the operator with a disabled
``Create draft run`` button and a terminal as the only way forward. The three write
endpoints have existed all along (``backend-api/routers/registry.py:35``, ``:64``,
``:121``), so the gap was the UI, and this is the file that closes it.

Four rules make these forms behave:

* **Validate what the backend validates, before sending.** ``device_id`` and
  ``config_id`` are pattern-constrained (``backend-api/ids.py:16,21``), ``params``
  must be a JSON *object*, and the version pair is length-bounded. A bad value is a
  sentence under the field, not a ``422`` from the server.
* **A new record is selected, not merely present.** A successful write queues the new
  record's identity and reruns; the selector blocks resolve that identity against
  their freshly fetched options and write the selectbox's own widget key **before**
  the widget is built. Same ordering rule ``ui/state.py`` documents for the sidebar:
  Streamlit refuses to modify a widget-bound session key after its widget exists.
* **The confirmation survives the rerun.** ``st.rerun`` discards everything the
  current run has already drawn, so the success sentence is stashed and printed by
  the next run rather than written and thrown away.
* **Send exactly the declared fields.** Every request model sets ``extra="forbid"``
  (``backend-api/api_models.py:20``), so a field the model does not declare is a
  ``422`` and not a silently ignored value - which is why the version form offers no
  ``notes`` box: ``DeviceVersionCreate`` has no such field.

These forms are the stopgap for the demo path, not the intended feed: the registry's
normal source is the ``config-events`` topic, and every ingested MF4 already carries
``device_id``, ``tool_version``, ``asammdf_version`` and ``config_hash12`` in its
header. See section 9 of ``dev-planning/test-manager-frontend-architecture.md``.
"""

import json
import re

import streamlit as st

import api_client
from ui import errors

# Mirrors of the backend's own constraints, duplicated on purpose: the alternative is
# a round trip to discover a typo the operator can be told about immediately. Source
# of truth: ``backend-api/api_models.py:27`` (kind), ``ids.py:16`` (device id),
# ``ids.py:21`` (config id), ``api_models.py:34-35`` (version lengths).
DEVICE_KINDS = ("plant-sim", "hil", "vehicle", "bench")
DEVICE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,31}$")
CONFIG_ID_RE = re.compile(r"^CFG-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
VERSION_MAX_LEN = 64

_PENDING = "tm_registered_pending"
_FLASH = "tm_registered_flash"


# ------------------------------------------------- a fresh record -> the selector


def _queue(kind: str, identity: object) -> None:
    """Remember what was written, for the selector to adopt on the next rerun."""
    st.session_state.setdefault(_PENDING, {})[kind] = identity


def _take(kind: str) -> object | None:
    pending = st.session_state.get(_PENDING) or {}
    return pending.pop(kind, None)


def take_device() -> str | None:
    """The ``device_id`` registered on the previous run, once."""
    value = _take("device")
    return str(value) if isinstance(value, str) else None


def take_device_version() -> tuple[str, str, str] | None:
    """``(device_id, sw_version, hw_version)``.

    The device id travels with the pair so that a version registered for one device
    cannot be applied to another after the selection moved.
    """
    value = _take("device_version")
    if isinstance(value, tuple) and len(value) == 3:
        return str(value[0]), str(value[1]), str(value[2])
    return None


def take_parameter_set() -> tuple[str, int] | None:
    """``(config_id, config_version)`` registered on the previous run, once."""
    value = _take("parameter_set")
    if isinstance(value, tuple) and len(value) == 2:
        return str(value[0]), int(value[1])
    return None


def preselect(widget_key: str, label: str | None, options: list[str]) -> None:
    """Point a selectbox at ``label`` *before* that selectbox is built.

    Legal only ahead of the widget - after instantiation Streamlit raises on a write
    to a widget-bound key, which is the whole reason the identity is queued instead of
    applied where the write happened. A label absent from ``options`` is ignored
    rather than raising, so a record that disappeared between runs cannot break the
    page.
    """
    if label and label in options:
        st.session_state[widget_key] = label


def _flash(message: str) -> None:
    st.session_state[_FLASH] = message


def show_flash() -> None:
    """Print the confirmation of a registration that ended in ``st.rerun``."""
    message = st.session_state.pop(_FLASH, None)
    if message:
        errors.success(str(message))


# ----------------------------------------------------------- client-side checking


def _text(value: object) -> str:
    return str(value or "").strip()


def parse_params(raw: str) -> tuple[dict | None, str]:
    """``(params, problem)``. An empty box is an empty object, not a problem.

    The backend field is ``params: dict``, so a JSON array or scalar is a ``422``;
    reporting the parser's own line and column is more use than the server's "input
    should be a valid dictionary".
    """
    text = raw.strip()
    if not text:
        return {}, ""
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        return None, (
            f"`params` is not valid JSON: {exc.msg} (line {exc.lineno}, column {exc.colno})."
        )
    if not isinstance(value, dict):
        return None, (
            "`params` must be a JSON object mapping parameter name to value, not a "
            f"{type(value).__name__}."
        )
    return value, ""


def _device_blockers(device_id: str, name: str) -> list[str]:
    blockers: list[str] = []
    if not device_id:
        blockers.append("A device id is required.")
    elif not DEVICE_ID_RE.match(device_id):
        blockers.append(
            f"`{device_id}` is not a legal device id. Lower-case letters, digits, `.`, "
            "`_` and `-` only, 3 to 32 characters, first character a letter or digit: "
            f"`{DEVICE_ID_RE.pattern}`. It has to stay path-safe."
        )
    if not name:
        blockers.append("A name is required.")
    return blockers


def _version_blockers(sw_version: str, hw_version: str, config_id: str) -> list[str]:
    blockers: list[str] = []
    pairs = (("A software version", sw_version), ("A hardware version", hw_version))
    for label, value in pairs:
        if not value:
            blockers.append(f"{label} is required.")
        elif len(value) > VERSION_MAX_LEN:
            blockers.append(f"{label} must be at most {VERSION_MAX_LEN} characters.")
    if config_id and not CONFIG_ID_RE.match(config_id):
        blockers.append(
            f"`{config_id}` cannot match any registered parameter set: a parameter set "
            f"id looks like `CFG-BASE` (`{CONFIG_ID_RE.pattern}`). Leave it empty if "
            "this version pins no configuration."
        )
    return blockers


def _parameter_set_blockers(config_id: str, params_problem: str) -> list[str]:
    blockers: list[str] = []
    if not config_id:
        blockers.append("A parameter set id is required.")
    elif not CONFIG_ID_RE.match(config_id):
        blockers.append(
            f"`{config_id}` is not a legal parameter set id. It must start with `CFG-` "
            "followed by up to 64 letters, digits, `.`, `_` or `-`: "
            f"`{CONFIG_ID_RE.pattern}`. Example: `CFG-BASE`."
        )
    if params_problem:
        blockers.append(params_problem)
    return blockers


def _blocked(blockers: list[str]) -> bool:
    """Print why the write button is disabled.

    A disabled button with no stated reason is the defect these forms exist to fix,
    so the reason is never omitted.
    """
    for blocker in blockers:
        st.caption(blocker)
    return bool(blockers)


# -------------------------------------------------------------------------- forms


def device_form(key_prefix: str) -> None:
    """``POST /devices``. The device only - its versions are a separate write."""
    with st.expander("Register a device", expanded=False):
        st.markdown(
            "A device is the plant, HIL, bench or vehicle whose software and hardware "
            "version a run pins. Registering it does **not** create a version, and a "
            "run needs both, so use the version form afterwards."
        )
        top = st.columns(2)
        device_id = _text(
            top[0].text_input(
                "Device id",
                key=f"{key_prefix}_reg_dev_id",
                placeholder="acc-plant-sim-02",
                help="Immutable and path-safe; it also names the device in every trace.",
            )
        )
        name = _text(
            top[1].text_input(
                "Name",
                key=f"{key_prefix}_reg_dev_name",
                placeholder="ACC plant simulator 02",
            )
        )
        bottom = st.columns(2)
        kind = bottom[0].selectbox(
            "Kind",
            list(DEVICE_KINDS),
            key=f"{key_prefix}_reg_dev_kind",
            help="The four kinds the backend accepts; anything else is rejected.",
        )
        description = _text(bottom[1].text_input("Description", key=f"{key_prefix}_reg_dev_desc"))

        disabled = _blocked(_device_blockers(device_id, name))
        if st.button(
            "Register device",
            type="primary",
            disabled=disabled,
            key=f"{key_prefix}_reg_dev_go",
        ):
            payload, ok = errors.guarded(
                lambda: api_client.create_device(device_id, name, str(kind), description),
                f"register device `{device_id}`",
            )
            if ok:
                registered = str((payload or {}).get("device_id") or device_id)
                _queue("device", registered)
                _flash(
                    f"Registered device `{registered}`. It still needs one "
                    "`(sw_version, hw_version)` pair before a run can pin it."
                )
                st.rerun()


def device_version_form(key_prefix: str, device_id: str) -> None:
    """``POST /devices/{device_id}/versions``, for the selected device only."""
    with st.expander(f"Register a version of `{device_id}`", expanded=False):
        st.markdown(
            "A device version is the `(sw_version, hw_version)` pair a run pins, and it "
            "is immutable - re-registering the same pair answers `409`. Only the two "
            "versions are required; the rest is provenance the report prints when it is "
            "known."
        )
        pair = st.columns(2)
        sw_version = _text(
            pair[0].text_input(
                "Software version",
                key=f"{key_prefix}_reg_ver_sw",
                placeholder="acc_stim-1.0.0",
            )
        )
        hw_version = _text(
            pair[1].text_input(
                "Hardware version",
                key=f"{key_prefix}_reg_ver_hw",
                placeholder="sim-none",
            )
        )
        tools = st.columns(3)
        tool_name = _text(tools[0].text_input("Tool name", key=f"{key_prefix}_reg_ver_tool"))
        tool_version = _text(
            tools[1].text_input("Tool version", key=f"{key_prefix}_reg_ver_toolver")
        )
        asammdf_version = _text(
            tools[2].text_input(
                "asammdf version",
                key=f"{key_prefix}_reg_ver_asammdf",
                help="The writer version stamped into the MF4 this device produces.",
            )
        )
        refs = st.columns(3)
        plant_spec_ref = _text(
            refs[0].text_input("Plant spec ref", key=f"{key_prefix}_reg_ver_plant")
        )
        config_id = _text(
            refs[1].text_input(
                "Parameter set id",
                key=f"{key_prefix}_reg_ver_cfg",
                placeholder="CFG-BASE (optional)",
                help="The configuration this version ships with, if it ships with one.",
            )
        )
        config_version = refs[2].number_input(
            "Parameter set version",
            min_value=1,
            step=1,
            value=1,
            key=f"{key_prefix}_reg_ver_cfgver",
            help="Only sent when a parameter set id is given.",
        )
        dbc_id = _text(
            st.text_input(
                "DBC id",
                key=f"{key_prefix}_reg_ver_dbc",
                placeholder="(raw-CAN traces only - leave empty)",
                help="Declared extension point for raw-CAN MF4; decoded traces need none.",
            )
        )
        make_current = st.checkbox(
            "Mark as this device's current version",
            value=True,
            key=f"{key_prefix}_reg_ver_current",
            help=(
                "Convenience only. The run form lists every registered pair, so a run "
                "can pin an older version whatever this says."
            ),
        )

        disabled = _blocked(_version_blockers(sw_version, hw_version, config_id))
        if st.button(
            "Register device version",
            type="primary",
            disabled=disabled,
            key=f"{key_prefix}_reg_ver_go",
        ):
            _, ok = errors.guarded(
                lambda: api_client.create_device_version(
                    device_id,
                    sw_version,
                    hw_version,
                    plant_spec_ref=plant_spec_ref,
                    tool_name=tool_name,
                    tool_version=tool_version,
                    asammdf_version=asammdf_version,
                    dbc_id=dbc_id or None,
                    config_id=config_id or None,
                    config_version=int(config_version) if config_id else None,
                    make_current=bool(make_current),
                ),
                f"register version `sw {sw_version} / hw {hw_version}` of `{device_id}`",
            )
            if ok:
                _queue("device_version", (device_id, sw_version, hw_version))
                _flash(
                    f"Registered `{device_id}` sw `{sw_version}` / hw `{hw_version}`. "
                    "A run can pin it now."
                )
                st.rerun()


def parameter_set_form(key_prefix: str) -> None:
    """``POST /parameter-sets``. One immutable ``(config_id, config_version)``."""
    with st.expander("Register a parameter set", expanded=False):
        st.markdown(
            "A parameter set is the plant configuration a run pins. The backend "
            "canonicalises `params` and derives `config_hash12` from it - the same "
            "twelve hex characters the plant embeds in every MF4 - which is what lets "
            "the provenance check at evaluation time compare like with like."
        )
        head = st.columns(2)
        config_id = _text(
            head[0].text_input(
                "Parameter set id",
                key=f"{key_prefix}_reg_cfg_id",
                placeholder="CFG-BASE",
                help="`CFG-` then letters, digits, `.`, `_` or `-`. Checked before sending.",
            )
        )
        config_version = head[1].number_input(
            "Version",
            min_value=1,
            step=1,
            value=1,
            key=f"{key_prefix}_reg_cfg_ver",
            help="Integer >= 1. The pair is immutable; re-registering it answers `409`.",
        )
        meta = st.columns(2)
        target_key = _text(
            meta[0].text_input(
                "Target key",
                key=f"{key_prefix}_reg_cfg_target",
                help="Defaults to the parameter set id when left empty.",
            )
        )
        category = _text(
            meta[1].text_input("Category", value="plant-config", key=f"{key_prefix}_reg_cfg_cat")
        )
        params_raw = str(
            st.text_area(
                "params (JSON object)",
                value="{}",
                key=f"{key_prefix}_reg_cfg_params",
                help=(
                    "Parsed here before it is sent. These values are what "
                    "`config_hash12` is computed from, so they must be the plant's "
                    "merged configuration and not a summary of it."
                ),
            )
            or ""
        )
        content_url = _text(
            st.text_input(
                "Content url",
                key=f"{key_prefix}_reg_cfg_url",
                placeholder="(optional) where the full configuration document lives",
            )
        )
        notes = _text(st.text_input("Notes", key=f"{key_prefix}_reg_cfg_notes"))

        params, params_problem = parse_params(params_raw)
        disabled = _blocked(_parameter_set_blockers(config_id, params_problem))
        if st.button(
            "Register parameter set",
            type="primary",
            disabled=disabled,
            key=f"{key_prefix}_reg_cfg_go",
        ):
            version = int(config_version)
            payload, ok = errors.guarded(
                lambda: api_client.create_parameter_set(
                    config_id,
                    version,
                    target_key=target_key,
                    category=category or "plant-config",
                    params=params or {},
                    content_url=content_url or None,
                    notes=notes,
                ),
                f"register parameter set `{config_id}@v{version}`",
            )
            if ok:
                _queue("parameter_set", (config_id, version))
                _flash(
                    f"Registered `{config_id}@v{version}` with `config_hash12` "
                    f"`{(payload or {}).get('config_hash12')}`. A trace whose MF4 "
                    "carries a different hash reads as a provenance mismatch."
                )
                st.rerun()
