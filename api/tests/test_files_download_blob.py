# GET /files/{file_id}/download over BLOB storage — contract v1.1 §D.
#
# `api/tests/test_files_download.py` proves the route with a fake provider and
# with `LocalFileBytes`. This module proves the provider a deployment really
# uses: `BlobFileBytes` over the `ingest.store` blob client
# (`api/ingest/store.py`). The API builds no second blob client.
#
# The two paths this module pins:
#
# * a provider EXISTS — the route answers 200, it streams the real bytes, and
#   the audit entry lands BEFORE the first byte;
# * a provider is ABSENT — the route answers 503 with the §A body
#   `{detail, code, errors}` and code `storage_unreachable`, and it writes NO
#   audit entry, because a trace for a stream that never began is a fake.

from __future__ import annotations

import io
from collections.abc import Iterator
from typing import Any

import pytest

from api.services import file_bytes
from api.services.file_bytes import (
    BlobFileBytes,
    FileBytesProvider,
    FileBytesUnavailable,
    UnavailableFileBytes,
    blob_key,
    build_default_provider,
)
from tests import factories
from tests.factories import register_file, upsert_run

files_db = factories.files_db

DOWNLOAD_URL = "/api/v1/files/{file_id}/download"


# --- a fake blob store, shaped like `ingest.store.BlobStore` -------------------


class _FakeHandle(io.BytesIO):
    """An fsspec-style handle. It carries `size` and it records the first read."""

    def __init__(self, payload: bytes, events: list[str]) -> None:
        super().__init__(payload)
        self.size = len(payload)
        self._events = events

    def read(self, count: int = -1) -> bytes:
        chunk = super().read(count)
        if chunk and "bytes_first_chunk" not in self._events:
            self._events.append("bytes_first_chunk")
        return chunk


class _FakeStore:
    """Stand in for `ingest.store.BlobStore`. It holds one key per test."""

    def __init__(self, objects: dict[str, bytes], events: list[str]) -> None:
        self._objects = objects
        self.events = events
        self.opened: list[str] = []

    def open(self, key: str) -> _FakeHandle:
        self.opened.append(key)
        if key not in self._objects:
            raise FileNotFoundError(key)
        return _FakeHandle(self._objects[key], self.events)


class _RecordingCollection:
    def __init__(self, delegate: Any, events: list[str]) -> None:
        self._delegate = delegate
        self._events = events

    def insert_one(self, document: dict) -> Any:
        self._events.append("journal_insert")
        return self._delegate.insert_one(document)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)


class _RecordingDb:
    """Route the journal collection through a recorder. Everything else passes."""

    def __init__(self, delegate: Any, events: list[str]) -> None:
        self._delegate = delegate
        self._events = events

    def __getitem__(self, name: str) -> Any:
        collection = self._delegate[name]
        if name == "journal_entries":
            return _RecordingCollection(collection, self._events)
        return collection

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)


@pytest.fixture
def override_bytes(app):
    """Install a bytes provider for the app, and remove it afterwards."""
    installed: list[FileBytesProvider] = []

    def install(provider: FileBytesProvider) -> None:
        app.dependency_overrides[file_bytes.get_file_bytes_provider] = lambda: provider
        installed.append(provider)

    yield install
    app.dependency_overrides.pop(file_bytes.get_file_bytes_provider, None)


@pytest.fixture
def recording_db(client, files_db):
    """Yield the recorded event list, with the journal writes inside it."""
    from api import db as db_module

    events: list[str] = []
    client.app.dependency_overrides[db_module.get_db] = lambda: _RecordingDb(files_db, events)
    yield events
    client.app.dependency_overrides[db_module.get_db] = lambda: files_db


def _downloaded_entries(db, file_id: str) -> list[dict]:
    return list(db["journal_entries"].find({"entity_id": file_id, "field": "file.downloaded"}))


# --- the key mapping ----------------------------------------------------------


def test_blob_key_keeps_the_whole_key_of_a_seeded_reference():
    # The seed stores `blob://test-manager/landing/...`. The filesystem is
    # already scoped to the bucket, so every segment after the scheme is key.
    assert (
        blob_key("blob://test-manager/landing/rig-04/bat_cyc_0941.mf4")
        == "test-manager/landing/rig-04/bat_cyc_0941.mf4"
    )


def test_blob_key_keeps_the_bare_key_the_pipeline_writes():
    # The ingestion pipeline stores the bare object key, with no scheme.
    assert blob_key("ws-1/test-manager/landing/a.mf4") == "ws-1/test-manager/landing/a.mf4"


