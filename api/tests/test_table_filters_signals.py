"""Table-filters coverage for GET /signals (contract §2.2, §2.3, §2.4).

* multi-value ``unit`` / ``rate`` / ``rig`` — OR within a key, AND across
  keys; single-value calls stay byte-identical.
* ``sort`` whitelist ``name`` / ``typical_rate_hz`` / ``run_count`` /
  ``last_seen``. Default sort is **``last_seen desc``** (decision box 1,
  closed — this replaces the pre-change ``name asc``). ``name`` maps to
  Mongo's ``_id`` because the signal name *is* the doc id.
* view_counts keys ``{"all", "missing_unit"}`` — whole-table and
  filter-independent.

Style follows tests/test_signals_list.py exactly.
"""

from datetime import UTC, datetime, timedelta

from tests import factories_signals
from tests.factories_signals import make_signal

signals_db = factories_signals.signals_db

BASE_AT = datetime(2026, 8, 14, 9, 0, tzinfo=UTC)


def _get(client, **params) -> dict:
    response = client.get("/api/v1/signals", params=params)
    assert response.status_code == 200
    return response.json()


def _names(body: dict) -> list[str]:
    return [item["name"] for item in body["items"]]


def _seed_catalogue(db) -> None:
    """Seven signals across three rigs, three units and three rates."""
    make_signal(
        db,
        "Cell_Temp_C_Rig04",
        unit="°C",
        rig_ids=["RIG-04"],
        typical_rate_hz=100.0,
        run_count=8,
        last_seen=BASE_AT + timedelta(hours=6),
    )
    make_signal(
        db,
        "Coolant_Flow_Rate",
        unit="l/min",
        rig_ids=["RIG-04"],
        typical_rate_hz=10.0,
        run_count=5,
        last_seen=BASE_AT + timedelta(hours=5),
    )
    make_signal(
        db,
        "EM_Rotor_Temp",
        unit="°C",
        rig_ids=["RIG-02"],
        typical_rate_hz=100.0,
        run_count=12,
        last_seen=BASE_AT + timedelta(hours=4),
    )
    make_signal(
        db,
        "Pack_Press_Bar_Rig07",
        unit="bar",
        rig_ids=["RIG-07"],
        typical_rate_hz=1.0,
        run_count=3,
        last_seen=BASE_AT + timedelta(hours=3),
    )
    # Two rows with no unit at all — the "missing_unit" quick view.
    make_signal(
        db,
        "Chamber_Humidity",
        unit=None,
        rig_ids=["RIG-04"],
        typical_rate_hz=1.0,
        run_count=2,
        last_seen=BASE_AT + timedelta(hours=2),
    )
    make_signal(
        db,
        "Undefined_Probe",
        unit=None,
        rig_ids=["RIG-02"],
        typical_rate_hz=10.0,
        run_count=1,
        last_seen=BASE_AT + timedelta(hours=1),
    )
    make_signal(
        db,
        "AAA_First_By_Name",
        unit="bar",
        rig_ids=["RIG-04"],
        typical_rate_hz=10.0,
        run_count=9,
        last_seen=BASE_AT,
    )


# --- multi-value filters (§2.2) --------------------------------------------


def test_unit_two_values_return_the_union(client, signals_db) -> None:
    _seed_catalogue(signals_db)

    body = _get(client, unit=["°C", "bar"])

    assert set(_names(body)) == {
        "Cell_Temp_C_Rig04",
        "EM_Rotor_Temp",
        "Pack_Press_Bar_Rig07",
        "AAA_First_By_Name",
    }


def test_rate_two_values_return_the_union(client, signals_db) -> None:
    _seed_catalogue(signals_db)

    body = _get(client, rate=[100, 1])

    assert set(_names(body)) == {
        "Cell_Temp_C_Rig04",
        "EM_Rotor_Temp",
        "Pack_Press_Bar_Rig07",
        "Chamber_Humidity",
    }


