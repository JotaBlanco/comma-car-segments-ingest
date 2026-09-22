"""The decoder's channel catalogue: it measures, and it never keeps a sample."""

from __future__ import annotations

import math
import sys

import pytest

from inventory import NUMERIC_DTYPE, TEXT_DTYPE, UNKNOWN_RATE_HZ, FileInventory


def test_a_numeric_channel_is_measured_over_its_whole_array():
    inv = FileInventory()
    inv.observe_numeric("ACCMode", "V", [0, 1000, 2000, 3000], [0.0, 1.0, 2.0, 3.0])

    row = inv.rows()[0]
    assert row["dtype"] == NUMERIC_DTYPE
    assert row["unit"] == "V"
    assert row["stats"]["min"] == 0.0
    assert row["stats"]["max"] == 3.0
    assert row["stats"]["mean"] == 1.5
    assert row["stats"]["sample_count"] == 4
    assert row["stats"]["rms"] == pytest.approx(math.sqrt((0 + 1 + 4 + 9) / 4))


def test_the_rate_is_samples_per_second_over_the_observed_window():
    inv = FileInventory()
    inv.observe_numeric("s", "", [0, 100, 200, 300], [1.0, 1.0, 1.0, 1.0])

    assert inv.rows()[0]["rate_hz"] == pytest.approx(10.0)


@pytest.mark.parametrize(
    "ts,values",
    [([1000], [5.0]), ([1000, 1000], [5.0, 6.0])],
    ids=["one sample", "a zero-width window"],
)
def test_an_underivable_rate_is_zero_not_a_guess(ts, values):
    """0.0 is the parsers' convention for "unknown", not a claim of zero hertz."""
    inv = FileInventory()
    inv.observe_numeric("s", "", ts, values)

    assert inv.rows()[0]["rate_hz"] == UNKNOWN_RATE_HZ


def test_a_single_sample_channel_still_reports_statistics():
    """Population sigma, so one sample answers 0.0 rather than NaN."""
    inv = FileInventory()
    inv.observe_numeric("s", "", [1000], [5.0])

    stats = inv.rows()[0]["stats"]
    assert stats["std"] == 0.0
    assert stats["mean"] == 5.0


def test_no_statistic_is_ever_a_non_number():
    """NaN survives json.dumps as `NaN`, which is not JSON and fails the body."""
    inv = FileInventory()
    inv.observe_numeric("s", "", [0, 1000], [float("inf"), 1.0])

    assert "stats" not in inv.rows()[0]


def test_a_text_channel_gets_a_row_and_no_statistics():
    inv = FileInventory()
    inv.observe_text("Gear", "", 3, 1000, 3000)

    row = inv.rows()[0]
    assert row["dtype"] == TEXT_DTYPE
    assert row["rate_hz"] == pytest.approx(1.0)
    assert "stats" not in row


def test_a_channel_that_produced_nothing_is_still_in_the_catalogue():
    """It exists in the file, and the catalogue says so."""
    inv = FileInventory()
    inv.declare("NeverSampled", "degC")

    assert inv.rows() == [
        {"name": "NeverSampled", "unit": "degC", "dtype": NUMERIC_DTYPE, "rate_hz": 0.0}
    ]


def test_the_window_is_the_union_across_channels():
    inv = FileInventory()
    inv.observe_numeric("a", "", [2000, 3000], [1.0, 2.0])
    inv.observe_numeric("b", "", [1000, 5000], [1.0, 2.0])

    assert inv.window == (1000, 5000)


def test_a_file_with_no_sampled_channel_states_no_window():
    """A null window stays null rather than becoming a 1970 range."""
    inv = FileInventory()
    inv.declare("a", "")

    assert inv.window == (None, None)


def test_the_rows_are_name_sorted_so_the_marker_is_stable():
    inv = FileInventory()
    for name in ("zeta", "alpha", "mid"):
        inv.declare(name, "")

    assert [row["name"] for row in inv.rows()] == ["alpha", "mid", "zeta"]


def test_an_empty_unit_becomes_null_rather_than_an_empty_string():
    inv = FileInventory()
    inv.declare("s", "")

    assert inv.rows()[0]["unit"] is None


def test_no_sample_array_is_retained():
    """Memory scales with DISTINCT CHANNELS, never with sample count.

    One recording is hundreds of channels and hundreds of thousands of samples.
    The catalogue is measured from the array and must not hold a reference to
    it — this compares the array's refcount before and after.
    """
    inv = FileInventory()
    values = [float(i) for i in range(1000)]
    timestamps = list(range(1000))
    before = sys.getrefcount(values)

    inv.observe_numeric("s", "", timestamps, values)

    assert sys.getrefcount(values) == before
    assert inv.signal_count == 1
