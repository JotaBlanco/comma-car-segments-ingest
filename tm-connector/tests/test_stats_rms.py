"""`rms` rides the stats block like `sample_count`: forwarded when measured,
absent when not, never gating the four (API-CONTRACT §D)."""

from connector.inventory import _stats_block

FOUR = {"min": 1.0, "max": 6.0, "mean": 3.0, "std": 2.6458}


def test_a_measured_rms_is_forwarded_as_a_float():
    block = _stats_block({**FOUR, "rms": 3.6968})
    assert block["rms"] == 3.6968


def test_a_block_without_rms_is_still_legal_and_carries_no_key():
    block = _stats_block(dict(FOUR))
    assert block is not None
    assert "rms" not in block


def test_a_non_numeric_rms_is_dropped_without_dropping_the_block():
    block = _stats_block({**FOUR, "rms": "unknown"})
    assert block is not None
    assert "rms" not in block


def test_the_registry_model_accepts_the_rms_key():
    """The mirrored real model is the contract: an rms the API refuses would
    422 every file register that carries one."""
    from api.models.files import SignalStatsInput

    assert SignalStatsInput(**{**FOUR, "rms": 3.6968}).rms == 3.6968
