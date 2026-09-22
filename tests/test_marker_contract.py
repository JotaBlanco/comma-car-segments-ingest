"""The `file_complete` marker, read by the code that actually consumes it.

The marker is the ONLY message that registers a file in the Test Manager. Its
shape is not asserted field by field here — it is fed to tm-connector's real
readers, and then to the registry's real pydantic models, which are
`extra="forbid"`. A key invented in the decoder is a 422 that costs the whole
file's catalogue, and a 422 is indistinguishable on screen from a file nobody
uploaded, so it has to fail HERE instead.
"""

from __future__ import annotations

import pytest

from connector import bodies
from connector.identity import resolve_identity
from connector.inventory import FileInventory as ConnectorInventory
from inventory import FileInventory as DecoderInventory
from marker import build_marker


@pytest.fixture
def marker():
    """A marker for a three-channel file, built by the DECODER'S OWN builder.

    Not a hand-written copy of it: a hand-written marker proves the connector
    can read a shape nobody produces, which is the failure this whole file
    exists to catch.
    """
    inv = DecoderInventory()
    inv.observe_numeric("ACCMode", "", [1000, 1100, 1200], [1.0, 2.0, 3.0])
    inv.observe_text("Gear", "", 2, 1000, 1200)
    inv.declare("NeverSampled", "degC")
    start_ms, end_ms = inv.window
    return build_marker(
        metadata={
            "sha256": "a" * 64,
            "size_bytes": 4096,
            "blob_path": "mf4-uploads/drive.mf4",
        },
        filename="drive.mf4",
        upload_id="drive-7a9622106da0",
        declared={"run_id": "R-1", "work_order_id": "WO-2026-0851"},
        header_properties={"platform": "HYUNDAI_IONIQ"},
        inventory_rows=inv.rows(),
        time_start_ms=start_ms,
        time_end_ms=end_ms,
        unknown="unknown",
    )


def _bodies(marker):
    """The two request bodies tm-connector builds from one marker."""
    identity = resolve_identity(
        marker["declared"], marker["header_properties"], marker["file_name"], r"TAS-\d+"
    )
    entry = ConnectorInventory(upload_id=marker["upload_id"], file_name=marker["file_name"])
    file_body = bodies.file_body(
        identity, entry, marker["file"], marker["batch"], marker["file_name"]
    )
    return bodies.run_body(identity, "ingestion", "mf4_signals_v6"), file_body


def test_both_bodies_pass_the_registry_models(marker):
    """The real models, `extra="forbid"` and all. This is the whole point."""
    from api.models.files import FileRegisterRequest
    from api.models.runs import RunUpsertRequest

    run_body, file_body = _bodies(marker)

    RunUpsertRequest.model_validate(run_body)
    FileRegisterRequest.model_validate(file_body)


def test_the_file_registers_as_MF4(marker):
    _run, file_body = _bodies(marker)

    assert file_body["format"] == "MF4"


def test_every_channel_of_the_file_is_catalogued(marker):
    """Including the one that produced no sample. It exists in the file."""
    _run, file_body = _bodies(marker)

    assert {row["name"] for row in file_body["signals"]} == {
        "ACCMode",
        "Gear",
        "NeverSampled",
    }


def test_the_measured_statistics_survive_into_the_body(marker):
    """The decoder measures them; nothing between here and Mongo drops them."""
    _run, file_body = _bodies(marker)
    stats = next(r for r in file_body["signals"] if r["name"] == "ACCMode")["stats"]

    assert stats["min"] == 1.0
    assert stats["max"] == 3.0
    assert stats["mean"] == 2.0
    assert stats["sample_count"] == 3
    assert "rms" in stats


def test_a_text_channel_carries_no_statistics(marker):
    """min/max/mean over strings are not facts, and a partial block is refused."""
    _run, file_body = _bodies(marker)
    row = next(r for r in file_body["signals"] if r["name"] == "Gear")

    assert row["dtype"] == "str"
    assert "stats" not in row


def test_the_window_becomes_the_file_s_time_range(marker):
    _run, file_body = _bodies(marker)

    assert file_body["time_start"] is not None
    assert file_body["time_end"] is not None


def test_a_decode_failure_is_stated_by_the_producer(marker):
    """A file that never decoded still reaches the registry, saying why."""
    marker["batch"]["decode_error"] = "ValueError: not an MDF file"
    marker["batch"]["inventory"] = []
    _run, file_body = _bodies(marker)

    assert file_body["conversion_status"] == "failed"
    assert file_body["stage_error"] == "ValueError: not an MDF file"
    assert file_body["quarantine_reason"] == "ValueError: not an MDF file"


def test_a_successful_decode_states_no_stage_field(marker):
    """The registry DERIVES success from a non-empty inventory. Leave it to."""
    _run, file_body = _bodies(marker)

    assert "conversion_status" not in file_body
    assert "stage_error" not in file_body


def test_the_checksum_is_never_claimed_verified(marker):
    """The decoder takes no second digest, so nothing here may say two agree."""
    _run, file_body = _bodies(marker)

    assert file_body["checksum_state"] == "unverified"


def test_the_upload_is_followable_from_the_registered_file(marker):
    _run, file_body = _bodies(marker)

    assert file_body["ingestion_job_id"] == "drive-7a9622106da0"
    assert file_body["storage_ref"] == "mf4-uploads/drive.mf4"


def test_the_run_claims_the_lake_table_the_sink_writes(marker):
    run_body, _file = _bodies(marker)

    assert run_body["lake_table"] == "mf4_signals_v6"
    assert run_body["run_id"] == "R-1"
    assert run_body["work_order_id"] == "WO-2026-0851"


# --- what the sink does with the same message -------------------------------


def test_the_lake_sink_skips_the_marker(marker):
    """It carries an inventory and no `ts_ms`. Expanding it would raise."""
    from expand import is_sample_batch

    assert is_sample_batch(marker) is False


def test_the_marker_declares_the_run_the_decoder_resolved(marker):
    """Rung 1 of the connector's ladder reads this bag, so the two agree."""
    from connector.identity import resolve_identity as connector_resolve

    assert connector_resolve(marker["declared"], marker["header_properties"],
                             marker["file_name"], r"TAS-\d+").run_id == "R-1"