@pytest.mark.parametrize("reference", [None, "", "   "])
def test_blob_key_refuses_an_empty_reference(reference):
    with pytest.raises(FileBytesUnavailable) as error:
        blob_key(reference)
    assert error.value.reason == "blob_missing"


# --- the provider exists: the route serves bytes ------------------------------


def test_blob_download_streams_real_bytes_after_the_audit_event(
    client, files_db, override_bytes, recording_db
):
    upsert_run(files_db)
    file = register_file(
        files_db,
        filename="bat_cyc_20260814_0941.mf4",
        storage_ref="blob://test-manager/landing/rig-04/bat_cyc_20260814_0941.mf4",
    )
    payload = b"MDF     " + bytes(range(256)) * 8
    store = _FakeStore(
        {"test-manager/landing/rig-04/bat_cyc_20260814_0941.mf4": payload},
        recording_db,
    )
    override_bytes(BlobFileBytes(store))

    response = client.get(DOWNLOAD_URL.format(file_id=file["_id"]))

    assert response.status_code == 200, response.text
    assert response.content == payload
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-length"] == str(len(payload))
    assert response.headers["x-checksum-sha256"] == file["checksum_sha256"]
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-journal-id"]

    # The provider asked the store for the key the reference names.
    assert store.opened == ["test-manager/landing/rig-04/bat_cyc_20260814_0941.mf4"]

    # Audit-before-bytes. The journal write precedes the first chunk.
    assert recording_db[0] == "journal_insert", recording_db
    assert "bytes_first_chunk" in recording_db
    assert recording_db.index("journal_insert") < recording_db.index("bytes_first_chunk")

    entries = _downloaded_entries(files_db, file["_id"])
    assert len(entries) == 1
    assert entries[0]["_id"] == response.headers["x-journal-id"]


# --- the provider refuses: the route answers 503 ------------------------------


def test_missing_blob_answers_503_and_writes_no_audit(
    client, files_db, override_bytes, recording_db
):
    upsert_run(files_db)
    file = register_file(files_db, storage_ref="blob://test-manager/landing/gone.mf4")
    store = _FakeStore({}, recording_db)
    override_bytes(BlobFileBytes(store))

    response = client.get(DOWNLOAD_URL.format(file_id=file["_id"]))

    assert response.status_code == 503, response.text
    body = response.json()
    assert set(body) == {"detail", "code", "errors"}
    assert body["code"] == "storage_unreachable"
    assert body["errors"] == []
    assert "test-manager/landing/gone.mf4" in body["detail"]

    # No byte moved, so no trace may exist. A journal row here would be a fake.
    assert recording_db == []
    assert _downloaded_entries(files_db, file["_id"]) == []


def test_no_provider_answers_503_with_the_contract_body(
    client, files_db, override_bytes, recording_db, monkeypatch
):
    # This is the state the review measured on 18 Aug 2026, before the wiring.
    monkeypatch.delenv("TM_INGEST_SOURCE", raising=False)
    file_bytes._cached_blob_provider.cache_clear()
    upsert_run(files_db)
    file = register_file(files_db)
    provider = build_default_provider()
    assert isinstance(provider, UnavailableFileBytes)
    override_bytes(provider)

    response = client.get(DOWNLOAD_URL.format(file_id=file["_id"]))

    assert response.status_code == 503, response.text
    body = response.json()
    assert set(body) == {"detail", "code", "errors"}
    assert body["code"] == "storage_unreachable"
    assert recording_db == []
    assert _downloaded_entries(files_db, file["_id"]) == []


# --- the environment picks the provider ---------------------------------------


def test_blob_source_builds_the_blob_provider_over_the_blob_store(monkeypatch):
    # `TM_INGEST_SOURCE=blob` is the same value `ingest.store.build_store` takes
    # (`ingest/store.py:213`), so one name serves both duties.
    import ingest.store as store_module

    marker = _FakeStore({}, [])
    monkeypatch.setattr(store_module, "build_blob_store", lambda: marker)
    monkeypatch.setenv("TM_INGEST_SOURCE", "blob")
    file_bytes._cached_blob_provider.cache_clear()
    try:
        provider = build_default_provider()
        assert isinstance(provider, BlobFileBytes)
        assert provider._store is marker
    finally:
        file_bytes._cached_blob_provider.cache_clear()


def test_blob_source_refuses_when_the_store_cannot_be_built(monkeypatch):
    import ingest.store as store_module

    def explode() -> None:
        raise RuntimeError("no credential")

    monkeypatch.setattr(store_module, "build_blob_store", explode)
    monkeypatch.setenv("TM_INGEST_SOURCE", "blob")
    file_bytes._cached_blob_provider.cache_clear()
    try:
        provider = build_default_provider()
        assert isinstance(provider, UnavailableFileBytes)
        with pytest.raises(FileBytesUnavailable):
            provider.open("blob://anything")
    finally:
        file_bytes._cached_blob_provider.cache_clear()


