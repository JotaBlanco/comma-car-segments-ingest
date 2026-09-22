"""The inventory keeps NAMES and running scalars. It never keeps a sample array."""

import math
from datetime import UTC, datetime

import pytest

from connector.inventory import FileInventory
from tests.conftest import samples_message

NOW = datetime(2026, 8, 20, 10, 45, tzinfo=UTC)


def _inventory() -> FileInventory:
    return FileInventory(upload_id="u-1", first_seen_at=NOW, last_activity_at=NOW)


def _walk(node, seen=None):
    """Every object reachable from the accumulator's state."""
    seen = seen if seen is not None else set()
    if id(node) in seen:
        return
    seen.add(id(node))
    yield node
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _walk(key, seen)
            yield from _walk(value, seen)
    elif isinstance(node, (list, tuple, set)):
        for item in node:
            yield from _walk(item, seen)
    elif hasattr(node, "__dict__"):
        yield from _walk(vars(node), seen)


class TestNoSampleArrays:
    def test_no_incoming_array_object_survives_the_call(self):
        inventory = _inventory()
        message = samples_message(n=5000)
        arrays = {id(message["ts_ms"]), id(message["value"]), id(message["value_text"])}

        inventory.observe_batch(message, NOW)

        assert not arrays & {id(node) for node in _walk(inventory)}

    def test_clearing_the_incoming_arrays_changes_nothing(self):
        inventory = _inventory()
        message = samples_message(n=100)
        inventory.observe_batch(message, NOW)
        before = inventory.signal_rows()

        message["ts_ms"].clear()
        message["value"].clear()
        message["value_text"].clear()

        assert inventory.signal_rows() == before
        assert inventory.sample_count == 100

    def test_state_holds_no_long_sequence(self):
        inventory = _inventory()
        inventory.observe_batch(samples_message(n=5000), NOW)

        long_sequences = [
            node
            for node in _walk(inventory)
            if isinstance(node, (list, tuple)) and len(node) > 8
        ]
        assert long_sequences == []

    def test_memory_scales_with_signals_not_samples(self):
        def containers(inventory):
            return [
                node for node in _walk(inventory) if isinstance(node, (list, tuple, dict, set))
            ]

        small = _inventory()
        small.observe_batch(samples_message(signal="A", n=2), NOW)
        huge = _inventory()
        huge.observe_batch(samples_message(signal="A", n=500_000), NOW)

        assert len(small.signals) == len(huge.signals) == 1
        # A quarter of a million more samples buys exactly zero extra containers.
        assert len(containers(small)) == len(containers(huge))
        assert sum(len(node) for node in containers(small)) == sum(
            len(node) for node in containers(huge)
        )

    def test_two_hundred_sixty_one_signals_cost_two_hundred_sixty_one_tallies(self):
        inventory = _inventory()
        for index in range(261):
            inventory.observe_batch(samples_message(signal=f"SIG_{index}", n=2308), NOW)

        assert len(inventory.signals) == 261
        assert inventory.sample_count == 261 * 2308  # ~602,000 samples, 261 tallies


class TestTallies:
    def test_the_rate_comes_from_the_observed_window(self):
        inventory = _inventory()
        # 21 samples, 20 gaps of 50 ms = 1.0 s -> 20 Hz.
        inventory.observe_batch(samples_message(n=21, step_ms=50), NOW)

        row = inventory.signal_rows()[0]
        assert row["rate_hz"] == 20.0
        assert row["dtype"] == "float64"
        assert row["unit"] == "rpm"

    def test_one_sample_is_an_unknown_rate_not_a_zero_rate(self):
        inventory = _inventory()
        inventory.observe_batch(samples_message(n=1), NOW)
        assert inventory.signal_rows()[0]["rate_hz"] == 0.0

    def test_a_text_signal_takes_the_text_dtype(self):
        inventory = _inventory()
        inventory.observe_batch(samples_message(signal="GEAR", text=True, n=3), NOW)
        assert inventory.signal_rows()[0]["dtype"] == "str"

    def test_batches_of_one_signal_accumulate_into_one_row(self):
        inventory = _inventory()
        for seq in range(3):
            inventory.observe_batch(
                samples_message(seq=seq, n=10, start_ms=1000 + seq * 500), NOW
            )
        rows = inventory.signal_rows()
        assert len(rows) == 1
        assert inventory.sample_count == 30
        assert inventory.batches_seen == 3

    def test_rows_are_name_sorted_so_the_body_is_stable(self):
        inventory = _inventory()
        for name in ("ZZZ", "AAA", "MMM"):
            inventory.observe_batch(samples_message(signal=name), NOW)
        assert [row["name"] for row in inventory.signal_rows()] == ["AAA", "MMM", "ZZZ"]

    def test_no_stats_block_is_ever_built(self):
        # The registry names the signals; QuixLake answers the numbers.
        inventory = _inventory()
        inventory.observe_batch(samples_message(), NOW)
        assert set(inventory.signal_rows()[0]) == {"name", "unit", "rate_hz", "dtype"}


