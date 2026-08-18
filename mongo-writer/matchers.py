"""``document_matcher`` functions, one per topic.

The built-in ``MongoDBSink`` default matcher is ``{"_id": record.key}``, which puts
the Kafka key into ``_id``. That is exactly what must not happen here: human-readable
ids live in normal indexed fields (decision D3), and the Kafka key is the run id or
the trace key, so the default would give every result of a run the same ``_id`` and
collapse them into one document.

Each matcher below reproduces the unique index of its collection, so the sink's
upsert is the same identity the index enforces. ``_id`` stays an ``ObjectId``
everywhere.
"""


def traces(record) -> dict:
    """One document per ``trace_key`` - the completion event upserts the status."""
    return {"trace_key": record.value["trace_key"]}


def results(record) -> dict:
    """One document per ``(test_run_id, run_version, tc_id)``."""
    value = record.value
    return {
        "test_run_id": value["test_run_id"],
        "run_version": value["run_version"],
        "tc_id": value["tc_id"],
    }


def run_metrics(record) -> dict:
    """One document per ``(test_run_id, run_version)``."""
    value = record.value
    return {"test_run_id": value["test_run_id"], "run_version": value["run_version"]}


def parameter_sets(record) -> dict:
    """One document per ``(config_id, config_version)``, from a DCM-shaped event."""
    value = record.value
    metadata = value.get("metadata") or {}
    config_id = value.get("config_id") or value.get("id") or metadata.get("target_key")
    version = value.get("config_version")
    if version is None:
        version = metadata.get("version")
    return {"config_id": config_id, "config_version": _as_int(version)}


def report_refs(record) -> dict:
    """Report references are folded onto the run, keyed by ``test_run_id``."""
    return {"test_run_id": record.value["test_run_id"]}


def _as_int(value) -> int | None:
    try:
        return None if value is None else int(value)
    except (TypeError, ValueError):
        return None
