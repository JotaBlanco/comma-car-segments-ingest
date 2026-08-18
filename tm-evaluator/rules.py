"""Rule evaluation: the closed ``rule.op`` set, tolerance and the quantifier.

``rule = {op, value, value2?, quantifier}`` with
``op in lt le gt ge eq ne within outside is_true is_false equals_enum`` and
``quantifier in all any none`` (default ``all``).

The quantifier is what distinguishes "always within the bound" from "eventually
reaches" for a series-valued reduction, and it is reported on every criterion so a
reader never has to guess which one produced the verdict.

Tolerance is an **explicit, reported relaxation of the bound**: ``tol = abs +
rel * |value|``, applied once, in the direction the operator implies, and the
resulting ``effective_bound`` is carried into the result and printed in the report.
``null`` means zero. Nothing else in the evaluator ever moves a bound - no fudge
factors, and measurement uncertainty is reported beside the verdict, never
subtracted from the limit.

``actual`` is the **deciding** sample, not an average: for ``all`` it is the worst
sample (the one that would fail first), for ``any`` the best, for ``none`` the worst
offender. A criterion that fails should name the number that failed it.
"""

import math

import numpy as np

QUANTIFIERS = ("all", "any", "none")
OPS = (
    "lt", "le", "gt", "ge", "eq", "ne", "within", "outside", "is_true", "is_false",
    "equals_enum",
)


class RuleError(ValueError):
    """A malformed rule that the schema could not reject."""


def tolerance_of(criterion: dict) -> tuple[float, float]:
    tolerance = criterion.get("tolerance") or {}
    absolute = tolerance.get("abs")
    relative = tolerance.get("rel")
    return (float(absolute) if absolute is not None else 0.0,
            float(relative) if relative is not None else 0.0)


def effective_bounds(rule: dict, criterion: dict) -> tuple[float | None, float | None, float]:
    """The bound(s) after tolerance, plus the tolerance actually applied."""
    op = rule.get("op")
    absolute, relative = tolerance_of(criterion)
    raw = rule.get("value")
    raw2 = rule.get("value2")

    if op in ("is_true", "is_false"):
        # A boolean has no neighbourhood; relaxing it is meaningless.
        return None, None, 0.0
    if op == "equals_enum":
        # An enum value is compared exactly; tolerance is ignored on purpose.
        if raw is None:
            raise RuleError("rule op 'equals_enum' needs a 'value'")
        return float(raw), None, 0.0

    if raw is None:
        raise RuleError(f"rule op {op!r} needs a numeric 'value'")
    bound = float(raw)
    tol = absolute + relative * abs(bound)

    if op in ("lt", "le"):
        return bound + tol, None, tol
    if op in ("gt", "ge"):
        return bound - tol, None, tol
    if op in ("eq", "ne"):
        return bound, None, tol
    if op in ("within", "outside"):
        if raw2 is None:
            raise RuleError(f"rule op {op!r} needs 'value2'")
        low, high = sorted((bound, float(raw2)))
        if op == "within":
            return low - tol, high + tol, tol
        # Relaxing "outside" shrinks the forbidden band rather than widening it.
        return low + tol, high - tol, tol
    raise RuleError(f"unknown rule op {op!r}")


def _satisfies(values: np.ndarray, op: str, bound, bound2, tol: float) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        if op == "lt":
            result = values < bound
        elif op == "le":
            result = values <= bound
        elif op == "gt":
            result = values > bound
        elif op == "ge":
            result = values >= bound
        elif op == "eq":
            result = np.abs(values - bound) <= tol
        elif op == "ne":
            result = np.abs(values - bound) > tol
        elif op == "within":
            result = (values >= bound) & (values <= bound2)
        elif op == "outside":
            result = (values < bound) | (values > bound2)
        elif op == "is_true":
            result = values != 0
        elif op == "is_false":
            result = values == 0
        elif op == "equals_enum":
            result = values == float(bound)
        else:
            raise RuleError(f"unknown rule op {op!r}")
    return np.asarray(result) & np.isfinite(values)