def test_an_unknown_source_still_refuses(monkeypatch):
    monkeypatch.setenv("TM_INGEST_SOURCE", "sag")
    assert isinstance(build_default_provider(), UnavailableFileBytes)


# --- the stream never starts before the audit ---------------------------------


def test_blob_open_returns_an_iterator_that_has_not_read_a_byte():
    # The route calls `open()` before the journal write. `open()` may read
    # metadata for the size, and it must read NO data byte.
    events: list[str] = []
    store = _FakeStore({"k/a.mf4": b"payload-bytes"}, events)
    stream, size = BlobFileBytes(store).open("blob://k/a.mf4")

    assert size == len(b"payload-bytes")
    assert events == []

    assert b"".join(_drain(stream)) == b"payload-bytes"
    assert events == ["bytes_first_chunk"]


def _drain(stream: Iterator[bytes]) -> list[bytes]:
    return list(stream)


# --- the local byte seed ------------------------------------------------------
#
# `ingest.blob_seed` fills the bucket the local stack runs, so the download
# button serves a byte on a developer machine. It writes no document.


class _WritableStore(_FakeStore):
    """A fake store the byte seed can write into."""

    def read_bytes(self, key: str) -> bytes | None:
        return self._objects.get(key)

    def write(self, key: str, data: bytes) -> None:
        self._objects[key] = data


def test_the_byte_seed_reads_every_registered_key(files_db):
    from ingest import blob_seed

    upsert_run(files_db)
    register_file(files_db, storage_ref="blob://test-manager/landing/a.mf4")
    register_file(files_db, storage_ref="test-manager/landing/b.mf4")
    register_file(files_db, storage_ref=None)
    register_file(files_db, status="quarantined", storage_ref="blob://test-manager/landing/q.mf4")

    assert blob_seed.registered_keys(files_db) == [
        "test-manager/landing/a.mf4",
        "test-manager/landing/b.mf4",
    ]


def test_the_byte_seed_never_overwrites_a_key_the_bucket_holds(monkeypatch):
    from ingest import blob_seed

    store = _WritableStore({"kept.mf4": b"the real ingested file"}, [])
    monkeypatch.setattr(blob_seed, "put_object", lambda s, key, data: s.write(key, data))
    monkeypatch.setattr(blob_seed, "mf4_bytes", lambda fixture: b"MDF fixture")

    wrote, kept, refused = blob_seed.fill(store, ["kept.mf4", "new.mf4"])

    assert (wrote, kept, refused) == (1, 1, 0)
    assert store.read_bytes("kept.mf4") == b"the real ingested file"
    assert store.read_bytes("new.mf4") == b"MDF fixture"


def test_the_byte_seed_never_writes_over_a_key_it_may_not_read(monkeypatch):
    """Finding 39 (21 Aug 2026). A refused read is not an absent key.

    s3fs raises `PermissionError` on a 403, and `PermissionError` is an
    `OSError`. The store swallowed every `OSError` and answered None, so one
    refused read replaced a real captured measurement file with a fixture.
    """

    class _RefusingStore(_WritableStore):
        def read_bytes(self, key: str) -> bytes | None:
            if key == "refused.mf4":
                raise PermissionError("403 Forbidden")
            return self._objects.get(key)

    store = _RefusingStore({}, [])
    monkeypatch.setattr(blob_seed_module(), "put_object", lambda s, key, data: s.write(key, data))
    monkeypatch.setattr(blob_seed_module(), "mf4_bytes", lambda fixture: b"MDF fixture")

    wrote, kept, refused = blob_seed_module().fill(store, ["refused.mf4", "new.mf4"])

    assert (wrote, kept, refused) == (1, 0, 1)
    assert store.read_bytes("new.mf4") == b"MDF fixture"
    assert "refused.mf4" not in store._objects


def blob_seed_module():
    from ingest import blob_seed

    return blob_seed


def test_the_blob_store_tells_an_absent_key_from_a_refused_read():
    """`read_bytes` answers None for absent, and raises for everything else."""
    from ingest.store import BlobStore

    class _Filesystem:
        def open(self, key, mode):
            if key == "absent.mf4":
                raise FileNotFoundError(key)
            raise PermissionError("403 Forbidden")

    store = BlobStore(_Filesystem())

    assert store.read_bytes("absent.mf4") is None
    with pytest.raises(PermissionError):
        store.read_bytes("refused.mf4")
