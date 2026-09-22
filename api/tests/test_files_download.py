# GET /files/{file_id}/download — contract v1.1 §D, decision box "file download".
#
# The route lives at api/api/routers/files.py. It closes the box from Option B
# (de-scope) to Option A (ship the ★ route), following the provisional shape in
# API-CONTRACT-v1.1-proposed.md and the audit-before-bytes rule from
# plans/design/FILE-DOWNLOAD.md.
#
# The audit-before-bytes assertion is the first-order guarantee: the journal
# write happens BEFORE the first byte leaves. A bytes provider that records
# ordering proves the rule holds under both the happy path and the storage-503
# path (the 503 path writes NO journal entry, so the count stays at zero).

from __future__ import annotations

import pathlib
from collections.abc import Iterator
from typing import Any

import pytest
from pymongo.errors import PyMongoError

from api.services.file_bytes import (
    FileBytesProvider,
    FileBytesUnavailable,
)
from tests import factories
from tests.factories import register_file, upsert_run

files_db = factories.files_db

DOWNLOAD_URL = "/api/v1/files/{file_id}/download"


# --- provider fixtures ---------------------------------------------------------


class _RecordedOrdering:
    """A shared list every fake writes to. The order proves audit-before-bytes."""

    def __init__(self) -> None:
        self.events: list[str] = []


class _FakeBytes:
    """A stub bytes provider. It yields the payload from an in-memory buffer.

    ``ordering`` records "bytes_first_chunk" when the iterator produces its
    first chunk. A journal write records "journal_insert" first — assert
    "journal_insert" precedes "bytes_first_chunk" and audit-before-bytes holds.
    """

    def __init__(self, payload: bytes, ordering: _RecordedOrdering) -> None:
        self._payload = payload
        self._ordering = ordering

    def open(self, storage_ref: str | None) -> tuple[Iterator[bytes], int]:
        payload = self._payload
        ordering = self._ordering

        def iterator() -> Iterator[bytes]:
            ordering.events.append("bytes_first_chunk")
            yield payload

        return iterator(), len(payload)


class _RefusingBytes:
    """A stub bytes provider that always refuses. Simulates SAG-not-bound."""

    def __init__(self, detail: str = "Storage unreachable") -> None:
        self._detail = detail

    def open(self, storage_ref: str | None) -> tuple[Iterator[bytes], int]:
        raise FileBytesUnavailable(self._detail)


@pytest.fixture
def override_bytes(app):
    """Install a bytes provider for the app. Yields a setter."""
    from api.services import file_bytes

    installed: list[FileBytesProvider] = []

    def install(provider: FileBytesProvider) -> None:
        app.dependency_overrides[file_bytes.get_file_bytes_provider] = lambda: provider
        installed.append(provider)

    yield install
    app.dependency_overrides.pop(file_bytes.get_file_bytes_provider, None)


# --- tests --------------------------------------------------------------------


def test_download_streams_bytes_after_writing_the_audit_event(
    client, files_db, override_bytes
):
    upsert_run(files_db)
    file = register_file(files_db, filename="bat_cyc_20260814_0941.mf4")
    payload = b"\x00\x01\x02\x03demo-bytes"
    ordering = _RecordedOrdering()
    override_bytes(_FakeBytes(payload, ordering))

    # A shim insert_one that records the audit write before the stream starts.
    class RecordingCollection:
        def __init__(self, delegate: Any, order: _RecordedOrdering) -> None:
            self._delegate = delegate
            self._order = order

        def insert_one(self, document: dict) -> Any:
            self._order.events.append("journal_insert")
            return self._delegate.insert_one(document)

        def __getattr__(self, name: str) -> Any:
            return getattr(self._delegate, name)

    class RecordingDb:
        def __init__(self, delegate: Any, order: _RecordedOrdering) -> None:
            self._delegate = delegate
            self._order = order

        def __getitem__(self, name: str) -> Any:
            collection = self._delegate[name]
            if name == "journal_entries":
                return RecordingCollection(collection, self._order)
            return collection

        def __getattr__(self, name: str) -> Any:
            return getattr(self._delegate, name)

    from api import db as db_module

    client.app.dependency_overrides[db_module.get_db] = lambda: RecordingDb(
        files_db, ordering
    )
    try:
        response = client.get(DOWNLOAD_URL.format(file_id=file["_id"]))
    finally:
        client.app.dependency_overrides[db_module.get_db] = lambda: files_db

    assert response.status_code == 200, response.text
    assert response.content == payload
    assert response.headers["content-type"] == "application/octet-stream"
    assert "attachment" in response.headers["content-disposition"]
    assert "bat_cyc_20260814_0941.mf4" in response.headers["content-disposition"]
    assert response.headers["content-length"] == str(len(payload))
    assert response.headers["x-checksum-sha256"] == file["checksum_sha256"]

    # Audit-before-bytes. The journal write MUST precede the first byte chunk.
    assert ordering.events[0] == "journal_insert", ordering.events
    assert "bytes_first_chunk" in ordering.events
    assert ordering.events.index("journal_insert") < ordering.events.index(
        "bytes_first_chunk"
    )

    stored = list(
        files_db["journal_entries"].find({"entity_id": file["_id"]})
    )
    downloaded = [entry for entry in stored if entry["field"] == "file.downloaded"]
    assert len(downloaded) == 1
    assert downloaded[0]["kind"] == "event"
    assert downloaded[0]["entity_type"] == "file"
    assert downloaded[0]["actor"]


