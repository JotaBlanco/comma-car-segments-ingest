"""The file-detail timeline tells the arrival story, and only that story.

`GET /files/{file_id}` served every journal row of the file, so a
`file.downloaded` event landed inside the ingestion timeline. A download is
not an arrival step, so the timeline query now excludes that field.

The two halves below both matter. The first proves the download event stays
out of the view. The second proves the journal still holds the event, so the
fix is a filter and not a deletion. The audit-before-bytes rule stands.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from tests import factories
from tests.factories import insert_file_event, register_file, upsert_run

files_db = factories.files_db

DETAIL_URL = "/api/v1/files/{file_id}"
DOWNLOAD_URL = "/api/v1/files/{file_id}/download"

PAYLOAD = b"\x00\x01demo-bytes"


class _FakeBytes:
    """A stub bytes provider. It yields one chunk from memory."""

    def open(self, storage_ref: str | None) -> tuple[Iterator[bytes], int]:
        def iterator() -> Iterator[bytes]:
            yield PAYLOAD

        return iterator(), len(PAYLOAD)


@pytest.fixture
def stub_bytes(app):
    """Install the stub bytes provider for the app, then remove it."""
    from api.services import file_bytes

    app.dependency_overrides[file_bytes.get_file_bytes_provider] = _FakeBytes
    yield
    app.dependency_overrides.pop(file_bytes.get_file_bytes_provider, None)


@pytest.fixture
def file_with_arrival(files_db) -> dict:
    """One registered file with one arrival event on its journal."""
    upsert_run(files_db)
    file = register_file(files_db)
    insert_file_event(files_db, file["_id"], "file.registered")
    return file


def _timeline(client, file_id: str) -> list[dict]:
    response = client.get(DETAIL_URL.format(file_id=file_id))
    assert response.status_code == 200, response.text
    return response.json()["ingestion_timeline"]


def _press_download(client, file_id: str) -> None:
    response = client.get(DOWNLOAD_URL.format(file_id=file_id))
    assert response.status_code == 200, response.text
    # Read the stream, so the route completes before the next call.
    assert response.content == PAYLOAD


def test_a_download_does_not_change_the_ingestion_timeline(
    client, files_db, file_with_arrival, stub_bytes
):
    """The half that pins the view: the timeline length stays the same."""
    file_id = file_with_arrival["_id"]
    before = _timeline(client, file_id)

    _press_download(client, file_id)

    after = _timeline(client, file_id)
    assert len(after) == len(before)
    assert [entry["field"] for entry in after] == [entry["field"] for entry in before]
    assert "file.downloaded" not in [entry["field"] for entry in after]


def test_the_journal_still_holds_the_download_event(
    client, files_db, file_with_arrival, stub_bytes
):
    """The half that pins the audit: the event exists, the view hides it.

    A test that only counts the timeline passes when somebody deletes the
    write. This test fails in that case, so the pair holds both rules.
    """
    file_id = file_with_arrival["_id"]

    _press_download(client, file_id)

    stored = list(
        files_db["journal_entries"].find(
            {"entity_id": file_id, "field": "file.downloaded"}
        )
    )
    assert len(stored) == 1
    assert stored[0]["kind"] == "event"
    assert stored[0]["entity_type"] == "file"
    assert stored[0]["actor"]


def test_the_download_event_is_manual_and_names_the_caller(
    client, files_db, file_with_arrival, stub_bytes
):
    """A person pressed Download, so the source is `manual`, never `embedded`.

    The route sends no body, so the actor is whoever the identity resolves to.
    On the demo path that is the static token holder. `test_journal_actor.py`
    owns the rule itself, so this test only pins that the event names somebody.
    """
    file_id = file_with_arrival["_id"]

    _press_download(client, file_id)

    stored = files_db["journal_entries"].find_one(
        {"entity_id": file_id, "field": "file.downloaded"}
    )
    assert stored["source"] == "manual"
    assert stored["actor"]
