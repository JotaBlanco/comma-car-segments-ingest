"""Environment-derived settings for the Test Manager backend API.

Every value is read lazily through a module-level function so that importing
any module of this service never requires a populated environment. That is
deliberate: the service must not crash at import when blob storage, the
Lakehouse or the broker are absent (spec 8.2 - the testrig Storage Gateway is
down, so ``Quix__BlobStorage__Connection__Json`` is not injected today).
"""

import os

# Blob prefix constant (spec 3.1). Everything the Test Manager writes as an
# object lives under this prefix, which is disjoint from the lakehouse sink's
# "{workspaceId}/data-lake/time-series/" prefix (decision D7).
TM_PREFIX = "test-manager"

# Component versions. These are recorded on every artifact manifest, result and
# report so an old verdict stays explainable.
VALIDATOR_VERSION = "tm-validator/1.0.0"
EVALUATOR_VERSION = "tm-evaluator/1.0.0"
EXTRACTOR_VERSION = "tm-mf4-extractor/1.0.0"
REPORT_GENERATOR_VERSION = "tm-report-generator/1.0.0"

# Artifact set names, used as blob path segments and as manifest "set" values.
SET_REQUIREMENTS = "requirements"
SET_TEST_SPECS = "test_specs"
SET_TEST_IMPL = "test_impl"
SET_SIGNAL_CATALOG = "signal_catalog"

# Blob folder name per set (path segments use hyphens, manifests use snake).
SET_FOLDERS = {
    SET_REQUIREMENTS: "requirements",
    SET_TEST_SPECS: "test-specs",
    SET_TEST_IMPL: "test-impl",
    SET_SIGNAL_CATALOG: "signal-catalog",
}

# Set manifest schema names, per set.
SET_MANIFEST_SCHEMAS = {
    SET_REQUIREMENTS: "requirements-set-1.0.0",
    SET_TEST_SPECS: "test-specs-set-1.0.0",
    SET_TEST_IMPL: "test-impl-set-1.0.0",
    SET_SIGNAL_CATALOG: "signal-catalog-set-1.0.0",
}

# Per-set item schema and the field the human id lives in.
SET_ITEM_SCHEMAS = {
    SET_REQUIREMENTS: ("requirement-1.0.0", "id"),
    SET_TEST_SPECS: ("test-case-1.0.0", "tc_id"),
    SET_TEST_IMPL: ("test-impl-1.0.0", "impl_id"),
    SET_SIGNAL_CATALOG: ("signal-catalog-1.0.0", "signal"),
}

# Channel group -> lake table (spec 3.5). SIM_REF_100Hz is present so rows can
# be sunk, but a verdict may never read it (role "reference").
GROUP_TABLES = {
    "PT_CAN_100Hz": "acc_pt_can_100hz",
    "RADAR_OBJ_50Hz": "acc_radar_obj_50hz",
    "ACC_HMI_10Hz": "acc_hmi_10hz",
    "SIM_REF_100Hz": "acc_sim_ref_100hz",
}

GROUP_RASTER_HZ = {
    "PT_CAN_100Hz": 100.0,
    "RADAR_OBJ_50Hz": 50.0,
    "ACC_HMI_10Hz": 10.0,
    "SIM_REF_100Hz": 100.0,
}

# Hive partition columns, fixed for every vector table. Changing this is a
# migration (new table name + re-sink), not a configuration tweak: the sink
# validates the partition set against catalog metadata and the on-disk Hive
# paths at setup() and raises.
HIVE_COLUMNS = ["device_id", "scenario"]
TIMESTAMP_COLUMN = "ts_ms"

# Verdict vocabulary (decision D9).
VERDICTS = ("pass", "fail", "not_run", "error", "inconclusive")
REQ_VERDICTS = ("pass", "fail", "partial", "inconclusive", "error", "not_run")


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def topic_names() -> dict[str, str]:
    """Topic names, overridable per deployment (spec 4.1)."""
    return {
        "config_events": _env("config_events", "config-events"),
        "trace_ingest_requests": _env("trace_ingest_requests", "trace-ingest-requests"),
        "trace_ingest_completed": _env("trace_ingest_completed", "trace-ingest-completed"),
        "evaluation_requests": _env("evaluation_requests", "evaluation-requests"),
        "test_results": _env("test_results", "test-results"),
        "run_summaries": _env("run_summaries", "run-summaries"),
        "report_requests": _env("report_requests", "report-requests"),
        "report_completed": _env("report_completed", "report-completed"),
        "unit_test_requests": _env("unit_test_requests", "unit-test-requests"),
    }


def blob_backend_name() -> str:
    """Which blob implementation to use: auto | quix | local | off.

    ``auto`` picks the Quix filesystem when the platform injected blob
    credentials, else the local filesystem when TM_BLOB_LOCAL_ROOT is set,
    else nothing (endpoints needing blob then fail with a named cause).
    """
    return _env("TM_BLOB_BACKEND", "auto").strip().lower()


def blob_local_root() -> str:
    return _env("TM_BLOB_LOCAL_ROOT", "")


def max_upload_bytes() -> int:
    return int(_env("TM_MAX_UPLOAD_BYTES", str(512 * 1024 * 1024)))


def lakehouse_query_url() -> str:
    return os.environ.get("Quix__Lakehouse__Query__Url") or os.environ.get("QUIXLAKE_URL") or ""


def lakehouse_query_token() -> str:
    return (
        os.environ.get("Quix__Lakehouse__Query__AuthToken")
        or os.environ.get("QUIX_LAKE_TOKEN")
        or ""
    )
