# FR-DM-006b — the sync, the upload and the conversion status of a file.
#
# The pipeline runs the three stages outside this repository. It reports each
# outcome to this API. `POST /files` states the outcomes it already knows, and
# `PATCH /files/{file_id}` states a later one, so a re-run conversion shows in
# the ingestion timeline.
#
# The stage fields never promote a file. Only a run link ends a quarantine.

import uuid

import pytest

from tests import factories
from tests.factories import register_file, upsert_run

files_db = factories.files_db

FILES = "/api/v1/files"
RUN = "TAS-88214"
UNKNOWN_RUN = "TAS-00001"
ACTOR = "a.bergstrom"
STAGE_FIELDS = ("sync_status", "upload_status", "conversion_status")


@pytest.fixture(autouse=True)
def stats_lake(stub_lake):
    """Answer the statistics from the stub lake. This suite runs no real lake.

    This fixture pinned `TM_STATS_PROVIDER=mongo` until 20 Aug 2026. The switch
    is gone and the lake is the one statistics path, so the suite stubs the
    lake instead of picking a second mode.
    """


def _checksum() -> str:
    return uuid.uuid4().hex * 2


def _body(**overrides) -> dict:
    """A registration that proves nothing about any stage.

    `checksum_state` is `unverified`, there is no `storage_ref` and there are
    no signals, so `_derived_stages` derives none of the four (21 Aug 2026).
    A test of the derivation states its own facts. A test of a stated value or
    of a patch starts from this blank slate.
    """
    body = {
        "filename": "bat_cyc_20260814_0941.mf4",
        "run_id": RUN,
        "source_system": "INCA",
        "format": "MDF 4.10",
        "size_bytes": 1024,
        "checksum_sha256": _checksum(),
        "checksum_state": "unverified",
    }
    body.update(overrides)
    return body


def _register(client, **overrides) -> dict:
    response = client.post(FILES, json=_body(**overrides))
    assert response.status_code == 201, response.text
    return response.json()


def _patch(client, file_id: str, **fields):
    response = client.patch(f"{FILES}/{file_id}", json={"actor": ACTOR, **fields})
    return response.status_code, response.json()


def _row(client, file_id: str) -> dict:
    rows = client.get(FILES).json()["items"]
    return next(row for row in rows if row["file_id"] == file_id)


# --- the registration states the outcomes it knows ----------------------------


def test_the_registration_stores_the_three_stage_statuses(client, files_db) -> None:
    upsert_run(files_db, _id=RUN)

    file = _register(
        client,
        sync_status="success",
        upload_status="success",
        conversion_status="in_progress",
    )

    assert file["sync_status"] == "success"
    assert file["upload_status"] == "success"
    assert file["conversion_status"] == "in_progress"
    assert file["stage_error"] is None

    detail = client.get(f"{FILES}/{file['file_id']}").json()
    assert detail["sync_status"] == "success"
    assert detail["upload_status"] == "success"
    assert detail["conversion_status"] == "in_progress"

    row = _row(client, file["file_id"])
    assert row["conversion_status"] == "in_progress"


def test_the_registration_stores_a_failed_stage_and_its_error(client, files_db) -> None:
    upsert_run(files_db, _id=RUN)

    file = _register(
        client,
        sync_status="success",
        upload_status="failed",
        stage_error="the transfer timed out after 3 tries",
    )

    detail = client.get(f"{FILES}/{file['file_id']}").json()
    assert detail["upload_status"] == "failed"
    assert detail["stage_error"] == "the transfer timed out after 3 tries"


def test_a_file_with_no_stage_report_serves_null(client, files_db) -> None:
    """A stage nobody reported is unknown, not failed."""
    upsert_run(files_db, _id=RUN)

    file = _register(client)

    detail = client.get(f"{FILES}/{file['file_id']}").json()
    row = _row(client, file["file_id"])
    for field in (*STAGE_FIELDS, "stage_error"):
        assert file[field] is None
        assert detail[field] is None
        assert row[field] is None


