# FR-DM-111. GET /signals filters by `dtype` and by `source_system`, and
# GET /signals/facets serves both lists over the whole catalogue.
#
# `dtype` was stored on every catalogue row and no route ever filtered it.
# `source_system` lived on the file alone, so the catalogue row grew a
# `source_systems` array the ingest feeds with `$addToSet`.
#
# Style follows tests/test_table_filters_signals.py.

from tests import factories_signals
from tests.factories_signals import make_file_signal, make_signal

signals_db = factories_signals.signals_db

FACETS = "/api/v1/signals/facets"


def _get(client, **params) -> dict:
    response = client.get("/api/v1/signals", params=params)
    assert response.status_code == 200
    return response.json()


def _names(body: dict) -> list[str]:
    return [item["name"] for item in body["items"]]


def _seed(db) -> None:
    """Four signals over three data types and three producing systems."""
    make_signal(db, "Cell_Temp_C", dtype="float64", source_systems=["TAS"])
    make_signal(db, "Pack_Current", dtype="float32", source_systems=["INCA"])
    make_signal(db, "Gear_Position", dtype="int32", source_systems=["TAS", "INCA"])
    make_signal(db, "Chamber_Humidity", dtype="float64", source_systems=["ifile"])


# --- the dtype filter -------------------------------------------------------


def test_dtype_filters_the_catalogue(client, signals_db) -> None:
    _seed(signals_db)

    body = _get(client, dtype="float64")

    assert set(_names(body)) == {"Cell_Temp_C", "Chamber_Humidity"}


def test_dtype_two_values_return_the_union(client, signals_db) -> None:
    _seed(signals_db)

    body = _get(client, dtype=["float32", "int32"])

    assert set(_names(body)) == {"Pack_Current", "Gear_Position"}


def test_a_blank_dtype_filters_nothing(client, signals_db) -> None:
    # A cleared filter chip still sends its key. The blank value must not
    # empty the table.
    _seed(signals_db)

    body = _get(client, dtype="")

    assert body["total"] == 4


def test_an_unknown_dtype_returns_an_empty_page(client, signals_db) -> None:
    _seed(signals_db)

    body = _get(client, dtype="complex128")

    assert body["items"] == []
    assert body["total"] == 0


# --- the source_system filter ----------------------------------------------


def test_source_system_filters_the_catalogue(client, signals_db) -> None:
    _seed(signals_db)

    body = _get(client, source_system="ifile")

    assert _names(body) == ["Chamber_Humidity"]


def test_a_signal_of_two_systems_matches_either_one(client, signals_db) -> None:
    _seed(signals_db)

    assert "Gear_Position" in _names(_get(client, source_system="TAS"))
    assert "Gear_Position" in _names(_get(client, source_system="INCA"))


def test_source_system_two_values_return_the_union(client, signals_db) -> None:
    _seed(signals_db)

    body = _get(client, source_system=["INCA", "ifile"])

    assert set(_names(body)) == {"Pack_Current", "Gear_Position", "Chamber_Humidity"}


def test_a_row_without_the_array_matches_no_source_system(client, signals_db) -> None:
    # A catalogue row written before the field existed carries no array. It
    # must never answer a source filter, because nobody knows its system.
    make_signal(signals_db, "Legacy_Signal")
    signals_db["signals"].update_one(
        {"_id": "Legacy_Signal"}, {"$unset": {"source_systems": ""}}
    )

    body = _get(client, source_system="TAS")

    assert body["total"] == 0


def test_an_unknown_source_system_returns_an_empty_page(client, signals_db) -> None:
    _seed(signals_db)

    body = _get(client, source_system="CANape")

    assert body["items"] == []
    assert body["total"] == 0


# --- two filters together ---------------------------------------------------


def test_dtype_and_source_system_combine_with_and(client, signals_db) -> None:
    _seed(signals_db)

    body = _get(client, dtype="float64", source_system="TAS")

    assert _names(body) == ["Cell_Temp_C"]


def test_dtype_and_unit_combine_with_and(client, signals_db) -> None:
    make_signal(signals_db, "Cell_Temp_C", dtype="float64", unit="°C")
    make_signal(signals_db, "Pack_Press", dtype="float64", unit="bar")

    body = _get(client, dtype="float64", unit="bar")

    assert _names(body) == ["Pack_Press"]


