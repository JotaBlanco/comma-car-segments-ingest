# GET /signals/{name}/stats (ticket B-08, contract #16).
#
# The side that measured a run serves its numbers: the registry when the
# pipeline measured the signal, and QuixLake for every run it did not. The run
# document serves the status, the definition, the rig and the date. The tests
# above the lake block install the stub lake of api/tests/conftest.py, which
# answers from the registry rows.
#
# #16 is the route that ASKS. The run-signals list (#7) stopped asking on
# 21 Aug 2026: its numbers live in the registry, so it lists a signal the
# pipeline did not measure with no numbers and never sends a statement. This
# file keeps the #7 tests that prove it asks nobody.

import re
from datetime import UTC, datetime

import httpx
import pytest

from api.services import lake
from tests import factories_signals
from tests.conftest import real_lake_query
from tests.factories import register_file as upsert_file
from tests.factories import upsert_run
from tests.factories_signals import make_file_signal, make_signal

# The assignment re-exports the fixture without shadowing an import.
signals_db = factories_signals.signals_db

NAME = "HV_Batt_Cell_Temp_Max"


@pytest.fixture(autouse=True)
def stats_lake(stub_lake):
    """Answer the statistics from the stub lake, so no test opens a socket."""


def _run(db, run_id: str, day: int, **overrides) -> dict:
    """Seed one run. The day sets first_data_at, so the sort order is explicit."""
    return upsert_run(
        db,
        _id=run_id,
        first_data_at=datetime(2026, 8, day, 9, 41, tzinfo=UTC),
        **overrides,
    )


def _partly_measured(db, run_id: str, lowest, highest, mean, std, name: str = NAME) -> None:
    """Seed one run whose signal is measured on one file and not on the other.

    The registry then holds numbers without having measured the whole signal.
    A part served as the whole is a wrong number, so the reader asks the lake
    instead, and these Mongo numbers must never reach the answer.
    """
    make_file_signal(
        db,
        f"f-{run_id}-a",
        name,
        run_id=run_id,
        stats={"min": lowest, "max": highest, "mean": mean, "std": std},
    )
    make_file_signal(db, f"f-{run_id}-b", name, run_id=run_id, stats=None)


def _flagged(actor: str = "a.bergstrom") -> dict:
    return {
        "flagged": True,
        "reason": "Thermocouple drift",
        "actor": actor,
        "at": datetime(2026, 8, 15, 7, 0, tzinfo=UTC),
    }


def _row(db, run_id: str, lowest, highest, mean, std, name: str = NAME) -> dict:
    """Seed one file_signals row for that run. One file per run keeps it exact."""
    return make_file_signal(
        db,
        f"f-{run_id}",
        name,
        run_id=run_id,
        stats={"min": lowest, "max": highest, "mean": mean, "std": std},
    )


def _get(client, name: str = NAME, **params):
    return client.get(f"/api/v1/signals/{name}/stats", params=params)


def _run_ids(body: dict) -> list[str]:
    return [item["run_id"] for item in body["items"]]


def test_stats_match_the_seeded_values_and_carry_the_unit(client, signals_db):
    make_signal(signals_db, NAME, unit="°C")
    _run(signals_db, "TAS-88214", 14, definition_id="TD-BAT-114", rig_id="RIG-04")
    _row(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)

    response = _get(client)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == NAME
    assert body["unit"] == "°C"
    assert body["window"] == "run"
    assert body["total"] == 1
    assert body["page"] == 1
    assert body["page_size"] == 50
    assert body["total_pages"] == 1
    assert body["items"] == [
        {
            "run_id": "TAS-88214",
            "definition_id": "TD-BAT-114",
            "rig_id": "RIG-04",
            "run_date": "2026-08-14",
            "status": "awaiting_work_order",
            "min": 18.2,
            "max": 47.9,
            "mean": 33.4,
            "std": 6.21,
            "rms": None,
            "p50": None,
            "p95": None,
            "p99": None,
        }
    ]


def test_include_invalid_defaults_to_false_and_true_lists_the_flagged_run(
    client, signals_db
):
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    _run(signals_db, "TAS-88190", 12, invalid=_flagged())
    _row(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)
    _row(signals_db, "TAS-88190", 19.1, 44.0, 31.8, 5.40)

    default = _get(client)
    assert default.status_code == 200, default.text
    assert _run_ids(default.json()) == ["TAS-88214"]
    assert default.json()["total"] == 1

    asked = _get(client, include_invalid="true")
    assert asked.status_code == 200, asked.text
    body = asked.json()
    assert _run_ids(body) == ["TAS-88214", "TAS-88190"]
    assert body["total"] == 2
    assert body["items"][1]["status"] == "invalid"