class TestTheDecoderNamesTheChannels:
    """R6: a channel that emits nothing still earns an inventory row.

    "A channel that cannot reach the lake — text, an array, an empty one —
    still earns an inventory row. It exists in the file, and the catalogue says
    so." (ingestion/mf4.py:196-203). Building `signals[]` from observed batches
    alone makes such a channel invisible in the catalogue.
    """

    def test_a_channel_that_emitted_nothing_still_earns_a_row(self):
        inventory = _inventory()
        inventory.observe_batch(samples_message(signal="RPM"), NOW)
        inventory.declare_signals(
            [
                {"name": "BROKEN_SENSOR", "unit": "degC", "dtype": "float64"},
                {"name": "RPM", "unit": "rpm", "dtype": "float64"},
            ]
        )
        assert [row["name"] for row in inventory.signal_rows()] == ["BROKEN_SENSOR", "RPM"]

    def test_the_silent_channel_carries_the_unknown_rate_convention(self):
        inventory = _inventory()
        inventory.declare_signals([{"name": "BROKEN_SENSOR", "unit": "degC"}])
        assert inventory.signal_rows() == [
            {"name": "BROKEN_SENSOR", "unit": "degC", "rate_hz": 0.0, "dtype": "float64"}
        ]

    def test_the_observed_rate_wins_over_the_declared_row(self):
        # 21 samples, 20 gaps of 50 ms -> 20 Hz, measured on the wire.
        inventory = _inventory()
        inventory.observe_batch(samples_message(signal="RPM", n=21, step_ms=50), NOW)
        inventory.declare_signals([{"name": "RPM", "unit": "rpm", "rate_hz": 1.0}])
        assert inventory.signal_rows()[0]["rate_hz"] == 20.0

    def test_a_text_channel_keeps_its_declared_dtype(self):
        inventory = _inventory()
        inventory.declare_signals([{"name": "GEAR", "dtype": "str"}])
        assert inventory.signal_rows()[0]["dtype"] == "str"

    def test_a_signal_seen_on_the_wire_is_never_lost_to_the_declared_list(self):
        inventory = _inventory()
        inventory.observe_batch(samples_message(signal="RPM"), NOW)
        inventory.declare_signals([{"name": "BROKEN_SENSOR"}])
        assert [row["name"] for row in inventory.signal_rows()] == ["BROKEN_SENSOR", "RPM"]

    def test_an_empty_declared_inventory_is_an_honest_empty_inventory(self):
        # R5: a file we cannot decode registers with an honest empty inventory.
        inventory = _inventory()
        inventory.declare_signals([])
        assert inventory.signal_rows() == []

    def test_a_nameless_declared_row_is_dropped_not_posted(self):
        # `name` is required on FileSignalInput; a blank one would be a 422.
        inventory = _inventory()
        inventory.declare_signals([{"unit": "degC"}, {"name": "   "}, "not a row"])
        assert inventory.signal_rows() == []

    def test_a_repeated_declared_name_stores_one_row(self):
        inventory = _inventory()
        inventory.declare_signals([{"name": "RPM"}, {"name": "RPM", "unit": "rpm"}])
        assert len(inventory.signal_rows()) == 1

    def test_no_stats_block_survives_a_declared_row(self):
        inventory = _inventory()
        inventory.declare_signals([{"name": "BROKEN_SENSOR", "unit": "degC", "stats": {}}])
        assert set(inventory.signal_rows()[0]) == {"name", "unit", "rate_hz", "dtype"}


