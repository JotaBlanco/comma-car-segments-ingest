# GET /test-runs/{run_id}/signals lists the run's signals (contract #7).
#
# The side that measured a signal serves its numbers, and Mongo serves the
# inventory. Every test in this file checks the inventory half, so it installs
# the stub lake. The real lake path for this endpoint lives in
# api/tests/test_signal_stats.py, together with the guard that keeps #7 and #16
# in agreement, and the rules that pick the side.

import pytest

from tests import factories, factories_signals
from tests.factories_signals import make_file_signal

# The assignment re-exports the fixture without shadowing an import.
signals_db = factories_signals.signals_db

RUN = "TAS-88214"


@pytest.fixture(autouse=True)
def stats_lake(stub_lake):
    """Answer the statistics from the stub lake. The suite runs no real lake."""


def _names(body: dict) -> list[str]:
    return [item["name"] for item in body["items"]]


def _get(client, run_id: str = RUN, **params):
    return client.get(f"/api/v1/test-runs/{run_id}/signals", params=params)


def test_total_equals_the_distinct_signal_count(client, signals_db):
    factories.upsert_run(signals_db)
    factories.register_file(signals_db, _id="f-a")
    factories.register_file(signals_db, _id="f-b")
    rows = [("f-a", "HV_Batt_Cell_Temp_Max"), ("f-a", "Coolant_Inlet_Temp"), ("f-b", "HV_Batt_Cell_Temp_Max")]
    for file_id, name in rows:
        make_file_signal(signals_db, file_id, name)
    seeded = {name for _, name in rows}

    body = _get(client).json()

    # The total counts distinct signals, not file_signals rows.
    assert body["total"] == len(seeded)
    assert len(body["items"]) == body["total"]
    assert set(_names(body)) == seeded


def test_the_largest_file_gives_the_merged_metadata(client, signals_db):
    factories.upsert_run(signals_db)
    factories.register_file(signals_db, _id="f-big", size_bytes=3000)
    factories.register_file(signals_db, _id="f-small", size_bytes=1000)
    make_file_signal(
        signals_db, "f-big", "Coolant_Inlet_Temp", unit="°C", rate_hz=100.0
    )
    make_file_signal(
        signals_db, "f-small", "Coolant_Inlet_Temp", unit=None, rate_hz=1.0
    )

    row = _get(client).json()["items"][0]

    assert row["unit"] == "°C"
    assert row["rate_hz"] == 100.0


def test_the_row_carries_the_four_measured_numbers(client, signals_db):
    # The file row carries the four numbers the pipeline measured. The row must
    # carry every one of them, and the endpoint must not round or drop a number.
    factories.upsert_run(signals_db)
    factories.register_file(signals_db, _id="f-a", size_bytes=4096)
    make_file_signal(
        signals_db,
        "f-a",
        "HV_Batt_Pack_Voltage",
        stats={"min": 312.4, "max": 398.7, "mean": 361.2, "std": 18.4},
    )

    row = _get(client).json()["items"][0]

    assert row["stats"] == {
        "min": 312.4,
        "max": 398.7,
        "mean": 361.2,
        "std": 18.4,
        # Optional since 21 Aug 2026 (FR-DM-014). This block states none.
        "rms": None,
        "p50": None,
        "p95": None,
        "p99": None,
    }


def test_another_run_stays_out(client, signals_db):
    factories.upsert_run(signals_db)
    factories.register_file(signals_db, _id="f-a")
    factories.register_file(signals_db, _id="f-other", run_id="TAS-88207")
    make_file_signal(signals_db, "f-a", "HV_Batt_Cell_Temp_Max")
    make_file_signal(
        signals_db, "f-other", "EM_Rotor_Temp", run_id="TAS-88207"
    )

    body = _get(client).json()

    assert _names(body) == ["HV_Batt_Cell_Temp_Max"]
    assert body["total"] == 1


