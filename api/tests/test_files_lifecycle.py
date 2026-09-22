# Soft delete, archive and restore for files (FR-DM-040, FR-DM-042).
#
# `lifecycle` is a second field beside `status`. `status` stays the verdict of
# the registry (registered or quarantined). `lifecycle` states what a person did
# with the record afterwards: active, archived or deleted.
#
# A delete never removes the stored object. The routes touch the document only,
# so the bytes stay in the store and an operator can still recover them.
#
# Style follows tests/test_files_quarantine.py.

import uuid
from collections.abc import Iterator

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


class _FakeBytes:
    """A stub bytes provider. It serves one payload from memory."""

    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def open(self, storage_ref: str | None) -> tuple[Iterator[bytes], int]:
        payload = self._payload

        def iterator() -> Iterator[bytes]:
            yield payload

        return iterator(), len(payload)


@pytest.fixture
def override_bytes(app):
    """Install a bytes provider for the app. Yields a setter."""
    from api.services import file_bytes

    def install(provider) -> None:
        app.dependency_overrides[file_bytes.get_file_bytes_provider] = lambda: provider

    yield install
    app.dependency_overrides.pop(file_bytes.get_file_bytes_provider, None)


def _checksum() -> str:
    return uuid.uuid4().hex * 2


def _body(**overrides) -> dict:
    body = {"actor": ACTOR}
    body.update(overrides)
    return body


def _delete(client, file_id: str, **overrides):
    return client.request("DELETE", f"{FILES}/{file_id}", json=_body(**overrides))


def _archive(client, file_id: str, **overrides):
    return client.post(f"{FILES}/{file_id}/archive", json=_body(**overrides))


def _restore(client, file_id: str, **overrides):
    return client.post(f"{FILES}/{file_id}/restore", json=_body(**overrides))


def _events(db, file_id: str, field: str) -> list[dict]:
    return list(db["journal_entries"].find({"entity_id": file_id, "field": field}))


def _stored(db, file_id: str) -> dict:
    return db["files"].find_one({"_id": file_id})


# --- delete ------------------------------------------------------------------


def test_delete_marks_the_file_deleted_and_journals_it(client, files_db):
    upsert_run(files_db)
    file_id = register_file(files_db)["_id"]

    response = _delete(client, file_id, note="the rig wrote it twice")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["file_id"] == file_id
    assert body["lifecycle"] == "deleted"
    assert _stored(files_db, file_id)["lifecycle"] == "deleted"

    entries = _events(files_db, file_id, "file.deleted")
    assert len(entries) == 1
    assert entries[0]["entity_type"] == "file"
    assert entries[0]["kind"] == "event"
    assert entries[0]["source"] == "manual"
    assert entries[0]["actor"] == ACTOR
    assert entries[0]["note"] == "the rig wrote it twice"


def test_a_delete_keeps_the_stored_object(client, files_db):
    # The bytes are never deleted. The document keeps its storage reference,
    # so an operator can still reach the object.
    upsert_run(files_db)
    file = register_file(files_db, storage_ref="blob://test/keep-me")

    assert _delete(client, file["_id"]).status_code == 200
    assert _stored(files_db, file["_id"])["storage_ref"] == "blob://test/keep-me"


def test_a_second_delete_writes_nothing(client, files_db):
    upsert_run(files_db)
    file_id = register_file(files_db)["_id"]
    assert _delete(client, file_id).status_code == 200
    first = _stored(files_db, file_id)["updated_at"]

    response = _delete(client, file_id)

    assert response.status_code == 200, response.text
    assert response.json()["lifecycle"] == "deleted"
    assert len(_events(files_db, file_id, "file.deleted")) == 1
    assert _stored(files_db, file_id)["updated_at"] == first


# --- archive and restore ------------------------------------------------------


def test_archive_marks_the_file_archived_and_journals_it(client, files_db):
    upsert_run(files_db)
    file_id = register_file(files_db)["_id"]

    response = _archive(client, file_id)

    assert response.status_code == 200, response.text
    assert response.json()["lifecycle"] == "archived"
    assert _stored(files_db, file_id)["lifecycle"] == "archived"

    entries = _events(files_db, file_id, "file.archived")
    assert len(entries) == 1
    assert entries[0]["source"] == "manual"
    assert entries[0]["actor"] == ACTOR


