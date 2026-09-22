"""Never-drop: the file the registry cannot place still reaches the registry."""

from tests.conftest import BLOB_PATH, complete_message, metadata_message


class TestAnUnlinkableFile:
    def test_it_registers_with_a_null_run_and_is_quarantined(self, connector, api):
        # No declared bag, no test.run_key, no filename match. The registry's
        # designed answer for an unlinkable file, and the never-drop choice.
        connector.on_batch(
            complete_message(
                declared={},
                header_properties={},
                file_name="road_capture.mf4",
                run_id=None,
            )
        )

        document = api.only_file()
        assert document["run_id"] is None
        assert document["status"] == "quarantined"
        assert document["quarantine_reason"] == "no run key"

    def test_no_run_id_is_ever_invented(self, connector, api):
        connector.on_batch(
            complete_message(declared={}, header_properties={}, file_name="capture.mf4")
        )
        assert "/test-runs" not in api.paths()
        assert api.runs == {}

    def test_an_unresolvable_rig_is_the_sentinel(self, connector, api, no_dressing):
        connector.on_batch(complete_message(declared={}, header_properties={}))
        # The run key still came from the filename, so a run was upserted.
        # Dressing is switched OFF here rather than relied on to decline: this
        # law is about the SENTINEL, and leaving it to the sha1 dice makes it
        # pass by coincidence — a changed pool or rate would flip it silently
        # and the failure would read as a dressing bug, not a sentinel one.
        assert api.bodies("/test-runs")[0]["rig_id"] == "UNKNOWN"

    def test_the_file_is_still_visible_to_an_operator(self, connector, api):
        connector.on_batch(
            complete_message(declared={}, header_properties={}, file_name="capture.mf4")
        )
        assert len(api.files) == 1


class TestADecodeFailure:
    def test_the_decode_error_becomes_the_quarantine_reason(self, connector, api):
        connector.on_metadata(metadata_message())
        connector.on_batch(
            complete_message(
                signal_count=0,
                sample_count=0,
                decode_error="asammdf cannot parse this file",
                time_start_ms=None,
                time_end_ms=None,
            )
        )

        document = api.only_file()
        assert document["status"] == "quarantined"
        assert document["quarantine_reason"] == "asammdf cannot parse this file"

    def test_the_stage_says_the_conversion_failed(self, connector, api):
        # The registry derives a conversion SUCCESS from a non-empty inventory
        # and derives no failure at all (api/api/routers/files.py:1123-1128),
        # so the stage panel read "No report" on a file that plainly failed.
        # The producer holds the decode error, so the producer states it.
        connector.on_metadata(metadata_message())
        connector.on_batch(
            complete_message(
                signal_count=0,
                sample_count=0,
                decode_error="asammdf cannot parse this file",
                time_start_ms=None,
                time_end_ms=None,
            )
        )

        body = api.bodies("/files")[0]
        assert body["conversion_status"] == "failed"
        assert body["stage_error"] == "asammdf cannot parse this file"

    def test_a_decode_that_succeeded_states_no_stage_field(self, connector, api):
        # A success keeps the registry's own derivation. Sending null here
        # would state a report that never happened, and the screen must read
        # an absent stage as unknown, never as failed.
        connector.on_metadata(metadata_message())
        connector.on_batch(complete_message())

        body = api.bodies("/files")[0]
        assert "conversion_status" not in body
        assert "stage_error" not in body

    def test_a_null_window_stays_null(self, connector, api):
        connector.on_batch(
            complete_message(sample_count=0, time_start_ms=None, time_end_ms=None)
        )
        body = api.bodies("/files")[0]
        assert body["time_start"] is None
        assert body["time_end"] is None

    def test_the_file_that_never_decoded_is_still_registered_and_visible(
        self, connector, api
    ):
        connector.on_metadata(metadata_message())
        connector.on_batch(complete_message(decode_error="no decodable signals"))
        assert len(api.files) == 1
        assert api.only_file()["storage_ref"] == BLOB_PATH


class TestAChecksumMismatch:
    def test_it_quarantines_on_the_checksum_not_the_run(self, connector, api):
        connector.on_metadata(metadata_message())
        connector.on_batch(
            complete_message(
                file={
                    "sha256": "0" * 64,
                    "size_bytes": 184320,
                    "blob_path": BLOB_PATH,
                    "format": "MDF 4.10",
                    "checksum_state": "mismatch",
                }
            )
        )

        document = api.only_file()
        assert document["status"] == "quarantined"
        assert document["quarantine_reason"] == "checksum mismatch"

    def test_the_timeline_says_checksum_failed(self, connector, api):
        connector.on_metadata(metadata_message())
        connector.on_batch(
            complete_message(
                file={
                    "sha256": "0" * 64,
                    "size_bytes": 1,
                    "blob_path": BLOB_PATH,
                    "format": "MDF 4.10",
                    "checksum_state": "mismatch",
                }
            )
        )
        fields = [entry["field"] for entry in api.journal]
        assert "file.checksum_failed" in fields
        assert "file.checksum_verified" not in fields

    def test_a_quarantined_file_carries_no_inventory(self, connector, api):
        # upsert_file_signals runs on the registered path only
        # (api/api/routers/files.py:506-507).
        connector.on_batch(
            complete_message(declared={}, header_properties={}, file_name="capture.mf4")
        )
        assert api.only_file()["_signals"] == []