def test_the_definition_filter_splits_the_runs(client, signals_db):
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14, definition_id="TD-BAT-114")
    _run(signals_db, "TAS-88190", 12, definition_id="TD-BAT-207")
    _row(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)
    _row(signals_db, "TAS-88190", 19.1, 44.0, 31.8, 5.40)

    response = _get(client, definition="TD-BAT-114")

    assert response.status_code == 200, response.text
    body = response.json()
    assert _run_ids(body) == ["TAS-88214"]
    assert body["total"] == 1
    assert body["items"][0]["definition_id"] == "TD-BAT-114"


def test_the_rig_filter_splits_the_runs(client, signals_db):
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14, rig_id="RIG-04")
    _run(signals_db, "TAS-88190", 12, rig_id="RIG-07")
    _row(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)
    _row(signals_db, "TAS-88190", 19.1, 44.0, 31.8, 5.40)

    response = _get(client, rig="RIG-07")

    assert response.status_code == 200, response.text
    body = response.json()
    assert _run_ids(body) == ["TAS-88190"]
    assert body["total"] == 1
    assert body["items"][0]["rig_id"] == "RIG-07"


def test_a_non_run_window_returns_400_unsupported_window(client, signals_db):
    make_signal(signals_db, NAME)

    response = _get(client, window="cycle")

    assert response.status_code == 400
    body = response.json()
    assert set(body) == {"detail", "code", "errors"}
    assert body["code"] == "unsupported_window"
    assert body["errors"] == []


def test_each_status_derives_from_its_run_document(client, signals_db):
    # The rule is invalid > awaiting_work_order > complete.
    # Never copy the status from the contract example: contract #16 says
    # "complete" for the run that its own §3 calls "awaiting_work_order".
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14, work_order_id="WO-4471")
    _run(signals_db, "TAS-88203", 13, work_order_id=None)
    _run(signals_db, "TAS-88190", 12, work_order_id="WO-4470", invalid=_flagged())
    _row(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)
    _row(signals_db, "TAS-88203", 18.9, 46.2, 32.7, 6.02)
    _row(signals_db, "TAS-88190", 19.1, 44.0, 31.8, 5.40)

    response = _get(client, include_invalid="true")

    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert [item["run_id"] for item in items] == [
        "TAS-88214",
        "TAS-88203",
        "TAS-88190",
    ]
    assert [item["status"] for item in items] == [
        "complete",
        "awaiting_work_order",
        "invalid",
    ]


def test_rows_sort_by_first_data_at_newest_first(client, signals_db):
    # The run ids run against the dates on purpose. The old fixture used ids
    # that already fell in date order, so a sort on _id passed it unchanged.
    # started_at runs against the dates too, so a sort on the wrong time field
    # is visible as well.
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-00001", 14, started_at=datetime(2026, 8, 2, tzinfo=UTC))
    _run(signals_db, "TAS-99999", 12, started_at=datetime(2026, 8, 6, tzinfo=UTC))
    _run(signals_db, "TAS-50000", 13, started_at=datetime(2026, 8, 4, tzinfo=UTC))
    _row(signals_db, "TAS-00001", 18.2, 47.9, 33.4, 6.21)
    _row(signals_db, "TAS-99999", 19.1, 44.0, 31.8, 5.40)
    _row(signals_db, "TAS-50000", 18.9, 46.2, 32.7, 6.02)

    response = _get(client)

    assert response.status_code == 200, response.text
    body = response.json()
    assert _run_ids(body) == ["TAS-00001", "TAS-50000", "TAS-99999"]
    assert [item["run_date"] for item in body["items"]] == [
        "2026-08-14",
        "2026-08-13",
        "2026-08-12",
    ]


def test_run_date_falls_back_to_started_at(client, signals_db):
    # first_data_at is the sort key and the displayed date. A run that never
    # got one still shows the day it started.
    make_signal(signals_db, NAME)
    upsert_run(
        signals_db,
        _id="TAS-88214",
        first_data_at=None,
        started_at=datetime(2026, 8, 11, 6, 30, tzinfo=UTC),
    )
    _row(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)

    body = _get(client).json()

    assert [item["run_date"] for item in body["items"]] == ["2026-08-11"]


def test_a_run_with_no_date_at_all_does_not_appear(client, signals_db):
    make_signal(signals_db, NAME)
    upsert_run(signals_db, _id="TAS-88214", first_data_at=None, started_at=None)
    _row(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)

    body = _get(client).json()

    assert body["items"] == []
    assert body["total"] == 0


def test_the_page_slices_the_rows_and_the_total_counts_them_all(client, signals_db):
    # Twelve runs, ten to a page. The allowed page sizes start at ten.
    make_signal(signals_db, NAME)
    for day in range(3, 15):
        _run(signals_db, f"TAS-{day:02d}", day)
        _row(signals_db, f"TAS-{day:02d}", float(day), float(day + 1), float(day), 1.0)

    first = _get(client, page_size=10).json()
    second = _get(client, page_size=10, page=2).json()

    assert _run_ids(first)[:2] == ["TAS-14", "TAS-13"]
    assert len(first["items"]) == 10
    assert _run_ids(second) == ["TAS-04", "TAS-03"]
    assert first["total"] == second["total"] == 12
    assert first["total_pages"] == 2


