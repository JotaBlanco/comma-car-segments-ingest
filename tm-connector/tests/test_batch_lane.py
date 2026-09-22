"""The `mf4-to-msg` lane: inventory, the file body, and the journal burst."""

import pytest

from tests.conftest import (
    BLOB_PATH,
    FILE_NAME,
    SHA256,
    UPLOAD_ID,
    complete_message,
    metadata_message,
    samples_message,
)


@pytest.fixture
def decoded(connector, api):
    """One full file: metadata, two signals of batches, the terminal marker."""
    connector.on_metadata(metadata_message())
    connector.on_batch(samples_message(signal="ENGINE_RPM", n=21, step_ms=50))
    connector.on_batch(samples_message(signal="VEHICLE_SPEED", unit="km/h", n=11, step_ms=100))
    connector.on_batch(complete_message(signal_count=2, sample_count=32))
    return connector


class TestGoldenFileBody:
    def test_the_body_field_by_field(self, decoded, api):
        body = api.bodies("/files")[0]
        assert body == {
            "filename": FILE_NAME,
            "run_id": "TAS-90001",
            "source_system": "TAS",
            "format": "MDF 4.10",
            "size_bytes": 184320,
            "checksum_sha256": SHA256,
            "checksum_state": "verified",
            "quarantine_reason": None,
            "storage_ref": BLOB_PATH,
            "ingestion_job_id": UPLOAD_ID,
            "time_start": "2026-08-20T10:42:07.412000Z",
            "time_end": "2026-08-20T10:43:37.412000Z",
            "signals": [
                {"name": "ENGINE_RPM", "unit": "rpm", "rate_hz": 20.0, "dtype": "float64"},
                {
                    "name": "VEHICLE_SPEED",
                    "unit": "km/h",
                    "rate_hz": 10.0,
                    "dtype": "float64",
                },
            ],
        }

    def test_there_is_no_lake_ref_field(self, decoded, api):
        # The file model has none, and the mirrored API is read-only. Inventing
        # one would be a 422 under extra="forbid".
        assert "lake_ref" not in api.bodies("/files")[0]

    def test_the_inventory_reaches_the_registry(self, decoded, api):
        assert api.only_file()["signal_count"] == 2
        assert len(api.only_file()["_signals"]) == 2

    def test_the_file_is_registered_not_quarantined(self, decoded, api):
        assert api.only_file()["status"] == "registered"
        assert api.only_file()["quarantine_reason"] is None


class TestTheInventoryRouteIsNotUsed:
    def test_no_phantom_api_submission_file_is_minted(self, decoded, api):
        # POST /test-runs/{run_id}/signals mints a SEPARATE logical file named
        # api-submission-<...>.json with source_system "api"
        # (routers/test_runs.py:199-260). It would inflate file_count.
        assert not [path for path in api.paths() if path.endswith("/signals")]
        assert all(not doc["filename"].startswith("api-submission") for doc in api.files.values())
        assert {doc["source_system"] for doc in api.files.values()} == {"TAS"}


