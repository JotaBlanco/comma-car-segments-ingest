"""🔴 The run must exist before the file is registered. On every path.

`register_file_document` quarantines a file whose run is unknown, permanently:
`elif not known_run: status, reason = "quarantined", "no run key"`
(api/api/routers/files.py:436-446). A replay does not repair it, the inventory
is never written, the rollup never runs, and the only exit is a human PATCH.

The failure is silent, permanent, and visible only as a run whose file count
never rises. So it gets its own test file.
"""

import pytest

from connector.registry import RegistryUnavailable
from tests.conftest import complete_message, metadata_message, samples_message


class TestAFailedRunRegistrationLeavesNoFileBehind:
    def test_no_file_call_is_attempted(self, connector, api):
        api.force_status["/test-runs"] = 503

        with pytest.raises(RegistryUnavailable):
            connector.on_batch(complete_message())

        assert "/files" not in api.paths()

    def test_no_file_document_exists(self, connector, api):
        api.force_status["/test-runs"] = 503

        with pytest.raises(RegistryUnavailable):
            connector.on_batch(complete_message())

        assert api.files == {}

    def test_the_offset_is_not_committed(self, connector, api):
        # quixstreams commits after the handler RETURNS. Raising out of it is
        # how this service refuses to commit past a failed run upsert.
        api.force_status["/test-runs"] = 503

        with pytest.raises(RegistryUnavailable):
            connector.on_batch(complete_message())

        assert connector.files_registered == 0
        assert connector.journal_events == 0

    def test_nothing_is_journalled(self, connector, api):
        api.force_status["/test-runs"] = 503
        with pytest.raises(RegistryUnavailable):
            connector.on_batch(complete_message())
        assert api.journal == []

    def test_a_malformed_run_body_also_stops_before_the_file_call(self, connector, api):
        # A 4xx is our fault and can never succeed on a re-send, so it commits —
        # but it must still never fall through to POST /files.
        api.force_status["/test-runs"] = 422

        connector.on_batch(complete_message())

        assert "/files" not in api.paths()
        assert api.files == {}
        assert connector.poisoned == 1

    def test_the_redelivery_repairs_it(self, connector, api):
        api.force_status["/test-runs"] = 503
        with pytest.raises(RegistryUnavailable):
            connector.on_batch(complete_message())

        api.force_status.clear()
        connector.on_batch(complete_message())

        assert api.only_file()["status"] == "registered"
        assert api.only_file()["run_id"] == "TAS-90001"


class TestTheCallsAreNeverParallelisedOrReordered:
    def test_the_run_call_precedes_the_file_call_on_the_happy_path(self, connector, api):
        connector.on_metadata(metadata_message())
        connector.on_batch(samples_message())
        connector.on_batch(complete_message())

        paths = api.paths()
        assert paths.index("/test-runs") < paths.index("/files")

    def test_the_catch_up_path_does_not_reverse_them(self, connector, api):
        # Batches first, metadata never — the out-of-order branch takes the same
        # single function and cannot reorder the two calls.
        connector.on_batch(samples_message())
        connector.on_batch(complete_message())

        paths = api.paths()
        assert paths.index("/test-runs") < paths.index("/files")

    def test_a_second_run_upsert_at_terminal_time_still_precedes_the_file(
        self, connector, api
    ):
        connector.on_metadata(metadata_message())
        connector.on_batch(complete_message())

        paths = api.paths()
        # Two run upserts (metadata-time and terminal-time), both before /files.
        # Four journal posts since 26 Aug 2026: the marker-stated sample count
        # fires file.samples_written again.
        assert paths == [
            "/test-runs", "/test-runs", "/files",
            "/journal", "/journal", "/journal", "/journal",
        ]