def test_a_row_without_a_run_document_does_not_appear(client, signals_db):
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    _row(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)
    _row(signals_db, "TAS-00001", 1.0, 2.0, 1.5, 0.5)

    response = _get(client)

    assert response.status_code == 200, response.text
    body = response.json()
    assert _run_ids(body) == ["TAS-88214"]
    assert body["total"] == 1


def test_only_the_named_signal_produces_rows(client, signals_db):
    make_signal(signals_db, NAME)
    make_signal(signals_db, "Coolant_Inlet_Temp")
    _run(signals_db, "TAS-88214", 14)
    _row(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)
    _row(signals_db, "TAS-88214", 4.0, 9.0, 6.5, 1.1, name="Coolant_Inlet_Temp")

    response = _get(client)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 1
    assert body["items"][0]["max"] == 47.9


def test_an_unknown_signal_returns_404(client, signals_db):
    response = _get(client, name="No_Such_Signal")

    assert response.status_code == 404
    body = response.json()
    assert set(body) == {"detail", "code", "errors"}
    assert body["code"] == "signal_not_found"
    assert body["detail"] == "Signal No_Such_Signal not found"


# --- the QuixLake provider ---
# These tests never open a socket. The fake replaces lake.query.


def expected_sql(group_by: str, where_column: str, value: str) -> str:
    """Spell the aggregate out here, so no test asks the code under test.

    The old fake compared the statement against signal_stats_sql() and
    run_stats_sql(). That comparison always held, so the #7 statement could
    group and filter on the wrong columns and every test stayed green.
    """
    return (
        f"SELECT {group_by}, min(value) AS min, max(value) AS max, "
        "avg(value) AS mean, stddev(value) AS std, "
        "sqrt(avg(value * value)) AS rms, "
        "quantile_cont(value, 0.5) AS p50, quantile_cont(value, 0.95) AS p95, "
        "quantile_cont(value, 0.99) AS p99 "
        "FROM test_signal_samples "
        f"WHERE {where_column} = '{value}' "
        f"GROUP BY {group_by}"
    )


# The fake reads the statement instead of trusting it. A wrong column then
# selects the wrong rows, exactly as a real lake would.
_SQL = re.compile(
    r"^SELECT (?P<group>\w+), min\(value\) AS min, max\(value\) AS max, "
    r"avg\(value\) AS mean, stddev\(value\) AS std, "
    r"sqrt\(avg\(value \* value\)\) AS rms, "
    r"quantile_cont\(value, 0\.5\) AS p50, quantile_cont\(value, 0\.95\) AS p95, "
    r"quantile_cont\(value, 0\.99\) AS p99 "
    r"FROM (?P<table>\S+) WHERE (?P<column>\w+) = '(?P<value>.*)' "
    r"GROUP BY (?P<group_again>\w+)$"
)


class _FakeLake:
    """One lake table of per-run, per-signal numbers.

    Both aggregates read the same table, so #7 and #16 can never disagree
    unless the code disagrees.
    """

    def __init__(self) -> None:
        self.table: dict[tuple[str, str], dict[str, str]] = {}
        self.sent: list[str] = []

    def add(
        self,
        run_id: str,
        lowest,
        highest,
        mean,
        std,
        signal: str = NAME,
        **optional,
    ) -> "_FakeLake":
        """Write one row. The lake computes RMS and the three percentiles too.

        A caller that states none of the four writes a row without them, so
        the reader must still serve the four core numbers of that row.
        """
        self.table[(run_id, signal)] = {
            "min": str(lowest),
            "max": str(highest),
            "mean": str(mean),
            "std": str(std),
            **{field: str(value) for field, value in optional.items()},
        }
        return self

    def add_raw(self, run_id: str, signal: str = NAME, **stats: str) -> "_FakeLake":
        """Write one row exactly as the CSV carries it, empty fields included."""
        self.table[(run_id, signal)] = stats
        return self

    def query(self, sql: str, transport=None) -> list[dict[str, str]]:
        """Run the statement against the fake table, as DuckDB would."""
        self.sent.append(sql)
        parsed = _SQL.match(sql)
        assert parsed is not None, f"the lake cannot run this statement: {sql}"
        group, column = parsed["group"], parsed["column"]
        assert group == parsed["group_again"], f"the statement groups twice: {sql}"
        assert {group, column} == {"run_id", "signal"}, f"wrong columns: {sql}"
        # The literal doubles a quote. DuckDB reads one quote back.
        wanted = parsed["value"].replace("''", "'")
        rows = []
        for (run_id, signal), stats in self.table.items():
            columns = {"run_id": run_id, "signal": signal}
            if columns[column] == wanted:
                rows.append({group: columns[group], **stats})
        return rows


