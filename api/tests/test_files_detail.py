# GET /files/{file_id} serves the whole detail screen (ticket B-03, contract #13).

from datetime import UTC, datetime, timedelta

from tests import factories
from tests.factories import insert_file_event, insert_file_signal, register_file

# The assignments re-export the fixtures without shadowing an import.
# files_db points the app at this test's database, with indexes applied.
files_db = factories.files_db

BASE_AT = datetime(2026, 8, 14, 9, 41, 12, tzinfo=UTC)
SOURCE_AT = datetime(2026, 8, 14, 9, 41, 33, tzinfo=UTC)


def _get(client, file_id: str, **params):
    return client.get(f"/api/v1/files/{file_id}", params=params)


def test_detail_serves_the_whole_screen_in_one_call(client, files_db):
    file = register_file(
        files_db,
        filename="bat_cyc_20260814_0941.mf4",
        storage_ref="blob://test-manager/landing/rig-04/bat_cyc_20260814_0941.mf4",
        ingestion_job_id="ing-20260814-0941-77c2",
        field_sources={"size_bytes": {"source": "embedded", "actor": "ingestion", "at": SOURCE_AT}},
    )
    file_id = file["_id"]
    insert_file_signal(files_db, file_id, "HV_Batt_Cell_Temp_Max")
    insert_file_signal(files_db, file_id, "Coolant_Inlet_Temp")
    insert_file_event(files_db, file_id, "file.detected", at=BASE_AT)
    insert_file_event(files_db, file_id, "file.registered", at=SOURCE_AT)

    # Decoys. The detail reads one file, so none of these may reach the body.
    # The second file tests the entity_id clause on both collections. The run
    # entry carries this file's id, so it tests the entity_type clause.
    other = register_file(files_db, filename="other.mf4")
    insert_file_signal(files_db, other["_id"], "Decoy_Signal")
    insert_file_event(files_db, other["_id"], "file.detected", at=BASE_AT)
    insert_file_event(files_db, file_id, "run.linked", at=BASE_AT, entity_type="run")

    response = _get(client, file_id)

    assert response.status_code == 200
    body = response.json()
    assert body["file_id"] == file_id
    assert body["filename"] == "bat_cyc_20260814_0941.mf4"
    assert body["run_id"] == file["run_id"]
    assert body["source_system"] == file["source_system"]
    assert body["status"] == "registered"
    assert body["storage_ref"] == file["storage_ref"]
    assert body["ingestion_job_id"] == "ing-20260814-0941-77c2"
    assert body["field_sources"]["size_bytes"]["source"] == "embedded"

    assert len(body["ingestion_timeline"]) == 2
    for entry in body["ingestion_timeline"]:
        assert entry["id"]
        assert entry["kind"] == "event"
        assert entry["entity_type"] == "file"
        assert entry["entity_id"] == file_id

    assert len(body["signals"]) == 2
    assert {row["name"] for row in body["signals"]} == {
        "HV_Batt_Cell_Temp_Max",
        "Coolant_Inlet_Temp",
    }
    for row in body["signals"]:
        assert row["unit"] == "°C"
        assert row["stats"] is not None


def test_timeline_is_chronological(client, files_db):
    file = register_file(files_db)
    file_id = file["_id"]
    insert_file_event(files_db, file_id, "file.registered", at=BASE_AT + timedelta(minutes=20))
    insert_file_event(files_db, file_id, "file.detected", at=BASE_AT)
    insert_file_event(
        files_db, file_id, "file.checksum_verified", at=BASE_AT + timedelta(minutes=10)
    )

    response = _get(client, file_id)

    assert response.status_code == 200
    timeline = response.json()["ingestion_timeline"]
    assert [entry["field"] for entry in timeline] == [
        "file.detected",
        "file.checksum_verified",
        "file.registered",
    ]
    stamps = [entry["at"] for entry in timeline]
    assert stamps == sorted(stamps)


def test_signals_limit_caps_the_list(client, files_db):
    file = register_file(files_db)
    file_id = file["_id"]
    insert_file_signal(files_db, file_id, "Signal_A")
    insert_file_signal(files_db, file_id, "Signal_B")
    insert_file_signal(files_db, file_id, "Signal_C")

    response = _get(client, file_id, signals_limit=2)

    assert response.status_code == 200
    assert len(response.json()["signals"]) == 2


def _register_body(**overrides) -> dict:
    """A POST /files body. It names no storage reference on purpose."""
    body = {
        "filename": "em_eff_20260813_1726.mf4",
        "run_id": None,
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 2048,
        "checksum_sha256": "b" * 64,
        "checksum_state": "verified",
    }
    body.update(overrides)
    return body


def test_a_file_with_no_storage_reference_serves_null(client, files_db):
    # The never-drop rule keeps a file the registry could not place, and such a
    # file carries no storage reference. POST /files accepts the body without
    # one, so the detail must serve `null` and never fail its own response
    # validation. It answered 500 internal_error until 2026-08-17 (§E1, now
    # agreed).
    registered = client.post("/api/v1/files", json=_register_body())
    assert registered.status_code == 201, registered.text
    file_id = registered.json()["file_id"]

    response = _get(client, file_id)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "quarantined"
    assert "storage_ref" in body
    assert body["storage_ref"] is None


def test_unknown_file_returns_404_file_not_found(client, files_db):
    response = _get(client, "f-does-not-exist")

    assert response.status_code == 404
    body = response.json()
    assert set(body) == {"detail", "code", "errors"}
    assert body["detail"] == "File f-does-not-exist not found"
    assert body["code"] == "file_not_found"
    assert body["errors"] == []


def test_wire_uses_file_id_not_underscore_id(client, files_db):
    file = register_file(files_db)

    response = _get(client, file["_id"])

    assert response.status_code == 200
    body = response.json()
    assert body["file_id"] == file["_id"]
    assert "_id" not in body