def test_two_filters_that_share_no_row_return_an_empty_page(client, signals_db) -> None:
    _seed(signals_db)

    body = _get(client, dtype="int32", source_system="ifile")

    assert body["items"] == []
    assert body["total"] == 0


# --- the facets -------------------------------------------------------------


def test_the_facets_serve_both_new_lists(client, signals_db) -> None:
    _seed(signals_db)

    body = client.get(FACETS).json()

    assert body["dtypes"] == ["float32", "float64", "int32"]
    assert body["source_systems"] == ["INCA", "TAS", "ifile"]


def test_every_facet_value_filters_something(client, signals_db) -> None:
    _seed(signals_db)

    body = client.get(FACETS).json()

    for dtype in body["dtypes"]:
        assert _get(client, dtype=dtype)["total"] > 0, dtype
    for system in body["source_systems"]:
        assert _get(client, source_system=system)["total"] > 0, system


def test_an_empty_catalogue_answers_empty_lists(client, signals_db) -> None:
    body = client.get(FACETS).json()

    assert body["dtypes"] == []
    assert body["source_systems"] == []


# --- the token guard --------------------------------------------------------


def test_the_list_refuses_a_call_with_no_token(bare_client, signals_db) -> None:
    response = bare_client.get("/api/v1/signals", params={"dtype": "float64"})

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


def test_the_facets_refuse_a_call_with_no_token(bare_client, signals_db) -> None:
    response = bare_client.get(FACETS)

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


# --- the ingest grows the array --------------------------------------------


def test_the_ingest_adds_the_producing_system_of_the_file(client, signals_db) -> None:
    from api.services import queries_signals

    file_doc = {"_id": "f-1", "run_id": None, "source_system": "TAS"}
    signal = _FileSignal("Brake_Pressure", "bar", 10.0, "float64")

    queries_signals.upsert_file_signals(signals_db, file_doc, [signal])

    row = signals_db["signals"].find_one({"_id": "Brake_Pressure"})
    assert row["source_systems"] == ["TAS"]


def test_a_second_system_joins_the_array_and_never_replaces_it(
    client, signals_db
) -> None:
    from api.services import queries_signals

    signal = _FileSignal("Brake_Pressure", "bar", 10.0, "float64")
    queries_signals.upsert_file_signals(
        signals_db, {"_id": "f-1", "run_id": None, "source_system": "TAS"}, [signal]
    )
    queries_signals.upsert_file_signals(
        signals_db, {"_id": "f-2", "run_id": None, "source_system": "INCA"}, [signal]
    )

    row = signals_db["signals"].find_one({"_id": "Brake_Pressure"})
    assert sorted(row["source_systems"]) == ["INCA", "TAS"]


def test_the_backfill_fills_a_row_the_seed_wrote(client, signals_db) -> None:
    from api.services import queries_signals

    # The seed writes the catalogue straight from the fixtures, so the ingest
    # never runs and the row carries no producing system.
    make_signal(signals_db, "Cell_Temp_C", source_systems=[])
    signals_db["files"].insert_one({"_id": "f-1", "source_system": "TAS"})
    make_file_signal(signals_db, "f-1", "Cell_Temp_C")

    touched = queries_signals.backfill_source_systems(signals_db)

    assert touched == 1
    assert _names(_get(client, source_system="TAS")) == ["Cell_Temp_C"]


def test_the_backfill_runs_twice_without_growing_the_array(client, signals_db) -> None:
    from api.services import queries_signals

    make_signal(signals_db, "Cell_Temp_C", source_systems=[])
    signals_db["files"].insert_one({"_id": "f-1", "source_system": "TAS"})
    make_file_signal(signals_db, "f-1", "Cell_Temp_C")

    queries_signals.backfill_source_systems(signals_db)
    queries_signals.backfill_source_systems(signals_db)

    row = signals_db["signals"].find_one({"_id": "Cell_Temp_C"})
    assert row["source_systems"] == ["TAS"]


class _FileSignal:
    """The shape `upsert_file_signals` reads off one inventory row."""

    def __init__(self, name: str, unit: str | None, rate_hz: float, dtype: str) -> None:
        self.name = name
        self.unit = unit
        self.rate_hz = rate_hz
        self.dtype = dtype
        self.stats = None
