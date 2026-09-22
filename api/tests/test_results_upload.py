# POST /results/upload — contract v1.2, the AGREED result-upload box.
#
# The route lives at api/api/routers/results.py and the writer at
# api/api/services/file_writes.py. It closes R-12: a person could not upload a
# manually processed result, because no route took the bytes.
#
# The first-order guarantee is that the audit line tells the truth. The
# download route writes its entry BEFORE it reads the bytes, because a read
# must leave a trace even when the read then fails. A write is the other way
# round: an entry that says "Uploaded 4,096 bytes" before the store has taken
# them describes bytes that may never land. So this route stores the bytes
# first and records them second, and a writer that records the order proves it.

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from typing import Any

import pytest
from pymongo.errors import PyMongoError

from api.routers import results as results_router
from api.services import file_writes
from api.services.file_bytes import FileBytesUnavailable
from tests import factories_results
from tests.factories_results import RESULTS, RUN_ID, provenance, result_body

# The assignment re-exports the fixture without shadowing an import.
results_db = factories_results.results_db

UPLOAD = f"{RESULTS}/upload"
PAYLOAD = b"cycle,peak_temp\n1,41.2\n2,43.8\n"
FILENAME = "thermal_summary_v1.csv"


# --- helpers -------------------------------------------------------------------


def upload_metadata(**overrides) -> dict:
    """The metadata part of an upload. It is the POST /results body, minus the ref."""
    body = result_body(**overrides)
    body.pop("storage_ref", None)
    return body


def post_upload(client, metadata: dict | str, payload: bytes = PAYLOAD, name=FILENAME):
    """Send one multipart upload the way the screen sends it."""
    text = metadata if isinstance(metadata, str) else json.dumps(metadata)
    return client.post(
        UPLOAD,
        files={"file": (name, payload, "text/csv")},
        data={"metadata": text},
    )


def stored_results(db) -> int:
    return db["processed_results"].count_documents({})


def upload_events(db) -> list[dict]:
    return list(db["journal_entries"].find({"field": "run.result_uploaded"}))


# --- writer doubles ------------------------------------------------------------


class _FakeWrites:
    """A stub writer. It keeps the bytes in memory so a test can read them back.

    ``ordering`` records ``"bytes_written"`` when the write starts. The
    recording database records ``"journal_insert"``. The bytes must come first.
    """

    def __init__(self, ordering: list[str] | None = None) -> None:
        self.stored: dict[str, bytes] = {}
        self._ordering = ordering

    def check_ready(self) -> None:
        return None

    def write(self, key: str, chunks: Iterable[bytes]) -> int:
        if self._ordering is not None:
            self._ordering.append("bytes_written")
        # The route streams. A test may join the chunks, because it holds a
        # payload of a few bytes.
        data = b"".join(chunks)
        self.stored[key] = data
        return len(data)


class _RefusingWrites:
    """A writer with no store behind it. It refuses before the audit entry."""

    def check_ready(self) -> None:
        raise FileBytesUnavailable(
            "Storage unreachable — no blob storage is bound to this deployment."
        )

    def write(self, key: str, chunks: Iterable[bytes]) -> int:
        raise FileBytesUnavailable("Storage unreachable — the store took no write.")


class _FailingWrites:
    """A writer that answers ready and then refuses the write itself."""

    def check_ready(self) -> None:
        return None

    def write(self, key: str, chunks: Iterable[bytes]) -> int:
        raise FileBytesUnavailable(f"the store refused the write: {key}")


@pytest.fixture
def override_writer(app):
    """Install a writer for the app. Yields a setter."""
    from api.services import file_writes

    def install(writer):
        app.dependency_overrides[file_writes.get_file_writer] = lambda: writer
        return writer

    yield install
    app.dependency_overrides.pop(file_writes.get_file_writer, None)


class _RecordingCollection:
    """Record every journal insert, in order."""

    def __init__(self, delegate: Any, order: list[str], fail: bool) -> None:
        self._delegate = delegate
        self._order = order
        self._fail = fail

    def insert_one(self, document: dict) -> Any:
        self._order.append("journal_insert")
        if self._fail:
            raise PyMongoError("the journal is not writable")
        return self._delegate.insert_one(document)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)