def test_an_old_document_with_no_stage_keys_serves_null(client, files_db) -> None:
    """Mongo holds files that were written before these fields existed."""
    stored = register_file(files_db)

    detail = client.get(f"{FILES}/{stored['_id']}").json()

    for field in (*STAGE_FIELDS, "stage_error"):
        assert field in detail
        assert detail[field] is None


def test_an_unknown_status_on_the_registration_answers_422(client, files_db) -> None:
    upsert_run(files_db, _id=RUN)

    response = client.post(FILES, json=_body(conversion_status="done"))

    assert response.status_code == 422


# --- the pipeline reports a later stage ---------------------------------------


def test_a_patch_records_a_failed_conversion(client, files_db) -> None:
    upsert_run(files_db, _id=RUN)
    file = _register(client, conversion_status="in_progress")

    status, body = _patch(
        client,
        file["file_id"],
        conversion_status="failed",
        stage_error="the MF4 header names 0 channels",
    )

    assert status == 200, body
    assert body["conversion_status"] == "failed"
    assert body["stage_error"] == "the MF4 header names 0 channels"
    stored = files_db["files"].find_one({"_id": file["file_id"]})
    assert stored["conversion_status"] == "failed"


def test_a_stage_patch_needs_no_run_id(client, files_db) -> None:
    """The stage fields stand alone. The body states no run."""
    upsert_run(files_db, _id=RUN)
    file = _register(client)

    status, body = _patch(client, file["file_id"], sync_status="pending")

    assert status == 200, body
    assert body["sync_status"] == "pending"
    assert body["run_id"] == RUN


def test_the_stage_patch_journals_the_change(client, files_db) -> None:
    upsert_run(files_db, _id=RUN)
    file = _register(client, conversion_status="in_progress")

    _patch(
        client,
        file["file_id"],
        conversion_status="failed",
        stage_error="the MF4 header names 0 channels",
        note="run 2 of the converter",
    )

    entries = list(
        files_db["journal_entries"].find(
            {"entity_id": file["file_id"], "field": "file.conversion_status"}
        )
    )
    assert len(entries) == 1
    entry = entries[0]
    assert entry["entity_type"] == "file"
    assert entry["kind"] == "change"
    assert entry["old"] == "in_progress"
    assert entry["new"] == "failed"
    assert entry["source"] == "manual"
    assert entry["actor"] == ACTOR
    assert entry["note"] == "run 2 of the converter"

    detail = client.get(f"{FILES}/{file['file_id']}").json()
    fields = [item["field"] for item in detail["ingestion_timeline"]]
    assert "file.conversion_status" in fields
    assert "file.stage_error" in fields


def test_the_stage_patch_carries_the_manual_source(client, files_db) -> None:
    upsert_run(files_db, _id=RUN)
    file = _register(client)

    _status, body = _patch(client, file["file_id"], upload_status="success")

    source = body["field_sources"]["upload_status"]
    assert source["source"] == "manual"
    assert source["actor"] == ACTOR
    assert source["at"]


# --- a stage never promotes a file -------------------------------------------


def test_a_stage_patch_keeps_a_quarantined_file_quarantined(client, files_db) -> None:
    """Only a run link ends a quarantine. A conversion outcome never does."""
    file = _register(client, run_id=UNKNOWN_RUN)
    assert file["status"] == "quarantined"
    assert file["quarantine_reason"] == "no run key"
    upsert_run(files_db, _id=RUN)

    status, body = _patch(
        client,
        file["file_id"],
        conversion_status="failed",
        stage_error="the converter refused the file",
    )

    assert status == 200, body
    assert body["status"] == "quarantined"
    assert body["quarantine_reason"] == "no run key"
    assert body["run_id"] == UNKNOWN_RUN
    stored = files_db["files"].find_one({"_id": file["file_id"]})
    assert stored["status"] == "quarantined"
    assert stored["quarantine_reason"] == "no run key"
    fields = [item["field"] for item in body["ingestion_timeline"]]
    assert "file.unquarantined" not in fields


def test_a_success_conversion_keeps_a_bad_checksum_quarantined(client, files_db) -> None:
    upsert_run(files_db, _id=RUN)
    file = _register(client, checksum_state="mismatch")
    assert file["quarantine_reason"] == "checksum mismatch"

    _status, body = _patch(client, file["file_id"], conversion_status="success")

    assert body["status"] == "quarantined"
    assert body["quarantine_reason"] == "checksum mismatch"