class TestJournalBurst:
    def test_the_vocabulary_is_the_frozen_five(self, decoded, api):
        fields = {entry["field"] for entry in api.journal}
        assert fields <= {
            "file.detected",
            "file.checksum_verified",
            "file.checksum_failed",
            "file.header_parsed",
            "file.samples_written",
        }

    def test_the_order_is_detected_checksum_header_samples(self, decoded, api):
        assert [entry["field"] for entry in api.journal] == [
            "file.detected",
            "file.checksum_verified",
            "file.header_parsed",
            "file.samples_written",
        ]

    def test_every_event_lands_after_the_file_exists(self, decoded, api):
        # POST /journal 404s on an unknown entity_id (routers/journal.py:79-80),
        # so the burst cannot precede the registration.
        paths = api.paths()
        assert paths.index("/files") < paths.index("/journal")
        assert all(entry["entity_id"] == api.only_file()["file_id"] for entry in api.journal)

    def test_detected_carries_the_upload_moment_not_the_call_moment(self, decoded, api):
        detected = api.journal[0]
        assert detected["at"].isoformat().startswith("2026-08-20T10:42:07")

    def test_the_stamps_strictly_increase_so_the_timeline_has_an_order(self, decoded, api):
        stamps = [entry["at"] for entry in api.journal]
        assert stamps == sorted(stamps)
        assert len(set(stamps)) == len(stamps)

    def test_the_body_carries_exactly_eight_keys(self, decoded, api):
        for _path, body in [call for call in api.calls if call[0] == "/journal"]:
            assert set(body) == {
                "entity_type",
                "entity_id",
                "field",
                "kind",
                "source",
                "actor",
                "note",
                "at",
            }

    def test_samples_written_says_the_decoder_produced_them(self, decoded, api):
        # NOT "the lake committed them" — the sink is a separate consumer on the
        # same topic and this service cannot observe its writes.
        note = next(e for e in api.journal if e["field"] == "file.samples_written")["note"]
        assert note == "The decoder produced 32 samples across 2 signals."
        assert "lake" not in note.lower()

    def test_checksum_verified_claims_a_digest_over_the_stored_bytes(self, decoded, api):
        note = next(e for e in api.journal if e["field"] == "file.checksum_verified")["note"]
        assert note == (
            "A digest was computed over the stored bytes and matches the upload digest."
        )

    def test_header_parsed_reports_the_resolved_identity(self, decoded, api):
        note = next(e for e in api.journal if e["field"] == "file.header_parsed")["note"]
        assert note == "Resolved run TAS-90001 on rig RIG-01."

    def test_a_precedence_conflict_is_reported_in_the_header_note(self, connector, api):
        connector.on_batch(
            complete_message(
                declared={"run_id": "TAS-90002", "rig_id": "RIG-01"},
                sample_count=0,
            )
        )
        note = next(e for e in api.journal if e["field"] == "file.header_parsed")["note"]
        assert "header stated run_id=TAS-90001" in note
        assert "TAS-90002 won" in note

    def test_no_samples_written_event_when_nothing_decoded(self, connector, api):
        connector.on_batch(complete_message(signal_count=0, sample_count=0))
        assert "file.samples_written" not in {entry["field"] for entry in api.journal}


