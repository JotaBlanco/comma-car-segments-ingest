"""run-readiness: turn "a trace finished vectorising" into "this run may evaluate".

The completion event carries only a ``trace_key``; the link rows that turn it into
a run live in Mongo, so the worker asks the API which runs and cases a trace
belongs to, then asks the API whether each of those runs is ready. Readiness itself
is one function in the API (``GET /test-runs/{id}/readiness``) rather than a second
implementation here - a readiness rule that exists twice will eventually disagree
with itself.

The stream is re-keyed with ``group_by("test_run_id")`` so State is per run and
in-context, and the state records that an evaluation has already been requested at
this ``run_version``. That is what makes the trigger idempotent: five traces
finishing for the same run produce one evaluation request, not five.

Evaluation is still never performed on arrival - this worker only publishes a
request, and only when the run says ``auto_evaluate``.
"""

import logging

import backend_client

logger = logging.getLogger(__name__)


def expand_completions(value: dict) -> list[dict]:
    """One completion event -> one entry per affected ``(run, run_version)``.

    Returns a list so the caller can use ``apply(..., expand=True)`` and then
    ``group_by("test_run_id")``; a trace attached to three runs has to fan out
    before it can be keyed by run.
    """
    trace_key = value.get("trace_key")
    if not trace_key:
        return []
    try:
        payload = backend_client.trace_runs(trace_key)
    except backend_client.BackendError as exc:
        logger.warning("Could not resolve runs for %s: %s", trace_key, exc)
        return []

    entries = []
    for item in payload.get("items") or []:
        entries.append(
            {
                "test_run_id": item["test_run_id"],
                "run_version": int(item["run_version"]),
                "tc_ids": item.get("tc_ids") or [],
                "status": item.get("status"),
                "auto_evaluate": bool(item.get("auto_evaluate")),
                "trace_key": trace_key,
                "ingest_status": value.get("ingest_status"),
            }
        )
    if not entries:
        logger.info("Trace %s is attached to no run yet; nothing to trigger", trace_key)
    return entries


def maybe_request(value: dict, state) -> dict:
    """Publish an evaluation request once per run and ``run_version``."""
    test_run_id = value["test_run_id"]
    run_version = value["run_version"]
    marker = f"requested_v{run_version}"

    if state.get(marker):
        return {**value, "action": "already_requested"}
    if not value.get("auto_evaluate"):
        return {**value, "action": "auto_evaluate_off"}
    if value.get("status") != "submitted":
        return {**value, "action": f"status_{value.get('status')}"}

    try:
        readiness = backend_client.readiness(test_run_id, run_version)
    except backend_client.BackendError as exc:
        logger.warning("Readiness check for %s failed: %s", test_run_id, exc)
        return {**value, "action": "readiness_unavailable", "error": str(exc)}

    if not readiness.get("ready"):
        pending = [
            entry["tc_id"] for entry in readiness.get("per_test_case") or []
            if not entry.get("ready")
        ]
        return {**value, "action": "not_ready", "pending_tc_ids": pending}

    try:
        request = backend_client.request_evaluation(test_run_id, "run-readiness")
    except backend_client.BackendError as exc:
        logger.warning("Could not request evaluation for %s: %s", test_run_id, exc)
        return {**value, "action": "request_failed", "error": str(exc)}

    state.set(marker, True)
    logger.info("Requested readiness-triggered evaluation of %s v%s", test_run_id, run_version)
    return {**value, "action": "requested", "request": request}
