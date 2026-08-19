"""Regression tests for V-model fixture seeding.

Two defects are pinned here, both of which took the backend down on restart:

1. Seeding was not idempotent. ``vm_artifact_sets`` keyed its documents on the bare
   artifact version (``v0001``), which every artifact kind shares, so each kind's
   registry document overwrote the previous one. The requirements set lost its
   registry entry, the sha256-keyed "already ingested" guard could therefore never
   match, and the second seed fell through to ``insert_many`` on documents whose
   ``_id`` already existed - BulkWriteError E11000.
2. ``seed_vmodel_safe`` caught too narrow a set of exceptions, so that
   ``BulkWriteError`` escaped the startup lifespan and the API refused to boot.

A fixture problem must never stop the API from serving, and re-seeding must be safe
to repeat, so both are covered.
"""

import logging
from typing import Any, Generator

import pytest
from fastapi.testclient import TestClient
from pymongo.database import Database
from pymongo.errors import BulkWriteError
from testcontainers.mongodb import MongoDbContainer

from api import vmodel_seed
from api.app import create_app
from api.models_vmodel import ArtifactKind
from api.vmodel_seed import (
    SEED_VERSION,
    VM_COLLECTIONS,
    collection_counts,
    seed_vmodel,
    seed_vmodel_safe,
)

# The committed acc_project fixtures are fixed content, so the seed is fully deterministic.
EXPECTED_COUNTS = {
    "vm_artifact_sets": 4,
    "vm_requirements": 37,
    "vm_test_specs": 9,
    "vm_test_impls": 9,
    "vm_signals": 65,
    "vm_baselines": 1,
    "vm_traces": 37,
    "vm_run_traces": 37,
    "vm_results": 333,
    "vm_reports": 0,
}


@pytest.fixture()
def vm_db(mongo_container: MongoDbContainer) -> Generator[Database[dict[str, Any]], None, None]:
    """A clean database with no ``vm_*`` collections. No app, no Influx, no auth."""
    client = mongo_container.get_connection_client()
    database = client[mongo_container.dbname]
    for name in VM_COLLECTIONS:
        database.drop_collection(name)
    yield database
    for name in VM_COLLECTIONS:
        database.drop_collection(name)
    client.close()