@pytest.fixture
def lake_rows(monkeypatch, stats_lake) -> _FakeLake:
    """Answer every lake query from the fake table, not from the registry."""
    fake = _FakeLake()
    monkeypatch.setattr(lake, "query", fake.query)
    return fake


def test_the_registry_numbers_win_over_the_lake_rows(client, signals_db, lake_rows):
    # The pipeline measures each signal as it passes and states the four
    # numbers on the inventory row. A block that is present was measured, so
    # the registry answers and the lake never runs for this run.
    make_signal(signals_db, NAME, unit="°C")
    _run(signals_db, "TAS-88214", 14, definition_id="TD-BAT-114", rig_id="RIG-04")
    _row(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)
    lake_rows.add("TAS-88214", 1.0, 2.0, 1.5, 0.5)

    response = _get(client)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["unit"] == "°C"
    assert body["items"] == [
        {
            "run_id": "TAS-88214",
            "definition_id": "TD-BAT-114",
            "rig_id": "RIG-04",
            "run_date": "2026-08-14",
            "status": "awaiting_work_order",
            "min": 18.2,
            "max": 47.9,
            "mean": 33.4,
            "std": 6.21,
            "rms": None,
            "p50": None,
            "p95": None,
            "p99": None,
        }
    ]


def test_a_measured_run_and_a_lake_run_list_side_by_side(client, signals_db, lake_rows):
    # A mixture states each row from the side that measured it. It never
    # blends the two into one number.
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    _run(signals_db, "TAS-88190", 12)
    _row(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)
    lake_rows.add("TAS-88190", 1.0, 2.0, 1.5, 0.5)

    body = _get(client).json()

    by_run = {row["run_id"]: row["mean"] for row in body["items"]}
    assert by_run == {"TAS-88214": 33.4, "TAS-88190": 1.5}


def test_the_run_signals_list_skips_the_lake_when_every_signal_is_measured(
    client, signals_db, lake_rows
):
    # A query the reader does not need is a query it must not send.
    _run(signals_db, "TAS-88214", 14)
    make_file_signal(
        signals_db, "f-a", NAME, stats={"min": 1.0, "max": 2.0, "mean": 1.5, "std": 0.5}
    )

    items = client.get("/api/v1/test-runs/TAS-88214/signals").json()["items"]

    assert items[0]["stats"] == {
        "min": 1.0,
        "max": 2.0,
        "mean": 1.5,
        "std": 0.5,
        "rms": None,
        "p50": None,
        "p95": None,
        "p99": None,
    }
    assert lake_rows.sent == []


def test_the_run_signals_list_mixes_a_measured_and_an_unmeasured_signal(
    client, signals_db, lake_rows
):
    # CHANGED 21 Aug 2026. The unmeasured rows used to take their numbers from
    # the lake. The list reads the registry alone now, so a signal the pipeline
    # did not measure lists blank even while the lake holds a row for it.
    _run(signals_db, "TAS-88214", 14)
    make_file_signal(
        signals_db, "f-a", NAME, stats={"min": 1.0, "max": 2.0, "mean": 1.5, "std": 0.5}
    )
    make_file_signal(signals_db, "f-a", "Chamber_Humidity", stats=None)
    make_file_signal(signals_db, "f-a", "Coolant_Inlet_Temp", stats=None)
    lake_rows.add("TAS-88214", 18.2, 47.9, 33.4, 6.21, signal="Chamber_Humidity")

    body = client.get("/api/v1/test-runs/TAS-88214/signals").json()

    by_name = {row["name"]: row["stats"] for row in body["items"]}
    assert by_name[NAME]["mean"] == 1.5
    assert by_name["Chamber_Humidity"] is None
    assert by_name["Coolant_Inlet_Temp"] is None
    assert lake_rows.sent == []
    # One of three signals carries numbers, so the envelope says why the other
    # two are blank.
    assert body["stats_unavailable"]["reason"] == "partly_measured", body


def test_a_signal_measured_on_one_file_of_two_asks_the_lake(client, signals_db, lake_rows):
    # Half a run is not the run. The lake reads every sample, so it answers.
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    _partly_measured(signals_db, "TAS-88214", 1.0, 2.0, 1.5, 0.5)
    lake_rows.add("TAS-88214", 18.2, 47.9, 33.4, 6.21)

    body = _get(client).json()

    assert [row["mean"] for row in body["items"]] == [33.4]
    assert lake_rows.sent == [expected_sql("run_id", "signal", NAME)]


def test_the_lake_provider_sends_the_partition_filtered_sql(client, signals_db, lake_rows):
    make_signal(signals_db, NAME)

    _get(client)

    assert lake_rows.sent == [expected_sql("run_id", "signal", NAME)]


