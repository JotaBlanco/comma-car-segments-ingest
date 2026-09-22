"""Demo dressing: an UNKNOWN-rig run is sometimes dressed, always the same way.

The dice are the spec — sha1 of the run id — so the tests roll them
independently where an expectation needs computing, never by copying the
implementation's answer for a value the suite could not predict.
"""

import hashlib

from connector import dressing
from connector.dressing import BENCH_SOFTWARE, OPERATORS, RIG_CELLS, dress_run_body
from tests.conftest import complete_message, metadata_message

# Verified against the spec by test_the_examples_land_where_the_suite_says:
# sha1("RUN-1756220000000")[0] % 4 != 0, sha1("RUN-1756220000002")[0] % 4 == 0.
DRESSED_ID = "RUN-1756220000000"
HONEST_ID = "RUN-1756220000002"


def _body(run_id: str, **fields) -> dict:
    return {"run_id": run_id, "rig_id": "UNKNOWN", "source": "embedded", "actor": "t", **fields}


def test_the_examples_land_where_the_suite_says():
    """The two module-level example ids sit on the branches their names claim."""
    assert hashlib.sha1(DRESSED_ID.encode()).digest()[0] % dressing.HONEST_ONE_IN != 0
    assert hashlib.sha1(HONEST_ID.encode()).digest()[0] % dressing.HONEST_ONE_IN == 0


def test_the_same_run_always_dresses_the_same_way():
    """Redeliveries and both lanes must agree — the reason the dice are a hash."""
    assert dress_run_body(_body(DRESSED_ID)) == dress_run_body(_body(DRESSED_ID))


def test_a_dressed_run_wears_the_whole_outfit_from_the_pools():
    body = dress_run_body(_body(DRESSED_ID))

    assert (body["rig_id"], body["test_cell"]) in RIG_CELLS
    assert body["operator"] in OPERATORS
    assert body["bench_sw"] in BENCH_SOFTWARE


def test_an_honest_run_gains_nothing():
    """The kept beat: some runs still arrive honestly UNKNOWN, correctable by hand."""
    body = dress_run_body(_body(HONEST_ID))

    assert body["rig_id"] == "UNKNOWN"
    for invented in ("test_cell", "operator", "bench_sw"):
        assert invented not in body


def test_roughly_a_quarter_of_runs_stay_honest():
    """Across a wide window of minted-style ids the honest share is 1-in-4.

    Tight on purpose: a 15..35% band admits both `HONEST_ONE_IN = 3` and `= 5`
    (measured — both survive a loose window), so it would pin nothing about the
    rate it claims to describe. Over 4000 ids the exact share is 24.9%.
    """
    ids = [f"RUN-{1756220000000 + i}" for i in range(4000)]
    honest = sum(1 for rid in ids if dress_run_body(_body(rid))["rig_id"] == "UNKNOWN")

    assert 0.23 <= honest / len(ids) <= 0.27, honest / len(ids)


def test_every_rig_in_the_pool_is_actually_used():
    """The spread, not just the rate: collapsing RIG_CELLS to a single rig kept
    every other test in this suite green (mutation sweep, 26 Aug 2026), and the
    estate then reads as obviously synthetic — every run on one rig."""
    ids = [f"RUN-{1756220000000 + i}" for i in range(4000)]
    seen = {dress_run_body(_body(rid))["rig_id"] for rid in ids} - {"UNKNOWN"}

    assert seen == {rig for rig, _ in RIG_CELLS}


def test_each_dressed_field_draws_from_its_whole_pool():
    """Same guard for the other three: a pool that never varies is a pool that
    may as well be a constant, and the mutation sweep proved nothing caught it."""
    ids = [f"RUN-{1756220000000 + i}" for i in range(4000)]
    bodies = [dress_run_body(_body(rid)) for rid in ids]
    dressed = [body for body in bodies if body["rig_id"] != "UNKNOWN"]

    assert {body["test_cell"] for body in dressed} == {cell for _, cell in RIG_CELLS}
    assert {body["operator"] for body in dressed} == set(OPERATORS)
    assert {body["bench_sw"] for body in dressed} == set(BENCH_SOFTWARE)


def test_the_dressed_bench_software_matches_the_estates_family():
    """The seed states this family (api/seed/fixtures.py:71); a dressed run sits
    in the same table as seeded ones and must not read as a different fleet."""
    for version in BENCH_SOFTWARE:
        assert version.startswith("TAS 7.4."), version
        assert " · fw 2." in version, version


def test_a_stated_rig_is_never_touched():
    """Dressing fills silence only — a file with real metadata keeps all of it."""
    body = dress_run_body(_body(DRESSED_ID, rig_id="RIG-99"))

    assert body["rig_id"] == "RIG-99"
    for invented in ("test_cell", "operator", "bench_sw"):
        assert invented not in body


def test_a_stated_context_field_survives_on_a_dressed_run():
    """A declared operator outranks the pool even when the rig is dressed."""
    body = dress_run_body(_body(DRESSED_ID, operator="A. Bergström"))

    assert body["rig_id"] != "UNKNOWN"
    assert body["operator"] == "A. Bergström"


def test_a_run_with_no_id_is_left_alone():
    body = dress_run_body({"run_id": None, "rig_id": "UNKNOWN"})
    assert body["rig_id"] == "UNKNOWN"


def test_both_lanes_upsert_the_same_dress(connector, api):
    """The metadata-time upsert and the file-complete upsert of one run agree,
    because the dice sit in the one body builder both lanes share."""
    declared = {"run_id": DRESSED_ID}
    connector.on_metadata(metadata_message(declared=declared, filename="d.mf4"))
    connector.on_batch(
        complete_message(declared=declared, header_properties={}, file_name="d.mf4")
    )

    first, second = api.bodies("/test-runs")
    assert first["rig_id"] == second["rig_id"] != "UNKNOWN"
    assert first["operator"] == second["operator"]
    assert first["test_cell"] == second["test_cell"]
