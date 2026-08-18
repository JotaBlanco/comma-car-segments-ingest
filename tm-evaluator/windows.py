"""Evaluation windows: the closed ``window.type`` vocabulary (spec 4.8).

A window resolves to a boolean mask over the base grid plus the list of contiguous
spans it selects. The spans are what the report's plots shade, so the reader can
see which part of the trace a verdict was taken from - a number without its window
is not evidence.

Closed set, intersectable via ``{type: "all_of", parts: [...]}``:

``full`` | ``time_range(t_start_s, t_end_s)`` |
``state_mask(signal, in[], settle_s, min_duration_s)`` |
``event_relative(event, offset_start_s, offset_end_s, occurrence)`` |
``signal_threshold(signal, op, value)``
"""

import numpy as np

import events


class WindowError(ValueError):
    """A malformed window specification that the schema could not reject."""


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Contiguous ``True`` runs as inclusive ``(start_index, end_index)`` pairs."""
    if mask.size == 0:
        return []
    padded = np.concatenate(([False], mask.astype(bool), [False]))
    changes = np.diff(padded.astype(np.int8))
    starts = np.nonzero(changes == 1)[0]
    ends = np.nonzero(changes == -1)[0] - 1
    return list(zip(starts.tolist(), ends.tolist(), strict=True))


def spans(mask: np.ndarray, t: np.ndarray) -> list[tuple[float, float]]:
    return [(float(t[start]), float(t[end])) for start, end in runs(mask)]


def _state_mask(spec: dict, frame) -> np.ndarray:
    signal = spec.get("signal")
    wanted = spec.get("in") or []
    if not signal or not wanted:
        raise WindowError("state_mask needs 'signal' and a non-empty 'in'")
    values = frame.get(signal)
    mask = np.zeros(values.shape, dtype=bool)
    for entry in wanted:
        target = 1.0 if entry is True else (0.0 if entry is False else float(entry))
        mask |= events.compare(values, "eq", target)

    settle_s = float(spec.get("settle_s") or 0.0)
    min_duration_s = float(spec.get("min_duration_s") or 0.0)
    if settle_s <= 0 and min_duration_s <= 0:
        return mask

    t = frame.t
    out = np.zeros(mask.shape, dtype=bool)
    for start, end in runs(mask):
        # settle_s discards the beginning of each run, which is what keeps a
        # state transient out of a steady-state measurement.
        run_start_t = t[start] + settle_s
        keep = np.zeros(mask.shape, dtype=bool)
        keep[start : end + 1] = True
        keep &= t >= run_start_t
        if not keep.any():
            continue
        kept_indices = np.nonzero(keep)[0]
        duration = float(t[kept_indices[-1]] - t[kept_indices[0]])
        if min_duration_s > 0 and duration < min_duration_s:
            continue
        out |= keep
    return out


def _event_relative(spec: dict, frame) -> np.ndarray:
    event = spec.get("event")
    if not isinstance(event, dict):
        raise WindowError("event_relative needs an 'event' object")
    instants = events.event_times(event, frame)
    if not instants:
        return np.zeros(frame.t.shape, dtype=bool)
    occurrence = spec.get("occurrence") or "first"
    if occurrence == "first":
        chosen = instants[:1]
    elif occurrence == "last":
        chosen = instants[-1:]
    elif occurrence == "all":
        chosen = instants
    else:
        raise WindowError(f"unknown event_relative occurrence {occurrence!r}")

    offset_start = float(spec.get("offset_start_s") or 0.0)
    offset_end = float(spec.get("offset_end_s") or 0.0)
    mask = np.zeros(frame.t.shape, dtype=bool)
    for instant in chosen:
        mask |= (frame.t >= instant + offset_start) & (frame.t <= instant + offset_end)
    return mask


def resolve(spec: dict, frame) -> np.ndarray:
    """Boolean mask over ``frame.t`` for one window specification."""
    kind = (spec or {}).get("type")
    if kind == "full":
        return np.ones(frame.t.shape, dtype=bool)
    if kind == "time_range":
        start = float(spec["t_start_s"])
        end = float(spec["t_end_s"])
        if end <= start:
            raise WindowError(f"time_range needs t_end_s > t_start_s, got {start} .. {end}")
        return (frame.t >= start) & (frame.t <= end)
    if kind == "state_mask":
        return _state_mask(spec, frame)
    if kind == "event_relative":
        return _event_relative(spec, frame)
    if kind == "signal_threshold":
        return events.compare(frame.get(spec["signal"]), spec["op"], float(spec["value"]))
    if kind == "all_of":
        parts = spec.get("parts") or []
        if len(parts) < 2:
            raise WindowError("all_of needs at least two parts")
        mask = np.ones(frame.t.shape, dtype=bool)
        for part in parts:
            mask &= resolve(part, frame)
        return mask
    raise WindowError(f"unknown window type {kind!r}")


def signals_referenced(spec: dict) -> list[str]:
    """Every signal a window needs, so the loader knows what to fetch."""
    kind = (spec or {}).get("type")
    if kind in ("state_mask", "signal_threshold"):
        return [spec["signal"]] if spec.get("signal") else []
    if kind == "event_relative":
        return events.signals_referenced(spec.get("event") or {})
    if kind == "all_of":
        found: list[str] = []
        for part in spec.get("parts") or []:
            found.extend(signals_referenced(part))
        return found
    return []
