"""Rendering ``pass_criteria`` readably, and merging a run's actuals into them.

A criterion is a machine-evaluable object - ``{criterion_id, signal, channel_group,
unit, window, reduce, rule, tolerance, quantifier, min_samples,
on_missing_signal}`` (spec 4.8) - not prose. Dumping that JSON at a test engineer
is what this module exists to avoid: each nested object is flattened into one
human-readable cell, one criterion per row.

The formatters are deliberately total over the closed vocabularies in
``backend-api/schemas/test-case-1.0.0.schema.json``: every ``reduce.op``, every
``window.type`` and every ``rule.op`` has a rendering, and an unknown value falls
back to a labelled compact form rather than disappearing.
"""

from typing import Any

import pandas as pd
import streamlit as st

RULE_SYMBOLS = {
    "lt": "<",
    "le": "≤",
    "gt": ">",
    "ge": "≥",
    "eq": "=",
    "ne": "≠",
    "equals_enum": "= enum",
}

VERDICT_ICONS = {
    "pass": "✅ pass",
    "fail": "❌ fail",
    "not_run": "⬜ not run",
    "error": "⚠️ error",
    "inconclusive": "❓ inconclusive",
    "partial": "◐ partial",
    "skip": "– skipped",
}


def verdict_label(verdict: str | None) -> str:
    if not verdict:
        return "–"
    return VERDICT_ICONS.get(verdict, verdict)


