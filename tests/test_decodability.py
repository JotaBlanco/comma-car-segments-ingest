"""A decode that resolved no database must not read as a file holding nothing.

On 2026-09-25 four traces were decoded with the `Porsche_Taycan` DBC missing
from DCM: 180,000 CAN frames each dropped, zero samples, every file marked
decoded and registered clean. `decode_failure` is the one predicate that tells
that apart from an ordinary MF4 with no CAN frames in it.
"""

from __future__ import annotations

from decodability import DECODING_OFF, decode_failure


def test_a_file_with_no_can_frames_is_not_a_failure():
    """An ordinary MF4. It asks for no database, so none is missing."""
    assert decode_failure(
        bus_frames=0, decoded_signals=0, dbc_reason=None, platform="Porsche_Taycan"
    ) is None


def test_an_empty_bus_logging_group_is_not_a_failure():
    """The group exists and carries no frame. Zero samples is the honest answer."""
    assert decode_failure(
        bus_frames=0,
        decoded_signals=0,
        dbc_reason="no CAN database resolved for platform Porsche_Taycan",
        platform="Porsche_Taycan",
    ) is None


def test_frames_in_signals_out_is_not_a_failure():
    assert decode_failure(
        bus_frames=180_000,
        decoded_signals=249,
        dbc_reason=None,
        platform="Porsche_Taycan",
    ) is None


def test_decoding_switched_off_is_a_configuration_not_a_failure():
    """DBC_SOURCE=none is a deployment stating "do not decode CAN"."""
    assert decode_failure(
        bus_frames=180_000,
        decoded_signals=0,
        dbc_reason=DECODING_OFF,
        platform="Porsche_Taycan",
    ) is None


def test_a_missing_database_is_a_failure_that_names_its_cause():
    """The 25 Sep incident, as the operator has to read it off a table cell."""
    assert decode_failure(
        bus_frames=180_000,
        decoded_signals=0,
        dbc_reason="no CAN database resolved for platform Porsche_Taycan",
        platform="Porsche_Taycan",
    ) == (
        "no CAN database resolved for platform Porsche_Taycan - "
        "180000 CAN frame(s) could not be decoded"
    )


def test_a_database_that_decoded_nothing_is_a_failure_too():
    """A database resolved and matched no frame: the wrong DBC for this bus."""
    assert decode_failure(
        bus_frames=180_000, decoded_signals=0, dbc_reason=None, platform="Taycan"
    ) == "the CAN database for platform Taycan decoded 0 of 180000 frame(s)"


def test_every_reason_fits_a_table_cell():
    """`quarantine_reason` renders untruncated in a column (spec R5)."""
    reasons = [
        decode_failure(
            bus_frames=180_000,
            decoded_signals=0,
            dbc_reason=reason,
            platform="Porsche_Taycan",
        )
        for reason in (
            None,
            "no CAN database resolved for platform Porsche_Taycan",
            "the DCM document for Porsche_Taycan is not a loadable database",
            "extract_bus_logging failed with the Porsche_Taycan database",
            "the file carries no embedded .dbc attachment",
            "no embedded CAN database could be extracted",
            "extract_bus_logging failed with the embedded database(s)",
        )
    ]

    assert all(len(reason) <= 120 for reason in reasons)
