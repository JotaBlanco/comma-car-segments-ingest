"""🔴 The decoder and tm-connector must resolve the SAME run for the same file.

This is the one law of the Test Manager integration that nothing downstream can
detect on its own. The connector catalogues a file's signals in the registry
under the run it resolves; the sink writes that file's samples into a lake
partition named by the run the DECODER resolved. When the two differ:

* the registry holds a run whose catalogue is complete,
* the lake holds its rows under a run id nothing in the registry names,
* a query for the run answers nothing,
* and every step of the pipeline reports success.

So the two ladders are executed here side by side, over the same message, and
compared. `mf4-decoder/identity.py` and `tm-connector/connector/identity.py`
hold one ladder in two files; this is what keeps them one ladder.
"""

from __future__ import annotations

import pytest

import identity as decoder_identity
from connector.identity import resolve_identity as connector_resolve

PATTERN = r"TAS-\d+"
# What `provenance.py` writes for a field the file does not state. The mint must
# refuse it — see `test_a_sentinel_provenance_mints_nothing`.
UNKNOWN = "unknown"


def _decoder_run_id(declared, header, filename, provenance):
    """What the decoder puts in the `run_id` partition column."""
    _bag, run_id = decoder_identity.resolve_identity(
        declared, header, filename, PATTERN, provenance, UNKNOWN
    )
    return run_id


def _connector_run_id(declared, header, filename):
    """What tm-connector registers the file's run as."""
    return connector_resolve(declared, header, filename, PATTERN).run_id


def _both(declared, header, filename, provenance):
    """Run the decoder, then hand the connector what the decoder actually sent.

    The connector never sees the raw upload message: it sees the marker, whose
    `declared` bag is the one the decoder resolved. Passing the ORIGINAL bag
    here would test a message that is never produced.
    """
    bag, decoder_run = decoder_identity.resolve_identity(
        declared, header, filename, PATTERN, provenance, UNKNOWN
    )
    return decoder_run, _connector_run_id(bag, header, filename)


# --- the four rungs, each agreed on ----------------------------------------

CASES = [
    pytest.param(
        {"run_id": "R-DECLARED"},
        {"test.run_key": "R-HEADER"},
        "TAS-4242.mf4",
        {"platform": "HYUNDAI_IONIQ", "route": "0000000e--053ec37492"},
        "R-DECLARED",
        id="rung 1: the operator's assignment outranks every other channel",
    ),
    pytest.param(
        {},
        {"test.run_key": "R-HEADER"},
        "TAS-4242.mf4",
        {"platform": "HYUNDAI_IONIQ", "route": "0000000e--053ec37492"},
        "R-HEADER",
        id="rung 2: the file's own header beats its name",
    ),
    pytest.param(
        {},
        {},
        "TAS-4242.mf4",
        {"platform": "HYUNDAI_IONIQ", "route": "0000000e--053ec37492"},
        "TAS-4242",
        id="rung 3: the filename, when neither channel states one",
    ),
    pytest.param(
        {},
        {},
        "recording.mf4",
        {"platform": "HYUNDAI_IONIQ", "route": "0000000e--053ec37492"},
        "HYUNDAI_IONIQ_0000000e--053ec37492",
        id="rung 4: minted from the provenance the decoder alone can read",
    ),
]


@pytest.mark.parametrize("declared,header,filename,provenance,expected", CASES)
def test_the_two_apps_resolve_the_same_run(declared, header, filename, provenance, expected):
    decoder_run, connector_run = _both(declared, header, filename, provenance)

    assert decoder_run == expected
    assert connector_run == expected, (
        f"the decoder partitions this file under {decoder_run!r} and the registry "
        f"catalogues it under {connector_run!r}"
    )


def test_a_file_that_names_no_run_is_refused_by_both():
    """Neither invents one. The registry quarantines; the sink drops the rows."""
    decoder_run, connector_run = _both({}, {}, "recording.mf4", {"platform": UNKNOWN, "route": UNKNOWN})

    assert decoder_run is None
    assert connector_run is None


def test_a_sentinel_provenance_mints_nothing():
    """`unknown_unknown` would merge every provenance-less file into one run."""
    assert decoder_identity.mint_run_id({"platform": UNKNOWN, "route": "r"}, UNKNOWN) is None
    assert decoder_identity.mint_run_id({"platform": "p", "route": UNKNOWN}, UNKNOWN) is None
    assert decoder_identity.mint_run_id({"platform": "p"}, UNKNOWN) is None
    assert decoder_identity.mint_run_id({"platform": "p", "route": "r"}, UNKNOWN) == "p_r"


def test_the_minted_id_is_safe_as_a_partition_directory():
    """It becomes `run_id=<value>/`, so a separator in it would fork the tree."""
    minted = decoder_identity.mint_run_id(
        {"platform": "VW/MQB", "route": "a b--c"}, UNKNOWN
    )

    assert minted is not None
    assert "/" not in minted and " " not in minted


def test_the_default_pattern_is_the_one_the_connector_compiles():
    """Rung 3 is driven by a pattern both apps read. One default, not two."""
    from connector.config import DEFAULT_RUN_KEY_PATTERN

    assert decoder_identity.DEFAULT_RUN_KEY_PATTERN == DEFAULT_RUN_KEY_PATTERN


def test_an_uncompilable_pattern_degrades_the_same_way_in_both():
    """A bad configuration value must not make the two apps disagree.

    Both fall back to the default rather than disabling the filename rung — if
    one fell back and the other disabled it, a bad value would split every
    filename-named file between the registry and the lake.
    """
    bad = "(unclosed"
    bag, decoder_run = decoder_identity.resolve_identity(
        {}, {}, "TAS-77.mf4", bad, {"platform": UNKNOWN, "route": UNKNOWN}, UNKNOWN
    )
    connector_run = connector_resolve(bag, {}, "TAS-77.mf4", bad).run_id

    assert decoder_run == "TAS-77"
    assert connector_run == "TAS-77"