class TestStatisticsRideInFromTheMarker:
    """This connector measures timestamps, never values. Whoever did measure
    them puts a block on the marker's inventory row, and it reaches the body.
    """

    def _marker_row(self, name="ENGINE_RPM", **stats):
        block = {"min": 1.0, "max": 6.0, "mean": 3.0, "std": 2.6457513110645907}
        block.update(stats)
        return {"name": name, "unit": "rpm", "dtype": "float64", "rate_hz": 10.0,
                "stats": block}

    def test_a_declared_block_reaches_the_posted_row(self):
        inventory = _inventory()
        inventory.declare_signals([self._marker_row()])

        stats = inventory.signal_rows()[0]["stats"]

        assert stats == {"min": 1.0, "max": 6.0, "mean": 3.0,
                         "std": 2.6457513110645907}

    def test_it_survives_a_signal_we_also_saw_on_the_wire(self):
        """The case that made this non-trivial: `signal_rows` OVERWRITES the
        declared row with the tally's, and the tally has no numbers to carry."""
        inventory = _inventory()
        inventory.observe_batch(samples_message(signal="ENGINE_RPM"), NOW)
        inventory.declare_signals([self._marker_row("ENGINE_RPM")])

        row = inventory.signal_rows()[0]

        assert row["stats"]["mean"] == 3.0
        # and the measured rate still wins over the declared one
        assert row["rate_hz"] != 10.0

    def test_sample_count_is_forwarded_as_an_int(self):
        """`SignalStatsInput` takes `sample_count` since 21 Aug 2026. It weighs
        the multi-file merge, so the connector states it, and as an int."""
        inventory = _inventory()
        inventory.declare_signals([self._marker_row(sample_count=602137)])

        stats = inventory.signal_rows()[0]["stats"]
        assert set(stats) == {"min", "max", "mean", "std", "sample_count"}
        assert stats["sample_count"] == 602137
        assert type(stats["sample_count"]) is int

    def test_a_count_that_is_not_a_count_is_left_out(self):
        """Zero, negative, bool and float counts are not counts. The four
        numbers still go; the merge falls to the lake for that file."""
        for bad in (0, -3, True, 2.5):
            inventory = _inventory()
            inventory.declare_signals([self._marker_row(sample_count=bad)])

            assert set(inventory.signal_rows()[0]["stats"]) == {"min", "max", "mean", "std"}

    def test_a_signal_with_no_block_carries_no_stats_key(self):
        inventory = _inventory()
        inventory.declare_signals([{"name": "SILENT", "unit": None, "rate_hz": 0.0}])

        assert "stats" not in inventory.signal_rows()[0]

    def test_a_partial_block_is_refused_whole(self):
        """Three real numbers beside one that never existed reads as measured.
        All four or none."""
        inventory = _inventory()
        inventory.declare_signals([
            {"name": "RPM", "stats": {"min": 1.0, "max": 6.0, "mean": 3.0}}
        ])

        assert "stats" not in inventory.signal_rows()[0]

    def test_a_non_numeric_statistic_is_refused(self):
        inventory = _inventory()
        inventory.declare_signals([
            {"name": "RPM", "stats": {"min": 1.0, "max": "six", "mean": 3.0, "std": 1.0}}
        ])

        assert "stats" not in inventory.signal_rows()[0]

    def test_a_bool_is_not_a_statistic(self):
        inventory = _inventory()
        inventory.declare_signals([
            {"name": "RPM", "stats": {"min": True, "max": 6.0, "mean": 3.0, "std": 1.0}}
        ])

        assert "stats" not in inventory.signal_rows()[0]

    def test_ints_are_normalised_to_floats(self):
        """Mongo would otherwise store one signal's min as an int and another's
        as a float, and `SignalStats` types them float."""
        inventory = _inventory()
        inventory.declare_signals([
            {"name": "RPM", "stats": {"min": 1, "max": 6, "mean": 3, "std": 2}}
        ])

        assert all(isinstance(v, float) for v in inventory.signal_rows()[0]["stats"].values())