def test_a_signal_without_stats_lists_with_a_null_stats_block(client, signals_db):
    factories.upsert_run(signals_db)
    factories.register_file(signals_db, _id="f-a")
    make_file_signal(signals_db, "f-a", "Chamber_Humidity", stats=None)

    row = _get(client).json()["items"][0]

    assert row["stats"] is None


def test_a_run_known_only_from_its_files_still_lists(client, signals_db):
    # The run document belongs to lane A. A file already proves the run exists.
    factories.register_file(signals_db, _id="f-a")
    make_file_signal(signals_db, "f-a", "HV_Batt_Cell_Temp_Max")

    response = _get(client)

    assert response.status_code == 200
    assert _names(response.json()) == ["HV_Batt_Cell_Temp_Max"]


def test_an_unknown_run_returns_404(client, signals_db):
    factories.upsert_run(signals_db)

    response = _get(client, "TAS-00000")

    assert response.status_code == 404
    assert response.json()["code"] == "run_not_found"


def test_a_run_without_signals_returns_an_empty_page(client, signals_db):
    factories.upsert_run(signals_db)

    body = _get(client).json()

    assert body["items"] == []
    assert body["total"] == 0


def test_the_page_slices_the_merged_rows(client, signals_db):
    # The run holds 12 distinct names over 18 file_signals rows, and one page
    # holds 10. The three numbers differ, so total tells them apart:
    # 12 is right, 18 counts rows, 10 counts the page.
    factories.upsert_run(signals_db)
    factories.register_file(signals_db, _id="f-a", size_bytes=3000)
    factories.register_file(signals_db, _id="f-b", size_bytes=1000)
    names = [f"Signal_{index:02d}" for index in range(12)]
    for name in names:
        make_file_signal(signals_db, "f-a", name)
    for name in names[:6]:
        make_file_signal(signals_db, "f-b", name)
    assert signals_db["file_signals"].count_documents({}) == 18

    first = _get(client, page=1, page_size=10).json()
    second = _get(client, page=2, page_size=10).json()

    assert first["total"] == 12 and second["total"] == 12
    assert first["total_pages"] == 2
    assert _names(first) == names[:10]
    assert _names(second) == names[10:]


def _seed_a_real_run(db, count: int = 186) -> list[str]:
    """Seed one run with a signal count of the real band.

    The real band is 186 to 261 named signals per run
    (`plans/design/MF4-INGEST-INTEGRATION.md:269`). The tests below use the two
    ends of that band, because a round number hides an off-by-one page slice.
    """
    factories.upsert_run(db)
    factories.register_file(db, _id="f-a")
    names = [f"Signal_{index:03d}" for index in range(count)]
    for name in names:
        make_file_signal(db, "f-a", name)
    return names


def test_one_page_holds_a_whole_run_of_186_signals(client, signals_db):
    # A page of 200 still holds the small end of the real band.
    names = _seed_a_real_run(signals_db)

    body = _get(client, page_size=200).json()

    assert body["total"] == 186
    assert len(body["items"]) == 186
    assert body["total_pages"] == 1
    assert _names(body) == names


def test_one_page_of_500_holds_the_largest_real_run_of_261_signals(client, signals_db):
    # 261 is the top of the measured band: `plans/design/MF4-INGEST-INTEGRATION.md:269`
    # records "186-261 real named signals per run" for the six converted drives.
    # The run-detail Signals tab asks for one page of 500, so it must receive
    # all 261 rows and never send the presenter to page 2.
    names = _seed_a_real_run(signals_db, count=261)

    body = _get(client, page_size=500).json()

    assert body["total"] == 261
    assert len(body["items"]) == 261
    assert body["total_pages"] == 1
    assert _names(body) == names


def test_a_page_of_200_splits_the_largest_real_run(client, signals_db):
    # The reason 500 exists. At 200 a 261-signal run needs two pages.
    _seed_a_real_run(signals_db, count=261)

    body = _get(client, page_size=200).json()

    assert body["total_pages"] == 2
    assert len(body["items"]) == 200