def test_rig_two_values_return_the_union(client, signals_db) -> None:
    _seed_catalogue(signals_db)

    body = _get(client, rig=["RIG-02", "RIG-07"])

    assert set(_names(body)) == {"EM_Rotor_Temp", "Pack_Press_Bar_Rig07", "Undefined_Probe"}


def test_unit_and_rig_combine_with_and(client, signals_db) -> None:
    _seed_catalogue(signals_db)

    body = _get(client, unit="°C", rig=["RIG-04"])

    assert _names(body) == ["Cell_Temp_C_Rig04"]


def test_unit_single_value_matches_pre_change_behavior(client, signals_db) -> None:
    _seed_catalogue(signals_db)

    body = _get(client, unit="bar")

    assert set(_names(body)) == {"Pack_Press_Bar_Rig07", "AAA_First_By_Name"}


def test_rig_single_value_matches_pre_change_behavior(client, signals_db) -> None:
    _seed_catalogue(signals_db)

    body = _get(client, rig="RIG-07")

    assert _names(body) == ["Pack_Press_Bar_Rig07"]


def test_absent_filters_return_the_whole_collection(client, signals_db) -> None:
    _seed_catalogue(signals_db)

    body = _get(client)

    assert body["total"] == 7


# --- sort params (§2.3) -----------------------------------------------------


def test_default_sort_is_last_seen_desc(client, signals_db) -> None:
    """Decision box 1 (closed): default is `last_seen desc`, not `name asc`."""
    _seed_catalogue(signals_db)

    body = _get(client)

    assert _names(body) == [
        "Cell_Temp_C_Rig04",
        "Coolant_Flow_Rate",
        "EM_Rotor_Temp",
        "Pack_Press_Bar_Rig07",
        "Chamber_Humidity",
        "Undefined_Probe",
        "AAA_First_By_Name",
    ]


def test_sort_by_name_asc(client, signals_db) -> None:
    """`name` maps to Mongo's `_id`; per-key default direction is asc."""
    _seed_catalogue(signals_db)

    body = _get(client, sort="name", order="asc")

    assert _names(body) == sorted(
        [
            "Cell_Temp_C_Rig04",
            "Coolant_Flow_Rate",
            "EM_Rotor_Temp",
            "Pack_Press_Bar_Rig07",
            "Chamber_Humidity",
            "Undefined_Probe",
            "AAA_First_By_Name",
        ]
    )


def test_sort_by_name_desc(client, signals_db) -> None:
    _seed_catalogue(signals_db)

    body = _get(client, sort="name", order="desc")

    assert _names(body) == sorted(
        [
            "Cell_Temp_C_Rig04",
            "Coolant_Flow_Rate",
            "EM_Rotor_Temp",
            "Pack_Press_Bar_Rig07",
            "Chamber_Humidity",
            "Undefined_Probe",
            "AAA_First_By_Name",
        ],
        reverse=True,
    )


def test_sort_by_typical_rate_hz_desc(client, signals_db) -> None:
    _seed_catalogue(signals_db)

    body = _get(client, sort="typical_rate_hz", order="desc")

    # 100 Hz rows come first (two), then 10 Hz (three), then 1 Hz (two).
    rates = [item["typical_rate_hz"] for item in body["items"]]
    assert rates == sorted(rates, reverse=True)


def test_sort_by_typical_rate_hz_asc(client, signals_db) -> None:
    _seed_catalogue(signals_db)

    body = _get(client, sort="typical_rate_hz", order="asc")

    rates = [item["typical_rate_hz"] for item in body["items"]]
    assert rates == sorted(rates)


def test_sort_by_run_count_desc(client, signals_db) -> None:
    _seed_catalogue(signals_db)

    body = _get(client, sort="run_count", order="desc")

    assert [item["name"] for item in body["items"][:3]] == [
        "EM_Rotor_Temp",
        "AAA_First_By_Name",
        "Cell_Temp_C_Rig04",
    ]


