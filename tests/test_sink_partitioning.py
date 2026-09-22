"""What the lake sink writes, and what it refuses to write.

Three rules, each with a failure mode that is silent if it breaks:

* the terminal marker is SKIPPED — expanding it reads `ts_ms` on a message that
  has none, which stalls the checkpoint on a perfectly valid message;
* a batch naming no run is DROPPED — `run_id=unknown/` is a directory that looks
  like a real run and would hold every unplaceable file in the estate;
* an unclaimed batch is `unassigned`, never null — a null partition value is
  dropped by the groupby and the row vanishes without an error.
"""

from __future__ import annotations

import pytest


@pytest.fixture(scope="module")
def sink():
    """The sink's rules, imported directly.

    They live in `expand.py` rather than `main.py` precisely so this import
    needs no broker: `main.py`'s module body resolves the input topic's metadata
    against a live cluster before it has defined anything worth testing.
    """
    import expand

    return expand


def _batch(**overrides):
    batch = {
        "kind": "samples",
        "file_name": "drive.mf4",
        "upload_id": "drive-7a96",
        "platform": "HYUNDAI_IONIQ",
        "run_id": "HYUNDAI_IONIQ_0000000e--053ec37492",
        "work_order": "WO-2026-0851",
        "test_definition": "TD-BAT-THERM",
        "signal": "ACCMode",
        "unit": "",
        "ts_ms": [1000, 1100],
        "value": [1.0, 2.0],
        "value_text": [None, None],
    }
    batch.update(overrides)
    return batch


# --- the kind filter --------------------------------------------------------


def test_a_sample_batch_is_written(sink):
    assert sink.is_sample_batch(_batch()) is True


def test_the_terminal_marker_is_skipped(sink):
    """It carries an inventory and no samples. It is tm-connector's message."""
    assert sink.is_sample_batch({"kind": "file_complete", "batch": {"inventory": []}}) is False


def test_a_batch_with_no_kind_is_still_written(sink):
    """The pre-integration decoder wrote no `kind`, and `earliest` replays it.

    The filter refuses the MARKER specifically. Demanding `kind == "samples"`
    would silently drop the whole backlog the topic already holds.
    """
    batch = _batch()
    del batch["kind"]

    assert sink.is_sample_batch(batch) is True


# --- the run, and what its absence costs ------------------------------------


def test_the_traceability_columns_reach_every_row(sink):
    rows = list(sink._expand_columnar(_batch()))

    assert len(rows) == 2
    for row in rows:
        assert row["run_id"] == "HYUNDAI_IONIQ_0000000e--053ec37492"
        assert row["work_order"] == "WO-2026-0851"
        assert row["test_definition"] == "TD-BAT-THERM"


@pytest.mark.parametrize("run_id", [None, "", "   ", "unknown"])
def test_a_batch_that_names_no_run_is_dropped(sink, run_id):
    """Not defaulted. `run_id=unknown/` would read as a real run on screen."""
    assert list(sink._expand_columnar(_batch(run_id=run_id))) == []


def test_an_unclaimed_batch_partitions_as_unassigned(sink):
    """Nobody claimed it — a fact, not a fault, and never a null."""
    rows = list(sink._expand_columnar(_batch(work_order=None, test_definition=None)))

    assert rows
    for row in rows:
        assert row["work_order"] == "unassigned"
        assert row["test_definition"] == "unassigned"


def test_unassigned_is_not_the_same_word_as_unknown(sink):
    """"Nobody assigned this" and "the file states none" are different facts."""
    assert sink.UNASSIGNED != sink.UNKNOWN


# --- the platform, and its fallback -----------------------------------------


def test_the_file_s_own_platform_wins(sink):
    """The MF4 header measured it; a work order only asserts it."""
    rows = list(
        sink._expand_columnar(
            _batch(platform="HYUNDAI_IONIQ", _work_order_platform="TOYOTA_RAV4")
        )
    )

    assert rows[0]["platform"] == "HYUNDAI_IONIQ"


def test_the_work_order_platform_fills_in_for_a_file_that_states_none(sink):
    rows = list(
        sink._expand_columnar(_batch(platform="unknown", _work_order_platform="TOYOTA_RAV4"))
    )

    assert rows[0]["platform"] == "TOYOTA_RAV4"


def test_neither_source_leaves_unknown_rather_than_null(sink):
    rows = list(sink._expand_columnar(_batch(platform=None)))

    assert rows[0]["platform"] == "unknown"


def test_the_work_order_key_is_read_defensively(sink):
    """An unmatched lookup fills the default; it must never raise."""
    assert sink.work_order_target_key(_batch()) == "WO-2026-0851"
    assert sink.work_order_target_key(_batch(work_order=None)) == ""
    assert sink.work_order_target_key("not a dict") == ""


# --- the partition tree the deployment declares ------------------------------


def test_the_declared_tree_is_the_traceability_chain():
    """quix.yaml, the sink's default and the frontend's two halves are one tree."""
    import yaml

    with open("quix.yaml") as handle:
        project = yaml.safe_load(handle)

    def variables(name):
        deployment = next(d for d in project["deployments"] if d["name"] == name)
        return {v["name"]: v.get("value") for v in deployment.get("variables", [])}

    sink_tree = variables("MF4 DataLake Sink")["HIVE_COLUMNS"]
    frontend = variables("Test Manager - Frontend")

    assert sink_tree.startswith("platform,work_order,test_definition,run_id")
    # The frontend walks the same tree in two halves: the levels that ADDRESS a
    # session, then the levels INSIDE one. Their concatenation is the sink's.
    head = frontend["TM_LAKE_SESSION_PARTITIONS"]
    tail = frontend["TM_LAKE_DATA_PARTITIONS"]
    assert f"{head},{tail}" == sink_tree