@pytest.mark.skip(
    reason=(
        "PARKED, not abandoned: the FALLBACK statistics lane, written red and "
        "left red on purpose. API-CONTRACT.md v1.1 (AGREED 2026-08-17) makes "
        "QuixLake the DEFAULT stats provider and the Mongo merge an explicit "
        "opt-out, and says in terms: 'Never claim that the demo precomputes the "
        "statistics.' So this producer is legal as the named fallback and wrong "
        "as the primary path. It is also gated on a wire change nobody has "
        "signed off: SignalStatsInput holds only min/max/mean/std with "
        "extra='forbid', so posting sample_count is a 422 - and without a count "
        "_merge_stats refuses a multi-file run and answers None anyway. "
        "Un-skip together with that contract edit, not before."
    )
)
class TestTheTallyMeasuresTheValues:
    """The four columns the Signals tab shows, measured as the batches pass.

    `queries_stats._merge_stats` combines one signal's per-file blocks into a
    per-run answer, and `_sample_count` says a producer that states its count
    makes that merge exact. This is that producer. Every expected number below
    is computed from the definition, never read back from the implementation.
    """

    def test_a_numeric_signal_carries_the_four_statistics_and_its_count(self):
        inventory = _inventory()
        inventory.observe_batch(samples_message(n=3, value=[1.0, 2.0, 6.0]), NOW)

        stats = inventory.signal_rows()[0]["stats"]

        # mean = 9/3 = 3. Sample variance = ((1-3)^2+(2-3)^2+(6-3)^2)/(3-1)
        #                                 = (4+1+9)/2 = 7, so std = sqrt(7).
        assert stats["min"] == 1.0
        assert stats["max"] == 6.0
        assert stats["mean"] == pytest.approx(3.0)
        assert stats["std"] == pytest.approx(math.sqrt(7))
        assert stats["sample_count"] == 3

    def test_the_statistics_accumulate_across_batches(self):
        inventory = _inventory()
        inventory.observe_batch(samples_message(n=2, value=[1.0, 2.0]), NOW)
        inventory.observe_batch(samples_message(n=2, seq=1, value=[3.0, 10.0]), NOW)

        stats = inventory.signal_rows()[0]["stats"]

        # Over [1, 2, 3, 10]: mean = 16/4 = 4. Sample variance =
        # ((1-4)^2+(2-4)^2+(3-4)^2+(10-4)^2)/3 = (9+4+1+36)/3 = 50/3.
        assert stats["min"] == 1.0
        assert stats["max"] == 10.0
        assert stats["mean"] == pytest.approx(4.0)
        assert stats["std"] == pytest.approx(math.sqrt(50 / 3))
        assert stats["sample_count"] == 4

    def test_one_sample_has_no_spread_rather_than_an_undefined_one(self):
        """Sample std needs two points. 0.0 is the honest answer for one.

        It is also the arithmetically harmless one: `_merge_stats` weights a
        block's variance by `(count - 1) * std**2`, which is zero either way.
        """
        inventory = _inventory()
        inventory.observe_batch(samples_message(n=1, value=[42.0]), NOW)

        stats = inventory.signal_rows()[0]["stats"]

        assert stats["min"] == stats["max"] == 42.0
        assert stats["mean"] == pytest.approx(42.0)
        assert stats["std"] == 0.0
        assert stats["sample_count"] == 1

    def test_a_non_finite_sample_is_measured_by_nobody(self):
        """A NaN in one sample must not poison the rest.

        MF4 carries NaN for a channel's unset samples, and min/max/mean all
        propagate it silently - the column would read NaN and look like a
        parser bug rather than an absent value.
        """
        inventory = _inventory()
        inventory.observe_batch(
            samples_message(n=4, value=[1.0, float("nan"), 3.0, float("inf")]), NOW
        )

        stats = inventory.signal_rows()[0]["stats"]

        assert stats["min"] == 1.0
        assert stats["max"] == 3.0
        assert stats["mean"] == pytest.approx(2.0)
        assert stats["sample_count"] == 2

    def test_a_text_signal_carries_no_statistics(self):
        """`min` of a string is not a number the column can show."""
        inventory = _inventory()
        inventory.observe_batch(samples_message(text=True), NOW)

        row = inventory.signal_rows()[0]

        assert row["dtype"] == "text"
        assert row["stats"] is None

    def test_a_channel_that_emitted_nothing_carries_no_statistics(self):
        """Nothing was measured, so there is nothing to state."""
        inventory = _inventory()
        inventory.declare_signals([{"name": "SILENT", "unit": "degC"}])

        assert inventory.signal_rows()[0]["stats"] is None

    def test_the_block_carries_exactly_what_the_api_accepts(self):
        """`SignalStatsInput` forbids an unknown key, so an extra one is a 422."""
        inventory = _inventory()
        inventory.observe_batch(samples_message(), NOW)

        assert set(inventory.signal_rows()[0]["stats"]) == {
            "min",
            "max",
            "mean",
            "std",
            "sample_count",
        }