class TestThePostedInventoryIsTheDecodersOwn:
    """R6: the connector posts the inventory the decoder reports."""

    def _decode(self, connector, **complete):
        connector.on_metadata(metadata_message())
        connector.on_batch(samples_message(signal="RPM", n=21, step_ms=50))
        connector.on_batch(complete_message(signal_count=2, sample_count=21, **complete))

    def test_a_channel_that_produced_no_batches_still_reaches_the_catalogue(
        self, connector, api
    ):
        self._decode(
            connector,
            inventory=[
                {"name": "BROKEN_SENSOR", "unit": "degC", "dtype": "float64"},
                {"name": "RPM", "unit": "rpm", "dtype": "float64"},
            ],
        )
        posted = [row["name"] for row in api.bodies("/files")[0]["signals"]]
        assert posted == ["BROKEN_SENSOR", "RPM"]
        assert api.only_file()["signal_count"] == 2
        assert {row["name"] for row in api.only_file()["_signals"]} == {
            "BROKEN_SENSOR",
            "RPM",
        }

    def test_the_inventory_rides_the_batch_block(self, connector, api):
        # One location, beside `samples_suppressed` — not the payload root.
        self._decode(
            connector,
            batch={
                "seq": 1,
                "last": True,
                "signal_count": 2,
                "sample_count": 21,
                "time_start_ms": 1787222527412,
                "time_end_ms": 1787222617412,
                "decode_error": None,
                "inventory": [{"name": "BROKEN_SENSOR"}, {"name": "RPM"}],
            },
        )
        posted = [row["name"] for row in api.bodies("/files")[0]["signals"]]
        assert posted == ["BROKEN_SENSOR", "RPM"]

    def test_the_observed_tally_still_supplies_the_measured_rate(self, connector, api):
        self._decode(connector, inventory=[{"name": "RPM"}, {"name": "BROKEN_SENSOR"}])
        rows = {row["name"]: row for row in api.bodies("/files")[0]["signals"]}
        assert rows["RPM"]["rate_hz"] == 20.0
        assert rows["BROKEN_SENSOR"]["rate_hz"] == 0.0

    def test_no_inventory_field_falls_back_to_the_observed_batches(self, connector, api):
        self._decode(connector)
        assert [row["name"] for row in api.bodies("/files")[0]["signals"]] == ["RPM"]

    def test_that_fallback_is_loud_because_it_is_the_bug_it_replaces(
        self, connector, api, caplog
    ):
        # Inferring `signals[]` from batches IS the R6 loss. It survives only as
        # a never-lose-a-signal degrade for an old decoder image; a SILENT one
        # would rebuild the failure mode with no test able to see it.
        with caplog.at_level("ERROR", logger="tm-connector"):
            self._decode(connector)
        assert any("inventory" in record.message for record in caplog.records)

    def test_the_status_page_reports_what_was_catalogued(self, connector, api):
        # Not "how many channels reached a batch" — the two differ exactly when
        # a channel emitted nothing, which is the case R6 exists for.
        self._decode(connector, inventory=[{"name": "RPM"}, {"name": "BROKEN_SENSOR"}])
        assert connector.status_snapshot()["last_completed"]["signals"] == 2

    def test_a_file_with_no_decodable_channel_posts_an_empty_inventory(
        self, connector, api
    ):
        # R5: it registers, with an honest and empty signal inventory.
        connector.on_metadata(metadata_message())
        connector.on_batch(
            complete_message(signal_count=0, sample_count=0, inventory=[])
        )
        assert api.bodies("/files")[0]["signals"] == []
        assert api.only_file()["status"] == "registered"