def _deciding_value(values: np.ndarray, satisfied: np.ndarray, quantifier: str,
                    op: str) -> float:
    """The sample that decides the verdict, so ``actual`` names it."""
    if values.size == 0:
        return float("nan")
    if quantifier == "all":
        violating = values[~satisfied]
        pool = violating if violating.size else values
        return float(_extremum(pool, op, worst=True))
    if quantifier == "any":
        passing = values[satisfied]
        pool = passing if passing.size else values
        return float(_extremum(pool, op, worst=False))
    # "none": the worst offender is a satisfying sample, because satisfying the
    # inner predicate is what makes the criterion fail.
    offending = values[satisfied]
    pool = offending if offending.size else values
    return float(_extremum(pool, op, worst=True))


def _extremum(values: np.ndarray, op: str, worst: bool) -> float:
    """Which end of the distribution is "worst" depends on the operator."""
    if values.size == 0:
        return float("nan")
    if op in ("lt", "le", "within", "eq", "is_false", "equals_enum"):
        return np.max(values) if worst else np.min(values)
    if op in ("gt", "ge", "is_true", "ne", "outside"):
        return np.min(values) if worst else np.max(values)
    return np.max(values) if worst else np.min(values)


def evaluate(criterion: dict, reduction) -> dict:
    """Judge one reduction against one rule. Returns the criterion result block."""
    rule = criterion.get("rule") or {}
    op = rule.get("op")
    if op not in OPS:
        raise RuleError(f"unknown rule op {op!r}")
    quantifier = rule.get("quantifier") or "all"
    if quantifier not in QUANTIFIERS:
        raise RuleError(f"unknown quantifier {quantifier!r}")

    bound, bound2, tol = effective_bounds(rule, criterion)
    values = reduction.finite_values()
    min_samples = int(criterion.get("min_samples") or 1)

    block = {
        "criterion_id": criterion.get("criterion_id"),
        "description": criterion.get("description"),
        "signal": criterion.get("signal"),
        "channel_group": criterion.get("channel_group"),
        "reduce_op": reduction.op,
        "reduce_kind": reduction.kind,
        "rule_op": op,
        "quantifier": quantifier,
        "unit": criterion.get("unit"),
        "bound": rule.get("value"),
        "bound2": rule.get("value2"),
        "effective_bound": bound,
        "effective_bound2": bound2,
        "tolerance": criterion.get("tolerance"),
        "tolerance_applied": tol,
        "sample_count": int(reduction.sample_count),
        "min_samples": min_samples,
        "requirement_ref": criterion.get("requirement_ref"),
        "reduce_detail": _jsonable(reduction.detail),
    }

    if values.size == 0:
        block.update(
            verdict="inconclusive",
            reason_code="window_never_satisfied",
            actual=None,
            note=(
                "the reduction produced no finite value in the evaluation window; "
                "there is nothing to compare against the bound"
            ),
        )
        return block

    if values.size < min_samples:
        block.update(
            verdict="inconclusive",
            reason_code="insufficient_samples",
            actual=float(values[0]) if values.size == 1 else None,
            note=f"{values.size} finite sample(s) in the window, min_samples is {min_samples}",
        )
        return block

    satisfied = _satisfies(values, op, bound, bound2, tol)
    if quantifier == "all":
        passed = bool(np.all(satisfied))
    elif quantifier == "any":
        passed = bool(np.any(satisfied))
    else:
        passed = not bool(np.any(satisfied))

    block.update(
        verdict="pass" if passed else "fail",
        reason_code=None if passed else "criterion_violated",
        actual=_round(_deciding_value(values, satisfied, quantifier, op)),
        satisfied_samples=int(np.count_nonzero(satisfied)),
    )
    return block


def _round(value: float) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(float(value), 6)


def _jsonable(detail: dict) -> dict:
    """Numpy scalars and tuples are not JSON; the result document must be."""
    out = {}
    for key, value in (detail or {}).items():
        if key == "spans":
            out[key] = [[float(start), float(end)] for start, end in value]
        elif isinstance(value, np.integer):
            out[key] = int(value)
        elif isinstance(value, np.floating):
            out[key] = float(value)
        else:
            out[key] = value
    return out
