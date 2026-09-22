"""Batches before their metadata, and batches after a restart.

Every batch repeats `file`, `declared` and `header_properties`, so this lane is
self-sufficient: it needs nothing from the metadata lane and has no cross-topic
ordering dependency. Out-of-order is ordinary, not an error.
"""

from tests.conftest import SHA256, complete_message, metadata_message, samples_message


class TestBatchesBeforeMetadata:
    def test_the_file_registers_with_no_metadata_message_at_all(self, connector, api):
        connector.on_batch(samples_message(n=21))
        connector.on_batch(complete_message(sample_count=21))

        assert api.only_file()["status"] == "registered"
        assert api.only_file()["run_id"] == "TAS-90001"

    def test_the_run_is_created_by_the_batch_lane_when_it_arrives_first(self, connector, api):
        connector.on_batch(complete_message())
        assert api.runs["TAS-90001"]["rig_id"] == "RIG-01"

    def test_a_late_metadata_message_merges_and_mints_nothing(self, connector, api):
        connector.on_batch(samples_message())
        connector.on_batch(complete_message())
        before = len(api.files), len(api.journal)

        connector.on_metadata(metadata_message())

        assert (len(api.files), len(api.journal)) == before
        assert len(api.runs) == 1

    def test_the_inventory_survives_the_reordering(self, connector, api):
        connector.on_batch(samples_message(signal="A", n=11))
        connector.on_metadata(metadata_message())
        connector.on_batch(samples_message(signal="B", n=11))
        connector.on_batch(complete_message(signal_count=2))

        assert api.only_file()["signal_count"] == 2


class TestRestartMidFile:
    def test_a_restart_before_the_marker_replays_and_completes(self, connector, api):
        # The pod dies after two batches. The offsets were not committed, so the
        # same batches redeliver, and the accumulator rebuilds from them.
        connector.on_batch(samples_message(signal="A", n=11))
        connector.on_batch(samples_message(signal="B", n=11))

        fresh = connector.__class__(connector._registry, connector._config, clock=connector._now)
        fresh.on_batch(samples_message(signal="A", n=11))
        fresh.on_batch(samples_message(signal="B", n=11))
        fresh.on_batch(complete_message(signal_count=2))

        assert api.only_file()["signal_count"] == 2
        assert len(api.files) == 1

    def test_a_marker_with_no_preceding_batches_still_registers_the_file(
        self, connector, api
    ):
        # The batches were committed before the restart, so only the marker
        # redelivers. The inventory is thin, but the file is never dropped.
        connector.on_batch(complete_message(signal_count=2, sample_count=32))

        assert api.only_file()["status"] == "registered"
        assert api.only_file()["signal_count"] == 0
        assert api.only_file()["checksum_sha256"] == SHA256

    def test_two_files_in_flight_never_mix_their_inventories(self, connector, api):
        connector.on_batch(samples_message(signal="A", upload_id="u-a"))
        connector.on_batch(samples_message(signal="B", upload_id="u-b"))
        connector.on_batch(samples_message(signal="C", upload_id="u-b"))

        snapshot = {
            entry["upload_id"]: entry["signals_seen"]
            for entry in connector.status_snapshot()["files_in_flight"]
        }
        assert snapshot == {"u-a": 1, "u-b": 2}