class TestTheMissingChecksumSentinel:
    """R2: a missing hash is the empty string, never the literal "unknown".

    `checksum_sha256` is a unique index key, partial on `status:"registered"`
    (api/api/db.py:71-76). A never-null sentinel there folds every hash-less
    file into ONE registry document and counts the rest as replays. The API
    documents the empty string as its own sentinel and matches on it explicitly
    (routers/files.py:368-393); the fallback honours it (watcher.py:348).
    """

    HASHLESS = {
        "sha256": "unknown",
        "size_bytes": 184320,
        "blob_path": BLOB_PATH,
        "format": "MDF 4.10",
        "checksum_state": "verified",
    }

    def test_the_unknown_sentinel_never_reaches_the_unique_index(self, connector, api):
        connector.on_metadata(metadata_message())
        connector.on_batch(complete_message(file=dict(self.HASHLESS)))
        assert api.bodies("/files")[0]["checksum_sha256"] == ""

    def test_a_hash_less_file_never_claims_a_verified_state(self, connector, api):
        # No digest exists, so "verified" would be a claim about bytes nobody
        # hashed (the fallback returns ("", "unverified", ...) together).
        connector.on_metadata(metadata_message())
        connector.on_batch(complete_message(file=dict(self.HASHLESS)))
        assert api.bodies("/files")[0]["checksum_state"] == "unverified"

    def test_two_hash_less_files_are_two_registry_documents(self, connector, api):
        connector.on_metadata(metadata_message())
        connector.on_batch(complete_message(file=dict(self.HASHLESS)))
        connector.on_batch(
            complete_message(
                upload_id="second-upload",
                file_name="TAS-90001_second.mf4",
                file=dict(self.HASHLESS) | {"blob_path": BLOB_PATH + ".2"},
            )
        )
        assert len(api.files) == 2
        assert connector.files_replayed == 0

    def test_the_hash_less_file_is_visible_and_says_why(self, connector, api):
        connector.on_metadata(metadata_message())
        connector.on_batch(complete_message(file=dict(self.HASHLESS)))
        document = api.only_file()
        assert document["status"] == "quarantined"
        assert document["quarantine_reason"] == "unreadable object"

    def test_the_recovery_read_of_the_same_object_resolves_to_one_document(
        self, connector, api
    ):
        # An empty stored checksum makes no claim about the bytes, so a later
        # pass that DID hash them matches the quarantined document
        # (files.py:376-381). "unknown" matches neither branch of that `$or`
        # and mints a second document for one stored object.
        connector.on_metadata(metadata_message())
        connector.on_batch(complete_message(file=dict(self.HASHLESS)))
        connector.on_batch(complete_message())
        assert len(api.files) == 1

    def test_a_real_digest_is_forwarded_untouched(self, connector, api):
        connector.on_metadata(metadata_message())
        connector.on_batch(complete_message())
        assert api.bodies("/files")[0]["checksum_sha256"] == SHA256
        assert api.only_file()["status"] == "registered"

    def test_the_timeline_claims_no_digest_that_was_never_taken(self, connector, api):
        # The vocabulary is frozen at five names and neither of the two checksum
        # events is true here, so the file gets neither. "A digest was computed
        # over the stored bytes and matches" would be a straight falsehood, and
        # the file's own `unverified` state already explains the gap.
        connector.on_metadata(metadata_message())
        connector.on_batch(complete_message(file=dict(self.HASHLESS)))
        fields = {entry["field"] for entry in api.journal}
        assert "file.checksum_verified" not in fields
        assert "file.checksum_failed" not in fields
        assert "file.detected" in fields

    def test_an_unknown_upload_id_is_never_a_correlation_handle_either(
        self, connector, api
    ):
        # `ingestion_job_id` is the handle an operator follows back to the
        # upload. A literal "unknown" looks real and leads nowhere.
        connector.on_batch(complete_message(upload_id="unknown"))
        assert api.bodies("/files")[0]["ingestion_job_id"] is None


class TestSuppressedSampleBatches:
    """R1/R3/R4: the decoder refused to write rows, and the file says why."""

    def test_the_reason_is_narrated_on_the_timeline(self, connector, api):
        connector.on_metadata(metadata_message())
        connector.on_batch(
            complete_message(
                signal_count=1,
                sample_count=0,
                samples_suppressed="no start time",
                inventory=[{"name": "RPM", "unit": "rpm"}],
            )
        )

        note = next(e for e in api.journal if e["field"] == "file.header_parsed")["note"]
        assert "no start time" in note

    def test_suppression_is_never_turned_into_a_quarantine(self, connector, api):
        # The registry stays honest either way: the file and its inventory are
        # real, only the lake rows are absent.
        connector.on_metadata(metadata_message())
        connector.on_batch(
            complete_message(
                sample_count=0,
                samples_suppressed="no start time",
                inventory=[{"name": "RPM"}],
            )
        )
        assert api.only_file()["status"] == "registered"
        assert api.bodies("/files")[0]["quarantine_reason"] is None

    def test_the_suppression_shows_on_the_status_page(self, connector):
        connector.on_batch(
            complete_message(sample_count=0, samples_suppressed="checksum mismatch")
        )
        assert (
            connector.status_snapshot()["last_completed"]["samples_suppressed"]
            == "checksum mismatch"
        )


class TestTheTerminalMarkerIsRequired:
    def test_batches_alone_register_nothing(self, connector, api):
        connector.on_batch(samples_message())
        connector.on_batch(samples_message(seq=1))
        assert api.paths() == []
        assert connector.status_snapshot()["files_in_flight"][0]["signals_seen"] == 1