def test_the_lake_provider_excludes_a_flagged_run_by_default(client, signals_db, lake_rows):
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    _run(signals_db, "TAS-88190", 12, invalid=_flagged())
    lake_rows.add("TAS-88214", 18.2, 47.9, 33.4, 6.21)
    lake_rows.add("TAS-88190", 19.1, 44.0, 31.8, 5.40)

    default = _get(client)
    assert _run_ids(default.json()) == ["TAS-88214"]
    assert default.json()["total"] == 1

    asked = _get(client, include_invalid="true")
    body = asked.json()
    assert _run_ids(body) == ["TAS-88214", "TAS-88190"]
    assert body["items"][1]["status"] == "invalid"


def test_the_lake_provider_takes_the_definition_and_rig_filters(client, signals_db, lake_rows):
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14, definition_id="TD-BAT-114", rig_id="RIG-04")
    _run(signals_db, "TAS-88190", 12, definition_id="TD-BAT-207", rig_id="RIG-07")
    lake_rows.add("TAS-88214", 18.2, 47.9, 33.4, 6.21)
    lake_rows.add("TAS-88190", 19.1, 44.0, 31.8, 5.40)

    by_definition = _get(client, definition="TD-BAT-114")
    assert _run_ids(by_definition.json()) == ["TAS-88214"]

    by_rig = _get(client, rig="RIG-07")
    assert _run_ids(by_rig.json()) == ["TAS-88190"]


def test_a_lake_row_without_a_run_document_does_not_appear(client, signals_db, lake_rows):
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    lake_rows.add("TAS-88214", 18.2, 47.9, 33.4, 6.21)
    lake_rows.add("TAS-00001", 1.0, 2.0, 1.5, 0.5)

    body = _get(client).json()

    assert _run_ids(body) == ["TAS-88214"]
    assert body["total"] == 1


def test_a_null_standard_deviation_drops_the_row(client, signals_db, lake_rows):
    # One sample makes DuckDB stddev answer NULL, which reaches us as "".
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    lake_rows.add_raw("TAS-88214", min="18.2", max="18.2", mean="18.2", std="")

    body = _get(client).json()

    assert body["items"] == []
    assert body["total"] == 0


def test_a_non_run_window_returns_400_before_the_lake_is_asked(client, signals_db, lake_rows):
    make_signal(signals_db, NAME)

    response = _get(client, window="cycle")

    assert response.status_code == 400
    assert response.json()["code"] == "unsupported_window"
    assert lake_rows.sent == []


# --- #7 and #16 must never state two different numbers ---
# One run, one signal, two endpoints. A demo that shows two different minimums
# for the same measurement loses the room. Both read the registry block first,
# so a measured signal reads the same on both screens.
#
# They part in one honest way since 21 Aug 2026: #16 asks the lake as well, so
# it can state a number for a run the pipeline never measured, while #7 lists
# that signal blank. One screen states a number and the other states nothing.
# Neither states a different number, so neither contradicts the other.


def _run_signal_stats(client, run_id: str, name: str = NAME) -> dict:
    """Read one signal's stats block out of the per-run list (#7)."""
    body = client.get(f"/api/v1/test-runs/{run_id}/signals").json()
    return next(row["stats"] for row in body["items"] if row["name"] == name)


def _cross_run_stats(client, run_id: str, name: str = NAME) -> dict:
    """Read the same run's row out of the cross-run stats (#16)."""
    body = _get(client, name=name, include_invalid="true").json()
    row = next(item for item in body["items"] if item["run_id"] == run_id)
    # Eight fields, not four: #7 and #16 must agree about the blank ones too.
    return {
        field: row[field]
        for field in ("min", "max", "mean", "std", "rms", "p50", "p95", "p99")
    }


def test_the_two_endpoints_agree_about_one_run(client, signals_db, lake_rows):
    # The pipeline measured the whole signal on one file, so both endpoints
    # read that block. The lake row below differs on every number, and it must
    # reach neither screen.
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    _row(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)
    lake_rows.add("TAS-88214", 1.0, 2.0, 1.5, 0.5)

    assert _run_signal_stats(client, "TAS-88214") == _cross_run_stats(client, "TAS-88214")
    assert _cross_run_stats(client, "TAS-88214") == {
        "min": 18.2,
        "max": 47.9,
        "mean": 33.4,
        "std": 6.21,
        "rms": None,
        "p50": None,
        "p95": None,
        "p99": None,
    }


def test_a_run_only_the_lake_measured_lists_blank_on_the_run_page(
    client, signals_db, lake_rows
):
    # Two files of one run, and neither states a sample count. The merge
    # refuses, so #7 states nothing. #16 asks the lake, which reads the samples
    # itself, so it states the lake numbers. The two never disagree: one number
    # against no number is not a contradiction, and #7 invents nothing.
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    upsert_file(signals_db, _id="f-big", size_bytes=3000)
    upsert_file(signals_db, _id="f-small", size_bytes=1000)
    make_file_signal(signals_db, "f-big", NAME, stats={"min": 1.0, "max": 2.0, "mean": 1.5, "std": 0.5})
    make_file_signal(signals_db, "f-small", NAME, stats={"min": 9.0, "max": 9.9, "mean": 9.5, "std": 9.1})
    lake_rows.add("TAS-88214", 18.2, 47.9, 33.4, 6.21)

    assert _run_signal_stats(client, "TAS-88214") is None
    assert _cross_run_stats(client, "TAS-88214") == {
        "min": 18.2,
        "max": 47.9,
        "mean": 33.4,
        "std": 6.21,
        "rms": None,
        "p50": None,
        "p95": None,
        "p99": None,
    }