def test_download_writes_one_journal_entry_per_call(client, files_db, override_bytes):
    upsert_run(files_db)
    file = register_file(files_db)
    override_bytes(_FakeBytes(b"payload", _RecordedOrdering()))

    for _ in range(3):
        assert client.get(DOWNLOAD_URL.format(file_id=file["_id"])).status_code == 200

    downloaded = list(
        files_db["journal_entries"].find(
            {"entity_id": file["_id"], "field": "file.downloaded"}
        )
    )
    assert len(downloaded) == 3


def test_unknown_file_returns_404_file_not_found(client, files_db, override_bytes):
    override_bytes(_FakeBytes(b"never-served", _RecordedOrdering()))

    response = client.get(DOWNLOAD_URL.format(file_id="f-does-not-exist"))

    assert response.status_code == 404
    body = response.json()
    assert body["code"] == "file_not_found"
    assert body["detail"] == "File f-does-not-exist not found"
    # The refusing path writes no journal entry.
    assert files_db["journal_entries"].count_documents({"field": "file.downloaded"}) == 0


def test_quarantined_file_returns_403_not_allowed(client, files_db, override_bytes):
    override_bytes(_FakeBytes(b"never-served", _RecordedOrdering()))
    upsert_run(files_db)
    file = register_file(
        files_db, status="quarantined", quarantine_reason="checksum mismatch"
    )

    response = client.get(DOWNLOAD_URL.format(file_id=file["_id"]))

    assert response.status_code == 403
    body = response.json()
    assert body["code"] == "not_allowed"
    assert "quarantined" in body["detail"].lower()
    # No audit written on refusal.
    assert files_db["journal_entries"].count_documents({"field": "file.downloaded"}) == 0


def test_storage_unreachable_returns_503_and_writes_no_audit(
    client, files_db, override_bytes
):
    upsert_run(files_db)
    file = register_file(files_db)
    override_bytes(_RefusingBytes("Storage unreachable — SAG not bound"))

    response = client.get(DOWNLOAD_URL.format(file_id=file["_id"]))

    assert response.status_code == 503
    body = response.json()
    assert body["code"] == "storage_unreachable"
    assert "storage" in body["detail"].lower()
    # The design note is explicit: no fake trace on a byte stream that never
    # started. The audit-before-bytes rule protects "who downloaded what", not
    # "who tried to download what".
    assert files_db["journal_entries"].count_documents({"field": "file.downloaded"}) == 0


def test_audit_write_failure_returns_503_and_serves_no_bytes(
    client, files_db, override_bytes
):
    upsert_run(files_db)
    file = register_file(files_db)
    ordering = _RecordedOrdering()
    override_bytes(_FakeBytes(b"never-served", ordering))

    class FailingCollection:
        def insert_one(self, document: dict) -> Any:
            raise PyMongoError("mongo is down")

    class FailingDb:
        def __init__(self, delegate: Any) -> None:
            self._delegate = delegate

        def __getitem__(self, name: str) -> Any:
            if name == "journal_entries":
                return FailingCollection()
            return self._delegate[name]

        def __getattr__(self, name: str) -> Any:
            return getattr(self._delegate, name)

    from api import db as db_module

    client.app.dependency_overrides[db_module.get_db] = lambda: FailingDb(files_db)
    try:
        response = client.get(DOWNLOAD_URL.format(file_id=file["_id"]))
    finally:
        client.app.dependency_overrides[db_module.get_db] = lambda: files_db

    assert response.status_code == 503
    body = response.json()
    assert body["code"] == "not_ready"
    # The stream never yielded a chunk.
    assert "bytes_first_chunk" not in ordering.events


def test_local_file_bytes_streams_from_landing_zone(tmp_path: pathlib.Path):
    # A developer with TM_INGEST_SOURCE=local + TM_LANDING_ZONE can download
    # real bytes. This unit test drives the provider directly.
    from api.services.file_bytes import LocalFileBytes

    (tmp_path / "test-manager" / "landing").mkdir(parents=True)
    body = b"local-bytes" * 100_000  # ~1.05 MiB — proves chunked streaming.
    file_path = tmp_path / "test-manager" / "landing" / "sample.mf4"
    file_path.write_bytes(body)

    provider = LocalFileBytes(tmp_path)
    stream, size = provider.open(
        "blob://test-manager/test-manager/landing/sample.mf4"
    )

    assert size == len(body)
    assembled = b"".join(stream)
    assert assembled == body


