# Raw-file versioning (FR-DM-103).
#
# A person uploads a new version of a file that is already in the registry.
# Every earlier version stays. Each version is a whole file document with its
# own id, checksum, storage reference, journal and download, so nothing
# overwrites a byte and nothing overwrites a record.
#
# Three fields hold the chain. `version` counts from 1. `supersedes` names the
# previous version. `version_group` names the root file of the chain. A stored
# document without the fields is version 1 and its own root.
#
# Style follows tests/test_files_lifecycle.py.

import uuid

import pytest

from tests import factories
from tests.factories import register_file, upsert_run

files_db = factories.files_db

FILES = "/api/v1/files"
RUN = "TAS-88214"
ACTOR = "a.bergstrom"


@pytest.fixture(autouse=True)
def stats_lake(stub_lake):
    """Answer the statistics from the stub lake. These tests count rows.

    This fixture pinned `TM_STATS_PROVIDER=mongo` until 20 Aug 2026. The switch
    is gone and the lake is the one statistics path, so the suite stubs the
    lake instead of picking a second mode.
    """


def _checksum() -> str:
    return uuid.uuid4().hex * 2


def _body(**overrides) -> dict:
    body = {
        "filename": "bat_cyc_20260814_0941.mf4",
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 2048,
        "checksum_sha256": _checksum(),
        "checksum_state": "verified",
        "storage_ref": f"blob://test/{uuid.uuid4().hex}",
        "actor": ACTOR,
    }
    body.update(overrides)
    return body


def _post_version(client, file_id: str, **overrides):
    return client.post(f"{FILES}/{file_id}/versions", json=_body(**overrides))


def _history(client, file_id: str):
    return client.get(f"{FILES}/{file_id}/versions")


def _detail(client, file_id: str):
    return client.get(f"{FILES}/{file_id}")


def _events(db, file_id: str, field: str) -> list[dict]:
    return list(db["journal_entries"].find({"entity_id": file_id, "field": field}))


def _stored(db, file_id: str) -> dict:
    return db["files"].find_one({"_id": file_id})


# --- the mint ----------------------------------------------------------------


def test_a_version_upload_mints_version_2(client, files_db):
    upsert_run(files_db)
    anchor = register_file(files_db)

    response = _post_version(client, anchor["_id"], filename="bat_cyc_rev2.mf4")

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["version"] == 2
    assert body["file_id"] != anchor["_id"]
    assert body["filename"] == "bat_cyc_rev2.mf4"
    assert body["status"] == "registered"

    stored = _stored(files_db, body["file_id"])
    assert stored["supersedes"] == anchor["_id"]
    assert stored["version_group"] == anchor["_id"]


def test_the_detail_serves_the_version_and_the_superseded_id(client, files_db):
    upsert_run(files_db)
    anchor = register_file(files_db)
    new_id = _post_version(client, anchor["_id"]).json()["file_id"]

    detail = _detail(client, new_id)

    assert detail.status_code == 200, detail.text
    assert detail.json()["version"] == 2
    assert detail.json()["supersedes"] == anchor["_id"]

    # The anchor is version 1 and it supersedes nothing, even though the
    # stored document carries neither field.
    anchor_detail = _detail(client, anchor["_id"]).json()
    assert anchor_detail["version"] == 1
    assert anchor_detail["supersedes"] is None


def test_a_third_version_supersedes_the_second(client, files_db):
    upsert_run(files_db)
    anchor = register_file(files_db)
    second = _post_version(client, anchor["_id"]).json()["file_id"]

    # The caller names the first version, and the route still appends to the
    # end of the chain.
    third = _post_version(client, anchor["_id"])

    assert third.status_code == 201, third.text
    assert third.json()["version"] == 3
    stored = _stored(files_db, third.json()["file_id"])
    assert stored["supersedes"] == second
    assert stored["version_group"] == anchor["_id"]


# --- the history -------------------------------------------------------------


