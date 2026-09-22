# One signal, one run count (contract SS-C, the signal-detail screen).
#
# Contract SS-C ties three reads to one screen and one phrase, "seen in 12
# runs": SS-B #15 `run_count`, SS-B #16 the per-run statistics table, and
# SS-B #2 `?signal=` behind the "View as run filter" link.
#
# THE TRUTH IS THE REGISTRY INVENTORY, the `file_signals` collection.
# SS-B #7 already rules it: "The inventory stays in the registry. Which
# signals the run carries ... come from Mongo." Which runs carry a signal is
# that same inventory, read the other way. `POST /files` writes it, and
# `upsert_file_signals` derives `run_count` from it on every write.
#
# So `run_count` and `?signal=` answer one question and must always agree.
# These tests pin that, through the write path a real ingestion takes.
#
# `GET /signals/{name}/stats` (#16) answers a DIFFERENT question and cannot be
# forced to agree. See `test_the_stats_table_never_claims_a_run_the_registry_
# does_not_know` below, and the note above it.

from tests import factories
from tests.factories import upsert_run

files_db = factories.files_db

SIGNAL = "HV_Batt_Cell_Temp_Max"
FILES = "/api/v1/files"


def _body(run_id: str, checksum: str, names: list[str]) -> dict:
    return {
        "filename": f"{run_id.lower()}.mf4",
        "run_id": run_id,
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 1024,
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


def _register(client, db, run_id: str, checksum: str, names=(SIGNAL,)) -> None:
    upsert_run(db, _id=run_id)
    response = client.post(FILES, json=_body(run_id, checksum, list(names)))
    assert response.status_code == 201, response.text


def _catalogue_run_count(client) -> int:
    response = client.get(f"/api/v1/signals/{SIGNAL}")
    assert response.status_code == 200, response.text
    return response.json()["run_count"]


def _runs_filtered_by_signal(client) -> int:
    response = client.get("/api/v1/test-runs", params={"signal": SIGNAL})
    assert response.status_code == 200, response.text
    return response.json()["total"]


def _inventory_run_count(db) -> int:
    return len(db["file_signals"].distinct("run_id", {"name": SIGNAL}))


def test_the_catalogue_count_equals_the_registry_inventory(client, files_db):
    for index in range(3):
        _register(client, files_db, f"TAS-9000{index}", f"{index:02x}" * 32)

    assert _inventory_run_count(files_db) == 3
    assert _catalogue_run_count(client) == 3


def test_the_catalogue_count_and_the_run_filter_agree(client, files_db):
    for index in range(4):
        _register(client, files_db, f"TAS-9100{index}", f"{index + 16:02x}" * 32)

    assert _catalogue_run_count(client) == _runs_filtered_by_signal(client) == 4


def test_two_files_of_one_run_count_that_run_one_time(client, files_db):
    """`run_count` counts runs, never registrations."""
    _register(client, files_db, "TAS-92000", "aa" * 32)
    _register(client, files_db, "TAS-92000", "bb" * 32)

    assert _catalogue_run_count(client) == _runs_filtered_by_signal(client) == 1


def test_a_replayed_registration_never_lifts_the_count(client, files_db):
    upsert_run(files_db, _id="TAS-93000")
    body = _body("TAS-93000", "cc" * 32, [SIGNAL])

    assert client.post(FILES, json=body).status_code == 201
    assert client.post(FILES, json=body).status_code == 200

    assert _catalogue_run_count(client) == 1


def test_a_file_that_names_no_run_never_lifts_the_count(client, files_db):
    _register(client, files_db, "TAS-94000", "dd" * 32)
    unlinked = _body("TAS-94000", "ee" * 32, [SIGNAL])
    unlinked["run_id"] = None
    assert client.post(FILES, json=unlinked).status_code == 201

    assert _catalogue_run_count(client) == 1


def test_the_stats_table_never_claims_a_run_the_registry_does_not_know(
    client, files_db, stub_lake
):
    """#16 may show fewer runs than `run_count`. It must never show more.

    The statistics table lists a run only when the provider holds numbers for
    it, and `SignalStatsRow` requires a min, a max, a mean and a standard
    deviation. A run the registry knows and the provider never measured has no
    row to show. So the table is a subset of `run_count`, and the two counts
    answer different questions. This test pins the direction of that gap: the
    table must never claim a run the registry does not carry.
    """
    for index in range(3):
        _register(client, files_db, f"TAS-9500{index}", f"{index + 32:02x}" * 32)

    response = client.get(f"/api/v1/signals/{SIGNAL}/stats", params={"window": "run"})

    assert response.status_code == 200, response.text
    known = set(files_db["file_signals"].distinct("run_id", {"name": SIGNAL}))
    listed = {row["run_id"] for row in response.json()["items"]}
    assert listed <= known
    assert response.json()["total"] <= _catalogue_run_count(client)