class _RecordingDb:
    """A database that wraps the journal collection only."""

    def __init__(self, delegate: Any, order: list[str], fail: bool = False) -> None:
        self._delegate = delegate
        self._order = order
        self._fail = fail

    def __getitem__(self, name: str) -> Any:
        collection = self._delegate[name]
        if name == "journal_entries":
            return _RecordingCollection(collection, self._order, self._fail)
        return collection

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)


@pytest.fixture
def recording_db(app, results_db):
    """Route the app at a database that records, or refuses, a journal write."""
    from api import db as db_module

    def install(order: list[str], fail: bool = False):
        app.dependency_overrides[db_module.get_db] = lambda: _RecordingDb(
            results_db, order, fail
        )
        return results_db

    yield install
    app.dependency_overrides[db_module.get_db] = lambda: results_db


# --- the happy path ------------------------------------------------------------


def test_an_upload_stores_the_bytes_then_records_the_result(
    client, results_db, override_writer
):
    writer = override_writer(_FakeWrites())

    response = post_upload(client, upload_metadata())

    assert response.status_code == 201, response.text
    body = response.json()
    # One upload, one blob.
    assert list(writer.stored.values()) == [PAYLOAD]
    key = next(iter(writer.stored))
    assert key.startswith(f"test-manager/results/{RUN_ID}/")
    assert key.endswith(FILENAME)
    # One upload, one row, and the row points at that blob.
    assert stored_results(results_db) == 1
    assert body["storage_ref"] == f"blob://{key}"
    assert body["run_id"] == RUN_ID
    assert body["version"] == 1


def test_the_upload_records_the_manual_source_and_the_caller(
    client, results_db, override_writer
):
    override_writer(_FakeWrites())

    response = post_upload(client, upload_metadata())

    assert response.status_code == 201, response.text
    events = upload_events(results_db)
    assert len(events) == 1
    # The demo path keeps the claimed actor. `journal_actor` replaces it with
    # the verified name when the platform check is on.
    assert events[0]["actor"] == provenance()["produced_by"]
    assert events[0]["source"] == "manual"
    assert events[0]["entity_type"] == "run"
    assert events[0]["entity_id"] == RUN_ID
    assert response.headers["X-Journal-Id"] == events[0]["_id"]


def test_the_audit_entry_lands_after_the_bytes(
    client, results_db, override_writer, recording_db
):
    """Finding 31d. The note states a byte count, so the bytes must be there.

    The entry used to land first, so a store that failed the write left a
    line claiming bytes that never moved. The contract forbids exactly that
    (`plans/API-CONTRACT.md`, "the server never fabricates a trace for bytes
    that never moved").
    """
    order: list[str] = []
    override_writer(_FakeWrites(order))
    recording_db(order)

    response = post_upload(client, upload_metadata())

    assert response.status_code == 201, response.text
    assert "journal_insert" in order
    assert "bytes_written" in order
    assert order.index("bytes_written") < order.index("journal_insert")


# --- the checksum --------------------------------------------------------------


def test_the_checksum_names_the_uploaded_bytes(client, results_db, override_writer):
    override_writer(_FakeWrites())
    expected = hashlib.sha256(PAYLOAD).hexdigest()

    response = post_upload(client, upload_metadata())

    assert response.status_code == 201, response.text
    assert response.headers["X-Checksum-SHA256"] == expected
    # The audit line describes the bytes it let through.
    note = upload_events(results_db)[0]["note"]
    assert expected in note
    assert f"{len(PAYLOAD)} bytes" in note


def test_the_checksum_reads_the_stream_in_chunks(client, results_db, override_writer):
    """A payload of several chunks hashes to the same value as one buffer.

    The route never holds the whole file, so the chunk loop must agree with a
    single-shot hash. A payload above `CHUNK_BYTES` proves the loop runs twice.
    """
    from api.services.file_bytes import CHUNK_BYTES

    payload = b"x" * (CHUNK_BYTES + 1024)
    writer = override_writer(_FakeWrites())

    response = post_upload(client, upload_metadata(), payload=payload)

    assert response.status_code == 201, response.text
    assert response.headers["X-Checksum-SHA256"] == hashlib.sha256(payload).hexdigest()
    assert list(writer.stored.values()) == [payload]


# --- the size cap --------------------------------------------------------------


def test_the_cap_is_one_hundred_mebibytes():
    """The contract states the number, so a change here changes the contract."""
    assert results_router.MAX_UPLOAD_BYTES == 100 * 1024 * 1024