def test_a_second_archive_writes_nothing(client, files_db):
    upsert_run(files_db)
    file_id = register_file(files_db)["_id"]
    assert _archive(client, file_id).status_code == 200

    response = _archive(client, file_id)

    assert response.status_code == 200, response.text
    assert response.json()["lifecycle"] == "archived"
    assert len(_events(files_db, file_id, "file.archived")) == 1


def test_archive_of_a_deleted_file_answers_409(client, files_db):
    upsert_run(files_db)
    file_id = register_file(files_db)["_id"]
    assert _delete(client, file_id).status_code == 200

    response = _archive(client, file_id)

    assert response.status_code == 409, response.text
    body = response.json()
    assert body["code"] == "file_deleted"
    assert "restore" in body["detail"].lower()
    assert _stored(files_db, file_id)["lifecycle"] == "deleted"
    assert _events(files_db, file_id, "file.archived") == []


def test_restore_brings_an_archived_file_back(client, files_db):
    upsert_run(files_db)
    file_id = register_file(files_db)["_id"]
    assert _archive(client, file_id).status_code == 200

    response = _restore(client, file_id)

    assert response.status_code == 200, response.text
    assert response.json()["lifecycle"] == "active"
    assert _stored(files_db, file_id)["lifecycle"] == "active"
    assert len(_events(files_db, file_id, "file.restored")) == 1


def test_restore_brings_a_deleted_file_back(client, files_db):
    upsert_run(files_db)
    file_id = register_file(files_db)["_id"]
    assert _delete(client, file_id).status_code == 200

    response = _restore(client, file_id)

    assert response.status_code == 200, response.text
    assert response.json()["lifecycle"] == "active"
    assert len(_events(files_db, file_id, "file.restored")) == 1


def test_a_restore_of_an_active_file_writes_nothing(client, files_db):
    upsert_run(files_db)
    file_id = register_file(files_db)["_id"]

    response = _restore(client, file_id)

    assert response.status_code == 200, response.text
    assert response.json()["lifecycle"] == "active"
    assert _events(files_db, file_id, "file.restored") == []


def test_a_restore_never_promotes_a_quarantined_file(client, files_db):
    # `lifecycle` and `status` are separate. A restore returns the record to
    # the table. It says nothing about the bytes, so the verdict stays.
    file = register_file(
        files_db, status="quarantined", quarantine_reason="checksum mismatch"
    )
    file_id = file["_id"]
    assert _delete(client, file_id).status_code == 200

    response = _restore(client, file_id)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["lifecycle"] == "active"
    assert body["status"] == "quarantined"
    assert body["quarantine_reason"] == "checksum mismatch"


def test_an_unknown_file_answers_404_on_every_lifecycle_route(client, files_db):
    for call in (_delete, _archive, _restore):
        response = call(client, "f-nothing")
        assert response.status_code == 404, response.text
        assert response.json()["code"] == "file_not_found"


def test_a_lifecycle_route_needs_a_token(bare_client, files_db):
    upsert_run(files_db)
    file_id = register_file(files_db)["_id"]

    assert bare_client.post(f"{FILES}/{file_id}/archive", json=_body()).status_code == 401


# --- the guards on the older routes ------------------------------------------


def test_a_deleted_file_refuses_the_download_with_410(client, files_db):
    upsert_run(files_db)
    file_id = register_file(files_db)["_id"]
    assert _delete(client, file_id).status_code == 200

    response = client.get(f"{FILES}/{file_id}/download")

    assert response.status_code == 410, response.text
    assert response.json()["code"] == "file_deleted"
    # No byte moved, so no download event exists.
    assert _events(files_db, file_id, "file.downloaded") == []


