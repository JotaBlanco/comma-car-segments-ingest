# GET /results/{result_id} and GET /results/{result_id}/download — contract
# §B #18b and #18c, requirement TR-006.
#
# TR-006 asks for a permanent link that resolves to one specific result
# version. The version chain was real and the screen printed it, but a version
# held no address of its own and no byte download, so the row stayed open.
#
# The download mirrors GET /files/{file_id}/download. Its first-order
# guarantee is **audit-before-bytes**: the journal write lands BEFORE the first
# byte leaves, and a refused write serves nothing. A provider that records the
# order proves the rule on the happy path, and the 503 path proves the other
# half — no entry is written when no byte ever moves.

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from pymongo.errors import PyMongoError

from api.services.file_bytes import FileBytesProvider, FileBytesUnavailable
from tests import factories_results
from tests.factories_results import RESULTS, RUN_ID, seed_result

# The assignment re-exports the fixture without shadowing an import.
results_db = factories_results.results_db

DETAIL_URL = RESULTS + "/{result_id}"
DOWNLOAD_URL = RESULTS + "/{result_id}/download"
PAYLOAD = b"cycle,peak_temp\n1,41.2\n2,43.8\n"


# --- doubles -------------------------------------------------------------------


class _Ordering:
    """A shared list every double writes to. The order proves the audit rule."""

    def __init__(self) -> None:
        self.events: list[str] = []


class _FakeBytes:
    """A stub bytes provider. It yields one payload from memory.

    It records the storage reference it received, so a test proves the route
    passes the result's own reference and never another entity's.
    """

    def __init__(self, payload: bytes, ordering: _Ordering) -> None:
        self._payload = payload
        self._ordering = ordering
        self.opened: list[str | None] = []

    def open(self, storage_ref: str | None) -> tuple[Iterator[bytes], int]:
        self.opened.append(storage_ref)
        payload = self._payload
        ordering = self._ordering

        def iterator() -> Iterator[bytes]:
            ordering.events.append("bytes_first_chunk")
            yield payload

        return iterator(), len(payload)


class _RefusingBytes:
    """A stub bytes provider that always refuses. It stands for an unbound store."""

    def __init__(self, detail: str = "Storage unreachable") -> None:
        self._detail = detail

    def open(self, storage_ref: str | None) -> tuple[Iterator[bytes], int]:
        raise FileBytesUnavailable(self._detail)


class _RecordingCollection:
    """A journal collection that records the insert, then delegates it."""

    def __init__(self, delegate: Any, ordering: _Ordering) -> None:
        self._delegate = delegate
        self._ordering = ordering

    def insert_one(self, document: dict) -> Any:
        self._ordering.events.append("journal_insert")
        return self._delegate.insert_one(document)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)


class _RefusingCollection:
    """A journal collection that refuses every insert."""

    def __init__(self, delegate: Any) -> None:
        self._delegate = delegate

    def insert_one(self, document: dict) -> Any:
        raise PyMongoError("the journal is down")

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)


class _WrappedDb:
    """A database that swaps the journal collection for a double."""

    def __init__(self, delegate: Any, journal) -> None:
        self._delegate = delegate
        self._journal = journal

    def __getitem__(self, name: str) -> Any:
        collection = self._delegate[name]
        if name == "journal_entries":
            return self._journal(collection)
        return collection

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)


# --- fixtures ------------------------------------------------------------------


@pytest.fixture
def override_bytes(app):
    """Install a bytes provider for the app. It yields a setter."""
    from api.services import file_bytes

    def install(provider: FileBytesProvider) -> None:
        app.dependency_overrides[file_bytes.get_file_bytes_provider] = lambda: provider

    yield install
    app.dependency_overrides.pop(file_bytes.get_file_bytes_provider, None)


@pytest.fixture
def wrap_journal(client, results_db):
    """Swap the journal collection for a double. It yields a setter."""
    from api import db as db_module

    def install(journal) -> None:
        client.app.dependency_overrides[db_module.get_db] = lambda: _WrappedDb(
            results_db, journal
        )

    yield install
    client.app.dependency_overrides[db_module.get_db] = lambda: results_db


def downloads(db) -> list[dict]:
    return list(db["journal_entries"].find({"field": "result.downloaded"}))


# --- GET /results/{result_id} --------------------------------------------------


def test_a_result_reads_back_by_its_own_id(client, results_db):
    result = seed_result(results_db)

    response = client.get(DETAIL_URL.format(result_id=result["_id"]))

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["result_id"] == result["_id"]
    assert body["run_id"] == RUN_ID
    assert body["result_key"] == result["result_key"]
    assert body["version"] == 1
    assert body["supersedes"] is None
    assert body["storage_ref"] == result["storage_ref"]
    assert body["provenance_status"] == "verified"
    assert body["provenance"]["tool"] == "bat-post"


