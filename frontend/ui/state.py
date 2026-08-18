"""Selection state: one baseline, one device, one config, one run, one record.

Streamlit has no anchors and no router, so "click a test-case chip and land on the
test case" has to be built out of two mechanisms:

* ``st.session_state`` carries the selection across a page switch;
* ``st.query_params`` makes the same selection a shareable URL, which is what the
  generated report links into (``report_html._req_link`` builds
  ``<frontend>/Requirements?baseline=BL-0007&req_id=ACC-SYS-PRF-020``).

Both are needed, and they can fight: if the URL were always adopted, changing a
sidebar selectbox would be reverted on the next rerun by the stale URL. So the
rule is: **a query parameter is adopted only when it differs from the value this
app last published to the URL.** Our own URL echoing back is ignored; a link from
outside, or a hand-edited address bar, wins.

Every selection key doubles as the ``key`` of the widget that edits it, and all
writes happen in :func:`adopt_query_params` / :func:`coerce_choice`, which the
sidebar calls *before* it builds any widget - mutating a widget-bound key after
instantiation is an error in Streamlit.
"""

import streamlit as st

# Query-parameter names. ``baseline``, ``req_id`` and ``tc_id`` are fixed by the
# report generator's outbound links and must not be renamed here alone.
SELECTION_KEYS = (
    "baseline",
    "device",
    "config",
    "test_run_id",
    "run_version",
    "req_id",
    "tc_id",
)

NO_RUN = "(no run selected)"
ANY_DEVICE = "(all devices)"
ANY_CONFIG = "(all parameter sets)"

_PREFIX = "tm_sel_"
_PUBLISHED = "tm_published_query"
_PENDING = "tm_pending_selection"


def skey(key: str) -> str:
    """The session-state / widget key that stores one selection."""
    return _PREFIX + key


def get(key: str) -> str | None:
    value = st.session_state.get(skey(key))
    if value in (None, "", NO_RUN, ANY_DEVICE, ANY_CONFIG):
        return None
    return str(value)


def set_value(key: str, value: str | int | None) -> None:
    """Set a selection. Only legal before the widget bound to ``key`` is built."""
    if value in (None, ""):
        st.session_state.pop(skey(key), None)
    else:
        st.session_state[skey(key)] = str(value)


def request(key: str, value: str | int | None) -> None:
    """Queue a selection change for the next rerun.

    Most selection keys are also widget keys, and Streamlit refuses to modify a
    widget-bound key after that widget has been instantiated - which is exactly
    where a link click happens (the sidebar is already drawn). Queueing here and
    applying in :func:`apply_pending` before the next batch of widgets keeps every
    link legal, including "open the run I just created".
    """
    pending = st.session_state.setdefault(_PENDING, {})
    pending[key] = None if value in (None, "") else str(value)


def apply_pending() -> None:
    """Apply queued selections. Must run before any selection widget is built."""
    pending = st.session_state.pop(_PENDING, None) or {}
    for key, value in pending.items():
        set_value(key, value)


def get_int(key: str) -> int | None:
    raw = get(key)
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def adopt_query_params() -> None:
    """Take over any query parameter this app did not put in the URL itself."""
    published = st.session_state.get(_PUBLISHED) or {}
    for key in SELECTION_KEYS:
        raw = st.query_params.get(key)
        if raw in (None, ""):
            continue
        if published.get(key) == raw:
            continue
        st.session_state[skey(key)] = raw


def publish_query_params() -> None:
    """Mirror the selection into the URL so every view is a shareable link."""
    desired = {key: value for key in SELECTION_KEYS if (value := get(key))}
    if dict(st.query_params) != desired:
        st.query_params.clear()
        for key, value in desired.items():
            st.query_params[key] = value
    st.session_state[_PUBLISHED] = desired


def coerce_choice(key: str, options: list[str], default: str | None = None) -> None:
    """Make the stored value legal for ``options`` before the widget is built.

    A selectbox whose session value is absent from its options raises, and a stale
    id survives in session state easily (a device filter narrows the run list, a
    deep link names a baseline that no longer exists). Fixing it here keeps every
    widget construction unconditional.
    """
    value = st.session_state.get(skey(key))
    if value in options:
        return
    if default is not None and default in options:
        st.session_state[skey(key)] = default
    else:
        st.session_state.pop(skey(key), None)


def baseline() -> str | None:
    """The baseline every artifact read resolves through."""
    return get("baseline")


def device() -> str | None:
    return get("device")


def config() -> tuple[str | None, int | None]:
    """``(config_id, config_version)`` parsed from the ``CFG-X@v3`` token."""
    raw = get("config")
    if raw is None or "@v" not in raw:
        return None, None
    config_id, _, version = raw.partition("@v")
    try:
        return config_id, int(version)
    except ValueError:
        return config_id, None


def config_token(config_id: str, config_version: int) -> str:
    return f"{config_id}@v{config_version}"


def test_run_id() -> str | None:
    return get("test_run_id")


def run_version() -> int | None:
    return get_int("run_version")


def req_id() -> str | None:
    return get("req_id")


def tc_id() -> str | None:
    return get("tc_id")


def read_context() -> dict:
    """The (baseline, run) pair every catalog read is filtered by.

    Passing the run alongside the baseline is what decorates pages 1 and 2 with
    verdicts; with no run selected the same pages show static coverage only and
    never a verdict, which is the rule in spec 1.0.
    """
    return {
        "baseline": baseline(),
        "test_run_id": test_run_id(),
        "run_version": run_version(),
    }
