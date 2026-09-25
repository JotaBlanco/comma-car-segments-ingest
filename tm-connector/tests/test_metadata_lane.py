"""The `mf4_metadata` lane: POST /test-runs, and nothing else."""

import pytest

from tests.conftest import DECLARED, metadata_message


@pytest.fixture
def lake_connector(api, clock):
    """A connector whose config states the lake table, the way the deployment
    does through the LAKE_TABLE project variable."""
    from connector.config import Config
    from connector.connector import Connector
    from connector.registry import Registry

    config = Config(
        api_url="http://tm/api/v1",
        api_token="t0ken",
        retry_max_attempts=3,
        lake_table="test_signal_samples_v3",
    )
    registry = Registry(
        base_url=config.api_url,
        token=config.api_token,
        max_attempts=config.retry_max_attempts,
        max_backoff=config.retry_max_backoff_seconds,
        sleep=lambda _seconds: None,
        client=api.client(config.api_url),
    )
    return Connector(registry, config, clock=clock)


class TestGoldenRunBody:
    def test_the_body_field_by_field(self, connector, api):
        connector.on_metadata(metadata_message())

        assert api.paths() == ["/test-runs"]
        assert api.bodies("/test-runs")[0] == {
            "run_id": "TAS-90001",
            "rig_id": "RIG-01",
            "work_order_id": "WO-2026-0853",
            "definition_id": "TD-RLD-301",
            "source": "embedded",
            "actor": "ingestion",
        }

    def test_the_context_fields_ride_when_the_bench_sent_them(self, connector, api):
        declared = dict(DECLARED)
        declared.update(
            {
                "description": "Road load, cold start",
                "test_cell": "CELL-2",
                "operator": "A. Nilsson",
                "bench_sw": "tb-4.2.1",
                "started_at": "2026-08-20T10:42:07Z",
                "ended_at": "2026-08-20T10:43:37Z",
            }
        )
        connector.on_metadata(metadata_message(declared=declared))

        body = api.bodies("/test-runs")[0]
        assert body["description"] == "Road load, cold start"
        assert body["test_cell"] == "CELL-2"
        assert body["operator"] == "A. Nilsson"
        assert body["bench_sw"] == "tb-4.2.1"
        assert body["started_at"] == "2026-08-20T10:42:07Z"
        assert body["ended_at"] == "2026-08-20T10:43:37Z"

    def test_the_lake_table_rides_when_the_config_states_one(self, lake_connector, api):
        """The run records which lakehouse table holds its samples.

        The value comes from the LAKE_TABLE project variable - the same one
        mf4-sink's TABLE_NAME references - so what the run claims and where the
        sink writes are one fact, not two copies. The fake validates with the
        real RunUpsertRequest, so this also pins that the API accepts the field.
        """
        lake_connector.on_metadata(metadata_message())

        assert api.bodies("/test-runs")[0]["lake_table"] == "test_signal_samples_v3"

    def test_an_unset_lake_table_is_omitted_not_null(self, connector, api):
        """Absent stays absent. A null would reach the registry's merge as a
        stated value and could overwrite a table a previous deployment recorded;
        an omitted key states nothing."""
        connector.on_metadata(metadata_message())

        assert "lake_table" not in api.bodies("/test-runs")[0]

    def test_the_platform_rides_when_the_bench_declared_it(self, connector, api):
        """BL-81: the registry uses this to state the `project` of a campaign
        this upload opens (`_open_claimed_work_order`). The fake validates
        against the real `RunUpsertRequest`, so this also pins that the API
        accepts the field."""
        declared = dict(DECLARED, platform="Porsche_Taycan")
        connector.on_metadata(metadata_message(declared=declared))

        assert api.bodies("/test-runs")[0]["platform"] == "Porsche_Taycan"

    def test_an_unstated_platform_is_omitted_not_null(self, connector, api):
        """Absent stays absent, exactly like `lake_table`: a null would state
        an empty project for a campaign this upload might open."""
        connector.on_metadata(metadata_message())

        assert "platform" not in api.bodies("/test-runs")[0]

    def test_an_unknown_declared_key_never_reaches_the_registry(self, connector, api):
        # RequestModel is extra="forbid": an unknown field is a 422. The fake
        # validates with the real model, so a leak would fail this test loudly.
        declared = dict(DECLARED, favourite_colour="blue", source="manual")
        connector.on_metadata(metadata_message(declared=declared))

        assert api.runs["TAS-90001"]["status"] == "complete"
        assert connector.poisoned == 0


class TestTheLaneTouchesNoFileRoute:
    def test_no_file_is_registered_at_metadata_time(self, connector, api):
        # Registering here with `signals: []` would lose the inventory
        # PERMANENTLY: upsert_file_signals runs on the registered CREATE path
        # only (routers/files.py:506-507), a replay early-returns before it
        # (:430-434), and FilePatchRequest accepts run_id/actor/note and nothing
        # else. No route adds signals to an existing file.
        connector.on_metadata(metadata_message())

        assert "/files" not in api.paths()
        assert api.files == {}

    def test_the_lane_cannot_violate_the_ordering_constraint(self, connector, api):
        connector.on_metadata(metadata_message())
        connector.on_metadata(metadata_message())
        assert set(api.paths()) == {"/test-runs"}


class TestTheRunAppearsBeforeAnyDecode:
    def test_the_run_exists_the_moment_the_upload_lands(self, connector, api):
        connector.on_metadata(metadata_message())
        assert "TAS-90001" in api.runs

    def test_a_file_that_never_decodes_still_has_its_run(self, connector, api):
        connector.on_metadata(metadata_message())
        # No batch ever arrives.
        assert api.runs["TAS-90001"]["rig_id"] == "RIG-01"
        assert connector.status_snapshot()["files_in_flight"][0]["metadata_seen"] is True

    def test_an_empty_declared_bag_is_an_ordinary_upload(self, connector, api, no_dressing):
        # The normal third-party case. Import emits {}, never null.
        connector.on_metadata(metadata_message(declared={}))
        # The run key still resolves from the filename. Dressing off, so the
        # sentinel is asserted directly instead of by sha1 coincidence.
        assert api.bodies("/test-runs")[0]["run_id"] == "TAS-90001"
        assert api.bodies("/test-runs")[0]["rig_id"] == "UNKNOWN"

    def test_no_run_key_anywhere_waits_for_the_decode(self, connector, api):
        connector.on_metadata(
            metadata_message(declared={}, filename="road_capture.mf4", id="u-2")
        )
        assert api.paths() == []
        assert connector.runs_upserted == 0