# --- the body refuses a value the contract does not name ----------------------


@pytest.mark.parametrize("field", STAGE_FIELDS)
def test_an_unknown_stage_value_answers_422(client, files_db, field) -> None:
    upsert_run(files_db, _id=RUN)
    file = _register(client)

    status, body = _patch(client, file["file_id"], **{field: "done"})

    assert status == 422, body
    stored = files_db["files"].find_one({"_id": file["file_id"]})
    assert stored.get(field) is None


def test_an_empty_body_still_answers_400(client, files_db) -> None:
    """A body that states no field writes nothing."""
    upsert_run(files_db, _id=RUN)
    file = _register(client)

    status, body = _patch(client, file["file_id"])

    assert status == 400
    assert body["code"] == "no_fields_to_update"


# --- a repeated report journals nothing ---------------------------------------
#
# Finding 31a (21 Aug 2026). The patch wrote every stage field the body named,
# without comparing it with the stored one. A pipeline that reports the same
# outcome twice — a retry, or a poller — then journalled "success → success",
# and the ingestion timeline stated a change that never happened.


@pytest.mark.parametrize("field", STAGE_FIELDS)
def test_a_repeated_stage_report_writes_no_journal_row(client, files_db, field) -> None:
    upsert_run(files_db, _id=RUN)
    file = _register(client)
    assert _patch(client, file["file_id"], **{field: "success"})[0] == 200
    stamped = files_db["files"].find_one({"_id": file["file_id"]})["updated_at"]

    status, body = _patch(client, file["file_id"], **{field: "success"})

    assert status == 200, body
    assert body[field] == "success"
    entries = list(
        files_db["journal_entries"].find(
            {"entity_id": file["file_id"], "field": f"file.{field}"}
        )
    )
    assert len(entries) == 1
    assert files_db["files"].find_one({"_id": file["file_id"]})["updated_at"] == stamped


def test_a_repeat_beside_a_real_change_still_journals_the_change(
    client, files_db
) -> None:
    """One unchanged field must not silence the field beside it."""
    upsert_run(files_db, _id=RUN)
    file = _register(client)
    assert _patch(client, file["file_id"], sync_status="success")[0] == 200

    status, body = _patch(
        client, file["file_id"], sync_status="success", upload_status="success"
    )

    assert status == 200, body
    fields = [
        entry["field"]
        for entry in files_db["journal_entries"].find({"entity_id": file["file_id"]})
    ]
    assert fields.count("file.sync_status") == 1
    assert fields.count("file.upload_status") == 1


# --- the registration derives what the body already proves --------------------
#
# FR-DM-006b, 21 Aug 2026. The four fields existed and no producer set them, so
# a stage that never reported looked like a stage still running. Each rule below
# reads one fact of the body. A stage the body does not support stays null.


def test_a_verified_checksum_derives_a_successful_sync(client, files_db) -> None:
    upsert_run(files_db, _id=RUN)

    file = _register(client, checksum_state="verified")

    assert file["sync_status"] == "success"
    assert file["stage_error"] is None


def test_a_checksum_mismatch_derives_a_failed_sync_and_its_error(
    client, files_db
) -> None:
    upsert_run(files_db, _id=RUN)

    file = _register(client, checksum_state="mismatch")

    assert file["sync_status"] == "failed"
    assert file["stage_error"] == "the producer reported a checksum mismatch"
    # The quarantine order does not move. A stage value never decides it.
    assert file["status"] == "quarantined"
    assert file["quarantine_reason"] == "checksum mismatch"


def test_an_unverified_checksum_derives_no_sync_status(client, files_db) -> None:
    """Nobody compared two digests, so nothing is known."""
    upsert_run(files_db, _id=RUN)

    file = _register(client, checksum_state="unverified")

    assert file["sync_status"] is None


def test_a_storage_ref_derives_a_successful_upload(client, files_db) -> None:
    upsert_run(files_db, _id=RUN)

    file = _register(client, storage_ref="blob://mf4/bat_cyc_20260814_0941.mf4")

    assert file["upload_status"] == "success"