class TestSeedIdempotency:
    """Seeding twice must be a no-op the second time, not a duplicate-key crash."""

    def test_second_seed_does_not_raise_and_keeps_counts(
        self, vm_db: Database[dict[str, Any]]
    ) -> None:
        """The regression: run 1 succeeds, run 2 used to raise BulkWriteError E11000."""
        first = seed_vmodel(vm_db)
        assert first == EXPECTED_COUNTS

        second = seed_vmodel(vm_db)

        assert second == EXPECTED_COUNTS
        assert second == first

    def test_third_seed_still_stable(self, vm_db: Database[dict[str, Any]]) -> None:
        """Idempotency is not a one-shot property - repeated restarts must all be safe."""
        for _ in range(3):
            seed_vmodel(vm_db)
        assert collection_counts(vm_db) == EXPECTED_COUNTS

    def test_every_artifact_kind_keeps_its_own_registry_document(
        self, vm_db: Database[dict[str, Any]]
    ) -> None:
        """Root cause: all four kinds shared _id 'v0001' and clobbered each other."""
        seed_vmodel(vm_db)

        sets = list(vm_db.vm_artifact_sets.find({}))
        kinds = sorted(str(doc["kind"]) for doc in sets)

        assert kinds == sorted(kind.value for kind in ArtifactKind)
        assert all(str(doc["artifact_version"]) == SEED_VERSION for doc in sets)

    def test_requirements_registry_survives_the_rest_of_the_chain(
        self, vm_db: Database[dict[str, Any]]
    ) -> None:
        """The requirements set must still be findable after specs/impls/signals ingest.

        This is what the sha256 idempotency guard reads; when it went missing the second
        seed re-ingested the same version from scratch.
        """
        seed_vmodel(vm_db)

        requirements_set = vm_db.vm_artifact_sets.find_one(
            {"kind": ArtifactKind.REQUIREMENTS.value}
        )

        assert requirements_set is not None
        assert requirements_set["item_count"] == 37

    def test_legacy_bare_version_registry_document_is_cleaned_up(
        self, vm_db: Database[dict[str, Any]]
    ) -> None:
        """A database seeded by the buggy version must heal itself on the next seed."""
        vm_db.vm_artifact_sets.insert_one(
            {"_id": SEED_VERSION, "kind": ArtifactKind.SIGNAL_CATALOG.value, "item_count": 65}
        )

        counts = seed_vmodel(vm_db)

        assert vm_db.vm_artifact_sets.find_one({"_id": SEED_VERSION}) is None
        assert counts == EXPECTED_COUNTS

    def test_reset_reseeds_to_the_same_counts(self, vm_db: Database[dict[str, Any]]) -> None:
        """POST /vmodel/seed?reset=true shares this code path and must also be safe."""
        seed_vmodel(vm_db)

        after_reset = seed_vmodel(vm_db, reset=True)

        assert after_reset == EXPECTED_COUNTS

    def test_reseeding_refreshes_changed_item_content(
        self, vm_db: Database[dict[str, Any]]
    ) -> None:
        """A stale document left by an earlier seed must be rewritten, not preserved."""
        seed_vmodel(vm_db)
        key = f"ACC-SYS-FUN-001@{SEED_VERSION}"
        vm_db.vm_requirements.update_one({"_id": key}, {"$set": {"title": "STALE"}})

        seed_vmodel(vm_db)

        doc = vm_db.vm_requirements.find_one({"_id": key})
        assert doc is not None
        assert doc["title"] != "STALE"

    def test_reseeding_removes_items_no_longer_in_the_set(
        self, vm_db: Database[dict[str, Any]]
    ) -> None:
        """An item dropped from the fixture must not linger at the same version."""
        seed_vmodel(vm_db)
        vm_db.vm_requirements.insert_one(
            {
                "_id": f"ACC-SYS-FUN-999@{SEED_VERSION}",
                "req_id": "ACC-SYS-FUN-999",
                "artifact_version": SEED_VERSION,
            }
        )

        seed_vmodel(vm_db)

        assert vm_db.vm_requirements.find_one({"_id": f"ACC-SYS-FUN-999@{SEED_VERSION}"}) is None
        assert vm_db.vm_requirements.count_documents({}) == 37


def _explode(*args: Any, **kwargs: Any) -> dict[str, int]:
    """Stand-in for a seed that hits a duplicate key, matching the production traceback."""
    raise BulkWriteError(
        {"writeErrors": [{"code": 11000, "errmsg": "E11000 duplicate key error", "index": 0}]}
    )


class TestSeedFailureIsNotFatal:
    """A broken fixture must degrade the V-model pages, never stop the API booting."""

    def test_safe_wrapper_swallows_a_pymongo_error(
        self,
        vm_db: Database[dict[str, Any]],
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """BulkWriteError is a PyMongoError; the old except clause did not cover it."""
        monkeypatch.setattr(vmodel_seed, "seed_vmodel", _explode)

        with caplog.at_level(logging.ERROR, logger="api.vmodel_seed"):
            seed_vmodel_safe(vm_db)

        assert any(record.levelno >= logging.ERROR for record in caplog.records)

    def test_safe_wrapper_swallows_an_unexpected_error(
        self, vm_db: Database[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Anything at all going wrong in a fixture load is still not worth a dead API."""

        def _boom(*args: Any, **kwargs: Any) -> dict[str, int]:
            raise RuntimeError("fixture tooling exploded")

        monkeypatch.setattr(vmodel_seed, "seed_vmodel", _boom)

        seed_vmodel_safe(vm_db)

    def test_application_starts_when_seeding_fails(
        self,
        mongo: None,
        influx: Any,
        blob_storage: None,
        config_api: Any,
        portal_api_url: str,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """End to end: the lifespan must complete and the API must serve requests.

        Built inline rather than through the ``client`` fixture because the patch has to
        be in place before the lifespan runs.
        """
        from api.config_api import get_config_api_client

        monkeypatch.setenv("Quix__Portal__Api", portal_api_url)
        monkeypatch.setenv("API_AUTH_ACTIVE", "false")
        monkeypatch.setattr(vmodel_seed, "seed_vmodel", _explode)

        app = create_app()
        app.dependency_overrides[get_config_api_client] = lambda: config_api

        with TestClient(app) as client:
            response = client.get("/api/v1/tests")

        assert response.status_code == 200
