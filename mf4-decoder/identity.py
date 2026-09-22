"""The run key, resolved the same way here as in tm-connector.

🔴 THE DECODER AND THE CONNECTOR MUST LAND ON THE SAME ANSWER.

The connector catalogues a run's signals in the registry; this decoder writes
that run's samples into a lake partition named `run_id=<value>/`. When the two
disagree the registry holds a run whose catalogue is complete while the lake
holds its rows somewhere else, a query for the run answers nothing, and no step
of the pipeline reports an error. Nothing downstream can detect it either: both
halves look perfectly normal on their own.

So the ladder below is `tm-connector/connector/identity.py::resolve_run_key`,
rung for rung, over the same message:

1. `declared.run_id` — an operator's assignment, made before any byte was
   written. It outranks the bytes on purpose: a re-upload with a corrected id
   would otherwise be impossible without editing the file.
2. `header_properties["test.run_key"]` — a producer that states the run INSIDE
   the file. A measured property of these bytes, so it beats a filename.
3. the filename, via `TM_RUN_KEY_PATTERN` — the last resort, and the same
   pattern the connector compiles.

A fourth rung exists here and nowhere else, because nothing upstream can reach
it: rungs 1-3 are silent for an ordinary comma recording, whose identity lives
in its own provenance block. `mint_run_id` builds `<platform>_<route>` from the
`<common_properties>` the decoder has just read, so every SEGMENT of one route
lands in one run — the unit an engineer actually reasons about.

The minted id is written back into the `declared` bag the decoder forwards, so
the connector reads it on RUNG 1 and cannot climb to a different answer. That is
the whole reason the mint lives in the bag rather than in a field of its own.
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger("mf4-decoder.identity")

# The connector's default, and the fallback when the configured pattern does not
# compile (`connector/config.py::DEFAULT_RUN_KEY_PATTERN`).
DEFAULT_RUN_KEY_PATTERN = r"TAS-\d+"

# The `<common_properties>` key a producer states a run key in. It is the
# connector's `test.run_key` (`connector/identity.py::HEADER_RUN_FIELDS`); the
# spelling is shared, so a rename has to happen in both files.
HEADER_RUN_KEY = "test.run_key"

# Everything the run key is minted from. Both are provenance columns the decoder
# already resolves, and both are the literal "unknown" when the file states none
# (`provenance.UNKNOWN`) — which is exactly when a mint must NOT happen.
MINT_FROM = ("platform", "route")

# A minted id becomes a lake partition directory, so it is path-safe by
# construction. Anything outside this set collapses to "_".
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _clean(value: object) -> str | None:
    """A usable id is a non-empty string. Anything else is absent."""
    if not isinstance(value, str):
        return None
    return value.strip() or None


def _run_key_pattern(pattern: str) -> re.Pattern[str]:
    """Compile the configured pattern, or the default when it cannot be used.

    A `TM_RUN_KEY_PATTERN` that does not compile falls back rather than DISABLING
    the filename rung — the connector takes the same decision for the same
    reason, and a decoder that disabled the rung while the connector kept it is
    precisely the disagreement this module exists to prevent.
    """
    if pattern and pattern.strip():
        try:
            return re.compile(pattern)
        except re.error as error:
            logger.warning("the run key pattern %r does not compile: %s", pattern, error)
    return re.compile(DEFAULT_RUN_KEY_PATTERN)


def find_run_key(filename: str, pattern: str) -> str | None:
    """Rung 3: read the run key out of the filename."""
    match = _run_key_pattern(pattern).search(filename or "")
    if match is None:
        return None
    # A pattern that can match nothing matches at position 0 and yields "" — an
    # id the registry stores happily and no query ever finds.
    return match.group(0) or None


def mint_run_id(provenance: dict[str, str], unknown: str) -> str | None:
    """Rung 4: `<platform>_<route>`, or None when the file names neither.

    Minting from a sentinel would file every provenance-less upload under one
    id — `unknown_unknown` — and merge unrelated recordings into a single run.
    A file that states nothing gets no run, which the registry answers with its
    deliberate quarantine and a human `PATCH`.
    """
    parts = [provenance.get(name) for name in MINT_FROM]
    if any(part is None or part == unknown or not str(part).strip() for part in parts):
        return None
    return _UNSAFE.sub("_", "_".join(str(part).strip() for part in parts)).strip("._-") or None


def resolve_run_key(
    declared: object,
    header_properties: object,
    filename: str,
    run_key_pattern: str,
) -> str | None:
    """Rungs 1-3, exactly as the connector climbs them. None means unresolved."""
    if isinstance(declared, dict):
        stated = _clean(declared.get("run_id"))
        if stated is not None:
            return stated
    if isinstance(header_properties, dict):
        stated = _clean(header_properties.get(HEADER_RUN_KEY))
        if stated is not None:
            return stated
    return find_run_key(filename, run_key_pattern)


def resolve_identity(
    declared: object,
    header_properties: object,
    filename: str,
    run_key_pattern: str,
    provenance: dict[str, str],
    unknown: str,
) -> tuple[dict[str, str], str | None]:
    """The `declared` bag every message carries, and the run id inside it.

    Returns the bag with `run_id` settled — the caller forwards it verbatim, and
    every reader downstream takes the run from rung 1 of its own ladder.
    """
    bag = dict(declared) if isinstance(declared, dict) else {}
    run_id = resolve_run_key(bag, header_properties, filename, run_key_pattern)
    if run_id is None:
        run_id = mint_run_id(provenance, unknown)
        if run_id is not None:
            logger.info(
                "%s declared no run and its header states none; minted %s from its provenance",
                filename,
                run_id,
            )
    if run_id is not None:
        bag["run_id"] = run_id
    else:
        logger.warning(
            "%s resolves to no run: nothing declared one, its header states none, "
            "the filename matches no pattern and its provenance names no platform/route. "
            "Its rows cannot be placed in the lake and the registry will quarantine it.",
            filename,
        )
    return bag, run_id
