"""FR-DM-013 — the run window follows the files the run holds.

The run is the container and its files are the parts. `run_facts` derives
`file_count` and `signal_count` at read time, so neither number can drift.
The window is stored, because `first_data_at` is the runs-list sort key and
Mongo sorts on a stored value. `apply_file_rollup` therefore has to re-derive
the window every time a file changes.

A re-link is the case that drifted. The window only ever grew, so a run kept a
`started_at` and an `ended_at` that its remaining files no longer supported.

The run's OWN window is a separate input. `POST /test-runs` takes `started_at`
and `ended_at` (`RunUpsertRequest`), so a producer can state a window for a run
that holds no file at all. The rollup unions that stated window with the file
windows, and a file that leaves never takes the stated window with it.
"""

import uuid
from datetime import datetime

from tests import factories

# The assignment re-exports the fixture without shadowing an import.
files_db = factories.files_db

FILES = "/api/v1/files"
RUNS = "/api/v1/test-runs"
RUN_A = "TAS-88214"
RUN_B = "TAS-88215"
ACTOR = "a.bergstrom"


def _create_run(client, run_id: str, **fields) -> None:
    """Register a run through the real route, so it carries what a producer states."""
    response = client.post(RUNS, json={"run_id": run_id, "rig_id": "RIG-04", **fields})
    assert response.status_code == 201, response.text


def _register(client, run_id: str, start: str, end: str) -> str:
    """Register one file with a time range. Return its id."""
    response = client.post(
        FILES,
        json={
            "filename": "bat_cyc_20260814_0941.mf4",
            "run_id": run_id,
            "source_system": "TAS",
            "format": "MDF 4.10",
            "size_bytes": 1024,
            "checksum_sha256": uuid.uuid4().hex * 2,
            "checksum_state": "verified",
            "time_start": start,
            "time_end": end,
            "signals": [
                {"name": "CAR_SPEED", "unit": "km/h", "rate_hz": 100.0, "dtype": "float64"}
            ],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["file_id"]


def _relink(client, file_id: str, run_id: str) -> None:
    response = client.patch(f"{FILES}/{file_id}", json={"run_id": run_id, "actor": ACTOR})
    assert response.status_code == 200, response.text


def _run(client, run_id: str) -> dict:
    response = client.get(f"{RUNS}/{run_id}")
    assert response.status_code == 200, response.text
    return response.json()


def _at(value: str | None) -> datetime | None:
    return None if value is None else datetime.fromisoformat(value)


def test_the_old_run_window_drops_the_file_that_left(client, files_db) -> None:
    """The window is the union of the files the run holds NOW."""
    _create_run(client, RUN_A)
    _create_run(client, RUN_B)
    wide = _register(client, RUN_A, "2026-08-14T08:30:00Z", "2026-08-14T12:00:00Z")
    _register(client, RUN_A, "2026-08-14T10:00:00Z", "2026-08-14T10:30:00Z")

    _relink(client, wide, RUN_B)

    old = _run(client, RUN_A)
    assert _at(old["started_at"]) == datetime.fromisoformat("2026-08-14T10:00:00Z")
    assert _at(old["ended_at"]) == datetime.fromisoformat("2026-08-14T10:30:00Z")


def test_the_new_run_takes_the_window_of_the_file_it_gained(client, files_db) -> None:
    _create_run(client, RUN_A)
    _create_run(client, RUN_B)
    wide = _register(client, RUN_A, "2026-08-14T08:30:00Z", "2026-08-14T12:00:00Z")

    _relink(client, wide, RUN_B)

    new = _run(client, RUN_B)
    assert _at(new["started_at"]) == datetime.fromisoformat("2026-08-14T08:30:00Z")
    assert _at(new["ended_at"]) == datetime.fromisoformat("2026-08-14T12:00:00Z")


def test_a_run_that_lost_its_last_file_holds_no_window(client, files_db) -> None:
    """The run stated no window of its own, so nothing is left to state one."""
    _create_run(client, RUN_A)
    _create_run(client, RUN_B)
    only = _register(client, RUN_A, "2026-08-14T09:00:00Z", "2026-08-14T10:00:00Z")

    _relink(client, only, RUN_B)

    old = _run(client, RUN_A)
    assert old["started_at"] is None
    assert old["ended_at"] is None


def test_the_window_the_producer_stated_survives_the_re_link(client, files_db) -> None:
    """`POST /test-runs` states a run window. A file that leaves never takes it."""
    _create_run(
        client,
        RUN_A,
        started_at="2026-08-14T09:00:00Z",
        ended_at="2026-08-14T12:00:00Z",
    )
    _create_run(client, RUN_B)
    wider = _register(client, RUN_A, "2026-08-14T08:00:00Z", "2026-08-14T13:00:00Z")

    _relink(client, wider, RUN_B)

    old = _run(client, RUN_A)
    assert _at(old["started_at"]) == datetime.fromisoformat("2026-08-14T09:00:00Z")
    assert _at(old["ended_at"]) == datetime.fromisoformat("2026-08-14T12:00:00Z")


def test_first_data_at_never_stands_later_than_the_run_start(client, files_db) -> None:
    """The documented invariant, held through a re-link."""
    _create_run(client, RUN_A)
    _create_run(client, RUN_B)
    wide = _register(client, RUN_A, "2026-08-14T08:30:00Z", "2026-08-14T12:00:00Z")
    _register(client, RUN_A, "2026-08-14T10:00:00Z", "2026-08-14T10:30:00Z")

    _relink(client, wide, RUN_B)

    old = _run(client, RUN_A)
    assert _at(old["first_data_at"]) <= _at(old["started_at"])
