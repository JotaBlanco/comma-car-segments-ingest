"""The closed ``reduce.op`` vocabulary (schemas.md 3.1, spec 4.8).

Two families, and the distinction is normative:

* **series transforms** (``none``, ``moving_average``, ``moving_min``,
  ``moving_max``, ``derivative``) are computed over the *whole* aligned series and
  the window mask is applied to the **result**. That is what "the 2 s moving
  average of deceleration while ACC is active" means: compute the average, then
  look at it while ACC is active. Computing it only from in-window samples would
  make the first ``window_s`` of every activation unevaluable, which is precisely
  what ``settle_s`` exists to handle instead.
* **aggregates** (everything else) are computed from the in-window samples only.

Moving reductions are **trailing (causal)** and drop samples whose window is
incomplete: they become NaN, and NaN never satisfies a rule. A back-filled or
partial-window value would be a fabricated measurement.

No fudge factors anywhere in this module: nothing here relaxes a bound, and
``tolerance`` is applied once, visibly, in ``rules.py``.
"""

import logging
from dataclasses import dataclass, field

import numpy as np

import events
import windows

logger = logging.getLogger(__name__)

SERIES_OPS = frozenset({"none", "moving_average", "moving_min", "moving_max", "derivative"})
SCALAR_OPS = frozenset(
    {
        "mean", "min", "max", "abs_max", "rms", "integral", "percentile", "duration_true",
        "count_edges", "time_between_edges", "settling_time", "overshoot", "value_at",
    }
)
ALL_OPS = SERIES_OPS | SCALAR_OPS


class ReduceError(ValueError):
    """A malformed reduction that the schema could not reject."""


@dataclass
class Reduction:
    """The outcome of one reduction, in a form ``rules.py`` can judge."""

    op: str
    kind: str  # "scalar" or "series"
    value: float | None = None
    t: np.ndarray | None = None
    values: np.ndarray | None = None
    sample_count: int = 0
    detail: dict = field(default_factory=dict)

    def finite_values(self) -> np.ndarray:
        if self.kind == "scalar":
            return (
                np.array([self.value], dtype=float)
                if self.value is not None and np.isfinite(self.value)
                else np.empty(0)
            )
        if self.values is None:
            return np.empty(0)
        return self.values[np.isfinite(self.values)]


def _masked(values: np.ndarray, mask: np.ndarray) -> np.ndarray:
    return values[mask]


def _trailing(values: np.ndarray, count: int, aggregate) -> np.ndarray:
    """Causal rolling aggregate; the first ``count - 1`` samples become NaN."""
    out = np.full(values.shape, np.nan)
    if count <= 1:
        return values.astype(float, copy=True)
    if values.size >= count:
        view = np.lib.stride_tricks.sliding_window_view(values, count)
        out[count - 1 :] = aggregate(view, axis=1)
    return out


def _window_sample_count(spec: dict, sample_period_s: float) -> int:
    window_s = spec.get("window_s")
    if window_s is None:
        raise ReduceError(f"reduce '{spec.get('op')}' needs 'window_s'")
    if sample_period_s <= 0:
        raise ReduceError("cannot size a moving window: the base grid has no sample period")
    return max(1, int(round(float(window_s) / sample_period_s)))


def _trapezoid(t: np.ndarray, y: np.ndarray) -> float:
    finite = np.isfinite(t) & np.isfinite(y)
    t_valid, y_valid = t[finite], y[finite]
    if t_valid.size < 2:
        return float("nan")
    return float(np.sum((y_valid[:-1] + y_valid[1:]) / 2.0 * np.diff(t_valid)))


def _in_any_span(instant: float, spans: list[tuple[float, float]]) -> bool:
    return any(start <= instant <= end for start, end in spans)


