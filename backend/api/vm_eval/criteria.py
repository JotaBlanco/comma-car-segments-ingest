"""The test-spec criterion vocabulary, in pure Python.

A direct port of the shared helpers in ``quixlab/notebooks/acc_performance_tests.py``,
with pandas replaced by lists because the backend image carries neither pandas nor numpy
and this evaluation is a few hundred thousand float operations, not a data-science job.

Two deliberate differences from the notebook, both load-bearing:

1. **Slow signals are forward-filled onto the union index** (see :func:`Frame.build`).
   The lake stores one row per ``(signal, ts_ms)`` at each signal's own raster:
   ``ACC_Status`` is 10 Hz, ``Trgt_Dist_m`` 50 Hz, ``VehSpd_Kph`` 100 Hz. Pivoting those
   into a wide table without holding the slow ones leaves a NULL in nine rows out of ten,
   so ``ACC_Status == 3`` is true only on every tenth row and every state mask collapses
   into single-sample runs that no ``min_duration_s`` can survive. Every criterion then
   reports INCONCLUSIVE. A state signal is a step function between its samples; holding it
   is what the signal means, not an interpolation convenience.

2. **The moving-average window is closed on both ends**, ``[t - window, t]``. The notebook's
   ``rolling("2000ms")`` is half-open on the left, which for ACC-SYS-TC-014 gives
   -3.824299 where the inclusive window gives -3.824041. The spec's other window type
   (``time_range``) is inclusive at both endpoints, so the inclusive reading is the
   consistent one, and it is the figure the test case's expected result was verified at.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from itertools import accumulate

#: A contiguous row range of a :class:`Frame`, ``[start, stop)``. Segments are always
#: contiguous - every producer below re-splits on discontinuities - so a pair of indices
#: carries the same information as the notebook's list of index labels at a fraction of
#: the cost.
Segment = tuple[int, int]

#: Verdict strings. Identical to ``models_vmodel_chain.VerdictStatus`` values; kept as
#: plain strings here so this module has no dependency on the API models.
PASS = "PASS"
FAIL = "FAIL"
INCONCLUSIVE = "INCONCLUSIVE"


@dataclass(frozen=True)
class Frame:
    """A wide signal table: one row per timestamp, one column per signal.

    ``values[signal][i]`` is the value of ``signal`` at ``ts_ms[i]``, or ``None`` before
    that signal's first sample. After :meth:`build` there are no interior holes.
    """

    ts_ms: tuple[int, ...]
    t_s: tuple[float, ...]
    values: dict[str, list[float | None]]

    @property
    def size(self) -> int:
        return len(self.ts_ms)

    def column(self, signal: str) -> list[float | None]:
        return self.values[signal]

    def has(self, signal: str) -> bool:
        """A signal is usable when it is present and not entirely NULL.

        An enumerated signal carries its label in ``value_text`` and leaves ``value``
        NULL, which is indistinguishable from an absent signal for a numeric criterion.
        ``on_missing_signal: error`` means both are reported, never skipped.
        """
        column = self.values.get(signal)
        return column is not None and any(item is not None for item in column)

    def missing(self, signals: Iterable[str]) -> list[str]:
        return [signal for signal in signals if not self.has(signal)]

    @classmethod
    def build(cls, rows: Iterable[tuple[str, int, float]]) -> Frame:
        """Pivot long ``(signal, ts_ms, value)`` rows into the wide, forward-filled table.

        Duplicate ``(signal, ts_ms)`` pairs are collapsed: every one of these runs is in
        the lake under several ``upload_id`` values, so each sample appears five times.
        Deduplicating is not cosmetic - without it every sample count is five times too
        large and every moving average is computed over repeated samples.
        """
        per_signal: dict[str, dict[int, float]] = {}
        stamps: set[int] = set()
        for signal, ts, value in rows:
            per_signal.setdefault(signal, {})[ts] = value
            stamps.add(ts)

        ordered = tuple(sorted(stamps))
        index = {ts: position for position, ts in enumerate(ordered)}

        values: dict[str, list[float | None]] = {}
        for signal, samples in per_signal.items():
            column: list[float | None] = [None] * len(ordered)
            for ts, value in samples.items():
                column[index[ts]] = value
            carried: float | None = None
            for position, item in enumerate(column):
                if item is None:
                    column[position] = carried
                else:
                    carried = item
            values[signal] = column

        return cls(ts_ms=ordered, t_s=tuple(ts / 1000.0 for ts in ordered), values=values)


def contiguous_runs(flags: Sequence[bool]) -> list[Segment]:
    """Index ranges of each contiguous run of ``True``, in time order."""
    runs: list[Segment] = []
    start: int | None = None
    for position, flag in enumerate(flags):
        if flag and start is None:
            start = position
        elif not flag and start is not None:
            runs.append((start, position))
            start = None
    if start is not None:
        runs.append((start, len(flags)))
    return runs


def state_mask(
    frame: Frame,
    allowed: Sequence[float],
    settle_s: float = 0.0,
    min_duration_s: float = 0.0,
    signal: str = "ACC_Status",
) -> list[Segment]:
    """Spec window type ``state_mask``.

    Contiguous runs of ``signal`` in ``allowed``; the first ``settle_s`` of each run is
    discarded and a run whose surviving span is shorter than ``min_duration_s`` is dropped
    whole. Segments stay separate rather than being concatenated, so a windowed reduction
    can never span a mask discontinuity.
    """
    column = frame.values.get(signal)
    if column is None:
        return []
    permitted = set(allowed)
    flags = [item is not None and item in permitted for item in column]

    kept: list[Segment] = []
    for start, stop in contiguous_runs(flags):
        first = frame.t_s[start] + settle_s
        cursor = start
        while cursor < stop and frame.t_s[cursor] < first:
            cursor += 1
        if cursor >= stop:
            continue
        if frame.t_s[stop - 1] - frame.t_s[cursor] < min_duration_s:
            continue
        kept.append((cursor, stop))
    return kept


def signal_threshold(
    frame: Frame, segments: Sequence[Segment], signal: str, op: str, value: float
) -> list[Segment]:
    """Spec window part type ``signal_threshold``, intersected with ``segments``.

    Re-splits into contiguous runs: dropping interior samples can break one segment into
    several, and a trailing average must not bridge the gap that leaves behind.
    """
    column = frame.values[signal]
    out: list[Segment] = []
    for start, stop in segments:
        flags = [
            item is not None and (item <= value if op == "le" else item >= value)
            for item in column[start:stop]
        ]
        out.extend((start + run_start, start + run_stop) for run_start, run_stop in contiguous_runs(flags))
    return out


def time_range(frame: Frame, t_start_s: float, t_end_s: float) -> list[Segment]:
    """Spec window type ``time_range``. Both endpoints inclusive."""
    flags = [t_start_s <= item <= t_end_s for item in frame.t_s]
    return contiguous_runs(flags)


def full_range(frame: Frame) -> list[Segment]:
    """Spec window type ``full``: the whole measurement, nothing masked."""
    return [(0, frame.size)] if frame.size else []


def trailing_mean(
    frame: Frame, segment: Segment, signal: str, window_s: float
) -> list[tuple[int, float]]:
    """Trailing moving average of ``signal`` over ``window_s`` of wall time.

    The window is ``[t - window_s, t]`` - trailing, not centred, and inclusive at both
    ends (see the module docstring). Samples whose window is not fully inside the segment
    are dropped, which is what makes this safe to call per contiguous segment: no average
    may span a mask discontinuity.

    Returns ``(row index, mean)`` pairs so a caller can point at the sample that produced
    the extremum without re-deriving it.
    """
    start, stop = segment
    times = frame.t_s[start:stop]
    column = frame.values[signal]
    raw = [column[position] for position in range(start, stop)]
    if not times or any(item is None for item in raw):
        raw = [0.0 if item is None else item for item in raw]

    # Prefix sums: mean over [i, j] is (P[j + 1] - P[i]) / (j + 1 - i). The values are
    # O(1) and the segment is a few thousand samples, so the cancellation error is ~1e-13
    # against a criterion read to four decimals.
    prefix = [0.0, *accumulate(float(item) for item in raw)]

    out: list[tuple[int, float]] = []
    left = 0
    horizon = times[0] + window_s
    for right, moment in enumerate(times):
        if moment < horizon:
            continue
        lower = moment - window_s
        while times[left] < lower:
            left += 1
        count = right - left + 1
        out.append((start + right, (prefix[right + 1] - prefix[left]) / count))
    return out


def effective_bound(op: str, bound: float, tolerance: float | None) -> float:
    """``tolerance.abs`` relaxes the bound in the permissive direction.

    The spec's own worked example: bound -3.5 with ``tolerance.abs`` 0.05 gives -3.55.
    ``eq`` uses the tolerance as a two-sided band instead, so the bound is unchanged.
    """
    tol = 0.0 if tolerance is None else float(tolerance)
    if op == "le":
        return bound + tol
    if op == "ge":
        return bound - tol
    return bound


def _reduce(
    reduce_op: str, values: Sequence[tuple[int, float]], op: str, bound: float
) -> tuple[int, float]:
    """Apply the criterion's own ``reduce.op``; return the deciding ``(row, value)``.

    ``reduce: none`` pairs with ``quantifier: all`` - every sample must satisfy the rule -
    so it reduces to the worst sample *for that rule*. The spec's reduce is honoured as
    written and never inferred from the rule: ACC-SYS-TC-014 C3 is ``reduce: min`` with
    ``op: le``, where the two point opposite ways on purpose.
    """
    if reduce_op == "max":
        return max(values, key=lambda item: item[1])
    if reduce_op == "min":
        return min(values, key=lambda item: item[1])
    if reduce_op == "abs_max":
        return max(values, key=lambda item: abs(item[1]))
    if reduce_op == "none":
        if op == "le":
            return max(values, key=lambda item: item[1])
        if op == "ge":
            return min(values, key=lambda item: item[1])
        if op == "eq":
            return max(values, key=lambda item: abs(item[1] - bound))
    raise ValueError(f"unsupported reduce op {reduce_op!r}")


@dataclass(frozen=True)
class CriterionOutcome:
    """One evaluated pass criterion or precondition gate."""

    criterion_id: str
    signal: str
    unit: str
    op: str
    reduce: str
    description: str
    bound: float
    effective_bound: float
    tolerance: float | None
    measured: float | None
    margin: float | None
    n_samples: int
    min_samples: int
    verdict: str
    window_label: str
    #: Row index of the sample that decided the criterion, for the plot marker.
    at_row: int | None = None
    #: ``(row, value)`` of every sample the reduction ran over, when the criterion
    #: derived a new series (a moving average) rather than reading one straight.
    derived_series: tuple[tuple[int, float], ...] = field(default=())

    @property
    def rule(self) -> str:
        symbol = {"le": "<=", "ge": ">=", "eq": "=="}.get(self.op, self.op)
        return f"{self.reduce} {symbol} {self.bound:g}"


def evaluate(
    frame: Frame,
    criterion_id: str,
    signal: str,
    unit: str,
    op: str,
    bound: float,
    tolerance: float | None,
    reduce_op: str,
    min_samples: int,
    segments: Sequence[Segment],
    window_s: float | None = None,
    description: str = "",
    window_label: str = "",
) -> CriterionOutcome:
    """Evaluate one pass criterion, or one precondition gate, over ``segments``."""
    derived: tuple[tuple[int, float], ...] = ()
    if reduce_op == "moving_average":
        if window_s is None:
            raise ValueError(f"{criterion_id}: moving_average needs a window_s")
        collected: list[tuple[int, float]] = []
        for segment in segments:
            collected.extend(trailing_mean(frame, segment, signal, window_s))
        derived = tuple(collected)
        values = collected
        reduce_for_scalar = "none"  # rule.quantifier is 'all' over the averaged series
        reduce_label = f"moving_average({window_s:g} s trailing)"
    else:
        column = frame.values.get(signal) or []
        values = [
            (position, column[position])
            for start, stop in segments
            for position in range(start, stop)
            if column[position] is not None
        ]
        reduce_for_scalar = reduce_op
        reduce_label = reduce_op

    count = len(values)
    limit = effective_bound(op, bound, tolerance)

    if count == 0:
        return CriterionOutcome(
            criterion_id=criterion_id,
            signal=signal,
            unit=unit,
            op=op,
            reduce=reduce_label,
            description=description,
            bound=float(bound),
            effective_bound=float(limit),
            tolerance=None if tolerance is None else float(tolerance),
            measured=None,
            margin=None,
            n_samples=0,
            min_samples=int(min_samples),
            verdict=INCONCLUSIVE,
            window_label=window_label,
        )

    at_row, measured = _reduce(reduce_for_scalar, values, op, bound)

    if count < min_samples:
        verdict = INCONCLUSIVE  # data-sufficiency guard, not a judgement
    elif op == "le":
        verdict = PASS if measured <= limit else FAIL
    elif op == "ge":
        verdict = PASS if measured >= limit else FAIL
    elif op == "eq":
        verdict = PASS if abs(measured - bound) <= (tolerance or 0.0) else FAIL
    else:
        raise ValueError(f"unsupported rule op {op!r}")

    if op == "le":
        margin = limit - measured
    elif op == "ge":
        margin = measured - limit
    else:
        margin = (tolerance or 0.0) - abs(measured - bound)

    return CriterionOutcome(
        criterion_id=criterion_id,
        signal=signal,
        unit=unit,
        op=op,
        reduce=reduce_label,
        description=description,
        bound=float(bound),
        effective_bound=float(limit),
        tolerance=None if tolerance is None else float(tolerance),
        measured=float(measured),
        margin=float(margin),
        n_samples=count,
        min_samples=int(min_samples),
        verdict=verdict,
        window_label=window_label,
        at_row=at_row,
        derived_series=derived,
    )


def overall_verdict(
    criteria: Sequence[CriterionOutcome], gates: Sequence[CriterionOutcome]
) -> str:
    """``pass_criteria_logic`` is ``all`` on all three specs.

    A failed or unevaluable precondition gate makes the whole result INCONCLUSIVE rather
    than a PASS or a FAIL: an ungated run cannot support either.
    """
    if any(gate.verdict != PASS for gate in gates):
        return INCONCLUSIVE
    if any(item.verdict == INCONCLUSIVE for item in criteria):
        return INCONCLUSIVE
    return PASS if all(item.verdict == PASS for item in criteria) else FAIL


def binding_criterion(criteria: Sequence[CriterionOutcome]) -> CriterionOutcome:
    """The criterion the headline figures come from.

    The first failure, or otherwise the criterion sitting closest to its bound in relative
    terms - the one a reader should look at first either way.
    """
    failing = [item for item in criteria if item.verdict != PASS]
    candidates = failing or list(criteria)
    return min(
        candidates,
        key=lambda item: (
            float("-inf") if item.margin is None else item.margin / (abs(item.bound) or 1.0)
        ),
    )
