# R-01 — a run has one owned read model.
#
# Four numbers about one run used to come from four writers, so they
# disagreed. `file_count`, `signal_count` and the file list are one truth,
# and every route that prints them must print the same truth.
#
# The case these tests state is the one that broke it: a run with a
# QUARANTINED file. `POST /files` called the rollup only for a registered
# file, so the badge said 2 while the Files tab listed 3. A real CAN capture
# is exactly the file that fails a parse, so the case is normal, not rare.
#
# The numbers here are deliberately not round: 3 files, 7 signals.

import pytest

from tests import factories
from tests.factories import upsert_run
from tests.factories_planning import make_work_order

files_db = factories.files_db

RUN = "TAS-88214"
FILES = "/api/v1/files"
RUNS = "/api/v1/test-runs"
WO = "WO-2026-0847"

# Four signals in the first file, five in the second, two shared. Seven
# distinct names on the run.
FIRST_SIGNALS = ["CAR_SPEED", "ACC_STATUS", "AEB_REQ", "HV_Batt_SOC"]
SECOND_SIGNALS = ["AEB_REQ", "HV_Batt_SOC", "Coolant_Inlet_Temp", "Cycle_Counter", "Yaw_Rate"]
RUN_SIGNAL_COUNT = 7

# The quarantined file names two more. It writes no `file_signals` row, so
# neither may reach the run's count.
QUARANTINED_SIGNALS = ["Chamber_Humidity", "Chamber_Ambient_Temp"]


@pytest.fixture(autouse=True)
def stats_lake(stub_lake):
    """Answer the statistics from the stub lake.

    These tests count rows, never numbers. A real lake answers 503 with no
    `Quix__Lakehouse__Query__Url`, and that answer belongs to R-05, not here.
    """


def _body(checksum: str, names: list[str], **overrides) -> dict:
    body = {
        "filename": f"cap_{checksum[:6]}.mf4",
        "run_id": RUN,
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 1_331_439_861,
        "checksum_sha256": checksum,
        "checksum_state": "verified",
        "signals": [
            {
                "name": name,
                "unit": "°C",
                "rate_hz": 100.0,
                "dtype": "float64",
                "stats": {"min": 18.2, "max": 47.9, "mean": 33.4, "std": 6.21},
            }
            for name in names
        ],
    }
    body.update(overrides)
    return body


def _register(client, checksum: str, names: list[str], **overrides) -> dict:
    response = client.post(FILES, json=_body(checksum, names, **overrides))
    assert response.status_code == 201, response.text
    return response.json()


def _run_with_a_quarantined_file(client, db) -> None:
    """Two registered files and one quarantined file, all naming one run."""
    upsert_run(db, _id=RUN)
    _register(client, "a1" * 32, FIRST_SIGNALS)
    _register(client, "b2" * 32, SECOND_SIGNALS)
    quarantined = _register(
        client, "c3" * 32, QUARANTINED_SIGNALS, checksum_state="mismatch"
    )
    assert quarantined["status"] == "quarantined"


def test_the_run_counts_its_quarantined_file(client, files_db) -> None:
    """The badge must count the file the Files tab lists. Three, not two."""
    _run_with_a_quarantined_file(client, files_db)

    run = client.get(f"{RUNS}/{RUN}").json()

    assert run["file_count"] == 3


def test_the_file_count_matches_the_files_the_drill_down_finds(client, files_db) -> None:
    """The header number and the rows under it come from one truth."""
    _run_with_a_quarantined_file(client, files_db)

    run = client.get(f"{RUNS}/{RUN}").json()
    listed = client.get(f"{RUNS}/{RUN}/files").json()

    assert run["file_count"] == 3
    assert listed["total"] == 3
    assert len(listed["items"]) == 3
    assert run["file_count"] == listed["total"]


def test_the_signal_count_matches_the_rows_the_signals_tab_holds(client, files_db) -> None:
    """A quarantined file writes no inventory row, so it lifts no badge."""
    _run_with_a_quarantined_file(client, files_db)

    run = client.get(f"{RUNS}/{RUN}").json()
    response = client.get(f"{RUNS}/{RUN}/signals", params={"page_size": 50})
    assert response.status_code == 200, response.text
    listed = response.json()

    assert run["signal_count"] == RUN_SIGNAL_COUNT
    assert listed["total"] == RUN_SIGNAL_COUNT
    assert len(listed["items"]) == RUN_SIGNAL_COUNT
    assert run["signal_count"] == listed["total"]

    served = {item["name"] for item in listed["items"]}
    for name in QUARANTINED_SIGNALS:
        assert name not in served


