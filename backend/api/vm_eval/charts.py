"""The plot payload: what the report draws, computed once on the server.

A verdict is a number; the chart is the evidence for it. Everything a reader needs to
check the number by eye is precomputed here - the series itself, the bound it was judged
against, the stretch of time where it was violated, and the single sample that decided the
verdict - so the browser draws SVG and does no signal processing.

Series are decimated with **min/max bucketing**, never by taking every n-th sample: the
extremum is the sample the criterion reduced to, so a decimation that can drop it would
draw a curve that contradicts the verdict printed next to it.
"""

from __future__ import annotations

from collections.abc import Sequence
from operator import itemgetter

from pydantic import BaseModel, Field

from .criteria import CriterionOutcome, Frame, Segment

#: Points kept per series after decimation. Two per bucket (the min and the max), so this
#: is ~240 buckets - finer than any screen this is rendered on.
POINT_BUDGET = 480

#: Criterion operators as the report prints them.
COMPARISON = {"le": "<=", "ge": ">=", "eq": "=="}


class ChartSeries(BaseModel):
    """One line on a chart."""

    series_id: str
    label: str
    unit: str = ""
    kind: str = Field("signal", description="signal | derived")
    role: str = Field("primary", description="primary | context")
    points: list[list[float]] = Field(
        default_factory=list, description="[t_s, value] pairs, decimated, time-ordered"
    )


class ChartBound(BaseModel):
    """A horizontal reference line: the bound the criterion is judged against."""

    label: str
    value: float
    kind: str = Field("bound", description="bound | tolerance")


class ChartSpan(BaseModel):
    """A shaded time range: the evaluated window, or a stretch that violates the bound."""

    label: str
    t_start_s: float
    t_end_s: float
    kind: str = Field("window", description="window | breach")


class ChartMarker(BaseModel):
    """A single called-out sample - the one the reduction picked."""

    label: str
    t_s: float
    value: float
    kind: str = Field("measured", description="measured | breach")


class CriterionChart(BaseModel):
    """One criterion, drawn."""

    chart_id: str
    criterion_id: str
    title: str
    caption: str = Field("", description="The criterion in words, for a reader in a hurry")
    y_label: str = ""
    unit: str = ""
    verdict: str = "PASS"
    reduce: str = Field("", description="The reduction the criterion applied, e.g. 'max'")
    comparison: str = Field("", description="<= | >= | == , as the report prints it")
    measured: float | None = None
    bound: float | None = None
    effective_bound: float | None = None
    margin: float | None = None
    n_samples: int = 0
    series: list[ChartSeries] = Field(default_factory=list)
    bounds: list[ChartBound] = Field(default_factory=list)
    spans: list[ChartSpan] = Field(default_factory=list)
    markers: list[ChartMarker] = Field(default_factory=list)


class CaseSeries(BaseModel):
    """Every chart for one (run, test case). One document of ``vm_result_series``."""

    key: str = Field(..., alias="_id", description="'{run_id}::{tc_id}'")
    run_id: str
    tc_id: str
    title: str = ""
    verdict: str = "NOT_RUN"
    source: str = Field("fixture", description="lake | fixture - where the samples came from")
    source_note: str = ""
    scenario: str = ""
    trace_key: str = ""
    sample_count: int = 0
    duration_s: float = 0.0
    charts: list[CriterionChart] = Field(default_factory=list)


