"""Edge and event detection with the midpoint convention (spec 4.6).

The edge instant is the **midpoint of the bracketing samples**, not the sample
where the new value first appears. At 100 Hz that halves the systematic bias from
10 ms to 0, leaving a symmetric +-5 ms uncertainty, which is exactly the number
reported as ``uncertainty_s``. Rounding to the later sample instead would make
every measured latency read 5 ms too long, and a 100 ms budget would fail for a
reason that is an artefact of the sampler.

``kind`` vocabulary (closed): ``rising`` | ``falling`` | ``any_edge`` | ``change`` |
``to_value`` | ``threshold``.
"""

import numpy as np

COMPARATORS = {
    "lt": lambda values, bound: values < bound,
    "le": lambda values, bound: values <= bound,
    "gt": lambda values, bound: values > bound,
    "ge": lambda values, bound: values >= bound,
    "eq": lambda values, bound: values == bound,
    "ne": lambda values, bound: values != bound,
}


class EventError(ValueError):
    """A malformed event specification that the schema could not reject."""


def compare(values: np.ndarray, op: str, bound: float) -> np.ndarray:
    """Elementwise comparison; NaN never satisfies a condition."""
    if op not in COMPARATORS:
        raise EventError(f"unknown comparison operator {op!r}")
    with np.errstate(invalid="ignore"):
        result = COMPARATORS[op](values, bound)
    return np.asarray(result) & ~np.isnan(values)


def _midpoints(t: np.ndarray, indices: np.ndarray) -> list[float]:
    """Midpoint of ``t[i-1]`` and ``t[i]`` for each transition index ``i``."""
    return [float((t[index - 1] + t[index]) / 2.0) for index in indices if index >= 1]


def _transitions(condition: np.ndarray, direction: str) -> np.ndarray:
    """Indices where a boolean series changes in the requested direction."""
    truth = condition.astype(bool)
    if truth.size < 2:
        return np.empty(0, dtype=int)
    previous = truth[:-1]
    current = truth[1:]
    if direction == "rising":
        changed = (~previous) & current
    elif direction == "falling":
        changed = previous & (~current)
    else:
        changed = previous != current
    return np.nonzero(changed)[0] + 1


def event_times(event: dict, frame) -> list[float]:
    """Instants at which an event occurs, in seconds on the base grid."""
    signal = event.get("signal")
    kind = event.get("kind")
    if not signal or not kind:
        raise EventError(f"event {event!r} needs both 'signal' and 'kind'")
    values = frame.get(signal)
    t = frame.t

    if kind in ("rising", "falling", "any_edge"):
        # A "rising" edge of a numeric flag is a transition to a non-zero value.
        condition = (values != 0) & ~np.isnan(values)
        direction = {"rising": "rising", "falling": "falling", "any_edge": "any"}[kind]
        return _midpoints(t, _transitions(condition, direction))

    if kind == "change":
        if values.size < 2:
            return []
        differs = values[1:] != values[:-1]
        both_known = ~np.isnan(values[1:]) & ~np.isnan(values[:-1])
        indices = np.nonzero(differs & both_known)[0] + 1
        return _midpoints(t, indices)

    if kind == "to_value":
        target = event.get("value")
        if target is None:
            raise EventError("event kind 'to_value' needs a 'value'")
        condition = compare(values, "eq", float(target))
        return _midpoints(t, _transitions(condition, "rising"))

    if kind == "threshold":
        op = event.get("op")
        target = event.get("value")
        if op is None or target is None:
            raise EventError("event kind 'threshold' needs both 'op' and 'value'")
        condition = compare(values, op, float(target))
        return _midpoints(t, _transitions(condition, "rising"))

    raise EventError(f"unknown event kind {kind!r}")


def signals_referenced(event: dict) -> list[str]:
    signal = event.get("signal")
    return [signal] if signal else []


def value_at(frame, signal: str, instant: float) -> float:
    """Zero-order-hold sample value at an instant: the most recent sample."""
    values = frame.get(signal)
    index = int(np.searchsorted(frame.t, instant, side="right")) - 1
    if index < 0:
        return float("nan")
    return float(values[min(index, values.size - 1)])
