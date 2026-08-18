"""Small shared renderers. No visual design here - structure only.

``select_row`` is the piece that makes a table clickable: Streamlit has no link
column that can carry state, so a single-row dataframe selection is turned into a
record selection, which the detail panel below the table then reads.
"""

from typing import Any

import pandas as pd
import streamlit as st

COVERAGE_ICONS = {
    "covered": "✅ covered",
    "not covered": "❌ not covered",
    "not trace-coverable": "🔍 not trace-coverable",
}


def coverage_label(coverage: Any) -> str:
    if not isinstance(coverage, dict):
        return str(coverage or "")
    return COVERAGE_ICONS.get(str(coverage.get("state")), str(coverage.get("state") or ""))


def measurand_label(measurand: Any) -> str:
    if not isinstance(measurand, list):
        return ""
    return ", ".join(
        f"{entry.get('name')} [{entry.get('unit') or '-'}]"
        for entry in measurand
        if isinstance(entry, dict)
    )


def joined(values: Any, empty: str = "") -> str:
    if not values:
        return empty
    if isinstance(values, list | tuple):
        return ", ".join(str(value) for value in values)
    return str(values)


def key_values(pairs: dict[str, Any], columns: int = 3) -> None:
    """A compact read-only attribute block."""
    items = list(pairs.items())
    slots = st.columns(columns)
    for index, (label, value) in enumerate(items):
        with slots[index % columns]:
            st.markdown(f"**{label}**")
            st.markdown(str(value) if value not in (None, "", [], {}) else "–")


def select_row(
    frame: pd.DataFrame,
    *,
    key: str,
    id_column: str,
    height: int | None = None,
) -> str | None:
    """Render a table whose row click selects a record.

    Returns the id only when the click is **new**. A dataframe keeps its selection
    across reruns, so without that guard a stale highlighted row would fight every
    other way of choosing a record - a chip link, a deep link, the address bar -
    and win on the next rerun.
    """
    if frame.empty:
        return None
    marker = f"{key}__last_click"
    event = st.dataframe(
        frame,
        key=key,
        use_container_width=True,
        hide_index=True,
        height=height,
        on_select="rerun",
        selection_mode="single-row",
    )
    rows = list(getattr(event.selection, "rows", []) or [])
    if not rows:
        st.session_state.pop(marker, None)
        return None
    index = rows[0]
    if index < 0 or index >= len(frame):
        return None
    chosen = str(frame.iloc[index][id_column])
    if st.session_state.get(marker) == chosen:
        return None
    st.session_state[marker] = chosen
    return chosen


def table(rows: list[dict], empty_note: str) -> None:
    """A plain table that says so when it is empty, never an empty grid."""
    if not rows:
        st.caption(empty_note)
        return
    st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)


def percent(value: Any) -> str:
    """``None`` is printed as ``n/a`` - an empty denominator is not 0 %."""
    if value is None:
        return "n/a"
    try:
        return f"{float(value) * 100:.1f} %"
    except (TypeError, ValueError):
        return str(value)


def json_expander(label: str, payload: Any) -> None:
    """The escape hatch for a document the page does not model field by field."""
    with st.expander(label):
        st.json(payload, expanded=False)