def test_sort_by_run_count_asc(client, signals_db) -> None:
    _seed_catalogue(signals_db)

    body = _get(client, sort="run_count", order="asc")

    counts = [item["run_count"] for item in body["items"]]
    assert counts == sorted(counts)


def test_sort_by_last_seen_asc_reverses_the_default(client, signals_db) -> None:
    _seed_catalogue(signals_db)

    default = _get(client)
    reversed_ = _get(client, sort="last_seen", order="asc")

    assert _names(reversed_) == list(reversed(_names(default)))


def test_ties_break_deterministically_by_id_asc(client, signals_db) -> None:
    """Signals with the same last_seen must not shuffle across pages."""
    tied_at = BASE_AT + timedelta(hours=10)
    make_signal(signals_db, "Zeta", last_seen=tied_at)
    make_signal(signals_db, "Alpha", last_seen=tied_at)
    make_signal(signals_db, "Mike", last_seen=tied_at)

    body = _get(client)

    # Descending on the tied field, ascending on _id as the tiebreak.
    assert _names(body) == ["Alpha", "Mike", "Zeta"]


def test_unknown_sort_key_returns_422_validation_error(client, signals_db) -> None:
    response = client.get("/api/v1/signals", params={"sort": "created_at"})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert body["errors"][0]["loc"] == ["query", "sort"]


def test_bad_order_value_returns_422_validation_error(client, signals_db) -> None:
    response = client.get("/api/v1/signals", params={"order": "descending"})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert body["errors"][0]["loc"] == ["query", "order"]


# --- view_counts (§2.4) -----------------------------------------------------


def test_view_counts_carries_the_two_keys(client, signals_db) -> None:
    _seed_catalogue(signals_db)

    view_counts = _get(client)["view_counts"]

    assert set(view_counts) == {"all", "missing_unit"}


def test_view_counts_match_the_seeded_data(client, signals_db) -> None:
    _seed_catalogue(signals_db)

    view_counts = _get(client)["view_counts"]

    # 7 signals, 2 with unit=None.
    assert view_counts == {"all": 7, "missing_unit": 2}


def test_view_counts_are_filter_independent(client, signals_db) -> None:
    """Applying a filter must not change the whole-table counts."""
    _seed_catalogue(signals_db)

    unfiltered = _get(client)["view_counts"]
    filtered = _get(client, unit=["°C"])["view_counts"]
    sorted_filtered = _get(client, rig=["RIG-04"], sort="run_count", order="desc")[
        "view_counts"
    ]

    assert filtered == unfiltered
    assert sorted_filtered == unfiltered


# --- pagination + filter + sort --------------------------------------------


def test_pagination_slices_the_filtered_sorted_result(client, signals_db) -> None:
    """Multi-value filter + non-default sort + paging = disjoint slices."""
    for index in range(15):
        make_signal(
            signals_db,
            f"Signal_{index:02d}",
            unit="°C" if index % 2 == 0 else "bar",
            typical_rate_hz=10.0,
            run_count=index,
            last_seen=BASE_AT + timedelta(minutes=index),
        )

    params = {
        "unit": ["°C", "bar"],
        "sort": "run_count",
        "order": "asc",
        "page_size": 10,
    }
    first = _get(client, **params, page=1)
    second = _get(client, **params, page=2)

    assert first["total"] == 15
    assert first["total_pages"] == 2
    first_names = set(_names(first))
    second_names = set(_names(second))
    assert first_names.isdisjoint(second_names)
    assert len(first["items"]) == 10
    assert len(second["items"]) == 5


def test_q_combines_with_filters_by_and(client, signals_db) -> None:
    """The mock's search box narrows *within* the current filter selection."""
    _seed_catalogue(signals_db)

    body = _get(client, unit=["°C"], q="rotor")

    assert _names(body) == ["EM_Rotor_Temp"]
