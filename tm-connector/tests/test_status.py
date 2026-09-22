"""The status endpoint: "stalled" and "healthy" without reading Kafka lag.

This service's consumer lag tracks the decoder's bulk throughput, not its own
work, so lag cannot answer "is it progressing". `/status` can.
"""

import json
import urllib.error
import urllib.request

from connector.status import serve_status
from tests.conftest import complete_message, metadata_message, samples_message


class TestSnapshot:
    def test_a_file_awaiting_its_batches_is_in_flight(self, connector):
        connector.on_metadata(metadata_message())

        snapshot = connector.status_snapshot()
        assert len(snapshot["files_in_flight"]) == 1
        entry = snapshot["files_in_flight"][0]
        assert entry["run_id"] == "TAS-90001"
        assert entry["metadata_seen"] is True
        assert entry["stalled"] is False

    def test_signals_seen_rises_with_the_batches(self, connector):
        connector.on_metadata(metadata_message())
        connector.on_batch(samples_message(signal="A"))
        connector.on_batch(samples_message(signal="B"))

        entry = connector.status_snapshot()["files_in_flight"][0]
        assert entry["signals_seen"] == 2
        assert entry["batches_seen"] == 2

    def test_the_terminal_marker_clears_the_in_flight_entry(self, connector, api):
        connector.on_metadata(metadata_message())
        connector.on_batch(samples_message())
        connector.on_batch(complete_message())

        snapshot = connector.status_snapshot()
        assert snapshot["files_in_flight"] == []
        assert snapshot["last_completed"]["run_id"] == "TAS-90001"
        assert snapshot["last_completed"]["signals"] == 1
        assert snapshot["last_completed"]["status"] == "registered"

    def test_counters_report_the_work_done(self, connector, api):
        connector.on_metadata(metadata_message())
        connector.on_batch(complete_message())

        counters = connector.status_snapshot()["counters"]
        assert counters["runs_upserted"] == 2  # metadata-time and terminal-time
        assert counters["files_registered"] == 1
        # Four: detected, checksum_verified, header_parsed, samples_written -
        # the marker states sample_count, and the count feeds the event again
        # since 26 Aug 2026 (the markers-only lane had silently dropped it).
        assert counters["journal_events"] == 4
        assert counters["poisoned"] == 0


class TestStall:
    def test_batches_that_never_arrive_are_flagged_not_left_looking_slow(
        self, connector, clock
    ):
        connector.on_metadata(metadata_message())
        assert connector.status_snapshot()["stalled_files"] == 0

        clock.advance(901)  # past TM_STALL_SECONDS

        snapshot = connector.status_snapshot()
        assert snapshot["stalled_files"] == 1
        assert snapshot["files_in_flight"][0]["stalled"] is True
        assert snapshot["files_in_flight"][0]["idle_seconds"] == 901.0

    def test_a_batch_resets_the_idle_clock(self, connector, clock):
        connector.on_metadata(metadata_message())
        clock.advance(800)
        connector.on_batch(samples_message())
        clock.advance(800)

        assert connector.status_snapshot()["stalled_files"] == 0

    def test_a_stall_changes_nothing_the_registry_sees(self, connector, api, clock):
        connector.on_metadata(metadata_message())
        calls = list(api.calls)
        clock.advance(10_000)
        connector.status_snapshot()
        assert api.calls == calls


class TestHttpEndpoint:
    def test_it_serves_status_and_health(self, connector):
        server = serve_status(connector.status_snapshot, 0)
        try:
            port = server.server_address[1]
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as reply:
                assert json.load(reply) == {"ok": True, "service": "tm-connector"}
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/status", timeout=5) as reply:
                body = json.load(reply)
            assert body["service"] == "tm-connector"
            assert body["files_in_flight"] == []
            assert "counters" in body
        finally:
            server.shutdown()
            server.server_close()

    def test_an_unknown_path_is_a_404(self, connector):
        server = serve_status(connector.status_snapshot, 0)
        try:
            port = server.server_address[1]
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/nope", timeout=5)
                raise AssertionError("expected a 404")
            except urllib.error.HTTPError as error:
                assert error.code == 404
        finally:
            server.shutdown()
            server.server_close()
