"""R-07 — an empty thing is not a thing.

Two defects, one shape. The front end builds a filter with
``URLSearchParams.append``, so a cleared filter chip still sends its key and
the value arrives as ``[""]``. The list helpers read ``[""]`` as a real value,
built ``{"$in": [""]}`` and emptied the table with no error.

The second defect is the search box. ``/files`` and ``/signals`` matched one
escaped substring, so a two-word query found nothing. Both now call
``every_word_matches``, the same helper ``/test-runs`` and ``/work-orders``
already use.

Style follows tests/test_table_filters_test_runs.py.
"""

from datetime import UTC, datetime

from tests.factories import register_file
from tests.factories_planning import make_run, make_work_order
from tests.factories_signals import make_signal

BASE_AT = datetime(2026, 8, 14, 9, 0, tzinfo=UTC)


def _get(client, path: str, **params) -> dict:
    return client.get(f"/api/v1{path}", params=params or None).json()


def _seed_runs(db) -> None:
    """Two runs on two rigs and two projects."""
    db["test_runs"].insert_many(
        [
            make_run(run_id="TAS-88214", rig_id="RIG-04", project="EX90"),
            make_run(run_id="TAS-88213", rig_id="RIG-02", project="EC40"),
        ]
    )


def _seed_work_orders(db) -> None:
    db["work_orders"].insert_many(
        [
            make_work_order(wo_id="WO-2026-0847", project="EX90", status="active"),
            make_work_order(wo_id="WO-2026-0839", project="EC40", status="closed"),
        ]
    )


# --- a blank filter value filters nothing -----------------------------------


def test_a_blank_rig_returns_every_run(client, routed_db) -> None:
    _seed_runs(routed_db)

    assert _get(client, "/test-runs", rig="")["total"] == 2


def test_a_blank_project_returns_every_run(client, routed_db) -> None:
    _seed_runs(routed_db)

    assert _get(client, "/test-runs", project="")["total"] == 2


def test_a_whitespace_rig_returns_every_run(client, routed_db) -> None:
    _seed_runs(routed_db)

    assert _get(client, "/test-runs", rig="   ")["total"] == 2


def test_a_blank_project_returns_every_work_order(client, routed_db) -> None:
    _seed_work_orders(routed_db)

    assert _get(client, "/work-orders", project="")["total"] == 2


def test_a_blank_unit_returns_every_signal(client, routed_db) -> None:
    make_signal(routed_db, "HV_Batt_Cell_Temp_Max")
    make_signal(routed_db, "Coolant_Inlet_Temp")

    assert _get(client, "/signals", unit="")["total"] == 2


def test_a_blank_rig_returns_every_signal(client, routed_db) -> None:
    make_signal(routed_db, "HV_Batt_Cell_Temp_Max")
    make_signal(routed_db, "Coolant_Inlet_Temp")

    assert _get(client, "/signals", rig="")["total"] == 2


def test_a_real_value_beside_a_blank_one_still_filters(client, routed_db) -> None:
    """The strip drops the blank. It never drops the whole filter."""
    _seed_runs(routed_db)

    body = _get(client, "/test-runs", rig=["", "RIG-04"])

    assert [item["run_id"] for item in body["items"]] == ["TAS-88214"]


def test_a_real_filter_value_still_filters(client, routed_db) -> None:
    """The regression pin: the fix must not turn a good filter off."""
    _seed_runs(routed_db)

    assert _get(client, "/test-runs", rig="RIG-02")["total"] == 1


# --- a two-word search matches a row that holds both words ------------------


def test_two_words_match_one_file(client, routed_db) -> None:
    register_file(routed_db, filename="probe_unreadable_b.mf4", run_id="TAS-88214")
    register_file(routed_db, filename="bat_cyc_20260814_0941.mf4", run_id="TAS-88213")

    body = _get(client, "/files", q="probe b")

    assert [item["filename"] for item in body["items"]] == ["probe_unreadable_b.mf4"]


def test_two_words_match_across_the_file_fields(client, routed_db) -> None:
    """One word matches the filename, the other matches the run id."""
    register_file(routed_db, filename="probe_unreadable_b.mf4", run_id="TAS-88214")
    register_file(routed_db, filename="probe_unreadable_b.mf4", run_id="TAS-88213")

    body = _get(client, "/files", q="probe TAS-88213")

    assert body["total"] == 1
    assert body["items"][0]["run_id"] == "TAS-88213"


def test_two_words_match_one_signal(client, routed_db) -> None:
    make_signal(
        routed_db,
        "Coolant_Inlet_Temp",
        description="Coolant temperature at pack inlet",
    )
    make_signal(routed_db, "HV_Batt_Cell_Temp_Max", description="Cell temperature")

    body = _get(client, "/signals", q="temperature pack")

    assert [item["name"] for item in body["items"]] == ["Coolant_Inlet_Temp"]


def test_the_search_words_may_arrive_in_any_order(client, routed_db) -> None:
    make_signal(
        routed_db,
        "Coolant_Inlet_Temp",
        description="Coolant temperature at pack inlet",
    )

    first = _get(client, "/signals", q="Coolant Inlet")
    second = _get(client, "/signals", q="Inlet Coolant")

    assert first["total"] == 1
    assert second["total"] == 1


def test_a_word_that_matches_nothing_still_empties_the_result(client, routed_db) -> None:
    """Word-AND, not word-OR. Every word must match."""
    make_signal(routed_db, "Coolant_Inlet_Temp", description="Coolant temperature")

    assert _get(client, "/signals", q="Coolant zzz")["total"] == 0


def test_a_blank_search_filters_nothing(client, routed_db) -> None:
    """An empty word list would build an empty $and, which Mongo rejects."""
    register_file(routed_db, filename="probe_unreadable_b.mf4")
    make_signal(routed_db, "Coolant_Inlet_Temp")

    assert _get(client, "/files", q="  ")["total"] == 1
    assert _get(client, "/signals", q="  ")["total"] == 1