def test_the_run_signals_list_sends_no_statement_at_all(client, signals_db, lake_rows):
    # CHANGED 21 Aug 2026. This list used to send one aggregate for the signals
    # the registry did not measure. It reads the registry alone now, so an
    # unmeasured signal costs no query and the lake stays out of the page.
    _run(signals_db, "TAS-88214", 14)
    make_file_signal(signals_db, "f-a", NAME, stats=None)

    body = client.get("/api/v1/test-runs/TAS-88214/signals").json()

    assert lake_rows.sent == []
    assert body["items"][0]["stats"] is None, body
    assert body["stats_unavailable"]["reason"] == "not_measured", body


def test_the_run_signals_list_keeps_its_registry_metadata(client, signals_db, lake_rows):
    # A blank number costs the row nothing else. The unit, the rate and the
    # dtype come from Mongo, and they are complete on a row with no numbers.
    _run(signals_db, "TAS-88214", 14)
    make_file_signal(signals_db, "f-a", NAME, unit="°C", rate_hz=100.0, dtype="float32", stats=None)
    lake_rows.add("TAS-88214", 18.2, 47.9, 33.4, 6.21)

    row = client.get("/api/v1/test-runs/TAS-88214/signals").json()["items"][0]

    assert row["unit"] == "°C"
    assert row["rate_hz"] == 100.0
    assert row["dtype"] == "float32"
    assert row["stats"] is None


def test_a_signal_the_pipeline_never_measured_lists_with_a_null_stats_block(
    client, signals_db, lake_rows
):
    # The pipeline measured one signal of the two. The other lists blank, and
    # the lake row for the run changes neither.
    _run(signals_db, "TAS-88214", 14)
    make_file_signal(
        signals_db, "f-a", NAME, stats={"min": 1.0, "max": 2.0, "mean": 1.5, "std": 0.5}
    )
    make_file_signal(signals_db, "f-a", "Chamber_Humidity", stats=None)
    lake_rows.add("TAS-88214", 18.2, 47.9, 33.4, 6.21)

    items = client.get("/api/v1/test-runs/TAS-88214/signals").json()["items"]

    by_name = {row["name"]: row["stats"] for row in items}
    assert by_name["Chamber_Humidity"] is None
    assert by_name[NAME] == {
        "min": 1.0,
        "max": 2.0,
        "mean": 1.5,
        "std": 0.5,
        "rms": None,
        "p50": None,
        "p95": None,
        "p99": None,
    }


def test_a_fully_measured_run_lists_its_signals_with_no_lake_at_all(
    client, signals_db, no_lake
):
    # `no_lake` clears every lake variable and puts the true lake client back.
    # The pipeline measured every signal of this run, so the Signals tab needs
    # no lake and still shows the four numbers. The cross-run list (#16) still
    # asks: the lake can hold a run the registry has no file row for.
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    _row(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)

    response = client.get("/api/v1/test-runs/TAS-88214/signals")

    assert response.status_code == 200, response.text
    assert response.json()["items"][0]["stats"]["mean"] == 33.4, response.text


def test_an_unconfigured_lake_fails_loudly_and_never_serves_a_part_as_the_whole(
    client, signals_db, no_lake
):
    # The registry measured one file of two, so it measured no whole signal.
    # Nothing falls back to those numbers. `no_lake` walks the real path.
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    _partly_measured(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)

    cross_run = _get(client)
    run_signals = client.get("/api/v1/test-runs/TAS-88214/signals")

    # THE rule of this test, and it holds on both answers: Mongo holds a part
    # of the numbers, and neither screen serves that part as the whole.
    for response in (cross_run, run_signals):
        for number in ("18.2", "47.9", "33.4", "6.21"):
            assert number not in response.text, response.text

    # #16 refuses. It fails loudly, and since 2026-08-17 it fails honestly:
    # 503, not 500. A dependency that is down is not a broken service (§A).
    assert cross_run.status_code == 503, cross_run.text
    body = cross_run.json()
    assert body["code"] == "lake_unavailable", body
    assert lake.URL_VAR in body["detail"], body
    assert "not configured" in body["detail"], body

    # #7 CHANGED on 21 Aug 2026. It reads the registry alone, so no lake
    # variable costs it one row or one number. The registry measured one file
    # of two, so it measured no whole signal, and the row lists blank with a
    # reason on the envelope.
    assert run_signals.status_code == 200, run_signals.text
    listed = run_signals.json()
    assert [row["name"] for row in listed["items"]] == [NAME]
    assert listed["items"][0]["stats"] is None, listed
    assert listed["stats_unavailable"]["reason"] == "not_measured", listed
    # The reason states a measurement, never a configuration.
    assert lake.URL_VAR not in run_signals.text, run_signals.text


