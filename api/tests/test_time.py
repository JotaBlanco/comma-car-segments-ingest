"""A-01 guard test 3 — timestamp precision survives the Mongo round trip.

The demo reset asserts a byte-identical restore. Mongo stores milliseconds and
Python holds microseconds, so a µs value read back is not the value written.
This test states that difference in one place. It runs again before the reset
self-verify (A-14, A-15), so a precision mismatch never reads as a reset bug.

The first and third tests are characterization of pymongo, not of this
codebase — no repo change can turn them red. The guard label belongs to the
helper-level test in the middle, which goes through `provenance.set_field`.
"""

from datetime import UTC, datetime

from api.models.common import Source
from api.provenance import set_field


def test_utc_microsecond_roundtrip(db) -> None:
    """A timestamp written with microseconds reads back at Mongo's precision."""
    written = datetime(2026, 8, 14, 9, 41, 33, 123456, tzinfo=UTC)
    db["probe"].insert_one({"_id": "t", "at": written})

    read = db["probe"].find_one({"_id": "t"})["at"]

    assert read.tzinfo is not None, "the client is tz-aware, so the value keeps its zone"
    assert read.year == written.year and read.second == written.second
    # Mongo keeps milliseconds. 123456 µs lands as 123000 µs.
    assert read.microsecond == 123000
    assert abs((read - written).total_seconds()) < 0.001


def test_a_helper_timestamp_survives_the_round_trip(db) -> None:
    """The value the helper stamps compares equal after a write and a read."""
    entry = set_field({"_id": "TAS-88214"}, "operator", "A. Bergström", Source.MANUAL, "a.b")

    db["journal_entries"].insert_one(entry)
    read = db["journal_entries"].find_one({"_id": entry["_id"]})

    stamped = entry["at"]
    assert read["at"].replace(microsecond=0) == stamped.replace(microsecond=0)
    assert read["at"].microsecond == stamped.microsecond // 1000 * 1000


def test_the_reset_comparison_uses_the_stored_precision(db) -> None:
    """Two values equal in Mongo stay equal after a read — the reset's premise."""
    at = datetime(2026, 8, 14, 11, 32, 4, 987654, tzinfo=UTC)
    db["probe"].insert_many([{"_id": "a", "at": at}, {"_id": "b", "at": at}])

    first = db["probe"].find_one({"_id": "a"})["at"]
    second = db["probe"].find_one({"_id": "b"})["at"]

    assert first == second