def test_the_history_lists_the_versions_in_order(client, files_db):
    upsert_run(files_db)
    anchor = register_file(files_db)
    second = _post_version(client, anchor["_id"]).json()["file_id"]
    third = _post_version(client, anchor["_id"]).json()["file_id"]

    response = _history(client, anchor["_id"])

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 3
    assert [item["file_id"] for item in body["items"]] == [anchor["_id"], second, third]
    assert [item["version"] for item in body["items"]] == [1, 2, 3]


def test_the_history_reads_from_any_version_id(client, files_db):
    upsert_run(files_db)
    anchor = register_file(files_db)
    second = _post_version(client, anchor["_id"]).json()["file_id"]

    from_root = _history(client, anchor["_id"]).json()
    from_second = _history(client, second).json()

    assert from_root == from_second


def test_a_deleted_version_stays_in_the_history(client, files_db):
    upsert_run(files_db)
    anchor = register_file(files_db)
    second = _post_version(client, anchor["_id"]).json()["file_id"]

    assert client.request(
        "DELETE", f"{FILES}/{anchor['_id']}", json={"actor": ACTOR}
    ).status_code == 200

    body = _history(client, second).json()

    assert body["total"] == 2
    assert [item["file_id"] for item in body["items"]] == [anchor["_id"], second]
    assert body["items"][0]["lifecycle"] == "deleted"


def test_a_file_with_no_version_serves_a_history_of_one(client, files_db):
    upsert_run(files_db)
    anchor = register_file(files_db)

    body = _history(client, anchor["_id"]).json()

    assert body["total"] == 1
    assert body["items"][0]["file_id"] == anchor["_id"]
    assert body["items"][0]["version"] == 1


# --- the replay --------------------------------------------------------------


def test_a_replay_of_the_latest_checksum_writes_nothing(client, files_db):
    upsert_run(files_db)
    anchor = register_file(files_db)
    first = _post_version(client, anchor["_id"])
    checksum = first.json()["checksum_sha256"]

    replay = _post_version(client, anchor["_id"], checksum_sha256=checksum)

    assert replay.status_code == 200, replay.text
    assert replay.json() == first.json()
    assert files_db["files"].count_documents({}) == 2
    assert len(_events(files_db, first.json()["file_id"], "file.version_registered")) == 1


# --- the refusals ------------------------------------------------------------


def test_a_checksum_of_an_older_version_answers_409(client, files_db):
    upsert_run(files_db)
    anchor = register_file(files_db)
    _post_version(client, anchor["_id"])

    response = _post_version(client, anchor["_id"], checksum_sha256=anchor["checksum_sha256"])

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "checksum_already_registered"
    assert files_db["files"].count_documents({}) == 2


def test_a_checksum_of_another_file_answers_409(client, files_db):
    upsert_run(files_db)
    anchor = register_file(files_db)
    other = register_file(files_db, filename="other.mf4")

    response = _post_version(client, anchor["_id"], checksum_sha256=other["checksum_sha256"])

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "checksum_already_registered"
    assert files_db["files"].count_documents({}) == 2


def test_a_version_of_a_deleted_file_answers_409(client, files_db):
    upsert_run(files_db)
    anchor = register_file(files_db)
    client.request("DELETE", f"{FILES}/{anchor['_id']}", json={"actor": ACTOR})

    response = _post_version(client, anchor["_id"])

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "file_deleted"
    assert files_db["files"].count_documents({}) == 1


def test_a_version_of_an_archived_file_answers_409(client, files_db):
    upsert_run(files_db)
    anchor = register_file(files_db)
    client.post(f"{FILES}/{anchor['_id']}/archive", json={"actor": ACTOR})

    response = _post_version(client, anchor["_id"])

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "file_archived"
    assert files_db["files"].count_documents({}) == 1


def test_an_unknown_file_answers_404_on_both_version_routes(client, files_db):
    upsert_run(files_db)

    post = _post_version(client, "f-missing")
    get = _history(client, "f-missing")

    assert post.status_code == 404, post.text
    assert post.json()["code"] == "file_not_found"
    assert get.status_code == 404, get.text
    assert get.json()["code"] == "file_not_found"


def test_the_body_refuses_an_unknown_field(client, files_db):
    upsert_run(files_db)
    anchor = register_file(files_db)

    response = client.post(
        f"{FILES}/{anchor['_id']}/versions", json={**_body(), "wrong_field": 1}
    )

    assert response.status_code == 422, response.text
    assert "wrong_field" in response.json()["detail"]


