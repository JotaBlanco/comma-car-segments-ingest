"""Turning MF4 channel groups into lake rows (spec 3.5).

One row per sample per channel group, wide and typed. Key columns are identical on
all four tables so the evaluator can address any of them the same way, and
``trace_key`` is on **every** row - it is the join key that ties a lake row back to
the raw object, the registry entry and the run.

Type policy:

* ``float32`` -> double (lossless widening);
* ``uint8`` / ``uint16`` -> int32, kept **integral, not boolean**, because 0/1
  flags and multi-valued enums share the same on-file family and a boolean would
  destroy the enum case.

``ts_ms`` is ``trace_epoch_ms + round(t_s * 1000)`` and exists so the sink has an
epoch timestamp column to partition and order by. It is wall-clock-tainted (the
plant's byte-identical mode uses a fixed header epoch), which is why
``epoch_source`` is recorded and why every verdict uses ``t_s``.
"""

import logging
import math

import mf4_reader

logger = logging.getLogger(__name__)

KEY_COLUMNS = (
    "trace_key", "device_id", "scenario", "variant_id", "config_hash12", "mf4_run_id",
    "channel_group", "ts_ms", "t_s", "sample_index", "ingest_utc", "extractor_version",
)


def _scalar(value):
    """Coerce one numpy scalar to a JSON-safe Python value.

    NaN and infinities are emitted as ``None``: they are not valid JSON, and a
    silently substituted 0.0 would be a fabricated measurement.
    """
    try:
        as_float = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(as_float) or math.isinf(as_float):
        return None
    if float(as_float).is_integer() and abs(as_float) < 2**53:
        # Keep integral samples integral so enum values stay comparable.
        return int(as_float)
    return as_float


def _is_integral_dtype(samples) -> bool:
    kind = getattr(getattr(samples, "dtype", None), "kind", "")
    return kind in ("i", "u", "b")


def extract_group(
    mdf,
    group_name: str,
    group_index: int,
    context: dict,
    warnings: list[str],
) -> tuple[list[dict], dict]:
    """Rows plus a per-group summary for ``trace.meta.json``."""
    names = mf4_reader.channel_names(mdf, group_index)
    series: dict[str, list] = {}
    timestamps: list[float] = []

    for name in names:
        try:
            signal = mdf.get(name, group=group_index)
        except Exception as exc:  # noqa: BLE001 - asammdf raises a wide family
            warnings.append(f"{group_name}/{name}: could not read channel ({exc})")
            continue
        samples = signal.samples
        integral = _is_integral_dtype(samples)
        values = [_scalar(sample) for sample in samples]
        if integral:
            values = [None if value is None else int(value) for value in values]
        series[name] = values
        if not timestamps:
            timestamps = [float(stamp) for stamp in signal.timestamps]

    if not series or not timestamps:
        warnings.append(f"{group_name}: no readable signal channels; group skipped")
        return [], {
            "name": group_name,
            "raster_hz": mf4_reader.KNOWN_GROUPS.get(group_name),
            "sample_count": 0,
            "t_s_first": None,
            "t_s_last": None,
            "signals": sorted(series),
        }

    sample_count = min([len(timestamps), *[len(values) for values in series.values()]])
    if any(len(values) != len(timestamps) for values in series.values()):
        warnings.append(
            f"{group_name}: channels have unequal sample counts; truncated to {sample_count}"
        )

    epoch_ms = int(context["trace_epoch_ms"])
    rows: list[dict] = []
    for index in range(sample_count):
        t_s = round(timestamps[index], 6)
        row = {
            "trace_key": context["trace_key"],
            "device_id": context["device_id"],
            "scenario": context["scenario"],
            "variant_id": context["variant_id"],
            "config_hash12": context["config_hash12"],
            "mf4_run_id": context["mf4_run_id"],
            "channel_group": group_name,
            "ts_ms": epoch_ms + int(round(t_s * 1000)),
            "t_s": t_s,
            "sample_index": index,
            "ingest_utc": context["ingest_utc"],
            "extractor_version": context["extractor_version"],
        }
        for name, values in series.items():
            row[name] = values[index]
        rows.append(row)

    summary = {
        "name": group_name,
        "raster_hz": mf4_reader.KNOWN_GROUPS.get(group_name),
        "sample_count": sample_count,
        "t_s_first": round(timestamps[0], 6),
        "t_s_last": round(timestamps[sample_count - 1], 6),
        "signals": sorted(series),
    }
    return rows, summary


def extract_all(mdf, context: dict) -> tuple[list[dict], list[dict], list[str]]:
    """Every present known group. Missing optional groups are simply absent."""
    warnings: list[str] = []
    indexes = mf4_reader.group_index(mdf)
    if not indexes:
        warnings.append(
            "no known channel group found; expected one of "
            f"{sorted(mf4_reader.KNOWN_GROUPS)}"
        )
    rows: list[dict] = []
    summaries: list[dict] = []
    for group_name in sorted(indexes):
        group_rows, summary = extract_group(
            mdf, group_name, indexes[group_name], context, warnings
        )
        rows.extend(group_rows)
        summaries.append(summary)
    return rows, summaries, warnings
