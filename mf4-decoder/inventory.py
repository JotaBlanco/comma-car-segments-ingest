"""The signal inventory measured while the file is being decoded.

The terminal `kind:"file_complete"` marker carries one row per channel IN THE
FILE, and tm-connector turns that list into the registry's catalogue for the
file (`connector/inventory.py::declare_signals`). Two properties matter:

* **Every channel earns a row, including one that reached no batch.** An empty
  channel, an all-NaN sensor, a text channel the sink drops — each exists in the
  file, so the catalogue says so. Inferring the list from the batches that
  happened to be produced makes such a channel invisible in the one place an
  engineer looks it up.
* **Nothing here retains a sample.** A row costs two short strings and six
  numbers, so memory scales with DISTINCT CHANNELS and never with sample count —
  the same guarantee the connector's accumulator gives.

The numbers are computed with numpy over the channel's own array, which the
decoder has already materialised in order to emit it. A streaming (Welford)
accumulator would buy nothing here and would cost accuracy: the array is whole
and in memory at exactly the moment the stats are taken.

The row shape is `FileSignalInput` (`api/api/models/files.py`), which is
`extra="forbid"` on the registry side — so a key invented here is a 422 that
costs the WHOLE file's catalogue, not one row.
"""

from __future__ import annotations

import math

import numpy as np

# The parsers' conventions, mirrored from `connector/inventory.py` so a row
# built here and a row built there describe a channel identically.
NUMERIC_DTYPE = "float64"
TEXT_DTYPE = "str"
# 0.0 means "underivable", not "this channel ticks at zero hertz".
UNKNOWN_RATE_HZ = 0.0


def _rate_hz(count: int, first_ts_ms: int | None, last_ts_ms: int | None) -> float:
    """Samples per second across the observed window, the connector's formula."""
    if count < 2 or first_ts_ms is None or last_ts_ms is None:
        return UNKNOWN_RATE_HZ
    span_ms = last_ts_ms - first_ts_ms
    if span_ms <= 0:
        return UNKNOWN_RATE_HZ
    return (count - 1) / (span_ms / 1000.0)


class FileInventory:
    """One file's channel catalogue, plus the window its samples span."""

    def __init__(self) -> None:
        self._rows: dict[str, dict] = {}
        self._first_ts_ms: int | None = None
        self._last_ts_ms: int | None = None

    # --- what the decoder reports -------------------------------------------

    def declare(self, signal: str, unit: str, dtype: str = NUMERIC_DTYPE) -> None:
        """A channel that produced no emittable sample. It is in the file.

        Called for an empty channel and for one whose samples were all NaN/Inf —
        both leave `_emit_channel` before a batch is built. `stats` is absent,
        which the registry reads as "not measured", never as zero.
        """
        self._rows.setdefault(
            signal,
            {"name": signal, "unit": unit or None, "dtype": dtype, "rate_hz": UNKNOWN_RATE_HZ},
        )

    def observe_numeric(self, signal: str, unit: str, ts_ms: list[int], values) -> None:
        """A numeric channel, measured over its whole array."""
        first = int(ts_ms[0]) if ts_ms else None
        last = int(ts_ms[-1]) if ts_ms else None
        row = self._row(signal, unit, NUMERIC_DTYPE, len(ts_ms), first, last)
        if not ts_ms:
            return
        arr = np.asarray(values, dtype=np.float64)
        # `_emit_channel` has already dropped NaN/Inf, so this is finite. The
        # guard stays because an all-dropped channel reaches `declare` instead
        # and a zero-length array would make every statistic a NaN.
        if arr.size == 0:
            return
        mean = float(arr.mean())
        row["stats"] = {
            "min": float(arr.min()),
            "max": float(arr.max()),
            "mean": mean,
            # Population sigma (ddof=0), which is what a single-sample channel
            # can answer at all: ddof=1 would divide by zero and report NaN,
            # and the registry refuses a block whose members are not numbers.
            "std": float(arr.std()),
            "rms": float(np.sqrt(np.mean(np.square(arr)))),
            "sample_count": int(arr.size),
        }
        # A statistic that is not a real number must never be sent: the
        # registry's model takes floats, and NaN survives JSON as `NaN`, which
        # is not valid JSON and fails the whole body.
        if not all(math.isfinite(v) for k, v in row["stats"].items() if k != "sample_count"):
            del row["stats"]

    def observe_text(
        self, signal: str, unit: str, count: int, first_ts_ms: int | None, last_ts_ms: int | None
    ) -> None:
        """A text channel. It gets a row and a rate, and no statistics.

        `min`/`max`/`mean`/`std` over strings are not facts. The registry's
        block is all four or none (`connector/inventory.py::_stats_block`), and
        none is the honest answer.

        The three numbers are passed rather than an array of timestamps: the
        text emit path batches as it goes and holds no whole-channel list, and
        building one here purely to measure it would retain the samples this
        module promises never to keep.
        """
        self._row(signal, unit, TEXT_DTYPE, count, first_ts_ms, last_ts_ms)

    # --- what the marker reads ----------------------------------------------

    def rows(self) -> list[dict]:
        """The `inventory` array, name-sorted so the marker is stable."""
        return [self._rows[name] for name in sorted(self._rows)]

    @property
    def window(self) -> tuple[int | None, int | None]:
        """The file's `time_start_ms` / `time_end_ms`, across every channel."""
        return self._first_ts_ms, self._last_ts_ms

    @property
    def signal_count(self) -> int:
        return len(self._rows)

    # --- internals ------------------------------------------------------------

    def _row(
        self,
        signal: str,
        unit: str,
        dtype: str,
        count: int,
        first_ts_ms: int | None,
        last_ts_ms: int | None,
    ) -> dict:
        """Create or update one row, and widen the file's window with it."""
        row = self._rows.get(signal)
        if row is None:
            row = {"name": signal, "unit": unit or None, "dtype": dtype}
            self._rows[signal] = row
        row["dtype"] = dtype
        if count and first_ts_ms is not None and last_ts_ms is not None:
            # A channel is emitted in ascending time, but the file's window is
            # the union across channels, so both ends are compared.
            if self._first_ts_ms is None or first_ts_ms < self._first_ts_ms:
                self._first_ts_ms = first_ts_ms
            if self._last_ts_ms is None or last_ts_ms > self._last_ts_ms:
                self._last_ts_ms = last_ts_ms
            row["rate_hz"] = _rate_hz(count, first_ts_ms, last_ts_ms)
        else:
            row.setdefault("rate_hz", UNKNOWN_RATE_HZ)
        return row