def test_a_smaller_page_still_reaches_the_last_of_186_signals(client, signals_db):
    # A page of 100 leaves 86 signals. Page 2 must hold every one of them.
    names = _seed_a_real_run(signals_db)

    first = _get(client, page=1, page_size=100).json()
    second = _get(client, page=2, page_size=100).json()

    assert first["total"] == 186 and second["total"] == 186
    assert first["total_pages"] == 2
    assert _names(first) == names[:100]
    assert _names(second) == names[100:]
    assert len(second["items"]) == 86


# --- The unit a person corrected must reach the run's rows --------------------
#
# The catalogue holds the manual unit, and file_signals holds the file header.
# The endpoint applies api.provenance, so `manual` beats `embedded` on the row.
# The front end therefore overlays nothing. Before this, the tab merged the
# first 100 rows of a 6,412-row catalogue over the run, so a correction on any
# other signal disappeared from the screen that made it.

CORRECTED = "Signal_185"


def test_a_manual_unit_wins_on_a_run_row_the_old_overlay_never_saw(client, signals_db):
    # 186 signals, and the correction sits on the last one. The old front-end
    # overlay read one catalogue page of 100, so index 185 was out of its reach.
    _seed_a_real_run(signals_db)
    factories_signals.make_signal(signals_db, CORRECTED, unit="bar", unit_source="manual")

    body = _get(client, page_size=200).json()
    row = next(item for item in body["items"] if item["name"] == CORRECTED)

    # The file header said °C. The person said bar, and the person wins.
    assert row["unit"] == "bar"


def test_the_run_row_names_the_source_that_won(client, signals_db):
    _seed_a_real_run(signals_db)
    factories_signals.make_signal(signals_db, CORRECTED, unit="bar", unit_source="manual")

    body = _get(client, page_size=200).json()
    row = next(item for item in body["items"] if item["name"] == CORRECTED)

    assert row["unit_source"] == "manual"


def test_an_embedded_unit_still_shows_when_no_manual_unit_exists(client, signals_db):
    # Same catalogue row, same signal, embedded on both sides. Nothing moves.
    _seed_a_real_run(signals_db)
    factories_signals.make_signal(signals_db, CORRECTED, unit="Pa", unit_source="embedded")

    body = _get(client, page_size=200).json()
    row = next(item for item in body["items"] if item["name"] == CORRECTED)

    assert row["unit"] == "°C"
    assert row["unit_source"] == "embedded"


def test_the_precedence_never_inverts_on_a_run_row(client, signals_db):
    # An embedded file unit must never beat the manual catalogue unit, whichever
    # page the row lands on. This checks the first page and the last page.
    _seed_a_real_run(signals_db)
    for name in ("Signal_000", CORRECTED):
        factories_signals.make_signal(signals_db, name, unit="bar", unit_source="manual")

    first = _get(client, page=1, page_size=100).json()
    second = _get(client, page=2, page_size=100).json()

    for body, name in ((first, "Signal_000"), (second, CORRECTED)):
        row = next(item for item in body["items"] if item["name"] == name)
        assert (row["unit"], row["unit_source"]) == ("bar", "manual")


def test_a_patched_unit_reaches_the_run_rows(client, signals_db):
    # The whole fault in one test: a person corrects the unit, and the run tab
    # must show it. PATCH writes the catalogue; GET #7 reads the winner.
    _seed_a_real_run(signals_db)
    factories_signals.make_signal(signals_db, CORRECTED, unit=None, unit_source="embedded")

    patch = client.patch(
        f"/api/v1/signals/{CORRECTED}",
        json={"unit": "bar", "actor": "a.bergstrom", "context_run_id": RUN},
    )
    assert patch.status_code == 200, patch.text

    body = _get(client, page_size=200).json()
    row = next(item for item in body["items"] if item["name"] == CORRECTED)

    assert (row["unit"], row["unit_source"]) == ("bar", "manual")