def test_the_lineage_prints_the_same_two_numbers(client, files_db) -> None:
    """The third screen must not invent a third pair of numbers."""
    _run_with_a_quarantined_file(client, files_db)

    run = client.get(f"{RUNS}/{RUN}").json()
    lineage = client.get(f"{RUNS}/{RUN}/lineage").json()

    assert len(lineage["files"]) == 3
    assert lineage["run"]["file_count"] == run["file_count"] == 3
    assert lineage["run"]["signal_count"] == run["signal_count"] == RUN_SIGNAL_COUNT


def test_the_runs_list_prints_the_same_two_numbers(client, files_db) -> None:
    """The list row and the detail screen must agree about one run."""
    _run_with_a_quarantined_file(client, files_db)

    page = client.get(RUNS, params={"page_size": 50}).json()

    row = next(item for item in page["items"] if item["run_id"] == RUN)
    assert row["file_count"] == 3
    assert row["signal_count"] == RUN_SIGNAL_COUNT


# --- The read side: a stored count can never beat the rows ---
#
# The rollup keeps the stored counts right for a file that arrives through
# `POST /files`. Not every run arrives that way. The seed's filler writes its
# runs straight into Mongo, and an older filler wrote a literal `signal_count`
# with no `file_signals` row at all, so a badge said 12 over an empty table.
# `run_facts` derives what every route serves, so a stored lie cannot reach a
# screen.

LIE = {"file_count": 99, "signal_count": 12}


def _tell_the_stored_counts_a_lie(db) -> None:
    db["test_runs"].update_one({"_id": RUN}, {"$set": LIE})


def test_the_detail_derives_its_counts_over_a_stored_lie(client, files_db) -> None:
    _run_with_a_quarantined_file(client, files_db)
    _tell_the_stored_counts_a_lie(files_db)

    run = client.get(f"{RUNS}/{RUN}").json()

    assert run["file_count"] == 3
    assert run["signal_count"] == RUN_SIGNAL_COUNT


def test_the_list_derives_its_counts_over_a_stored_lie(client, files_db) -> None:
    _run_with_a_quarantined_file(client, files_db)
    _tell_the_stored_counts_a_lie(files_db)

    page = client.get(RUNS, params={"page_size": 50}).json()

    row = next(item for item in page["items"] if item["run_id"] == RUN)
    assert row["file_count"] == 3
    assert row["signal_count"] == RUN_SIGNAL_COUNT


def test_the_lineage_derives_its_counts_over_a_stored_lie(client, files_db) -> None:
    _run_with_a_quarantined_file(client, files_db)
    _tell_the_stored_counts_a_lie(files_db)

    lineage = client.get(f"{RUNS}/{RUN}/lineage").json()

    assert lineage["run"]["file_count"] == len(lineage["files"]) == 3
    assert lineage["run"]["signal_count"] == RUN_SIGNAL_COUNT


def test_the_work_order_panel_derives_its_counts_over_a_stored_lie(
    client, files_db
) -> None:
    """The fourth screen that prints the pair. It must print the same pair."""
    files_db["work_orders"].insert_one(make_work_order(WO))
    upsert_run(files_db, _id=RUN, work_order_id=WO)
    _register(client, "a1" * 32, FIRST_SIGNALS)
    _register(client, "b2" * 32, SECOND_SIGNALS)
    _register(client, "c3" * 32, QUARANTINED_SIGNALS, checksum_state="mismatch")
    _tell_the_stored_counts_a_lie(files_db)

    detail = client.get(f"/api/v1/work-orders/{WO}").json()

    row = next(item for item in detail["runs"] if item["run_id"] == RUN)
    assert row["file_count"] == 3
    assert row["signal_count"] == RUN_SIGNAL_COUNT


def test_a_run_with_no_inventory_row_shows_no_signal(client, files_db) -> None:
    """The filler badge fault: a literal 12 over an empty Signals tab."""
    upsert_run(files_db, _id=RUN)
    files_db["test_runs"].update_one({"_id": RUN}, {"$set": LIE})

    run = client.get(f"{RUNS}/{RUN}").json()
    listed = client.get(f"{RUNS}/{RUN}/signals", params={"page_size": 50})

    assert run["file_count"] == 0
    assert run["signal_count"] == 0
    assert listed.json()["total"] == 0