def test_a_file_over_the_cap_answers_413_and_stores_nothing(
    client, results_db, override_writer, monkeypatch
):
    # The real cap is 100 MiB. A test proves the guard, not the number, so it
    # shrinks the cap instead of sending 100 MB through the harness.
    monkeypatch.setattr(results_router, "MAX_UPLOAD_BYTES", 32)
    writer = override_writer(_FakeWrites())

    response = post_upload(client, upload_metadata(), payload=b"y" * 64)

    assert response.status_code == 413, response.text
    assert response.json()["code"] == "file_too_large"
    assert writer.stored == {}
    assert stored_results(results_db) == 0
    assert upload_events(results_db) == []


def test_a_file_on_the_cap_passes(client, results_db, override_writer, monkeypatch):
    monkeypatch.setattr(results_router, "MAX_UPLOAD_BYTES", 32)
    override_writer(_FakeWrites())

    response = post_upload(client, upload_metadata(), payload=b"y" * 32)

    assert response.status_code == 201, response.text


# --- the store refuses ---------------------------------------------------------


def test_a_store_that_refuses_answers_503_and_writes_no_journal_entry(
    client, results_db, override_writer
):
    """The download route's rule, mirrored: no fake trace for bytes that never moved."""
    override_writer(_RefusingWrites())

    response = post_upload(client, upload_metadata())

    assert response.status_code == 503, response.text
    assert response.json()["code"] == "storage_unreachable"
    assert stored_results(results_db) == 0
    assert upload_events(results_db) == []


def test_a_store_that_fails_the_write_leaves_no_entry_and_no_result(
    client, results_db, override_writer
):
    """Finding 31d. No bytes moved, so no line may say they did."""
    override_writer(_FailingWrites())

    response = post_upload(client, upload_metadata())

    assert response.status_code == 503, response.text
    assert response.json()["code"] == "storage_unreachable"
    assert stored_results(results_db) == 0
    assert upload_events(results_db) == []


# --- the journal write fails ---------------------------------------------------


def test_a_failed_journal_write_answers_503_and_writes_no_result_row(
    client, results_db, override_writer, recording_db
):
    """A refused entry still costs the result row, so nothing points at the blob.

    The bytes are already in the store, and the route says so: it never claims
    they are gone. The object is unreferenced, because no row and no answer
    names it, and the caller may send the whole upload again.
    """
    order: list[str] = []
    writer = override_writer(_FakeWrites(order))
    recording_db(order, fail=True)

    response = post_upload(client, upload_metadata())

    assert response.status_code == 503, response.text
    assert response.json()["code"] == "not_ready"
    assert list(writer.stored.values()) == [PAYLOAD]
    assert stored_results(results_db) == 0


# --- the metadata gates --------------------------------------------------------


def test_metadata_that_carries_a_storage_ref_answers_422(
    client, results_db, override_writer
):
    writer = override_writer(_FakeWrites())
    metadata = upload_metadata()
    metadata["storage_ref"] = "blob://somewhere/else.parquet"

    response = post_upload(client, metadata)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "storage_ref_not_allowed"
    assert writer.stored == {}
    assert stored_results(results_db) == 0


def test_metadata_with_no_provenance_answers_422_and_stores_nothing(
    client, results_db, override_writer
):
    """The provenance gate binds the upload exactly as it binds POST /results."""
    writer = override_writer(_FakeWrites())
    metadata = upload_metadata()
    metadata.pop("provenance")

    response = post_upload(client, metadata)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "provenance_required"
    assert writer.stored == {}
    assert stored_results(results_db) == 0


def test_metadata_that_is_not_json_answers_422(client, results_db, override_writer):
    override_writer(_FakeWrites())

    response = post_upload(client, "not json at all")

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "invalid_metadata"
    assert stored_results(results_db) == 0


def test_metadata_with_an_unknown_field_answers_422(
    client, results_db, override_writer
):
    override_writer(_FakeWrites())
    metadata = upload_metadata()
    metadata["colour"] = "blue"

    response = post_upload(client, metadata)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "validation_error"
    assert stored_results(results_db) == 0


# --- the run must exist (finding 25) -------------------------------------------


def test_an_upload_for_an_unknown_run_stores_no_byte(
    client, results_db, override_writer
):
    """The run gate runs before the bytes, so a bad run id leaves no blob."""
    writer = override_writer(_FakeWrites())

    response = post_upload(client, upload_metadata(run_id="TAS-00000"))

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "unknown_run"
    assert writer.stored == {}
    assert stored_results(results_db) == 0
    assert upload_events(results_db) == []


