"""How a backend failure reaches the user: cause first, then what to do.

The Storage Gateway is unreachable, so most *artifact* reads answer ``503`` with
``error == "blob_storage_unavailable"`` and the cause in ``message``, while
everything Mongo-backed (devices, parameter sets, runs, results, metrics already
sunk) keeps working. Two rules follow, and both are implemented here rather than
per page:

1. A 503 is never drawn as an empty table. :func:`show` prints the cause and names
   what is still usable, so "no requirements" can never be mistaken for "there are
   no requirements".
2. No bare status codes. Every message is a sentence about what failed plus the
   backend's own hint.
"""

from collections.abc import Callable
from typing import Any

import streamlit as st

import api_client
from api_client import ApiError

BLOB_STILL_WORKS = (
    "Devices, parameter sets, traces, test runs, results and metrics are stored in "
    "MongoDB and still work; requirements, test specifications, implementations, "
    "baselines and reports live in blob storage and do not."
)


def show(exc: ApiError, doing: str) -> None:
    """Render one failure. ``doing`` completes the sentence "could not <doing>"."""
    if exc.is_blob_unavailable:
        st.warning(
            f"**Artifact storage is unavailable, so this page could not {doing}.**\n\n"
            f"Cause reported by the backend: {exc.message}\n\n"
            f"{BLOB_STILL_WORKS}",
            icon=":material/cloud_off:",
        )
        if exc.hint:
            st.caption(f"Operator hint: {exc.hint}")
        return

    if exc.code == "unreachable":
        st.error(
            f"**The backend API cannot be reached, so this page could not {doing}.**\n\n"
            f"{exc.message}",
            icon=":material/wifi_off:",
        )
        return

    if exc.code == "timeout":
        st.error(
            f"**The backend did not answer in time while trying to {doing}.**\n\n"
            f"{exc.message}",
            icon=":material/timer_off:",
        )
        return

    if exc.problems:
        st.error(f"**Rejected at the door, so nothing was stored: {exc.message}**")
        st.caption(
            "The upload is atomic - one bad item rejects the whole file and no "
            "partial version is minted. Fix every problem below and upload again."
        )
        st.dataframe(
            [
                {
                    "item": problem.get("entity_id") or "(set)",
                    "code": problem.get("code"),
                    "where": problem.get("pointer") or "",
                    "problem": problem.get("message"),
                }
                for problem in exc.problems
            ],
            use_container_width=True,
            hide_index=True,
        )
        return

    if exc.findings:
        st.error(f"**{exc.message}** - no baseline id was consumed.")
        st.dataframe(exc.findings, use_container_width=True, hide_index=True)
        return

    if exc.is_not_found:
        st.info(
            f"**Nothing to show: could not {doing}.**\n\n{exc.message}",
            icon=":material/search_off:",
        )
        return

    st.error(f"**Could not {doing}.**\n\n{exc.message}")
    if exc.hint:
        st.caption(f"Hint: {exc.hint}")


def guarded(call: Callable[[], Any], doing: str, *, quiet: bool = False) -> tuple[Any, bool]:
    """Run one backend call. Returns ``(payload, ok)`` and renders any failure.

    Pages branch on ``ok`` instead of wrapping every call in try/except, which is
    what keeps "an error was shown" and "an empty result was shown" distinct.
    """
    try:
        return call(), True
    except ApiError as exc:
        if not quiet:
            show(exc, doing)
        return None, False


def success(message: str) -> None:
    st.success(message, icon=":material/check_circle:")


def baseline_required(baseline: str | None) -> bool:
    """Gate for the three artifact pages; returns False after explaining why.

    Every artifact read resolves through a baseline, so "no baseline" and "blob is
    down" both end in an empty page - and they need different sentences, because one
    is a missing pin the user can create and the other is an outage they cannot.
    """
    if baseline:
        return True
    snapshot = health_snapshot()
    if snapshot.get("reachable") and not snapshot.get("blob_available"):
        st.warning(
            "**No baseline can be resolved because artifact storage is unavailable**, "
            "so requirements, test specifications and implementations cannot be read "
            f"at all.\n\nCause reported by the backend: {snapshot.get('blob_reason')}"
            f"\n\n{BLOB_STILL_WORKS}",
            icon=":material/cloud_off:",
        )
        return False
    st.warning(
        "**No baseline is selected, so no artifact version can be resolved.** "
        "A baseline pins one version of the requirements, test specifications, "
        "implementations and signal catalogue; publish or select one in the sidebar.",
        icon=":material/lock:",
    )
    return False


@st.cache_data(ttl=20, show_spinner=False)
def backend_health() -> dict:
    """Cached ``/health``. Answers even when blob, Mongo and the broker are down."""
    return api_client.health()


def health_snapshot() -> dict:
    """``/health`` plus a resolved-or-not flag, never raising."""
    try:
        payload = backend_health()
    except ApiError as exc:
        return {"reachable": False, "error": exc.message, "hint": exc.hint}
    blob = payload.get("blob_storage") or {}
    lake = payload.get("lakehouse_query") or {}
    return {
        "reachable": True,
        "blob_available": bool(blob.get("available")),
        "blob_backend": blob.get("backend"),
        "blob_reason": blob.get("reason"),
        "lake_available": bool(lake.get("available")),
        "lake_reason": lake.get("reason"),
        "versions": payload.get("versions") or {},
    }


def storage_banner(snapshot: dict) -> None:
    """The sidebar indicator that makes blob-backed vs Mongo-backed legible."""
    if not snapshot.get("reachable"):
        st.error(
            f"Backend unreachable: {snapshot.get('error')}", icon=":material/wifi_off:"
        )
        return
    if snapshot.get("blob_available"):
        st.caption(
            f":material/cloud_done: Artifact storage: `{snapshot.get('blob_backend')}`"
        )
        return
    st.warning(
        "Artifact storage unavailable - requirements, test specifications, "
        "implementations, baselines and reports cannot be read or written.",
        icon=":material/cloud_off:",
    )
    st.caption(f"Cause: {snapshot.get('blob_reason')}")