def apply(spec: dict, frame, signal: str, mask: np.ndarray) -> Reduction:
    """Apply one reduction to one signal within one window."""
    op = (spec or {}).get("op", "none")
    if op not in ALL_OPS:
        raise ReduceError(f"unknown reduce op {op!r}")
    values = frame.get(signal).astype(float)
    t = frame.t
    spans = windows.spans(mask, t)
    sample_period = frame.sample_period_s()

    if op in SERIES_OPS:
        transformed = _series_transform(op, spec, values, t, sample_period)
        return Reduction(
            op=op,
            kind="series",
            t=t[mask],
            values=transformed[mask],
            sample_count=int(np.count_nonzero(np.isfinite(transformed[mask]))),
            detail={"spans": spans},
        )

    in_window_t = _masked(t, mask)
    in_window_y = _masked(values, mask)
    finite = np.isfinite(in_window_y)
    finite_y = in_window_y[finite]
    count = int(finite_y.size)

    if op == "mean":
        value = float(np.mean(finite_y)) if count else float("nan")
    elif op == "min":
        value = float(np.min(finite_y)) if count else float("nan")
    elif op == "max":
        value = float(np.max(finite_y)) if count else float("nan")
    elif op == "abs_max":
        value = float(np.max(np.abs(finite_y))) if count else float("nan")
    elif op == "rms":
        value = float(np.sqrt(np.mean(np.square(finite_y)))) if count else float("nan")
    elif op == "integral":
        value = _trapezoid(in_window_t, in_window_y)
    elif op == "percentile":
        percentile = spec.get("p")
        if percentile is None:
            raise ReduceError("reduce 'percentile' needs 'p'")
        value = float(np.percentile(finite_y, float(percentile))) if count else float("nan")
    elif op == "duration_true":
        # Quantised to the base raster period: total time the series is non-zero.
        non_zero = int(np.count_nonzero(finite_y != 0))
        value = round(non_zero * sample_period, 6) if sample_period > 0 else float("nan")
    elif op == "count_edges":
        value = float(_count_edges(spec, frame, signal, spans))
    elif op == "time_between_edges":
        value, detail = _time_between_edges(spec, frame, spans)
        return Reduction(
            op=op, kind="scalar", value=value, sample_count=len(detail.get("pairs") or []),
            detail={**detail, "spans": spans},
        )
    elif op == "settling_time":
        value = _settling_time(spec, in_window_t, in_window_y)
    elif op == "overshoot":
        value = _overshoot(spec, finite_y)
    elif op == "value_at":
        value, detail = _value_at(spec, frame, signal, spans)
        return Reduction(
            op=op, kind="scalar", value=value, sample_count=1 if np.isfinite(value) else 0,
            detail={**detail, "spans": spans},
        )
    else:  # pragma: no cover - ALL_OPS guards this
        raise ReduceError(f"unhandled reduce op {op!r}")

    return Reduction(
        op=op, kind="scalar", value=value, sample_count=count, detail={"spans": spans}
    )


def _series_transform(
    op: str, spec: dict, values: np.ndarray, t: np.ndarray, sample_period: float
) -> np.ndarray:
    if op == "none":
        return values
    if op == "derivative":
        method = spec.get("method", "central")
        if method != "central":
            raise ReduceError(f"reduce 'derivative' supports method 'central' only, got {method!r}")
        if t.size < 2:
            return np.full(values.shape, np.nan)
        return np.gradient(values, t)
    count = _window_sample_count(spec, sample_period)
    aggregate = {"moving_average": np.mean, "moving_min": np.min, "moving_max": np.max}[op]
    return _trailing(values, count, aggregate)


def _count_edges(spec: dict, frame, signal: str, spans: list[tuple[float, float]]) -> int:
    edge = spec.get("edge")
    if edge not in ("rising", "falling", "any"):
        raise ReduceError("reduce 'count_edges' needs edge of rising|falling|any")
    kind = {"rising": "rising", "falling": "falling", "any": "any_edge"}[edge]
    instants = events.event_times({"signal": signal, "kind": kind}, frame)
    return sum(1 for instant in instants if _in_any_span(instant, spans))