# --- the row reader, and the rows a real lake can send ---


def _lake_answers(monkeypatch, rows):
    """Answer every lake query with these rows."""
    monkeypatch.setattr(lake, "query", lambda sql, transport=None: list(rows))


def _lake_transport(monkeypatch, handler):
    """Run the real lake client over a fake transport.

    The endpoint then walks the whole client, so the test proves what a real
    broken lake produces. It never opens a socket.
    """
    monkeypatch.setenv(lake.URL_VAR, "http://lake.test")
    monkeypatch.setenv(lake.TOKEN_VAR, "token-not-a-secret")
    # `stub_lake` holds `lake.query` now, so the real client comes from conftest.
    real_query = real_lake_query()
    fake_transport = httpx.MockTransport(handler)

    def query(sql: str, transport=None):
        return real_query(sql, transport=fake_transport)

    monkeypatch.setattr(lake, "query", query)


def test_a_lake_row_without_its_key_column_is_dropped(client, signals_db, monkeypatch):
    # A row that names no run cannot join a run document. It must not crash.
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    _lake_answers(monkeypatch, [{"min": "1.0", "max": "2.0", "mean": "1.5", "std": "0.5"}])

    response = _get(client)

    assert response.status_code == 200, response.text
    assert response.json()["items"] == []


def test_a_lake_row_with_a_missing_number_lists_no_row(client, signals_db, monkeypatch):
    # DuckDB omits nothing, but union_by_name can. A short row is not a row.
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    _lake_answers(monkeypatch, [{"run_id": "TAS-88214", "min": "1.0", "max": "2.0"}])

    response = _get(client)

    assert response.status_code == 200, response.text
    assert response.json()["items"] == []


@pytest.mark.parametrize("text", ["NaN", "Infinity", "-Infinity", "nan", "inf"])
def test_a_not_a_number_value_never_reaches_the_json(client, signals_db, monkeypatch, text):
    # float("NaN") succeeds, and json.dumps then writes a bare NaN token.
    # That is not JSON. Every strict client rejects the whole page.
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    _lake_answers(
        monkeypatch,
        [{"run_id": "TAS-88214", "min": "1.0", "max": text, "mean": "1.5", "std": "0.5"}],
    )

    response = _get(client)

    assert response.status_code == 200, response.text
    assert "NaN" not in response.text
    assert "Infinity" not in response.text
    assert response.json()["items"] == []


def test_a_run_id_with_a_quote_reaches_no_statement_from_this_list(
    client, signals_db, lake_rows
):
    # A run id is caller data, and this list no longer puts it in a statement.
    # The quoting guard for the same id lives on the SQL builder itself, in
    # api/tests/test_lake_client.py, because the Explore chat context still
    # sends that aggregate.
    run_id = "TAS-1'OR'1"
    _run(signals_db, run_id, 14)
    make_file_signal(
        signals_db,
        "f-a",
        NAME,
        run_id=run_id,
        stats={"min": 1.0, "max": 47.9, "mean": 1.5, "std": 0.5},
    )

    response = client.get(f"/api/v1/test-runs/{run_id}/signals")

    assert response.status_code == 200, response.text
    assert lake_rows.sent == []
    assert response.json()["items"][0]["stats"]["max"] == 47.9


def test_a_lake_that_measured_nothing_lists_no_runs(client, signals_db, lake_rows):
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    _partly_measured(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)

    body = _get(client).json()

    # Mongo knows the run and holds a part. The lake measured none of it.
    assert body["items"] == []
    assert body["total"] == 0
    assert "33.4" not in _get(client).text


def test_a_run_the_lake_never_measured_is_absent_from_the_stats(client, signals_db, lake_rows):
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    _run(signals_db, "TAS-88190", 12)
    lake_rows.add("TAS-88214", 18.2, 47.9, 33.4, 6.21)

    body = _get(client).json()

    assert _run_ids(body) == ["TAS-88214"]
    assert body["total"] == 1


# --- a lake that fails answers 503, never 500, and leaks nothing ---

_SECRETS = ("token-not-a-secret", "lake.test", "Binder Error", "Traceback")


def _assert_clean_503(response, *, unavailable: bool = True):
    assert response.status_code == 503, response.text
    body = response.json()
    assert body["code"] == "lake_unavailable", body
    assert lake.URL_VAR in body["detail"], body
    for secret in _SECRETS:
        assert secret not in response.text, f"the answer leaks {secret}"
    if unavailable:
        assert "did not answer" in body["detail"], body


def _answers(status: int, body: str):
    return lambda request: httpx.Response(status, text=body)


def _raises(error: Exception):
    def handler(request):
        raise error

    return handler


