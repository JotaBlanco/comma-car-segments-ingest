# PATCH /files/{file_id} — a person links an orphaned file to a run by hand.
#
# A file that names no run is orphaned (plans/design/INGEST-SPLIT.md section 5).
# The registration quarantines it with the reason "no run key" and keeps it, and
# nothing could repair it: /files carried no edit route, and a replay never
# promotes a quarantined file. The watcher moved to the ingestion pipeline, so
# the registry never sees the bytes and cannot resolve a run key by itself.
#
# The edit writes the run link and nothing else. The facts about the bytes stay
# out of the body, and a file with bad bytes never becomes registered here.

import uuid

import pytest

from tests import factories
from tests.factories import upsert_run

files_db = factories.files_db

FILES = "/api/v1/files"
RUNS = "/api/v1/test-runs"
RUN = "TAS-88214"
OTHER_RUN = "TAS-88215"
UNKNOWN_RUN = "TAS-00001"
ACTOR = "a.bergstrom"
SIGNALS = ["CAR_SPEED", "HV_Batt_SOC"]


@pytest.fixture(autouse=True)
def stats_lake(stub_lake):
    """Answer the statistics from the stub lake.

    These tests count rows, never numbers. A real lake answers 503 without a
    lakehouse url, and that answer belongs to another module.
    """


def _checksum() -> str:
    return uuid.uuid4().hex * 2


def _body(**overrides) -> dict:
    body = {
        "filename": "bat_cyc_20260814_0941.mf4",
        "run_id": RUN,
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 1024,
        "checksum_sha256": _checksum(),
        "checksum_state": "verified",
        "signals": [
            {"name": name, "unit": "°C", "rate_hz": 100.0, "dtype": "float64"}
            for name in SIGNALS
        ],
    }
    body.update(overrides)
    return body


def _register(client, **overrides) -> dict:
    response = client.post(FILES, json=_body(**overrides))
    assert response.status_code == 201, response.text
    return response.json()


def _orphan(client, db, **overrides) -> dict:
    """A file the registry could not place: it names a run nobody registered."""
    file = _register(client, run_id=UNKNOWN_RUN, **overrides)
    assert file["status"] == "quarantined"
    assert file["quarantine_reason"] == "no run key"
    upsert_run(db, _id=RUN)
    return file


def _patch(client, file_id: str, **fields):
    body = {"actor": ACTOR, **fields}
    response = client.patch(f"{FILES}/{file_id}", json=body)
    return response.status_code, response.json()


# --- the link lands ----------------------------------------------------------


def test_a_person_links_a_quarantined_file_to_a_run(client, files_db) -> None:
    file = _orphan(client, files_db)

    status, body = _patch(client, file["file_id"], run_id=RUN)

    assert status == 200, body
    assert body["run_id"] == RUN


def test_the_link_ends_a_no_run_key_quarantine(client, files_db) -> None:
    """The missing link was the reason, so the link repairs the file."""
    file = _orphan(client, files_db)

    _status, body = _patch(client, file["file_id"], run_id=RUN)

    assert body["status"] == "registered"
    assert body["quarantine_reason"] is None
    fields = [entry["field"] for entry in body["ingestion_timeline"]]
    assert "file.unquarantined" in fields


def test_the_same_id_still_ends_the_quarantine(client, files_db) -> None:
    """A quarantined file keeps the key it could not resolve.

    The run lands late, so the person states that same id. The link writes
    nothing and the quarantine still ends.
    """
    file = _register(client, run_id=UNKNOWN_RUN)
    assert file["quarantine_reason"] == "no run key"
    upsert_run(files_db, _id=UNKNOWN_RUN)

    _status, body = _patch(client, file["file_id"], run_id=UNKNOWN_RUN)

    assert body["status"] == "registered"
    assert body["run_id"] == UNKNOWN_RUN
    assert body["quarantine_reason"] is None


# --- the bytes keep their verdict --------------------------------------------