def decimate(points: Sequence[tuple[float, float]], budget: int = POINT_BUDGET) -> list[list[float]]:
    """Min/max bucket decimation. Keeps both extremes of every bucket, in time order."""
    total = len(points)
    if total <= budget:
        return [[round(t, 4), round(v, 6)] for t, v in points]

    buckets = max(1, budget // 2)
    out: list[tuple[float, float]] = []
    for index in range(buckets):
        low = total * index // buckets
        high = total * (index + 1) // buckets
        if high <= low:
            continue
        chunk = points[low:high]
        lowest = min(chunk, key=itemgetter(1))
        highest = max(chunk, key=itemgetter(1))
        first, second = (
            (lowest, highest) if lowest[0] <= highest[0] else (highest, lowest)
        )
        out.append(first)
        if second[0] != first[0]:
            out.append(second)
    return [[round(t, 4), round(v, 6)] for t, v in out]


def signal_points(
    frame: Frame, signal: str, segments: Sequence[Segment] | None = None
) -> list[tuple[float, float]]:
    """``(t_s, value)`` pairs for one signal, optionally restricted to ``segments``."""
    column = frame.values.get(signal)
    if column is None:
        return []
    if segments is None:
        return [
            (frame.t_s[position], value)
            for position, value in enumerate(column)
            if value is not None
        ]
    return [
        (frame.t_s[position], column[position])
        for start, stop in segments
        for position in range(start, stop)
        if column[position] is not None
    ]


def derived_points(frame: Frame, samples: Sequence[tuple[int, float]]) -> list[tuple[float, float]]:
    """``(t_s, value)`` pairs for a series the criterion derived, e.g. a moving average."""
    return [(frame.t_s[row], value) for row, value in samples]


def series_of(
    series_id: str,
    label: str,
    points: Sequence[tuple[float, float]],
    unit: str = "",
    kind: str = "signal",
    role: str = "primary",
) -> ChartSeries:
    return ChartSeries(
        series_id=series_id,
        label=label,
        unit=unit,
        kind=kind,
        role=role,
        points=decimate(points),
    )


def window_span(frame: Frame, segments: Sequence[Segment], label: str) -> list[ChartSpan]:
    """Shade what the criterion actually looked at, so the rest of the run reads as context."""
    return [
        ChartSpan(
            label=label,
            t_start_s=round(frame.t_s[start], 3),
            t_end_s=round(frame.t_s[stop - 1], 3),
            kind="window",
        )
        for start, stop in segments
        if stop > start
    ]


def breach_spans(
    points: Sequence[tuple[float, float]], bound: float, op: str, label: str
) -> list[ChartSpan]:
    """Contiguous stretches where the series is on the wrong side of the bound.

    This is the part of the picture the customer is meant to see: not "a number failed" but
    "for these four seconds the vehicle was outside the limit".
    """
    spans: list[ChartSpan] = []
    start: float | None = None
    previous: float | None = None
    for moment, value in points:
        violating = value > bound if op == "le" else value < bound
        if violating and start is None:
            start = moment
        elif not violating and start is not None:
            spans.append(
                ChartSpan(
                    label=label,
                    t_start_s=round(start, 3),
                    t_end_s=round(previous if previous is not None else moment, 3),
                    kind="breach",
                )
            )
            start = None
        previous = moment
    if start is not None and previous is not None:
        spans.append(
            ChartSpan(label=label, t_start_s=round(start, 3), t_end_s=round(previous, 3), kind="breach")
        )
    return spans


def measured_marker(frame: Frame, outcome: CriterionOutcome, label: str) -> list[ChartMarker]:
    """Pin the sample the reduction picked - the measured value, where it happened."""
    if outcome.at_row is None or outcome.measured is None:
        return []
    return [
        ChartMarker(
            label=label,
            t_s=round(frame.t_s[outcome.at_row], 3),
            value=round(outcome.measured, 6),
            kind="breach" if outcome.verdict != "PASS" else "measured",
        )
    ]


def chart_from(
    chart_id: str,
    outcome: CriterionOutcome,
    title: str,
    caption: str,
    y_label: str,
    series: list[ChartSeries],
    bounds: list[ChartBound],
    spans: list[ChartSpan],
    markers: list[ChartMarker],
) -> CriterionChart:
    """Assemble a chart around an evaluated criterion, carrying its numbers with it."""
    return CriterionChart(
        chart_id=chart_id,
        criterion_id=outcome.criterion_id,
        title=title,
        caption=caption,
        y_label=y_label,
        unit=outcome.unit,
        verdict=outcome.verdict,
        reduce=outcome.reduce,
        comparison=COMPARISON.get(outcome.op, outcome.op),
        measured=outcome.measured,
        bound=outcome.bound,
        effective_bound=outcome.effective_bound,
        margin=outcome.margin,
        n_samples=outcome.n_samples,
        series=series,
        bounds=bounds,
        spans=spans,
        markers=markers,
    )
