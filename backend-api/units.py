"""Unit algebra for pass criteria (spec 3.5).

A unit is parsed into base-exponent form so that ``m/s^2``, ``m*s^-2`` and
``m/(s^2)`` compare equal - the check must be about dimensions, not spelling.
Base tokens are opaque: ``kph`` is a base, not ``km/h``, because the signal
catalogue is authoritative about what a channel carries and no conversion is
ever applied to a bound.

Reduction transforms (schemas.md 3.1):

* ``derivative``          X -> X/s
* ``integral``            X -> X*s
* ``duration_true``       -> s
* ``count_edges``         -> 1 (dimensionless)
* ``time_between_edges``  -> s
* ``settling_time``       -> s
* everything else         identity
"""

import re

_TOKEN_RE = re.compile(r"^(?P<base>[A-Za-zµΩ°%][A-Za-z0-9_µΩ°%]*)(\^(?P<exp>-?[0-9]+))?$")
_DIMENSIONLESS = {"", "1", "-", "none", "unitless"}

# reduce.op -> exponent applied to seconds, or an absolute replacement unit.
SECOND_EXPONENT = {"derivative": -1, "integral": 1}
ABSOLUTE_UNIT = {
    "duration_true": "s",
    "count_edges": "1",
    "time_between_edges": "s",
    "settling_time": "s",
}

SERIES_OPS = frozenset({"none", "moving_average", "moving_min", "moving_max", "derivative"})


class UnitParseError(ValueError):
    """Raised when a unit string is not parseable base-exponent form."""


def parse(unit: str | None) -> dict[str, int]:
    """``"m/s^2"`` -> ``{"m": 1, "s": -2}``. Dimensionless -> ``{}``."""
    text = (unit or "").strip()
    if text.lower() in _DIMENSIONLESS:
        return {}
    text = text.replace("·", "*").replace("(", "").replace(")", "")
    if text.count("/") > 1:
        raise UnitParseError(f"unit {unit!r} has more than one '/'")
    numerator, _, denominator = text.partition("/")
    exponents: dict[str, int] = {}
    for part, sign in ((numerator, 1), (denominator, -1)):
        for token in part.split("*"):
            token = token.strip()
            if not token or token == "1":
                continue
            match = _TOKEN_RE.match(token)
            if match is None:
                raise UnitParseError(f"unit {unit!r} contains unparseable token {token!r}")
            base = match.group("base")
            exponent = int(match.group("exp") or 1) * sign
            exponents[base] = exponents.get(base, 0) + exponent
    return {base: exp for base, exp in exponents.items() if exp != 0}


def render(exponents: dict[str, int]) -> str:
    """Canonical rendering of base-exponent form, for error messages."""
    if not exponents:
        return "1"
    positives = sorted(base for base, exp in exponents.items() if exp > 0)
    negatives = sorted(base for base, exp in exponents.items() if exp < 0)
    numerator = "*".join(
        base if exponents[base] == 1 else f"{base}^{exponents[base]}" for base in positives
    ) or "1"
    if not negatives:
        return numerator
    denominator = "*".join(
        base if -exponents[base] == 1 else f"{base}^{-exponents[base]}" for base in negatives
    )
    return f"{numerator}/{denominator}"


def transform(signal_unit: str | None, reduce_op: str) -> dict[str, int]:
    """The unit a reduction produces from a signal's catalogue unit."""
    if reduce_op in ABSOLUTE_UNIT:
        return parse(ABSOLUTE_UNIT[reduce_op])
    exponents = dict(parse(signal_unit))
    seconds = SECOND_EXPONENT.get(reduce_op)
    if seconds is not None:
        exponents["s"] = exponents.get("s", 0) + seconds
        if exponents["s"] == 0:
            del exponents["s"]
    return exponents


def equal(left: str | None, right: str | None) -> bool:
    return parse(left) == parse(right)


def is_series(reduce_op: str) -> bool:
    """Whether a reduction yields a series (needing a quantifier) or a scalar."""
    return reduce_op in SERIES_OPS