def test_the_detail_serves_the_same_shape_the_list_serves(client, results_db):
    """One shape, two routes. A screen must never learn a second result shape."""
    result = seed_result(results_db)

    listed = client.get(RESULTS, params={"run": RUN_ID}).json()["items"][0]
    read = client.get(DETAIL_URL.format(result_id=result["_id"])).json()

    assert read == listed


def test_each_version_of_a_chain_has_its_own_address(client, results_db):
    """The point of the row: a link resolves to one version, never to the chain."""
    first = seed_result(results_db, name="thermal_summary_v1.parquet")
    second = seed_result(
        results_db,
        name="thermal_summary_v2.parquet",
        version=2,
        supersedes=first["_id"],
    )

    older = client.get(DETAIL_URL.format(result_id=first["_id"])).json()
    newer = client.get(DETAIL_URL.format(result_id=second["_id"])).json()

    assert older["version"] == 1
    assert older["supersedes"] is None
    assert newer["version"] == 2
    assert newer["supersedes"] == first["_id"]


def test_an_unknown_result_id_answers_404(client, results_db):
    response = client.get(DETAIL_URL.format(result_id="res-nothing"))

    assert response.status_code == 404, response.text
    assert response.json()["code"] == "result_not_found"


def test_the_detail_needs_the_bearer_token(bare_client, results_db):
    result = seed_result(results_db)

    response = bare_client.get(DETAIL_URL.format(result_id=result["_id"]))

    assert response.status_code == 401, response.text


def test_the_detail_writes_no_journal_entry(client, results_db):
    """A read of the row is not an event. Only the byte download is."""
    result = seed_result(results_db)
    before = results_db["journal_entries"].count_documents({})

    client.get(DETAIL_URL.format(result_id=result["_id"]))

    assert results_db["journal_entries"].count_documents({}) == before


# --- GET /results/{result_id}/download -----------------------------------------


def test_the_download_serves_the_bytes_after_the_audit_entry(
    client, results_db, override_bytes, wrap_journal
):
    """Audit-before-bytes. The journal insert precedes the first chunk."""
    result = seed_result(results_db)
    ordering = _Ordering()
    provider = _FakeBytes(PAYLOAD, ordering)
    override_bytes(provider)
    wrap_journal(lambda collection: _RecordingCollection(collection, ordering))

    response = client.get(DOWNLOAD_URL.format(result_id=result["_id"]))

    assert response.status_code == 200, response.text
    assert response.content == PAYLOAD
    assert ordering.events == ["journal_insert", "bytes_first_chunk"]
    # The route opens the result's own reference, never another entity's.
    assert provider.opened == [result["storage_ref"]]


def test_the_download_headers_name_the_bytes_and_the_audit_entry(
    client, results_db, override_bytes
):
    result = seed_result(results_db, checksum_sha256="a" * 64)
    override_bytes(_FakeBytes(PAYLOAD, _Ordering()))

    response = client.get(DOWNLOAD_URL.format(result_id=result["_id"]))

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-length"] == str(len(PAYLOAD))
    assert result["name"] in response.headers["content-disposition"]
    assert response.headers["x-checksum-sha256"] == "a" * 64
    assert response.headers["cache-control"] == "no-store"
    entry = downloads(results_db)[0]
    assert response.headers["x-journal-id"] == entry["_id"]


# --- the served filename comes from the stored key ------------------------------
#
# 26 Aug 2026. A QuixLab job published CSV bytes under the label
# "QuixLab run_TRNEW". The stored key was correct and ended in `run_TRNEW.csv`,
# but the route named the download from `name`, so a person saved a file with
# no extension and the operating system could not open it. The key holds the
# filename the uploader gave, so the route reads the key. It guesses no type.

# The real key from the demo workspace, shortened to the two segments that
# matter: the uuid `result_blob_key` mints, then the uploaded filename.
DEMO_KEY = (
    "blob://quixdev-testmanagerdemo-dev/test-manager/results/TRNEW/"
    "e7c4cc2d86004684a92447a7f58d11da-run_TRNEW.csv"
)


def test_the_download_names_the_file_from_the_stored_key(
    client, results_db, override_bytes
):
    """The label names no file type. The key does, so the key wins."""
    result = seed_result(
        results_db, name="QuixLab run_TRNEW", storage_ref=DEMO_KEY
    )
    override_bytes(_FakeBytes(PAYLOAD, _Ordering()))

    response = client.get(DOWNLOAD_URL.format(result_id=result["_id"]))

    assert response.status_code == 200, response.text
    disposition = response.headers["content-disposition"]
    assert 'filename="run_TRNEW.csv"' in disposition
    assert "filename*=UTF-8''run_TRNEW.csv" in disposition
    # The label must not be the saved name, and the minted uuid must not ride
    # along into it.
    assert 'filename="QuixLab run_TRNEW"' not in disposition
    assert "e7c4cc2d86004684a92447a7f58d11da" not in disposition


