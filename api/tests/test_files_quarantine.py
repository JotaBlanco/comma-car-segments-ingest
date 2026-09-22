# POST /files persists to Mongo and never drops a file (appendix ★).

import uuid

from tests import factories
from tests.factories import upsert_run

files_db = factories.files_db

FILES = "/api/v1/files"


def _checksum() -> str:
    return uuid.uuid4().hex * 2


def _body(**overrides) -> dict:
    body = {
        "filename": "bat_cyc_20260814_0941.mf4",
        "run_id": "TAS-88214",
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 1024,
        "checksum_sha256": _checksum(),
        "checksum_state": "verified",
    }
    body.update(overrides)
    return body


def _post(client, **overrides):
    return client.post(FILES, json=_body(**overrides))


def test_checksum_mismatch_registers_quarantined(client, files_db):
    upsert_run(files_db)
    response = _post(client, checksum_state="mismatch")
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "quarantined"
    assert body["quarantine_reason"] == "checksum mismatch"

    stored = files_db["files"].find_one({"_id": body["file_id"]})
    assert stored is not None
    assert stored["status"] == "quarantined"

    listed = client.get(FILES, params={"status": "quarantined"}).json()
    assert body["file_id"] in [item["file_id"] for item in listed["items"]]


def test_null_run_id_quarantines_no_run_key(client, files_db):
    response = _post(client, run_id=None)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "quarantined"
    assert body["quarantine_reason"] == "no run key"


def test_unresolvable_run_id_quarantines_no_run_key(client, files_db):
    response = _post(client, run_id="TAS-00001")
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "quarantined"
    assert body["quarantine_reason"] == "no run key"

    # The partial metadata survives: the registry keeps the unresolved key.
    stored = files_db["files"].find_one({"_id": body["file_id"]})
    assert stored["run_id"] == "TAS-00001"


def test_caller_reason_quarantines(client, files_db):
    upsert_run(files_db)
    response = _post(client, quarantine_reason="unparseable header")
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "quarantined"
    assert body["quarantine_reason"] == "unparseable header"


def test_rules_apply_in_contract_order(client, files_db):
    response = _post(
        client,
        checksum_state="mismatch",
        run_id=None,
        quarantine_reason="unparseable header",
    )
    assert response.status_code == 201, response.text
    assert response.json()["quarantine_reason"] == "checksum mismatch"

    response = _post(client, run_id=None, quarantine_reason="unparseable header")
    assert response.status_code == 201, response.text
    assert response.json()["quarantine_reason"] == "no run key"


def test_registered_file_persists_and_journals(client, files_db):
    upsert_run(files_db)
    response = _post(client)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "registered"
    assert body["quarantine_reason"] is None

    stored = files_db["files"].find_one({"_id": body["file_id"]})
    assert stored is not None
    assert stored["run_id"] == "TAS-88214"

    entries = list(files_db["journal_entries"].find({"entity_id": body["file_id"]}))
    assert len(entries) == 1
    entry = entries[0]
    assert entry["entity_type"] == "file"
    assert entry["field"] == "file.registered"
    assert entry["kind"] == "event"
    assert entry["actor"]


def test_a_quarantined_file_is_journalled_too(client, files_db):
    # The journal write covers every file, not only the registered one.
    # The file-detail screen reads that entry as the ingestion timeline.
    response = _post(client, run_id=None)
    assert response.status_code == 201, response.text
    file_id = response.json()["file_id"]

    detail = client.get(f"{FILES}/{file_id}").json()
    timeline = detail["ingestion_timeline"]
    assert len(timeline) == 1
    assert timeline[0]["field"] == "file.registered"
    assert timeline[0]["kind"] == "event"
    assert timeline[0]["actor"]
    assert "no run key" in timeline[0]["note"]


def test_the_file_document_counts_its_distinct_signal_names(client, files_db):
    # A body may name the same signal two times. The inventory keys on
    # (file_id, name), so it stores one row. signal_count must agree with
    # the signals list the detail serves, or the two contradict each other.
    upsert_run(files_db)
    signal = {"name": "Coolant_Inlet_Temp", "unit": "°C", "rate_hz": 10.0, "dtype": "float64"}
    other = {"name": "Chamber_Humidity", "unit": None, "rate_hz": 1.0, "dtype": "float64"}

    response = _post(client, signals=[signal, other, dict(signal)])
    assert response.status_code == 201, response.text
    file_id = response.json()["file_id"]

    detail = client.get(f"{FILES}/{file_id}").json()
    assert len(detail["signals"]) == 2
    assert detail["signal_count"] == len(detail["signals"])
    assert response.json()["signal_count"] == len(detail["signals"])


def test_the_registered_file_carries_its_own_field_sources(client, files_db):
    # The route tags every field the bytes and the header of the file prove.
    # It tagged two of them until 24 Aug 2026, and TR-011 called that the gap:
    # the other six read as "nobody recorded a source" although the file
    # stated them. `_EMBEDDED_FIELDS` is the list, and it holds eight.
    from api.routers.files import _EMBEDDED_FIELDS

    upsert_run(files_db)
    file_id = _post(client).json()["file_id"]

    sources = client.get(f"{FILES}/{file_id}").json()["field_sources"]
    assert set(sources) == set(_EMBEDDED_FIELDS)
    for entry in sources.values():
        assert entry["source"] == "embedded"
        assert entry["actor"] == "ingestion"
        assert entry["at"]


def test_quarantined_file_keeps_partial_metadata(client, files_db):
    response = _post(
        client,
        checksum_state="mismatch",
        size_bytes=4096,
        time_start="2026-08-14T09:41:07Z",
        time_end="2026-08-14T11:18:52Z",
    )
    assert response.status_code == 201, response.text
    stored = files_db["files"].find_one({"_id": response.json()["file_id"]})
    assert stored["size_bytes"] == 4096
    assert stored["time_start"] is not None
    assert stored["time_end"] is not None


def test_unknown_field_returns_422_naming_the_field(client, files_db):
    response = client.post(FILES, json=_body(wrong_field=1))
    assert response.status_code == 422
    assert "wrong_field" in response.json()["detail"]


def test_no_file_is_ever_dropped(client, files_db):
    upsert_run(files_db)
    cases = [
        {},
        {"checksum_state": "mismatch"},
        {"run_id": None},
        {"quarantine_reason": "unparseable header"},
    ]
    for index, case in enumerate(cases, start=1):
        assert _post(client, **case).status_code == 201
        assert files_db["files"].count_documents({}) == index


def test_status_filter_splits_registered_and_quarantined(client, files_db):
    upsert_run(files_db)
    registered = _post(client).json()["file_id"]
    quarantined = _post(client, checksum_state="mismatch").json()["file_id"]

    only_bad = client.get(FILES, params={"status": "quarantined"}).json()
    assert [item["file_id"] for item in only_bad["items"]] == [quarantined]

    only_good = client.get(FILES, params={"status": "registered"}).json()
    assert [item["file_id"] for item in only_good["items"]] == [registered]

    both = client.get(FILES).json()
    assert both["total"] == 2
    assert {item["file_id"] for item in both["items"]} == {registered, quarantined}