def test_an_archived_file_still_downloads(client, files_db, override_bytes):
    upsert_run(files_db)
    file_id = register_file(files_db)["_id"]
    assert _archive(client, file_id).status_code == 200
    override_bytes(_FakeBytes(b"demo-bytes"))

    response = client.get(f"{FILES}/{file_id}/download")

    assert response.status_code == 200, response.text
    assert response.content == b"demo-bytes"


def test_a_deleted_file_refuses_the_patch_with_409(client, files_db):
    upsert_run(files_db)
    file = register_file(files_db, run_id=None, status="quarantined")
    file_id = file["_id"]
    assert _delete(client, file_id).status_code == 200

    response = client.patch(
        f"{FILES}/{file_id}", json={"run_id": RUN, "actor": ACTOR}
    )

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "file_deleted"
    assert "restore" in response.json()["detail"].lower()
    assert _stored(files_db, file_id)["run_id"] is None


def test_an_archived_file_refuses_the_patch_with_409(client, files_db):
    upsert_run(files_db)
    file = register_file(files_db, run_id=None, status="quarantined")
    file_id = file["_id"]
    assert _archive(client, file_id).status_code == 200

    response = client.patch(
        f"{FILES}/{file_id}", json={"run_id": RUN, "actor": ACTOR}
    )

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "file_archived"
    assert "restore" in response.json()["detail"].lower()
    assert _stored(files_db, file_id)["run_id"] is None


# --- the list, the counts and the run rollup ---------------------------------


def test_the_default_list_hides_a_deleted_file(client, files_db):
    upsert_run(files_db)
    kept = register_file(files_db, filename="kept.mf4")["_id"]
    dropped = register_file(files_db, filename="dropped.mf4")["_id"]
    assert _delete(client, dropped).status_code == 200

    body = client.get(FILES).json()

    assert [item["file_id"] for item in body["items"]] == [kept]
    assert body["total"] == 1


def test_the_lifecycle_filter_serves_the_recycle_bin(client, files_db):
    upsert_run(files_db)
    active = register_file(files_db, filename="active.mf4")["_id"]
    archived = register_file(files_db, filename="archived.mf4")["_id"]
    deleted = register_file(files_db, filename="deleted.mf4")["_id"]
    assert _archive(client, archived).status_code == 200
    assert _delete(client, deleted).status_code == 200

    def ids(**params) -> set[str]:
        return {item["file_id"] for item in client.get(FILES, params=params).json()["items"]}

    assert ids(lifecycle="deleted") == {deleted}
    assert ids(lifecycle="archived") == {archived}
    # An older document carries no `lifecycle` field. It counts as active.
    assert ids(lifecycle="active") == {active}
    assert ids(lifecycle=["active", "archived"]) == {active, archived}
    # The plain table holds the active files only (21 Aug 2026). Archive
    # promises the row leaves the daily table, so it must leave.
    assert ids() == {active}


def test_a_list_row_carries_the_lifecycle(client, files_db):
    upsert_run(files_db)
    register_file(files_db)

    body = client.get(FILES).json()

    assert body["items"][0]["lifecycle"] == "active"


def test_the_view_counts_carry_archived_and_deleted(client, files_db):
    upsert_run(files_db)
    register_file(files_db, filename="active.mf4")
    archived = register_file(files_db, filename="archived.mf4")["_id"]
    deleted = register_file(files_db, filename="deleted.mf4")["_id"]
    quarantined = register_file(
        files_db, filename="bad.mf4", status="quarantined", quarantine_reason="no run key"
    )["_id"]
    assert _archive(client, archived).status_code == 200
    assert _delete(client, deleted).status_code == 200
    assert _delete(client, quarantined).status_code == 200

    counts = client.get(FILES).json()["view_counts"]

    assert set(counts) == {"all", "registered", "quarantined", "archived", "deleted"}
    # 4 documents. Two are deleted and one is archived, so the plain table
    # holds one row and `all` says one (21 Aug 2026). The two named views
    # carry their own numbers.
    assert counts == {
        "all": 1,
        "registered": 1,
        "quarantined": 0,
        "archived": 1,
        "deleted": 2,
    }
    assert counts["all"] == client.get(FILES).json()["total"]