def test_a_file_quarantined_for_bad_bytes_stays_quarantined(client, files_db) -> None:
    """The route reads no byte, so it may say nothing about the bytes."""
    upsert_run(files_db, _id=RUN)
    file = _register(client, checksum_state="mismatch")
    assert file["quarantine_reason"] == "checksum mismatch"

    _status, body = _patch(client, file["file_id"], run_id=RUN, note="the run is right")

    assert body["status"] == "quarantined"
    assert body["quarantine_reason"] == "checksum mismatch"
    stored = files_db["files"].find_one({"_id": file["file_id"]})
    assert stored["status"] == "quarantined"


def test_another_quarantine_reason_keeps_the_file_quarantined(client, files_db) -> None:
    """Only the missing link is repaired here. An unparseable header is not."""
    upsert_run(files_db, _id=RUN)
    file = _register(client, quarantine_reason="unparseable header")

    _status, body = _patch(client, file["file_id"], run_id=RUN)

    assert body["status"] == "quarantined"
    assert body["quarantine_reason"] == "unparseable header"


# --- the run's numbers follow ------------------------------------------------


def test_the_run_file_count_matches_the_drill_down(client, files_db) -> None:
    """The badge and the rows under it come from one truth."""
    file = _orphan(client, files_db)
    before = client.get(f"{RUNS}/{RUN}").json()
    assert before["file_count"] == 0

    _patch(client, file["file_id"], run_id=RUN)

    run = client.get(f"{RUNS}/{RUN}").json()
    listed = client.get(f"{RUNS}/{RUN}/files").json()
    assert run["file_count"] == 1
    assert listed["total"] == 1
    assert run["file_count"] == listed["total"]
    assert [item["file_id"] for item in listed["items"]] == [file["file_id"]]
    stored = files_db["test_runs"].find_one({"_id": RUN})
    assert stored["file_count"] == 1


def test_the_signals_of_the_file_reach_the_run(client, files_db) -> None:
    """The inventory rows follow the file to the run it now names."""
    upsert_run(files_db, _id=RUN)
    upsert_run(files_db, _id=OTHER_RUN)
    file = _register(client, run_id=OTHER_RUN)
    assert file["status"] == "registered"

    _patch(client, file["file_id"], run_id=RUN)

    run = client.get(f"{RUNS}/{RUN}").json()
    listed = client.get(f"{RUNS}/{RUN}/signals").json()
    assert run["signal_count"] == len(SIGNALS)
    assert listed["total"] == len(SIGNALS)
    assert {item["name"] for item in listed["items"]} == set(SIGNALS)

    old = client.get(f"{RUNS}/{OTHER_RUN}").json()
    assert old["signal_count"] == 0


def test_a_relink_moves_the_counts_to_the_new_run(client, files_db) -> None:
    """The old run loses the file it no longer holds."""
    upsert_run(files_db, _id=RUN)
    upsert_run(files_db, _id=OTHER_RUN)
    file = _register(client, run_id=OTHER_RUN)

    _patch(client, file["file_id"], run_id=RUN)

    old = client.get(f"{RUNS}/{OTHER_RUN}").json()
    new = client.get(f"{RUNS}/{RUN}").json()
    assert old["file_count"] == 0
    assert new["file_count"] == 1
    assert client.get(f"{RUNS}/{OTHER_RUN}/files").json()["total"] == 0
    assert files_db["test_runs"].find_one({"_id": OTHER_RUN})["file_count"] == 0


# --- the edit refuses a link to nothing --------------------------------------


def test_an_unknown_run_answers_422(client, files_db) -> None:
    """A person can retype. Telling them beats storing a link to nothing."""
    file = _orphan(client, files_db)

    status, body = _patch(client, file["file_id"], run_id="TAS-99999")

    assert status == 422
    assert body["code"] == "unknown_run"
    stored = files_db["files"].find_one({"_id": file["file_id"]})
    assert stored["run_id"] == UNKNOWN_RUN
    assert stored["status"] == "quarantined"


def test_a_body_with_no_run_answers_400(client, files_db) -> None:
    """A null counts as absent, so this route never clears a link."""
    file = _orphan(client, files_db)

    status, body = _patch(client, file["file_id"], run_id=None)

    assert status == 400
    assert body["code"] == "no_fields_to_update"


