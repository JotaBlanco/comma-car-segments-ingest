"""``value_selector`` functions: what actually gets written into each collection.

Named ``selectors_map`` rather than ``selectors`` on purpose: ``selectors`` is a
standard-library module, and shadowing it from an application directory that is the
process working directory would break any dependency that imports it.

Two jobs:

* **project.** A stream message often carries more than the collection needs. The
  ``run-summaries`` message, for example, carries the requirement verdicts as a
  nested array; those belong in their own collection with their own unique index,
  not inside the metric document.
* **normalise.** ``config-events`` arrive in the Quix DCM shape
  (``{id, event, contentUrl, metadata{...}}``) and have to become a
  ``parameter_sets`` document with a flat ``(config_id, config_version)`` identity,
  because that pair is what a run pins.

Nothing here invents a field. A value the message does not carry stays absent, so
a partial upsert is visibly partial rather than filled in with defaults.
"""

METRIC_FIELDS = (
    "requirement_coverage_all",
    "requirement_coverage_testable",
    "requirement_coverage_chapter",
    "requirement_verification_coverage",
    "baseline_coverage_static",
    "denominators",
    "tc_passed",
    "tc_failed",
    "tc_not_run",
    "tc_error",
    "tc_inconclusive",
    "tc_pass_rate_planned",
    "tc_pass_rate_executed",
    "tc_execution_rate",
    "sum_check_ok",
    "covered_req_ids",
    "verified_req_ids",
    "evaluator_version",
    "evaluated_utc",
    "queries",
    "warnings",
    "archive_path",
)

TRACE_FIELDS = (
    "ingest_status",
    "lake_rows",
    "signals",
    "groups",
    "mf4",
    "attachments",
    "trace_epoch_ms",
    "epoch_source",
    "extraction",
)

RESULT_FIELDS = (
    "test_run_id",
    "run_version",
    "tc_id",
    "req_ids",
    "trace_keys",
    "verdict",
    "reason_code",
    "criteria",
    "per_trace",
    "evidence",
    "alignment",
    "uncertainty",
    "note",
    "manual",
    "evaluated_utc",
    "evaluator_version",
    "result_sha256",
)


def _pick(value: dict, fields) -> dict:
    return {key: value[key] for key in fields if key in value}


def trace_status(value: dict) -> dict:
    """Completion event -> the mutable part of the ``traces`` document."""
    document = _pick(value, TRACE_FIELDS)
    document["trace_key"] = value["trace_key"]
    if "t_s_span" in value:
        document["t_s_span"] = value["t_s_span"]
    if value.get("message"):
        document["ingest_message"] = value["message"]
    return document


def result(value: dict) -> dict:
    return _pick(value, RESULT_FIELDS)


def run_metrics(value: dict) -> dict:
    document = _pick(value, METRIC_FIELDS)
    document["test_run_id"] = value["test_run_id"]
    document["run_version"] = value["run_version"]
    return document


def parameter_set(value: dict) -> dict:
    """Quix DCM event -> ``parameter_sets`` document.

    The event shape is ``{id, event, contentUrl, metadata{type, target_key,
    valid_from, category, version, created_at, sha256sum}}``. Keeping the topic in
    that shape means a future per-message ``join_lookup`` against
    ``QuixConfigurationService`` needs no topic migration.
    """
    metadata = value.get("metadata") or {}
    document = {
        "config_id": value.get("config_id") or value.get("id") or metadata.get("target_key"),
        "config_version": _as_int(value.get("config_version") or metadata.get("version")),
        "target_key": metadata.get("target_key") or value.get("target_key"),
        "category": metadata.get("category") or value.get("category"),
        "type": metadata.get("type") or value.get("type"),
        "content_url": value.get("contentUrl") or value.get("content_url"),
        "sha256sum": metadata.get("sha256sum") or value.get("sha256sum"),
        "created_at": metadata.get("created_at") or value.get("created_at"),
        "valid_from": metadata.get("valid_from"),
        "source": "config-events",
    }
    for key in ("params", "canonical_sha256", "config_hash12"):
        if key in value:
            document[key] = value[key]
    if document.get("canonical_sha256") and not document.get("config_hash12"):
        document["config_hash12"] = str(document["canonical_sha256"])[:12]
    return {key: val for key, val in document.items() if val is not None}


def report_ref(value: dict) -> dict:
    """Rendered-report reference, folded onto the run document."""
    return {"test_run_id": value["test_run_id"], "report_ref": value, "status": "reported"}


def _as_int(value) -> int | None:
    try:
        return None if value is None else int(value)
    except (TypeError, ValueError):
        return None