def test_a_deleted_file_stays_on_its_run(client, files_db):
    # The run drill-down keeps the file, so no reference dangles.
    upsert_run(files_db)
    file_id = register_file(files_db)["_id"]
    assert _delete(client, file_id).status_code == 200

    body = client.get(f"/api/v1/test-runs/{RUN}/files").json()

    assert [item["file_id"] for item in body["items"]] == [file_id]


# --- the replay never resurrects a deleted file -------------------------------


def test_a_replay_of_a_deleted_checksum_never_resurrects_the_file(client, files_db):
    upsert_run(files_db)
    body = {
        "filename": "bat_cyc_20260814_0941.mf4",
        "run_id": RUN,
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 1024,
        "checksum_sha256": _checksum(),
        "checksum_state": "verified",
    }
    first = client.post(FILES, json=body)
    assert first.status_code == 201, first.text
    file_id = first.json()["file_id"]
    assert _delete(client, file_id).status_code == 200
    before = list(files_db["journal_entries"].find({"entity_id": file_id}))

    replay = client.post(FILES, json=body)

    assert replay.status_code == 200, replay.text
    assert replay.json()["file_id"] == file_id
    assert replay.json()["lifecycle"] == "deleted"
    assert _stored(files_db, file_id)["lifecycle"] == "deleted"
    assert files_db["files"].count_documents({}) == 1
    after = list(files_db["journal_entries"].find({"entity_id": file_id}))
    assert len(after) == len(before)


# --- the plain table is the active table --------------------------------------


def test_the_default_list_hides_an_archived_file(client, files_db):
    """An archive takes the row off the daily table (finding 11, 21 Aug 2026).

    The route promised it and the list filter only hid the deleted files, so a
    person pressed Archive and the row stayed where it was.
    """
    upsert_run(files_db)
    kept = register_file(files_db, checksum_sha256=_checksum())["_id"]
    archived = register_file(files_db, checksum_sha256=_checksum())["_id"]
    assert _archive(client, archived).status_code == 200

    plain = client.get(FILES).json()

    assert [item["file_id"] for item in plain["items"]] == [kept]
    named = client.get(f"{FILES}?lifecycle=archived").json()
    assert [item["file_id"] for item in named["items"]] == [archived]


# --- the lifecycle write carries its source tag -------------------------------


@pytest.mark.parametrize(
    ("call", "value"),
    [(_delete, "deleted"), (_archive, "archived")],
    ids=["delete", "archive"],
)
def test_a_lifecycle_write_names_who_moved_the_file(client, files_db, call, value):
    """`field_sources.lifecycle` never existed: the routes wrote a raw $set."""
    upsert_run(files_db)
    file_id = register_file(files_db)["_id"]

    assert call(client, file_id).status_code == 200

    stored = _stored(files_db, file_id)
    assert stored["lifecycle"] == value
    source = stored["field_sources"]["lifecycle"]
    assert source["source"] == "manual"
    assert source["actor"] == ACTOR
    assert source["at"] is not None


def test_a_restore_stamps_the_source_too(client, files_db):
    upsert_run(files_db)
    file_id = register_file(files_db)["_id"]
    assert _archive(client, file_id).status_code == 200

    assert _restore(client, file_id).status_code == 200

    assert _stored(files_db, file_id)["field_sources"]["lifecycle"]["source"] == "manual"


# --- two presses write one journal row ----------------------------------------


def test_a_lost_race_writes_no_second_journal_row(client, files_db):
    """Finding 31c. The three routes read, decide, and then write.

    Two presses of Delete ran that read at the same time: both saw an active
    file and both wrote, so the journal kept two `file.deleted` rows for one
    delete. The write is a compare-and-set now, so the loser writes nothing.
    The stale document below is exactly what the loser holds.
    """
    from api.routers.files import _write_lifecycle

    upsert_run(files_db)
    file_id = register_file(files_db)["_id"]
    stale = _stored(files_db, file_id)
    assert _delete(client, file_id).status_code == 200

    _write_lifecycle(files_db, stale, "deleted", "file.deleted", ACTOR, None)

    assert len(_events(files_db, file_id, "file.deleted")) == 1