def test_an_unknown_file_answers_404(client, files_db) -> None:
    upsert_run(files_db, _id=RUN)

    status, body = _patch(client, "f-nobody", run_id=RUN)

    assert status == 404
    assert body["code"] == "file_not_found"


# --- the facts about the bytes are not patchable -----------------------------


@pytest.mark.parametrize(
    "field, value",
    [
        ("checksum_sha256", "0" * 64),
        ("size_bytes", 99),
        ("format", "CSV"),
        ("checksum_state", "verified"),
    ],
)
def test_the_checksum_the_size_and_the_format_are_not_patchable(
    client, files_db, field, value
) -> None:
    """The audit rests on these facts, so no body may state them."""
    upsert_run(files_db, _id=RUN)
    file = _register(client, checksum_state="mismatch")

    status, body = _patch(client, file["file_id"], run_id=RUN, **{field: value})

    assert status == 422
    assert field in body["detail"]
    stored = files_db["files"].find_one({"_id": file["file_id"]})
    assert stored[field] == file[field]


@pytest.mark.parametrize("field, value", [("status", "registered"), ("quarantine_reason", None)])
def test_the_status_and_the_reason_are_not_patchable(client, files_db, field, value) -> None:
    """The two values are derived at the registry's door, never stated.

    This is the laundering attempt: a body that states `registered` over bad
    bytes. The body refuses the field, so the file keeps its quarantine.
    """
    upsert_run(files_db, _id=RUN)
    file = _register(client, checksum_state="mismatch")

    status, _body = _patch(client, file["file_id"], run_id=RUN, **{field: value})

    assert status == 422
    stored = files_db["files"].find_one({"_id": file["file_id"]})
    assert stored["status"] == "quarantined"
    assert stored["quarantine_reason"] == "checksum mismatch"


def test_the_signal_count_is_not_patchable(client, files_db) -> None:
    """A count is derived from the rows. No body writes one."""
    file = _orphan(client, files_db)

    status, _body = _patch(client, file["file_id"], run_id=RUN, signal_count=99)

    assert status == 422


# --- the provenance ----------------------------------------------------------


def test_the_edit_carries_the_manual_source(client, files_db) -> None:
    file = _orphan(client, files_db)

    _status, body = _patch(client, file["file_id"], run_id=RUN)

    source = body["field_sources"]["run_id"]
    assert source["source"] == "manual"
    assert source["actor"] == ACTOR
    assert source["at"]


def test_the_edit_journals_the_link(client, files_db) -> None:
    file = _orphan(client, files_db)

    _patch(client, file["file_id"], run_id=RUN, note="from the paper log")

    entries = list(
        files_db["journal_entries"].find(
            {"entity_id": file["file_id"], "field": "file.run"}
        )
    )
    assert len(entries) == 1
    entry = entries[0]
    assert entry["entity_type"] == "file"
    assert entry["kind"] == "change"
    assert entry["old"] == UNKNOWN_RUN
    assert entry["new"] == RUN
    assert entry["source"] == "manual"
    assert entry["actor"] == ACTOR
    assert entry["note"] == "from the paper log"
    # The run's journal unions the entries that name it as the context.
    assert entry["context_run_id"] == RUN


# --- the never-drop rule holds -----------------------------------------------


def test_a_registered_twin_checksum_answers_409(client, files_db) -> None:
    """One registered file per checksum. The quarantined twin stays whole."""
    checksum = _checksum()
    orphan = _register(client, run_id=UNKNOWN_RUN, checksum_sha256=checksum)
    upsert_run(files_db, _id=RUN)
    twin = _register(client, checksum_sha256=checksum, storage_ref="blob://test/twin")
    assert twin["status"] == "registered"

    status, body = _patch(client, orphan["file_id"], run_id=RUN)

    assert status == 409
    assert body["code"] == "checksum_already_registered"
    stored = files_db["files"].find_one({"_id": orphan["file_id"]})
    assert stored is not None, "the never-drop rule keeps the file"
    assert stored["status"] == "quarantined"
    assert stored["run_id"] == UNKNOWN_RUN