def test_local_file_bytes_missing_blob_raises_unavailable(tmp_path: pathlib.Path):
    from api.services.file_bytes import LocalFileBytes

    provider = LocalFileBytes(tmp_path)
    with pytest.raises(FileBytesUnavailable) as excinfo:
        provider.open("blob://bucket/missing.mf4")
    assert excinfo.value.reason == "blob_missing"


def test_local_file_bytes_null_storage_ref_raises_unavailable(tmp_path: pathlib.Path):
    from api.services.file_bytes import LocalFileBytes

    provider = LocalFileBytes(tmp_path)
    with pytest.raises(FileBytesUnavailable) as excinfo:
        provider.open(None)
    assert excinfo.value.reason == "blob_missing"


# --- the checksum state is the claim, not the digest --------------------------
#
# Finding 12 (21 Aug 2026). The route copied the stored digest into
# `X-Checksum-SHA256` and verified nothing, and the front end printed
# "Downloaded · checksum verified" whenever that header carried a value. The
# ingestion pipeline registers real `unverified` files, so the app claimed a
# check nobody ran, on a screen about traceability.


@pytest.mark.parametrize("state", ["verified", "unverified"])
def test_the_download_states_the_checksum_verdict(
    client, files_db, override_bytes, state
):
    """The header carries the registry's verdict beside the digest."""
    upsert_run(files_db)
    file = register_file(files_db, checksum_state=state)
    override_bytes(_FakeBytes(b"payload", _RecordedOrdering()))

    response = client.get(DOWNLOAD_URL.format(file_id=file["_id"]))

    assert response.status_code == 200, response.text
    assert response.headers["x-checksum-sha256"] == file["checksum_sha256"]
    assert response.headers["x-checksum-state"] == state


def test_a_file_with_no_stored_state_reads_as_unverified(
    client, files_db, override_bytes
):
    """A document written before the field existed claims nothing."""
    upsert_run(files_db)
    file = register_file(files_db)
    files_db["files"].update_one(
        {"_id": file["_id"]}, {"$unset": {"checksum_state": ""}}
    )
    override_bytes(_FakeBytes(b"payload", _RecordedOrdering()))

    response = client.get(DOWNLOAD_URL.format(file_id=file["_id"]))

    assert response.status_code == 200, response.text
    assert response.headers["x-checksum-state"] == "unverified"


# --- a filename never breaks the response header ------------------------------
#
# Finding 40c (21 Aug 2026). A CR or an LF in a filename split the
# `Content-Disposition` value, and the route builds that header AFTER it
# journals the download. So the audit row stated a download the caller never
# received. Two guards close it: the registry refuses the name at its door, and
# the header drops every control character of a name registered before that.


def test_the_registry_refuses_a_filename_with_a_line_break(client, files_db):
    upsert_run(files_db)
    body = {
        "filename": "bat_cyc\r\nX-Evil: 1.mf4",
        "run_id": "TAS-88214",
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 1024,
        "checksum_sha256": "a" * 64,
        "checksum_state": "verified",
    }

    response = client.post("/api/v1/files", json=body)

    assert response.status_code == 422, response.text
    assert files_db["files"].count_documents({}) == 0


def test_the_registry_refuses_a_filename_that_is_too_long(client, files_db):
    upsert_run(files_db)
    body = {
        "filename": "b" * 256 + ".mf4",
        "run_id": "TAS-88214",
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 1024,
        "checksum_sha256": "b" * 64,
        "checksum_state": "verified",
    }

    response = client.post("/api/v1/files", json=body)

    assert response.status_code == 422, response.text
    assert files_db["files"].count_documents({}) == 0


def test_a_stored_filename_with_a_line_break_still_downloads(
    client, files_db, override_bytes
):
    """The document predates the refusal above, and the audit row must hold."""
    upsert_run(files_db)
    file = register_file(files_db, filename="bat_cyc\r\nX-Evil: 1.mf4")
    override_bytes(_FakeBytes(b"payload", _RecordedOrdering()))

    response = client.get(DOWNLOAD_URL.format(file_id=file["_id"]))

    assert response.status_code == 200, response.text
    disposition = response.headers["content-disposition"]
    assert "\r" not in disposition and "\n" not in disposition
    assert "X-Evil" not in response.headers
    downloaded = list(
        files_db["journal_entries"].find(
            {"entity_id": file["_id"], "field": "file.downloaded"}
        )
    )
    assert len(downloaded) == 1


def test_a_file_with_no_stored_bytes_answers_409_not_503(
    client, files_db, override_bytes
):
    """A logical file (minted by the signals facade, or registered without a
    ref) holds no bytes BY DESIGN. That answered 503 storage_unreachable on a
    perfectly healthy stack until 25 Aug 2026 — the results route models the
    same state as a 409. No journal entry either: nothing was downloaded."""
    override_bytes(_RefusingBytes("must never be consulted"))
    upsert_run(files_db)
    doc = register_file(files_db, storage_ref=None)

    response = client.get(DOWNLOAD_URL.format(file_id=doc["_id"]))

    assert response.status_code == 409, response.text
    body = response.json()
    assert body["code"] == "file_has_no_bytes"
    assert files_db["journal_entries"].count_documents({"kind": "access"}) == 0
