"""The per-file signal inventory.

**This module never retains a sample array.** One real capture is 261 signals
and ~602,000 samples; the registry wants the 261 names, and QuixLake answers
the numbers ("the registry names the signals; QuixLake answers the numbers" —
ingestion/watcher.py:190-195).

So a batch is READ and DISCARDED: the length, the first and the last timestamp
become integers on a per-signal tally, and no reference to the incoming list
survives the call. Memory per in-flight file scales with DISTINCT SIGNALS, never
with sample count.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime

# The numeric-sample convention the parsers use
# (api/api/models/files.py:126-129).
NUMERIC_DTYPE = "float64"
TEXT_DTYPE = "str"

# The rate a channel with no samples carries. 0.0 is the parsers' convention for
# "underivable", not a claim that the channel ticks at zero hertz.
UNKNOWN_RATE_HZ = 0.0


def _declared_row(name: str, row: dict) -> dict:
    """One `FileSignalInput` row for a channel that reached no batch.

    Exactly the four declared keys of the model and nothing else — `stats` and
    any other key the decoder happened to attach are dropped, because
    `RequestModel` is `extra="forbid"` and an unknown field is a 422.
    """
    unit = row.get("unit")
    dtype = row.get("dtype")
    rate_hz = row.get("rate_hz")
    stated_rate = isinstance(rate_hz, (int, float)) and not isinstance(rate_hz, bool)
    return {
        "name": name,
        "unit": unit if isinstance(unit, str) and unit else None,
        "rate_hz": float(rate_hz) if stated_rate else UNKNOWN_RATE_HZ,
        "dtype": dtype if isinstance(dtype, str) and dtype else NUMERIC_DTYPE,
    }


def _first_not_none(values: object):
    """The first non-null element, without keeping the sequence."""
    if not isinstance(values, (list, tuple)):
        return None
    for item in values:
        if item is not None:
            return item
    return None


# The four numbers `SignalStatsInput` shows. `sample_count` rides beside them
# since the contract edit of 21 Aug 2026 (`sample_count: int | None`): it
# weighs `queries_stats._merge_stats`, which refuses a multi-file run without a
# count per file and falls to the lake instead. It stays an int, never a float.
_STAT_KEYS = ("min", "max", "mean", "std")


def _stats_block(stats: object) -> dict | None:
    """One `SignalStatsInput` body, or None when there is nothing honest to send.

    All four keys or none: a partial block is worse than no block, because the
    reader treats a present `stats` as measured and would show three real
    numbers beside one that never existed.
    """
    if not isinstance(stats, dict):
        return None

    block = {}
    for key in _STAT_KEYS:
        value = stats.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        block[key] = float(value)

    count = stats.get("sample_count")
    if isinstance(count, int) and not isinstance(count, bool) and count > 0:
        block["sample_count"] = count

    # `rms` rides like `sample_count`: forwarded when measured, absent when
    # not, and NEVER in `_STAT_KEYS` — that tuple is the all-four-or-none
    # gate, and an optional key inside it would drop a whole legal block.
    rms = stats.get("rms")
    if not isinstance(rms, bool) and isinstance(rms, (int, float)):
        block["rms"] = float(rms)
    return block


@dataclass
class SignalTally:
    """What one signal costs us: five scalars and two short strings."""

    name: str
    unit: str | None = None
    dtype: str = NUMERIC_DTYPE
    count: int = 0
    first_ts_ms: int | None = None
    last_ts_ms: int | None = None

    @property
    def rate_hz(self) -> float:
        """Samples per second across the observed window.

        0.0 when underivable — one sample, or a zero-width window. That is the
        parsers' convention for "unknown", not a claim of zero rate.
        """
        if self.count < 2 or self.first_ts_ms is None or self.last_ts_ms is None:
            return 0.0
        span_ms = self.last_ts_ms - self.first_ts_ms
        if span_ms <= 0:
            return 0.0
        return (self.count - 1) / (span_ms / 1000.0)

    def to_row(self) -> dict:
        """One `FileSignalInput` row (api/api/models/files.py:71-78).

        `stats` is omitted on purpose — the registry names the signals.
        """
        return {
            "name": self.name,
            "unit": self.unit,
            "rate_hz": self.rate_hz,
            "dtype": self.dtype,
        }


@dataclass
class FileInventory:
    """One in-flight file: its identity handles and its signal tallies."""

    upload_id: str
    run_id: str | None = None
    file_name: str = ""
    # The moment mf4-import stored the bytes. Absent when the batches arrived
    # before (or without) their metadata message — an ordinary out-of-order case.
    uploaded_at: str | None = None
    metadata_seen: bool = False
    first_seen_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    last_activity_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    batches_seen: int = 0
    signals: dict[str, SignalTally] = field(default_factory=dict)
    # Every channel the decoder found in the FILE, name -> its reported row.
    # None until the terminal marker states one; `{}` is the honest answer for a
    # file that holds no decodable channel at all.
    declared: dict[str, dict] | None = None

    def touch(self, now: datetime) -> None:
        self.last_activity_at = now

    def declare_signals(self, rows: object) -> None:
        """Take the decoder's channel inventory from the terminal marker.

        Every channel in the file earns a row, including the ones that reached
        no batch — text, an array, an all-NaN sensor: "It exists in the file,
        and the catalogue says so" (ingestion/mf4.py:196-203). Inferring the
        list from observed batches instead makes such a channel invisible to the
        registry, which is the one place an engineer looks it up.

        Each row costs two short strings and a float, so this scales with
        DISTINCT CHANNELS exactly as the tallies do.
        """
        if not isinstance(rows, list):
            return
        declared: dict[str, dict] = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            name = row.get("name")
            if not isinstance(name, str) or not name.strip():
                # `name` is required on FileSignalInput, so a blank one is a 422
                # for the whole body — one bad row would cost every other row.
                continue
            declared[name.strip()] = row
        self.declared = declared

    def observe_batch(self, value: dict, now: datetime) -> None:
        """Fold one `kind:"samples"` message into the tallies.

        Reads `ts_ms` by length and by its two ends, then lets it go. Nothing
        from `value`, `value_text` or `ts_ms` is stored.
        """
        self.batches_seen += 1
        self.touch(now)

        name = value.get("signal")
        if not isinstance(name, str) or not name:
            # `signal` is a virtual partition key and the decoder guarantees a
            # non-empty string; a message without one is not a sample batch.
            return

        tally = self.signals.get(name)
        if tally is None:
            tally = SignalTally(name=name)
            self.signals[name] = tally

        unit = value.get("unit")
        if isinstance(unit, str) and unit and tally.unit is None:
            tally.unit = unit

        # The split is decided once per signal from the numpy dtype upstream, so
        # one non-null text sample settles the dtype for the whole signal.
        if _first_not_none(value.get("value_text")) is not None:
            tally.dtype = TEXT_DTYPE

        timestamps = value.get("ts_ms")
        if not isinstance(timestamps, (list, tuple)) or not timestamps:
            return
        tally.count += len(timestamps)
        first, last = timestamps[0], timestamps[-1]
        if isinstance(first, int) and (tally.first_ts_ms is None or first < tally.first_ts_ms):
            tally.first_ts_ms = first
        if isinstance(last, int) and (tally.last_ts_ms is None or last > tally.last_ts_ms):
            tally.last_ts_ms = last
        # `timestamps` goes out of scope here. Nothing above kept it.

    def signal_rows(self) -> list[dict]:
        """The `signals[]` array `POST /files` takes, name-sorted for a stable body.

        The decoder's list names the channels; a channel we also saw on the wire
        takes its MEASURED row, because a rate observed over real timestamps
        beats one the decoder guessed. A channel we saw that the decoder never
        listed is posted too — never lose a signal.

        Statistics ride in last, from the marker, because a tally row would
        otherwise overwrite them: this connector measures timestamps, never
        values, so `to_row()` has no numbers to carry. Whoever measured them
        (today mf4-stats, when it is deployed) put them on the inventory row and
        this merges them onto whichever row won above.
        """
        declared = self.declared or {}
        rows = {name: _declared_row(name, row) for name, row in declared.items()}
        rows.update({name: tally.to_row() for name, tally in self.signals.items()})

        for name, row in rows.items():
            block = _stats_block(declared.get(name, {}).get("stats"))
            if block is not None:
                row["stats"] = block

        return [rows[name] for name in sorted(rows)]

    @property
    def sample_count(self) -> int:
        return sum(tally.count for tally in self.signals.values())