# --- the early size cap (finding 40h) ------------------------------------------


def test_a_stated_body_length_over_the_cap_is_refused_before_the_spool(
    client, results_db, override_writer, monkeypatch
):
    """Finding 40h. Starlette spools the body before the route function runs.

    The route class reads Content-Length first, so an oversized request never
    reaches the parser and never reaches the pod's disk. The request below
    states a length far above the shrunk cap.
    """
    monkeypatch.setattr(results_router, "MAX_UPLOAD_BYTES", 32)
    monkeypatch.setattr(results_router, "MULTIPART_OVERHEAD_BYTES", 16)
    writer = override_writer(_FakeWrites())

    # The metadata carries no provenance, so the parser and the gate would
    # answer 422 the moment they ran. The answer is 413, so neither ran: the
    # request never reached the multipart parser and never reached the disk.
    metadata = upload_metadata()
    metadata.pop("provenance")

    response = post_upload(client, metadata, payload=b"y" * 4096)

    assert response.status_code == 413, response.text
    assert response.json()["code"] == "file_too_large"
    assert writer.stored == {}
    assert stored_results(results_db) == 0


def test_the_early_check_allows_the_multipart_envelope(
    client, results_db, override_writer, monkeypatch
):
    """A file exactly on the cap still passes, boundaries and metadata included.

    The metadata part alone is bigger than the file here, so a check that read
    Content-Length as the file size would refuse a legal upload.
    """
    monkeypatch.setattr(results_router, "MAX_UPLOAD_BYTES", 32)
    override_writer(_FakeWrites())

    response = post_upload(client, upload_metadata(), payload=b"y" * 32)

    assert response.status_code == 201, response.text


# --- the version chain, and the demo (findings 25 and 31d must not move it) ----


def test_a_re_upload_of_the_same_bytes_answers_200_and_mints_no_version(
    client, results_db, override_writer
):
    """The live demo: Luis presses Upload twice on one file.

    The same bytes under the same (run_id, result_key) are a retry, never a
    change. The answer is 200 with the stored row, and no version 2 appears.
    The rule reads the bytes only, so the changed description below never
    makes a phantom version either.
    """
    writer = override_writer(_FakeWrites())

    first = post_upload(client, upload_metadata())
    second = post_upload(client, upload_metadata(description="Rerun on stage"))

    assert first.status_code == 201, first.text
    assert second.status_code == 200, second.text
    assert first.json()["version"] == 1
    assert second.json() == first.json()
    # One row and one blob. The replay stored nothing.
    assert stored_results(results_db) == 1
    assert len(writer.stored) == 1
    assert second.headers["X-Checksum-SHA256"] == hashlib.sha256(PAYLOAD).hexdigest()


def test_a_replay_writes_no_journal_entry_and_no_blob(
    client, results_db, override_writer
):
    """A replay writes nothing at all, so it names no audit entry.

    The route sends `X-Journal-Id` for a real write only. No entry exists for
    a replay, so a header naming one would name a line that is not there.
    """
    writer = override_writer(_FakeWrites())

    post_upload(client, upload_metadata())
    keys_after_first = set(writer.stored)
    entries_after_first = len(upload_events(results_db))

    replay = post_upload(client, upload_metadata())

    assert replay.status_code == 200, replay.text
    assert "X-Journal-Id" not in replay.headers
    assert len(upload_events(results_db)) == entries_after_first == 1
    assert set(writer.stored) == keys_after_first


def test_a_second_upload_of_changed_bytes_mints_version_2(
    client, results_db, override_writer
):
    """Changed bytes keep the chain exactly as it was.

    The chain keys on (run_id, result_key). The second upload never overwrites
    the first: it mints version 2 and names version 1 in `supersedes`, and both
    rows stay. Each upload takes its own blob key, so neither blob is lost.
    """
    writer = override_writer(_FakeWrites())

    first = post_upload(client, upload_metadata())
    second = post_upload(client, upload_metadata(), payload=PAYLOAD + b"3,45.1")

    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert first.json()["version"] == 1
    assert first.json()["supersedes"] is None
    assert second.json()["version"] == 2
    assert second.json()["supersedes"] == first.json()["result_id"]
    # Two uploads, two rows and two blobs. Nothing is overwritten.
    assert stored_results(results_db) == 2
    assert len(writer.stored) == 2
    assert results_db["processed_results"].find_one(
        {"_id": first.json()["result_id"]}
    ) is not None