def test_no_storage_ref_derives_no_upload_status(client, files_db) -> None:
    """A failed upload and an upload nobody ran are not the same fact."""
    upsert_run(files_db, _id=RUN)

    file = _register(client)

    assert file["upload_status"] is None


def test_a_signal_inventory_derives_a_successful_conversion(client, files_db) -> None:
    upsert_run(files_db, _id=RUN)

    file = _register(
        client,
        signals=[
            {
                "name": "HV_Batt_Cell_Temp_Max",
                "unit": "°C",
                "rate_hz": 100.0,
                "dtype": "float64",
            }
        ],
    )

    assert file["conversion_status"] == "success"


def test_an_empty_inventory_derives_no_conversion_status(client, files_db) -> None:
    """A file may hold no channel, and a decode may fail. Not one fact."""
    upsert_run(files_db, _id=RUN)

    file = _register(client, signals=[])

    assert file["conversion_status"] is None


def test_a_quarantined_file_still_derives_its_stages(client, files_db) -> None:
    """The never-drop rule keeps the record, and the record keeps its facts."""
    file = _register(
        client,
        run_id=UNKNOWN_RUN,
        checksum_state="verified",
        storage_ref="blob://mf4/orphan.mf4",
    )

    assert file["status"] == "quarantined"
    assert file["quarantine_reason"] == "no run key"
    assert file["sync_status"] == "success"
    assert file["upload_status"] == "success"


# --- a stated value always wins ----------------------------------------------


def test_a_stated_stage_wins_over_the_derived_one(client, files_db) -> None:
    upsert_run(files_db, _id=RUN)

    file = _register(
        client,
        checksum_state="verified",
        storage_ref="blob://mf4/bat_cyc.mf4",
        sync_status="in_progress",
        upload_status="pending",
    )

    assert file["sync_status"] == "in_progress"
    assert file["upload_status"] == "pending"


def test_a_stated_sync_drops_the_derived_error(client, files_db) -> None:
    """A derived detail must never describe a failure the producer denies."""
    upsert_run(files_db, _id=RUN)

    file = _register(client, checksum_state="mismatch", sync_status="success")

    assert file["sync_status"] == "success"
    assert file["stage_error"] is None


def test_a_stated_error_wins_over_the_derived_one(client, files_db) -> None:
    upsert_run(files_db, _id=RUN)

    file = _register(
        client,
        checksum_state="mismatch",
        stage_error="the transfer timed out after 3 tries",
    )

    assert file["sync_status"] == "failed"
    assert file["stage_error"] == "the transfer timed out after 3 tries"


# --- a replay writes nothing --------------------------------------------------


def test_a_replay_keeps_the_stored_stage_values(client, files_db) -> None:
    upsert_run(files_db, _id=RUN)
    body = _body(checksum_state="verified", sync_status="in_progress")
    first = client.post(FILES, json=body).json()

    again = client.post(FILES, json=body)

    assert again.status_code == 200, again.text
    assert again.json()["file_id"] == first["file_id"]
    assert again.json()["sync_status"] == "in_progress"


# --- an API submission derives nothing ----------------------------------------


def test_an_api_submission_serves_null_for_all_four(client, files_db) -> None:
    """Contract §D rule 5. No pipeline stage ran over a logical file.

    The facade states `checksum_state: verified` and it sends an inventory, so
    a derived registration would answer "success" twice. It sends no samples,
    so the route needs no lake.
    """
    upsert_run(files_db, _id=RUN)

    response = client.post(
        f"/api/v1/test-runs/{RUN}/signals",
        json={
            "actor": ACTOR,
            "signals": [
                {
                    "name": "HV_Batt_Cell_Temp_Max",
                    "unit": "°C",
                    "rate_hz": 100.0,
                    "dtype": "float64",
                }
            ],
        },
    )

    assert response.status_code == 201, response.text
    detail = client.get(f"{FILES}/{response.json()['file_id']}").json()
    for field in (*STAGE_FIELDS, "stage_error"):
        assert detail[field] is None, field