# Every plausible way a lake breaks. Each one must reach the caller as a 503.
_BROKEN_LAKES = {
    "server-error": _answers(500, "Binder Error: no such table at http://lake.test"),
    "bad-gateway": _answers(502, "<html>502 Bad Gateway</html>"),
    "refused": _raises(httpx.ConnectError("connection refused")),
    "read-timeout": _raises(httpx.ReadTimeout("timed out")),
    "connect-timeout": _raises(httpx.ConnectTimeout("timed out")),
    "streamed-error": _answers(200, "run_id,min\nTAS-88214,18.2\n# ERROR: reset\n"),
}


@pytest.mark.parametrize("handler", list(_BROKEN_LAKES.values()), ids=list(_BROKEN_LAKES))
def test_a_failing_lake_answers_503_on_the_stats_endpoint(
    client, signals_db, monkeypatch, handler
):
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    _partly_measured(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)
    _lake_transport(monkeypatch, handler)

    response = _get(client)

    _assert_clean_503(response)
    # Mongo holds a part of the numbers. A failed lake never serves them.
    assert "33.4" not in response.text
    # A partial stream is not an answer either.
    assert "18.2" not in response.text


@pytest.mark.parametrize("handler", list(_BROKEN_LAKES.values()), ids=list(_BROKEN_LAKES))
def test_a_failing_lake_never_breaks_the_run_signals_endpoint(
    client, signals_db, monkeypatch, handler
):
    # CHANGED 21 Aug 2026. This route answered 503 for every broken lake, and
    # a person lost the whole Signals tab to a dependency it does not use. It
    # reads the registry alone now, so every broken lake leaves the same page.
    # The 503 guard stays on #16 above, which really does ask.
    _run(signals_db, "TAS-88214", 14)
    make_file_signal(
        signals_db, "f-a", NAME, stats={"min": 1.0, "max": 2.0, "mean": 1.5, "std": 0.5}
    )
    _lake_transport(monkeypatch, handler)

    response = client.get("/api/v1/test-runs/TAS-88214/signals")

    assert response.status_code == 200, response.text
    assert response.json()["items"][0]["stats"]["mean"] == 1.5, response.text


# A refused token used to sit inside _BROKEN_LAKES above, and the guard then
# demanded the words "did not answer" for it. **Measured against a real QuixLake
# on 18 Aug 2026: a refusal is not a lake that is down.** The lake refuses with
# 403 (`auth.py:69`), and 401 means the header never arrived (`auth.py:58`).
# The old wording sent the operator to hunt the host while the credential was
# the fault. The status and the code do not move, so the contract holds. These
# two tests keep every guard the old case carried and add the refusal wording.


@pytest.mark.parametrize("status", [401, 403], ids=["no-header", "refused-token"])
def test_a_refused_token_answers_503_and_names_the_token_on_the_stats_endpoint(
    client, signals_db, monkeypatch, status
):
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    _partly_measured(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)
    _lake_transport(monkeypatch, _answers(status, "token-not-a-secret is not valid"))

    response = _get(client)

    _assert_clean_503(response, unavailable=False)
    assert lake.TOKEN_VAR in response.json()["detail"], response.text
    assert "refused" in response.json()["detail"], response.text
    # Mongo holds a part of the numbers. A refused lake never serves them.
    assert "33.4" not in response.text


@pytest.mark.parametrize("status", [401, 403], ids=["no-header", "refused-token"])
def test_a_refused_token_never_breaks_the_run_signals_endpoint(
    client, signals_db, monkeypatch, status
):
    # A refused credential is the lake's business, and this list has none.
    _run(signals_db, "TAS-88214", 14)
    make_file_signal(signals_db, "f-a", NAME, stats=None)
    _lake_transport(monkeypatch, _answers(status, "token-not-a-secret is not valid"))

    response = client.get("/api/v1/test-runs/TAS-88214/signals")

    assert response.status_code == 200, response.text
    assert response.json()["items"][0]["stats"] is None, response.text
    # The page names no credential and no host, exactly as before.
    for secret in _SECRETS:
        assert secret not in response.text, f"the answer leaks {secret}"


def test_a_lake_that_answers_junk_invents_no_numbers(client, signals_db, monkeypatch):
    # A 200 that carries no CSV is rare, because a proxy sends a 5xx status.
    # It must still never invent a row and never become a 500.
    make_signal(signals_db, NAME)
    _run(signals_db, "TAS-88214", 14)
    _partly_measured(signals_db, "TAS-88214", 18.2, 47.9, 33.4, 6.21)
    _lake_transport(monkeypatch, _answers(200, "<html>not csv at all</html>"))

    response = _get(client)

    assert response.status_code == 200, response.text
    assert response.json()["items"] == []
    assert "33.4" not in response.text


def test_an_unconfigured_lake_names_the_variable_and_leaks_nothing(
    client, signals_db, no_lake
):
    make_signal(signals_db, NAME)

    _assert_clean_503(_get(client), unavailable=False)
    assert "not configured" in _get(client).json()["detail"]