def _time_between_edges(spec: dict, frame, spans: list[tuple[float, float]]):
    """Elapsed time from a ``from`` event to the next ``to`` event, midpoint convention."""
    from_spec = spec.get("from")
    to_spec = spec.get("to")
    if not isinstance(from_spec, dict) or not isinstance(to_spec, dict):
        raise ReduceError("reduce 'time_between_edges' needs 'from' and 'to' events")
    from_times = [
        instant for instant in events.event_times(from_spec, frame)
        if _in_any_span(instant, spans)
    ]
    to_times = events.event_times(to_spec, frame)

    pairs = []
    for start in from_times:
        following = [instant for instant in to_times if instant > start]
        if not following:
            # An unmatched 'from' is not a zero-latency pass; it is missing
            # evidence, and it is recorded as such.
            pairs.append({"from_s": start, "to_s": None, "elapsed_s": None})
            continue
        end = min(following)
        pairs.append(
            {"from_s": start, "to_s": end, "elapsed_s": round(float(end - start), 6)}
        )

    elapsed = [pair["elapsed_s"] for pair in pairs if pair["elapsed_s"] is not None]
    occurrence = spec.get("occurrence") or "first"
    unmatched = sum(1 for pair in pairs if pair["elapsed_s"] is None)
    detail = {"pairs": pairs, "occurrence": occurrence, "unmatched_from_events": unmatched}

    if not elapsed:
        return float("nan"), detail
    if occurrence == "first":
        return float(elapsed[0]), detail
    if occurrence == "last":
        return float(elapsed[-1]), detail
    if occurrence in ("max", "all"):
        # 'max' takes the worst pair, which is the only honest single number for a
        # latency budget. 'all' reports the same worst case and keeps every pair
        # in detail.
        return float(max(elapsed)), detail
    raise ReduceError(f"unknown time_between_edges occurrence {occurrence!r}")


def _settling_time(spec: dict, t: np.ndarray, y: np.ndarray) -> float:
    """First time after which ``abs(x - target) <= band_abs`` holds for >= ``hold_s``."""
    for key in ("target", "band_abs", "hold_s"):
        if spec.get(key) is None:
            raise ReduceError(f"reduce 'settling_time' needs {key!r}")
    target = float(spec["target"])
    band = float(spec["band_abs"])
    hold = float(spec["hold_s"])
    if t.size == 0:
        return float("nan")

    inside = np.isfinite(y) & (np.abs(y - target) <= band)
    origin = float(t[0])
    for start, end in windows.runs(inside):
        if float(t[end] - t[start]) >= hold:
            return round(float(t[start] - origin), 6)
    return float("nan")


def _overshoot(spec: dict, y: np.ndarray) -> float:
    """Signed extremum excursion beyond ``target``; 0.0 when there is none."""
    if spec.get("target") is None:
        raise ReduceError("reduce 'overshoot' needs 'target'")
    target = float(spec["target"])
    if y.size == 0:
        return float("nan")
    above = float(np.max(y)) - target
    below = float(np.min(y)) - target
    if above <= 0 and below >= 0:
        return 0.0
    return above if abs(above) >= abs(below) else below


def _value_at(spec: dict, frame, signal: str, spans: list[tuple[float, float]]):
    at_spec = spec.get("at")
    if not isinstance(at_spec, dict):
        raise ReduceError("reduce 'value_at' needs an 'at' event")
    instants = events.event_times(at_spec, frame)
    if not instants:
        return float("nan"), {"instant_s": None, "in_window": False}
    instant = instants[0]
    return (
        events.value_at(frame, signal, instant),
        {"instant_s": instant, "in_window": _in_any_span(instant, spans)},
    )


def signals_referenced(spec: dict) -> list[str]:
    """Signals a reduction needs beyond the criterion's primary signal."""
    found: list[str] = []
    for key in ("from", "to", "at"):
        event = (spec or {}).get(key)
        if isinstance(event, dict):
            found.extend(events.signals_referenced(event))
    return found
