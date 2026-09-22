"""A registry outage during finalize must not eat the in-flight tallies.

The marker's offset stays uncommitted when RegistryUnavailable escapes, so
Kafka redelivers it. The entry therefore stays in `_inflight` until the
registry has ACCEPTED the file — a redelivered marker re-registers with the
counts the batches built, not with zeros. A 4xx poison is the opposite case:
the message can never succeed, so the entry is dropped with it."""

import pytest

from connector.registry import RegistryUnavailable
from tests.conftest import complete_message, metadata_message, samples_message


def _feed(connector):
    connector.on_metadata(metadata_message())
    connector.on_batch(samples_message(signal="ENGINE_RPM", n=21))
    connector.on_batch(samples_message(signal="VEHICLE_SPEED", n=11))


class TestRedeliveryKeepsTheTallies:
    def test_an_unavailable_registry_leaves_the_entry_in_flight(self, connector, api):
        _feed(connector)
        api.force_status["/files"] = 503

        with pytest.raises(RegistryUnavailable):
            connector.on_batch(complete_message(signal_count=2, sample_count=32))

        rows = connector.status_snapshot()["files_in_flight"]
        assert len(rows) == 1
        assert rows[0]["signals_seen"] == 2

    def test_the_redelivered_marker_registers_the_original_counts(self, connector, api):
        _feed(connector)
        api.force_status["/files"] = 503
        with pytest.raises(RegistryUnavailable):
            connector.on_batch(complete_message(signal_count=2, sample_count=32))

        del api.force_status["/files"]
        connector.on_batch(complete_message(signal_count=2, sample_count=32))

        assert connector.files_registered == 1
        assert len(api.only_file()["_signals"]) == 2
        assert connector.status_snapshot()["files_in_flight"] == []

    def test_a_run_upsert_outage_is_survived_the_same_way(self, connector, api):
        _feed(connector)
        api.force_status["/test-runs"] = 503
        with pytest.raises(RegistryUnavailable):
            connector.on_batch(complete_message(signal_count=2, sample_count=32))

        del api.force_status["/test-runs"]
        connector.on_batch(complete_message(signal_count=2, sample_count=32))

        assert connector.files_registered == 1
        assert connector.status_snapshot()["files_in_flight"] == []


class TestPoisonStillDropsTheEntry:
    def test_a_rejected_file_takes_its_entry_with_it(self, connector, api):
        _feed(connector)
        api.force_status["/files"] = 422

        connector.on_batch(complete_message(signal_count=2, sample_count=32))

        assert connector.poisoned == 1
        assert connector.status_snapshot()["files_in_flight"] == []
