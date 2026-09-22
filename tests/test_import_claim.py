"""What mf4-to-blob states about a file it never opens.

The `declared` bag is the first rung of the run-key ladder and the only identity
channel that exists before a byte is written. Two things have to hold:

* a malformed id is refused at the door, because each of these becomes a lake
  partition directory, a blob path segment or a registry id;
* a claim written into the FILENAME is read, so a generated recording needs no
  form filled in — and a claim a person typed always beats it.
"""

from __future__ import annotations

import pytest

import metadata


# --- the bag ----------------------------------------------------------------


def test_only_the_declared_prefix_is_collected():
    bag = metadata.collect_declared(
        {"declared.run_id": "R-1", "filename": "a.mf4", "size": "10"}
    )

    assert bag == {"run_id": "R-1"}


def test_a_bare_prefix_makes_no_key():
    """`declared.` alone could only produce an empty key."""
    assert metadata.collect_declared({"declared.": "x"}) == {}


def test_a_key_outside_the_validated_set_rides_through_untouched():
    """This app cannot know the registry's whole vocabulary; the connector drops
    what the registry does not know."""
    bag = metadata.collect_declared({"declared.operator": "t.neubauer"})

    assert bag == {"operator": "t.neubauer"}


@pytest.mark.parametrize("field", ["run_id", "work_order_id", "definition_id", "rig_id"])
@pytest.mark.parametrize("value", ["a/b", "../etc", "has space", "", "-leading"])
def test_a_path_unsafe_id_is_refused(field, value):
    """Each of these becomes `<field>=<value>/` in the lake's partition tree."""
    with pytest.raises(ValueError):
        metadata.collect_declared({f"declared.{field}": value})


def test_the_message_names_the_constraint_and_not_the_value():
    """An error page must not echo a caller's string back at them."""
    with pytest.raises(ValueError) as caught:
        metadata.collect_declared({"declared.run_id": "../../etc/passwd"})

    assert "passwd" not in str(caught.value)


def test_too_many_parameters_are_refused():
    many = {f"declared.k{i}": "v" for i in range(metadata.MAX_DECLARED_KEYS + 1)}

    with pytest.raises(ValueError):
        metadata.collect_declared(many)


def test_an_over_long_value_is_refused():
    with pytest.raises(ValueError):
        metadata.collect_declared(
            {"declared.note": "x" * (metadata.MAX_DECLARED_VALUE_LEN + 1)}
        )


# --- the claim in the filename ----------------------------------------------


def test_a_claim_in_the_filename_is_read():
    claim = metadata.claim_from_filename(
        "HYUNDAI_IONIQ_WO-2026-0851_TD-BAT-THERM_0000000e--053ec37492_20.mf4"
    )

    assert claim == {"work_order_id": "WO-2026-0851", "definition_id": "TD-BAT-THERM"}


def test_a_hyphenated_id_is_not_sliced_in_half():
    """`WO-2026` is a work order that exists nowhere, claimed silently."""
    claim = metadata.claim_from_filename("x_WO-2026-0851_y.mf4")

    assert claim["work_order_id"] == "WO-2026-0851"


def test_a_comma_route_carries_no_claim():
    """A route id is full of hyphens and must never read as one."""
    assert metadata.claim_from_filename("0000000e--053ec37492_20.mf4") == {}


def test_a_plain_recording_claims_nothing():
    assert metadata.claim_from_filename("drive.mf4") == {}


def test_no_run_id_is_ever_read_from_a_name():
    """It would outrank the file's own header, which measured the bytes."""
    claim = metadata.claim_from_filename("R-9999_WO-2026-0851.mf4")

    assert "run_id" not in claim


# --- what reaches the wire ---------------------------------------------------


def _payload(filename="drive.mf4", declared=None):
    return metadata.build_payload(
        upload_id="drive-7a96",
        filename=filename,
        blob_path="mf4-uploads/drive.mf4",
        size_bytes=4096,
        sha256_hex="a" * 64,
        content_type=None,
        blob_url=None,
        uploader_ip=None,
        declared=declared,
    )


def test_the_bag_is_always_an_object():
    """`{}` when nothing arrived — never absent, never null."""
    assert _payload()["declared"] == {}


def test_a_typed_claim_beats_the_filename():
    """A person who typed a pair meant it. The name is only ever the fallback."""
    payload = _payload(
        "x_WO-2026-0851_TD-BAT-THERM.mf4",
        declared={"work_order_id": "WO-2026-0839"},
    )

    assert payload["declared"]["work_order_id"] == "WO-2026-0839"
    assert payload["declared"]["definition_id"] == "TD-BAT-THERM"


def test_the_claim_rides_in_both_spellings():
    """The registry's field names for the connector, the lake's for the decoder.

    One fact, two spellings, written in one place so the two cannot drift.
    """
    payload = _payload("x_WO-2026-0851_TD-BAT-THERM.mf4")

    assert payload["declared"]["work_order_id"] == "WO-2026-0851"
    assert payload["work_order"] == "WO-2026-0851"
    assert payload["declared"]["definition_id"] == "TD-BAT-THERM"
    assert payload["test_definition"] == "TD-BAT-THERM"


def test_no_run_id_key_is_invented():
    """Nothing here can resolve one, and a null would read as a stated null."""
    assert "run_id" not in _payload()


def test_the_declared_bag_survives_the_connector_s_filter():
    """A key the registry does not know is a 422, so the connector drops it.

    What this checks is that the keys mf4-to-blob DOES set are not among the
    dropped ones — a claim that never reaches the registry is worse than no
    claim at all, because the upload page says it was made.
    """
    from connector.identity import clean_declared

    payload = _payload("x_WO-2026-0851_TD-BAT-THERM.mf4", declared={"rig_id": "RIG-04"})
    kept = clean_declared(payload["declared"])

    assert kept == {
        "work_order_id": "WO-2026-0851",
        "definition_id": "TD-BAT-THERM",
        "rig_id": "RIG-04",
    }
