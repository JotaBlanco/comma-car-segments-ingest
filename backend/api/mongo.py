from typing import Any

from pymongo import MongoClient
from pymongo.database import Database

from .settings import MongoSettings

_mongo: Database[dict[str, Any]]


def connect(settings: MongoSettings) -> None:
    global _mongo
    _mongo = MongoClient(
        settings.url,
        tz_aware=True,
        uuidRepresentation="standard",
        maxPoolSize=50,  # Allow more concurrent connections
        minPoolSize=10,  # Keep connections warm
        maxIdleTimeMS=60000,  # Reuse connections for 60s
        connectTimeoutMS=5000,  # Fail fast on connection issues
        serverSelectionTimeoutMS=5000,  # Fail fast on server selection
    ).get_database(settings.database)

    # Create indexes for optimal query performance
    # Tests collection

    # Drop obsolete Phase 1 indexes
    try:
        _mongo.tests.drop_index("sample_id_1")
    except Exception:
        pass
    try:
        _mongo.tests.drop_index("environment_id_1")
    except Exception:
        pass
    try:
        _mongo.tests.drop_index("test_id_text_campaign_id_text_sample_id_text_environment_id_text_operator_text_description_text")
    except Exception:
        pass

    _mongo.tests.create_index("campaign_id")
    _mongo.tests.create_index("environment_id")
    _mongo.tests.create_index("operator")
    _mongo.tests.create_index("status")
    _mongo.tests.create_index("devices.device_id")  # Index on array field for Device filtering
    _mongo.tests.create_index("created_at")  # For sorting

    # Create text index for full-text search across multiple fields
    _mongo.tests.create_index(
        [
            ("test_id", "text"),
            ("campaign_id", "text"),
            ("operator", "text"),
            ("description", "text"),
        ]
    )

    # Devices collection
    _mongo.devices.create_index("status")
    _mongo.devices.create_index("location")
    _mongo.devices.create_index("product_category")
    _mongo.devices.create_index("product_name")
    _mongo.devices.create_index("manufacturer")
    _mongo.devices.create_index("sample_type")
    _mongo.devices.create_index("sample_id")
    _mongo.devices.create_index("creator")
    _mongo.devices.create_index("created_at")  # For sorting

    # Text index for Device search
    _mongo.devices.create_index(
        [
            ("device_id", "text"),
            ("manufacturer", "text"),
            ("product_name", "text"),
            ("sample_id", "text"),
        ]
    )

    # Device Journal collection
    _mongo.device_journal.create_index("device_id")
    _mongo.device_journal.create_index("timestamp")
    _mongo.device_journal.create_index([("device_id", 1), ("timestamp", -1)])  # Compound index

    # Logbook collection
    _mongo.logbook.create_index("test_id")

    # V-model collections (requirements register and its immutable versions)
    _mongo.vm_requirements.create_index([("artifact_version", 1), ("req_id", 1)], unique=True)
    _mongo.vm_requirements.create_index("req_id")
    _mongo.vm_requirements.create_index("chapter")
    _mongo.vm_requirements.create_index("status")
    _mongo.vm_artifact_sets.create_index([("kind", 1), ("canonical_sha256", 1)])
    _mongo.vm_baselines.create_index("requirements_version")
    _mongo.vm_test_specs.create_index([("artifact_version", 1), ("tc_id", 1)], unique=True)
    _mongo.vm_test_specs.create_index("tc_id")
    _mongo.vm_test_specs.create_index("covers_req_ids")
    _mongo.vm_test_impls.create_index([("artifact_version", 1), ("impl_id", 1)], unique=True)
    _mongo.vm_test_impls.create_index("tc_id")
    _mongo.vm_signals.create_index([("artifact_version", 1), ("signal", 1)], unique=True)
    _mongo.vm_signals.create_index("channel_group")
    _mongo.vm_traces.create_index("scenario")
    _mongo.vm_run_traces.create_index([("run_id", 1), ("trace_key", 1)], unique=True)
    _mongo.vm_results.create_index("run_id")
    _mongo.vm_results.create_index("tc_id")
    _mongo.vm_results.create_index("req_ids")
    _mongo.vm_results.create_index("status")
    _mongo.vm_results.create_index([("run_id", 1), ("tc_id", 1)])
    _mongo.tests.create_index("vmodel.baseline_id", sparse=True)


def disconnect() -> None:
    _mongo.client.close()


def get_mongo() -> Database[dict[str, Any]]:
    return _mongo