def test_the_download_never_guesses_a_type(client, results_db, override_bytes):
    """A JSON result keeps `.json`. Nothing here appends `.csv`."""
    result = seed_result(
        results_db,
        name="QuixLab run_TRNEW",
        storage_ref=DEMO_KEY.replace("run_TRNEW.csv", "summary.json"),
    )
    override_bytes(_FakeBytes(PAYLOAD, _Ordering()))

    response = client.get(DOWNLOAD_URL.format(result_id=result["_id"]))

    assert response.status_code == 200, response.text
    assert 'filename="summary.json"' in response.headers["content-disposition"]
    assert ".csv" not in response.headers["content-disposition"]


def test_a_reference_that_names_no_file_falls_back_to_the_label(
    client, results_db, override_bytes
):
    """`POST /results` takes any reference. One that names no file keeps the label."""
    result = seed_result(results_db, name="QuixLab run_TRNEW", storage_ref="blob://")
    override_bytes(_FakeBytes(PAYLOAD, _Ordering()))

    response = client.get(DOWNLOAD_URL.format(result_id=result["_id"]))

    assert response.status_code == 200, response.text
    assert 'filename="QuixLab run_TRNEW"' in response.headers["content-disposition"]


def test_the_audit_entry_names_the_result_and_keeps_the_run_timeline(
    client, results_db, override_bytes
):
    result = seed_result(results_db)
    override_bytes(_FakeBytes(PAYLOAD, _Ordering()))

    client.get(DOWNLOAD_URL.format(result_id=result["_id"]))

    entry = downloads(results_db)[0]
    assert entry["entity_type"] == "result"
    assert entry["entity_id"] == result["_id"]
    assert entry["field"] == "result.downloaded"
    assert entry["source"] == "manual"
    assert entry["context_run_id"] == RUN_ID
    assert str(len(PAYLOAD)) in entry["note"]


def test_a_result_with_no_storage_reference_says_it_holds_no_bytes(
    client, results_db, override_bytes
):
    """Never a 404. The result is there; the bytes live somewhere else."""
    result = seed_result(results_db, storage_ref=None)
    override_bytes(_FakeBytes(PAYLOAD, _Ordering()))

    response = client.get(DOWNLOAD_URL.format(result_id=result["_id"]))

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "result_has_no_bytes"
    # The caller still reads the result itself, so the answer must not deny it.
    assert client.get(DETAIL_URL.format(result_id=result["_id"])).status_code == 200
    assert downloads(results_db) == []


def test_a_blank_storage_reference_is_no_reference(client, results_db, override_bytes):
    result = seed_result(results_db, storage_ref="   ")
    override_bytes(_FakeBytes(PAYLOAD, _Ordering()))

    response = client.get(DOWNLOAD_URL.format(result_id=result["_id"]))

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "result_has_no_bytes"


def test_an_unreachable_store_answers_503_and_writes_no_entry(
    client, results_db, override_bytes
):
    """The server never fabricates a trace for bytes that never moved."""
    result = seed_result(results_db)
    override_bytes(_RefusingBytes())

    response = client.get(DOWNLOAD_URL.format(result_id=result["_id"]))

    assert response.status_code == 503, response.text
    assert response.json()["code"] == "storage_unreachable"
    assert downloads(results_db) == []


def test_a_refused_audit_write_answers_503_and_serves_no_byte(
    client, results_db, override_bytes, wrap_journal
):
    """Audit-before-bytes forbids a download that leaves no trace."""
    result = seed_result(results_db)
    ordering = _Ordering()
    override_bytes(_FakeBytes(PAYLOAD, ordering))
    wrap_journal(_RefusingCollection)

    response = client.get(DOWNLOAD_URL.format(result_id=result["_id"]))

    assert response.status_code == 503, response.text
    assert response.json()["code"] == "not_ready"
    assert "bytes_first_chunk" not in ordering.events
    assert downloads(results_db) == []


def test_an_unknown_id_answers_404_before_it_reaches_the_store(
    client, results_db, override_bytes
):
    override_bytes(_RefusingBytes())

    response = client.get(DOWNLOAD_URL.format(result_id="res-nothing"))

    assert response.status_code == 404, response.text
    assert response.json()["code"] == "result_not_found"


def test_the_download_needs_the_bearer_token(bare_client, results_db, override_bytes):
    result = seed_result(results_db)
    override_bytes(_FakeBytes(PAYLOAD, _Ordering()))

    response = bare_client.get(DOWNLOAD_URL.format(result_id=result["_id"]))

    assert response.status_code == 401, response.text
    assert downloads(results_db) == []


def test_the_download_url_never_carries_a_token(client, results_db, override_bytes):
    """The bearer travels in the header. A URL is logged and shared."""
    result = seed_result(results_db)
    override_bytes(_FakeBytes(PAYLOAD, _Ordering()))

    response = client.get(DOWNLOAD_URL.format(result_id=result["_id"]))

    assert response.status_code == 200, response.text
    assert "?" not in str(response.request.url)