def _number(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        text = f"{value:.6g}"
        return text
    return str(value)


def format_event(event: Any) -> str:
    """An edge/threshold/change event as used by the timing reductions."""
    if not isinstance(event, dict):
        return _number(event)
    kind = event.get("type") or event.get("kind")
    signal = event.get("signal", "")
    if kind == "rising":
        return f"rising edge of {signal}"
    if kind == "falling":
        return f"falling edge of {signal}"
    if kind == "any":
        return f"any edge of {signal}"
    if kind == "change":
        return f"change of {signal}"
    if kind == "signal_threshold":
        symbol = RULE_SYMBOLS.get(str(event.get("op")), str(event.get("op")))
        return f"{signal} {symbol} {_number(event.get('value'))}"
    parts = [f"{key}={_number(value)}" for key, value in sorted(event.items()) if key != "type"]
    return f"{kind}({', '.join(parts)})" if parts else str(kind)


def format_reduce(reduce: Any) -> str:
    """``{op: moving_average, window_s: 2.0}`` -> ``moving average over 2 s``."""
    if not isinstance(reduce, dict):
        return ""
    op = str(reduce.get("op") or "none")
    if op == "none":
        return "raw samples (no reduction)"
    if op in ("mean", "min", "max", "abs_max", "rms", "integral"):
        return op.replace("_", " ")
    if op in ("moving_average", "moving_min", "moving_max"):
        return f"{op.replace('_', ' ')} over {_number(reduce.get('window_s'))} s (trailing)"
    if op == "derivative":
        return f"derivative ({reduce.get('method') or 'central'})"
    if op == "percentile":
        return f"{_number(reduce.get('p'))}th percentile"
    if op == "duration_true":
        return "total time non-zero"
    if op == "count_edges":
        return f"count of {reduce.get('edge')} edges"
    if op == "time_between_edges":
        return (
            f"time from [{format_event(reduce.get('from'))}] to "
            f"[{format_event(reduce.get('to'))}], {reduce.get('occurrence') or 'first'}"
        )
    if op == "settling_time":
        return (
            f"settling time to {_number(reduce.get('target'))} "
            f"±{_number(reduce.get('band_abs'))} held {_number(reduce.get('hold_s'))} s"
        )
    if op == "overshoot":
        return f"overshoot beyond {_number(reduce.get('target'))}"
    if op == "value_at":
        return f"value at [{format_event(reduce.get('at'))}]"
    return op


def format_window(window: Any) -> str:
    """``state_mask``/``event_relative``/``all_of`` as one readable phrase."""
    if not isinstance(window, dict):
        return ""
    kind = str(window.get("type") or "")
    if kind == "full":
        return "whole trace"
    if kind == "time_range":
        return f"t = {_number(window.get('t_start_s'))}–{_number(window.get('t_end_s'))} s"
    if kind == "state_mask":
        values = ", ".join(_number(value) for value in window.get("in") or [])
        text = f"{window.get('signal')} in [{values}]"
        if window.get("settle_s"):
            text += f", after {_number(window.get('settle_s'))} s settle"
        if window.get("min_duration_s"):
            text += f", min {_number(window.get('min_duration_s'))} s"
        return text
    if kind == "event_relative":
        return (
            f"[{format_event(window.get('event'))}] "
            f"{_number(window.get('offset_start_s') or 0)}…"
            f"{_number(window.get('offset_end_s') or 0)} s "
            f"({window.get('occurrence') or 'first'})"
        )
    if kind == "signal_threshold":
        symbol = RULE_SYMBOLS.get(str(window.get("op")), str(window.get("op")))
        return f"while {window.get('signal')} {symbol} {_number(window.get('value'))}"
    if kind == "all_of":
        return " AND ".join(format_window(part) for part in window.get("parts") or [])
    return kind


def format_rule(rule: Any, unit: str | None = None) -> str:
    """``{op: ge, value: -3.5, quantifier: all}`` -> ``all samples ≥ -3.5 m/s^2``."""
    if not isinstance(rule, dict):
        return ""
    op = str(rule.get("op") or "")
    quantifier = str(rule.get("quantifier") or "all")
    suffix = f" {unit}" if unit else ""
    if op == "is_true":
        body = "is true"
    elif op == "is_false":
        body = "is false"
    elif op in ("within", "outside"):
        low, high = rule.get("value"), rule.get("value2")
        body = f"{op} [{_number(low)}, {_number(high)}]{suffix}"
    else:
        symbol = RULE_SYMBOLS.get(op, op)
        body = f"{symbol} {_number(rule.get('value'))}{suffix}"
    prefix = {"all": "every sample", "any": "at least one sample", "none": "no sample"}
    return f"{prefix.get(quantifier, quantifier)} {body}"


def format_tolerance(tolerance: Any) -> str:
    """Tolerance is always shown; ``null`` means zero, and zero is stated."""
    if not isinstance(tolerance, dict):
        return "none"
    absolute = tolerance.get("abs")
    relative = tolerance.get("rel")
    parts = []
    if absolute:
        parts.append(f"±{_number(absolute)} abs")
    if relative:
        parts.append(f"±{_number(float(relative) * 100)} % rel")
    return " + ".join(parts) if parts else "none"


def criteria_frame(criteria: list[dict], results_by_id: dict[str, dict]) -> pd.DataFrame:
    """One row per criterion; actual/verdict columns appear only with a run."""
    rows = []
    for criterion in criteria or []:
        criterion_id = str(criterion.get("criterion_id") or "")
        unit = criterion.get("unit")
        row = {
            "id": criterion_id,
            "signal": criterion.get("signal"),
            "group": criterion.get("channel_group"),
            "window": format_window(criterion.get("window")),
            "reduction": format_reduce(criterion.get("reduce")),
            "rule": format_rule(criterion.get("rule"), unit),
            "unit": unit,
            "tolerance": format_tolerance(criterion.get("tolerance")),
            "min samples": criterion.get("min_samples") or 1,
            "if signal missing": criterion.get("on_missing_signal") or "error",
            "covers": criterion.get("requirement_ref") or "",
            "description": criterion.get("description"),
        }
        outcome = results_by_id.get(criterion_id)
        if outcome is not None:
            row["verdict"] = verdict_label(outcome.get("verdict"))
            row["actual"] = _number(outcome.get("actual"))
            row["bound (after tolerance)"] = _number(outcome.get("effective_bound"))
            row["samples"] = outcome.get("sample_count")
            row["uncertainty s"] = _number(outcome.get("uncertainty_s"))
            row["reason"] = outcome.get("reason_code") or ""
        rows.append(row)
    return pd.DataFrame(rows)


def render_criteria(
    criteria: list[dict],
    logic: str | None = None,
    results_by_id: dict[str, dict] | None = None,
    *,
    caption: str | None = None,
) -> None:
    """The pass-criteria table of spec 1.2, optionally decorated with actuals."""
    if not criteria:
        st.caption("no criteria declared")
        return
    if logic:
        st.markdown(
            f"Combined with **`pass_criteria_logic = {logic}`** "
            f"({'every' if logic == 'all' else 'at least one'} criterion must hold)."
        )
    frame = criteria_frame(criteria, results_by_id or {})
    st.dataframe(frame, use_container_width=True, hide_index=True)
    if caption:
        st.caption(caption)


QUANTIFIER_PREFIX = {
    "all": "every sample",
    "any": "at least one sample",
    "none": "no sample",
}


def _result_rule(block: dict) -> str:
    """The rule as the evaluator recorded it - flat fields, not the nested object.

    A result block is not a criterion: the evaluator flattens ``rule`` into
    ``rule_op`` / ``bound`` / ``quantifier`` and adds the bound it actually compared
    against. Rendering it through the criterion formatters would leave the window,
    reduction and rule columns blank, which is why this exists separately.
    """
    op = str(block.get("rule_op") or "")
    unit = f" {block.get('unit')}" if block.get("unit") else ""
    prefix = QUANTIFIER_PREFIX.get(str(block.get("quantifier") or "all"), "")
    if op in ("within", "outside"):
        body = f"{op} [{_number(block.get('bound'))}, {_number(block.get('bound2'))}]{unit}"
    elif op in ("is_true", "is_false"):
        body = op.replace("_", " ")
    else:
        body = f"{RULE_SYMBOLS.get(op, op)} {_number(block.get('bound'))}{unit}"
    return f"{prefix} {body}".strip()


def _result_reduction(block: dict) -> str:
    op = str(block.get("reduce_op") or "none")
    detail = block.get("reduce_detail") or {}
    window_s = detail.get("window_s")
    if op == "none":
        return "raw samples"
    text = op.replace("_", " ")
    if window_s:
        text += f" over {_number(window_s)} s"
    return f"{text} ({block.get('reduce_kind')})" if block.get("reduce_kind") else text


def result_frame(blocks: list[dict]) -> pd.DataFrame:
    """One row per evaluated criterion: actual against bound, with the tolerance."""
    rows = []
    for block in blocks or []:
        rows.append(
            {
                "id": block.get("criterion_id"),
                "verdict": verdict_label(block.get("verdict")),
                "signal": block.get("signal"),
                "group": block.get("channel_group"),
                "reduction": _result_reduction(block),
                "rule": _result_rule(block),
                "actual": _number(block.get("actual")),
                "bound (after tolerance)": _number(block.get("effective_bound")),
                "tolerance applied": _number(block.get("tolerance_applied")),
                "declared tolerance": format_tolerance(block.get("tolerance")),
                "samples": block.get("sample_count"),
                "min samples": block.get("min_samples"),
                "uncertainty s": _number(block.get("uncertainty_s")),
                "reason": block.get("reason_code") or "",
                "trace_key": block.get("trace_key"),
                "covers": block.get("requirement_ref") or "",
                "description": block.get("description"),
                "note": block.get("note") or "",
            }
        )
    return pd.DataFrame(rows)


def render_results(blocks: list[dict], caption: str | None = None) -> None:
    """The per-criterion actual-versus-bound table of spec 1.5."""
    if not blocks:
        st.caption("no criterion was evaluated for this case")
        return
    st.dataframe(result_frame(blocks), use_container_width=True, hide_index=True)
    if caption:
        st.caption(caption)


def results_by_criterion(results: list[dict]) -> dict[str, dict]:
    """Index a run's criterion blocks by ``criterion_id`` for the merge above.

    Several traces may contribute a block for the same criterion; the worst one is
    kept, because that is the verdict the run reports (worst-case combination, and
    a criterion that failed in one trace has failed).
    """
    severity = {"pass": 0, "skip": 1, "not_run": 2, "inconclusive": 3, "fail": 4, "error": 5}
    worst: dict[str, dict] = {}
    for result in results or []:
        for block in result.get("criteria") or []:
            criterion_id = str(block.get("criterion_id") or "")
            if not criterion_id:
                continue
            current = worst.get(criterion_id)
            if current is None or severity.get(str(block.get("verdict")), 0) > severity.get(
                str(current.get("verdict")), 0
            ):
                worst[criterion_id] = block
    return worst