# --- the quarantine ----------------------------------------------------------


def test_a_mismatch_version_quarantines_and_joins_the_chain(client, files_db):
    # The never-drop rule holds for a version too. Bad bytes quarantine the
    # version, and the version still takes its place in the chain.
    upsert_run(files_db)
    anchor = register_file(files_db)

    response = _post_version(client, anchor["_id"], checksum_state="mismatch")

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "quarantined"
    assert body["quarantine_reason"] == "checksum mismatch"
    assert body["version"] == 2
    assert _stored(files_db, body["file_id"])["supersedes"] == anchor["_id"]

    history = _history(client, anchor["_id"]).json()
    assert [item["file_id"] for item in history["items"]] == [anchor["_id"], body["file_id"]]


# --- the run link ------------------------------------------------------------


def test_a_body_with_no_run_inherits_the_run_of_the_latest_version(client, files_db):
    upsert_run(files_db)
    anchor = register_file(files_db)

    response = _post_version(client, anchor["_id"])

    assert response.status_code == 201, response.text
    assert response.json()["run_id"] == RUN
    # The inherited link is a real one, so the version never quarantines for
    # "no run key".
    assert response.json()["status"] == "registered"


def test_a_body_that_names_a_run_keeps_it(client, files_db):
    upsert_run(files_db)
    upsert_run(files_db, _id="TAS-99000")
    anchor = register_file(files_db)

    response = _post_version(client, anchor["_id"], run_id="TAS-99000")

    assert response.status_code == 201, response.text
    assert response.json()["run_id"] == "TAS-99000"


# --- the journal -------------------------------------------------------------


def test_the_version_journal_event_carries_the_actor(client, files_db):
    upsert_run(files_db)
    anchor = register_file(files_db)

    new_id = _post_version(client, anchor["_id"], note="the rig rewrote the file").json()[
        "file_id"
    ]

    entries = _events(files_db, new_id, "file.version_registered")
    assert len(entries) == 1
    assert entries[0]["entity_type"] == "file"
    assert entries[0]["kind"] == "event"
    assert entries[0]["source"] == "manual"
    assert entries[0]["actor"] == ACTOR
    assert "2" in entries[0]["note"]
    assert anchor["_id"] in entries[0]["note"]
    assert "the rig rewrote the file" in entries[0]["note"]

    # The standard registration event stands beside it, unchanged.
    assert len(_events(files_db, new_id, "file.registered")) == 1


def test_the_anchor_keeps_its_own_journal(client, files_db):
    # A version writes on the new file only. The earlier version keeps the
    # entries it already had.
    upsert_run(files_db)
    anchor = register_file(files_db)

    response = _post_version(client, anchor["_id"])

    assert response.status_code == 201, response.text
    assert _events(files_db, anchor["_id"], "file.version_registered") == []


def test_a_version_never_lands_behind_a_deleted_head(client, files_db):
    """Delete v2, then POST a version naming v1: the chain's HEAD is in the
    recycle bin, and minting v3 behind its back gave a later restore a chain
    it had never seen (25 Aug 2026 deep review). The route gates on the
    HEAD's lifecycle, not the named anchor's."""
    upsert_run(files_db)
    anchor = register_file(files_db)
    v2 = _post_version(client, anchor["_id"], filename="bat_cyc_rev2.mf4").json()

    deleted = client.request(
        "DELETE", f"{FILES}/{v2['file_id']}", json={"actor": ACTOR}
    )
    assert deleted.status_code == 200, deleted.text

    response = _post_version(client, anchor["_id"], filename="bat_cyc_rev3.mf4")

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "file_deleted"

    restored = client.post(
        f"{FILES}/{v2['file_id']}/restore", json={"actor": ACTOR}
    )
    assert restored.status_code == 200, restored.text
    after = _post_version(client, anchor["_id"], filename="bat_cyc_rev3.mf4")
    assert after.status_code == 201, "an active head takes the version again"
    assert after.json()["version"] == 3