def test_another_result_key_starts_its_own_chain(client, results_db, override_writer):
    """A second artefact of one run is version 1 of its own key, never version 2."""
    override_writer(_FakeWrites())

    post_upload(client, upload_metadata())
    other = post_upload(client, upload_metadata(result_key="cycle_counts"))

    assert other.status_code == 201, other.text
    assert other.json()["version"] == 1
    assert other.json()["supersedes"] is None


# --- the writer itself ---------------------------------------------------------
#
# These take no database and no HTTP call. They cover api/api/services/file_writes.py.


def test_the_key_puts_a_result_under_the_workspace_folder(monkeypatch):
    """SAG grants a deployment a write under the workspace folder only."""
    monkeypatch.setenv(file_writes.WORKSPACE_VARIABLE, "ws-42")

    key = file_writes.result_blob_key(RUN_ID, FILENAME)

    assert key.startswith(f"ws-42/{file_writes.RESULT_FOLDER}/{RUN_ID}/")
    assert key.endswith(FILENAME)


def test_the_key_stays_bare_outside_a_deployment(monkeypatch):
    monkeypatch.delenv(file_writes.WORKSPACE_VARIABLE, raising=False)

    key = file_writes.result_blob_key(RUN_ID, FILENAME)

    assert key.startswith(f"{file_writes.RESULT_FOLDER}/{RUN_ID}/")


@pytest.mark.parametrize(
    "filename",
    ["../../etc/passwd", "blob://other/thing.parquet", "a\\b\\c.csv", ""],
)
def test_a_filename_never_escapes_the_key(monkeypatch, filename):
    """A caller names the file. The name must never carry a path into the key."""
    monkeypatch.setenv(file_writes.WORKSPACE_VARIABLE, "ws-42")

    prefix = f"ws-42/{file_writes.RESULT_FOLDER}/{RUN_ID}/"
    key = file_writes.result_blob_key(RUN_ID, filename)

    assert key.startswith(prefix)
    # The object name is one segment. It carries no separator, so it reaches no
    # folder of its own and it leaves the run folder for nothing.
    object_name = key[len(prefix) :]
    assert "/" not in object_name
    assert "\\" not in object_name


def test_two_uploads_of_one_filename_take_two_keys():
    """A result never overwrites an earlier one, and neither does its blob."""
    first = file_writes.result_blob_key(RUN_ID, FILENAME)
    second = file_writes.result_blob_key(RUN_ID, FILENAME)

    assert first != second


def test_the_local_writer_stores_the_stream(tmp_path):
    writer = file_writes.LocalFileWrites(tmp_path)
    writer.check_ready()

    written = writer.write("a/b/thermal.csv", iter([b"one", b"two"]))

    assert written == 6
    assert (tmp_path / "a" / "b" / "thermal.csv").read_bytes() == b"onetwo"


def test_the_local_writer_refuses_an_absent_directory(tmp_path):
    writer = file_writes.LocalFileWrites(tmp_path / "not-there")

    with pytest.raises(FileBytesUnavailable):
        writer.check_ready()


def test_the_default_writer_refuses_when_no_source_is_named(monkeypatch):
    """The safe default. A fabricated storage_ref would point at no bytes."""
    monkeypatch.delenv("TM_INGEST_SOURCE", raising=False)

    writer = file_writes.build_default_writer()

    assert isinstance(writer, file_writes.UnavailableFileWrites)
    with pytest.raises(FileBytesUnavailable):
        writer.write("any/key", iter([b""]))


def test_the_default_writer_takes_the_local_directory(monkeypatch, tmp_path):
    monkeypatch.setenv("TM_INGEST_SOURCE", "local")
    monkeypatch.setenv("TM_LANDING_ZONE", str(tmp_path))

    writer = file_writes.build_default_writer()

    assert isinstance(writer, file_writes.LocalFileWrites)


def test_the_blob_writer_turns_a_store_fault_into_a_refusal():
    """fsspec raises many types for one fault. The route needs one."""

    class _AngryFilesystem:
        def open(self, key, mode):
            raise TimeoutError("the bucket did not answer")

    class _Store:
        _fs = _AngryFilesystem()

    writer = file_writes.BlobFileWrites(_Store())
    writer.check_ready()

    with pytest.raises(FileBytesUnavailable):
        writer.write("ws/results/x.csv", iter([b"data"]))
