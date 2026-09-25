# POST /files registers a file one time only (ticket B-02, appendix *).
# The checksum is the idempotency key. Replays return 200 and write nothing.

import logging
from datetime import UTC, datetime

from api.routers import files as files_router
from api.services import alerts
from tests import factories
from tests.factories import upsert_run

# The assignment re-exports the fixture without shadowing an import.
# files_db points the app at this test's database, with indexes applied.
files_db = factories.files_db

RUN_ID = "TAS-88214"
CHECKSUM_A = "9f" * 32
CHECKSUM_B = "3c" * 32

TIME_START = "2026-08-14T09:00:00Z"
TIME_END = "2026-08-14T10:00:00Z"
EARLY_START = "2026-08-14T08:30:00Z"
LATE_END = "2026-08-14T11:00:00Z"


def _body(**overrides) -> dict:
    # A valid POST /files body. Every test starts from this shape.
    body = {
        "filename": "bat_cyc_20260814_0941.mf4",
        "run_id": RUN_ID,
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 1331439861,
        "checksum_sha256": CHECKSUM_A,
        "checksum_state": "verified",
    }
    body.update(overrides)
    return body


def _signals(count: int) -> list[dict]:
    # Build a signal inventory with the given number of rows.
    return [
        {
            "name": f"Signal_{index:02d}",
            "unit": "°C",
            "rate_hz": 100.0,
            "dtype": "float64",
            "stats": {"min": 18.2, "max": 47.9, "mean": 33.4, "std": 6.21},
        }
        for index in range(count)
    ]


def _named_signals(names: list[str]) -> list[dict]:
    # Build a signal inventory from an explicit list of names.
    return [
        {
            "name": name,
            "unit": "°C",
            "rate_hz": 100.0,
            "dtype": "float64",
            "stats": {"min": 18.2, "max": 47.9, "mean": 33.4, "std": 6.21},
        }
        for name in names
    ]


def _run(db) -> dict:
    return db["test_runs"].find_one({"_id": RUN_ID})


def _at(value: str) -> datetime:
    # Parse a wire timestamp. The API writes ISO-8601 with a Z suffix.
    return datetime.fromisoformat(value)


def _create_run(client) -> None:
    # Register the run through the real route, with no time range.
    # first_data_at then falls back to the registration time.
    response = client.post(
        "/api/v1/test-runs",
        json={
            "run_id": RUN_ID,
            "rig_id": "RIG-04",
            "source": "embedded",
            "actor": "ingestion",
        },
    )
    assert response.status_code == 201


def _list_row(client) -> dict:
    response = client.get("/api/v1/test-runs")
    assert response.status_code == 200
    rows = [row for row in response.json()["items"] if row["run_id"] == RUN_ID]
    assert len(rows) == 1
    return rows[0]


def _detail(client) -> dict:
    response = client.get(f"/api/v1/test-runs/{RUN_ID}")
    assert response.status_code == 200
    return response.json()


def _journal_count(db, file_id: str) -> int:
    return db["journal_entries"].count_documents({"entity_type": "file", "entity_id": file_id})


def test_replay_same_checksum_returns_200_with_existing_body(client, files_db):
    upsert_run(files_db)
    body = _body()

    first = client.post("/api/v1/files", json=body)
    assert first.status_code == 201

    second = client.post("/api/v1/files", json=body)

    assert second.status_code == 200
    file_id = first.json()["file_id"]
    assert second.json()["file_id"] == file_id
    assert files_db["files"].count_documents({}) == 1
    assert _journal_count(files_db, file_id) == 1


def test_duplicate_insert_race_returns_200_not_500(client, files_db, monkeypatch):
    upsert_run(files_db)
    body = _body()

    first = client.post("/api/v1/files", json=body)
    assert first.status_code == 201

    # Hide the duplicate from the route. The unique partial index must catch it.
    monkeypatch.setattr(
        files_router, "_existing_registered", lambda db, checksum, run_id: None
    )
    second = client.post("/api/v1/files", json=body)

    assert second.status_code == 200
    assert second.json()["file_id"] == first.json()["file_id"]
    assert files_db["files"].count_documents({}) == 1


def test_same_filename_different_checksum_creates_new_document(client, files_db):
    upsert_run(files_db)

    first = client.post("/api/v1/files", json=_body(checksum_sha256=CHECKSUM_A))
    second = client.post("/api/v1/files", json=_body(checksum_sha256=CHECKSUM_B))

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["file_id"] != second.json()["file_id"]
    assert files_db["files"].count_documents({}) == 2
    assert files_db["files"].count_documents({"checksum_sha256": CHECKSUM_A}) == 1
    assert files_db["files"].count_documents({"checksum_sha256": CHECKSUM_B}) == 1


def test_quarantined_files_are_not_deduplicated(client, files_db):
    # The never-drop rule beats dedup. Two mismatches keep two documents.
    # This body names no storage_ref, so it names no object. The quarantined
    # replay guard needs one, and it mints without one.
    upsert_run(files_db)
    body = _body(checksum_state="mismatch")

    first = client.post("/api/v1/files", json=body)
    second = client.post("/api/v1/files", json=body)

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["file_id"] != second.json()["file_id"]
    assert files_db["files"].count_documents({"status": "quarantined"}) == 2


def test_registration_updates_run_rollups(client, files_db):
    upsert_run(files_db, file_count=0, signal_count=0, started_at=None, ended_at=None)

    response = client.post(
        "/api/v1/files",
        json=_body(time_start=TIME_START, time_end=TIME_END, signals=_signals(3)),
    )

    assert response.status_code == 201
    run = _run(files_db)
    assert run["file_count"] == 1
    assert run["signal_count"] == 3
    assert run["started_at"] == datetime(2026, 8, 14, 9, 0, tzinfo=UTC)
    assert run["ended_at"] == datetime(2026, 8, 14, 10, 0, tzinfo=UTC)


def test_second_file_extends_the_run_time_range(client, files_db):
    upsert_run(files_db, file_count=0, signal_count=0, started_at=None, ended_at=None)

    first = client.post(
        "/api/v1/files",
        json=_body(time_start=TIME_START, time_end=TIME_END, signals=_signals(3)),
    )
    assert first.status_code == 201

    second = client.post(
        "/api/v1/files",
        json=_body(
            checksum_sha256=CHECKSUM_B,
            time_start=EARLY_START,
            time_end=LATE_END,
        ),
    )

    assert second.status_code == 201
    run = _run(files_db)
    assert run["file_count"] == 2
    assert run["started_at"] == datetime(2026, 8, 14, 8, 30, tzinfo=UTC)
    assert run["ended_at"] == datetime(2026, 8, 14, 11, 0, tzinfo=UTC)


def test_replay_does_not_touch_rollups(client, files_db):
    upsert_run(files_db, file_count=0, signal_count=0, started_at=None, ended_at=None)
    body = _body(time_start=TIME_START, time_end=TIME_END, signals=_signals(3))

    first = client.post("/api/v1/files", json=body)
    assert first.status_code == 201
    before = _run(files_db)

    replay = client.post("/api/v1/files", json=body)

    assert replay.status_code == 200
    after = _run(files_db)
    assert after["file_count"] == 1
    assert after["signal_count"] == before["signal_count"]
    assert after["started_at"] == before["started_at"]
    assert after["ended_at"] == before["ended_at"]


def test_a_replay_with_different_metadata_returns_the_stored_body(client, files_db):
    # (run, checksum) is the idempotency key (24 Aug 2026). A same-run replay
    # that carries new metadata still returns the stored body and writes
    # nothing: metadata is not part of the identity. The same bytes declared
    # for a DIFFERENT run register fresh — pinned in
    # test_per_run_checksum_identity.py.
    upsert_run(files_db, file_count=0, signal_count=0)

    first = client.post(
        "/api/v1/files",
        json=_body(time_start=TIME_START, time_end=TIME_END, signals=_named_signals(["S1"])),
    )
    assert first.status_code == 201
    stored = first.json()

    replay = client.post(
        "/api/v1/files",
        json=_body(
            filename="renamed_by_the_operator.mf4",
            size_bytes=7,
            time_start=EARLY_START,
            time_end=LATE_END,
            signals=_named_signals(["S9"]),
        ),
    )

    assert replay.status_code == 200
    assert replay.json() == stored
    assert files_db["files"].count_documents({}) == 1
    assert _journal_count(files_db, stored["file_id"]) == 1
    assert files_db["file_signals"].count_documents({"name": "S9"}) == 0


def test_a_file_inside_the_window_never_shrinks_the_run_range(client, files_db):
    # The rollup only grows the run window. A short second file must not
    # move started_at forward or ended_at back.
    _create_run(client)

    first = client.post(
        "/api/v1/files",
        json=_body(time_start=TIME_START, time_end=TIME_END, signals=_named_signals(["S1"])),
    )
    assert first.status_code == 201

    inside = client.post(
        "/api/v1/files",
        json=_body(
            checksum_sha256=CHECKSUM_B,
            time_start="2026-08-14T09:15:00Z",
            time_end="2026-08-14T09:45:00Z",
            signals=_named_signals(["S2"]),
        ),
    )
    assert inside.status_code == 201

    detail = _detail(client)
    assert _at(detail["started_at"]) == _at(TIME_START)
    assert _at(detail["ended_at"]) == _at(TIME_END)


def test_run_list_and_detail_report_the_registered_file(client, files_db):
    # The two read routes must agree with the file the ingestion path wrote.
    _create_run(client)
    signals = _signals(3)

    registered = client.post(
        "/api/v1/files",
        json=_body(time_start=TIME_START, time_end=TIME_END, signals=signals),
    )
    assert registered.status_code == 201

    row = _list_row(client)
    assert row["file_count"] == 1
    assert row["signal_count"] == len(signals)

    detail = _detail(client)
    assert detail["file_count"] == 1
    assert detail["signal_count"] == len(signals)
    assert _at(detail["started_at"]) == _at(TIME_START)
    assert _at(detail["ended_at"]) == _at(TIME_END)

    # The list column and the sort key must never precede the run's own start.
    assert _at(row["first_data_at"]) <= _at(detail["started_at"])


def test_first_data_at_never_trails_the_run_start_after_a_file_lands(client, files_db):
    # `first_data_at` is the only time field the runs list carries, and the key
    # the list sorts on. A rollup that lowers `started_at` and leaves
    # `first_data_at` behind orders the list on a value the detail contradicts.
    # `_create_run` registers no time range, so `first_data_at` starts at the
    # registry clock. The file then carries an earlier start.
    _create_run(client)

    registered = client.post(
        "/api/v1/files",
        json=_body(time_start=TIME_START, time_end=TIME_END, signals=_signals(2)),
    )
    assert registered.status_code == 201

    detail = _detail(client)
    row = _list_row(client)
    assert _at(detail["started_at"]) == _at(TIME_START)
    # Equal, not merely earlier. The registry clock is later than TIME_START,
    # so a rollup that skips the field fails this line.
    assert _at(row["first_data_at"]) == _at(TIME_START)


def test_file_count_matches_the_run_file_list(client, files_db):
    # `file_count` must equal the rows contract #6 lists. That list carries
    # every file of the run, the quarantined one included, so a rollup that
    # counts registrations alone contradicts the run's own Files tab.
    _create_run(client)

    quarantined = client.post(
        "/api/v1/files",
        json=_body(checksum_sha256=CHECKSUM_B, checksum_state="mismatch"),
    )
    assert quarantined.status_code == 201
    assert quarantined.json()["status"] == "quarantined"

    registered = client.post(
        "/api/v1/files",
        json=_body(time_start=TIME_START, time_end=TIME_END, signals=_signals(2)),
    )
    assert registered.status_code == 201

    listed = client.get(f"/api/v1/test-runs/{RUN_ID}/files")
    assert listed.status_code == 200
    assert listed.json()["total"] == 2
    assert _detail(client)["file_count"] == 2


def test_two_files_extend_the_run_range_on_the_detail(client, files_db):
    # The rollup grows the window. It never replaces it.
    _create_run(client)
    first_names = ["S1", "S2", "S3"]
    second_names = ["S4", "S5"]
    expected_signals = len(set(first_names) | set(second_names))

    first = client.post(
        "/api/v1/files",
        json=_body(
            time_start=TIME_START,
            time_end=TIME_END,
            signals=_named_signals(first_names),
        ),
    )
    assert first.status_code == 201

    second = client.post(
        "/api/v1/files",
        json=_body(
            checksum_sha256=CHECKSUM_B,
            time_start=EARLY_START,
            time_end=LATE_END,
            signals=_named_signals(second_names),
        ),
    )
    assert second.status_code == 201

    detail = _detail(client)
    assert detail["file_count"] == 2
    assert detail["signal_count"] == expected_signals
    assert _at(detail["started_at"]) == _at(EARLY_START)
    assert _at(detail["ended_at"]) == _at(LATE_END)

    row = _list_row(client)
    assert _at(row["first_data_at"]) <= _at(detail["started_at"])


def test_signal_count_counts_distinct_names_across_files(client, files_db):
    # BE-PLAN: signal_count holds the distinct signals across linked files.
    # Two files that share a name must not count that name two times.
    _create_run(client)
    first_names = ["S1", "S2", "S3"]
    second_names = ["S2", "S3", "S4"]
    expected = len(set(first_names) | set(second_names))

    first = client.post(
        "/api/v1/files",
        json=_body(
            time_start=TIME_START,
            time_end=TIME_END,
            signals=_named_signals(first_names),
        ),
    )
    assert first.status_code == 201

    second = client.post(
        "/api/v1/files",
        json=_body(
            checksum_sha256=CHECKSUM_B,
            time_start=TIME_START,
            time_end=TIME_END,
            signals=_named_signals(second_names),
        ),
    )
    assert second.status_code == 201

    assert _detail(client)["signal_count"] == expected
    assert _list_row(client)["signal_count"] == expected


# --- the quarantined replay (LOCAL-INGEST-LOOP finding 2) ---------------------------
#
# The replay guard used to match `status: "registered"` only. A quarantined
# file matched nothing, so every ingester restart minted it again. The local
# loop measured 512 quarantined mints on 19 Aug 2026.
#
# The identity of a quarantined file is its `storage_ref`, not its checksum.
# The ingestion pipeline registers an object it could not read with an EMPTY
# checksum, so a checksum key would fold every unreadable object into one
# document. The never-drop rule forbids that.

KEY_A = "test-manager/landing/RIG-04/2026/08/19/bat_cyc_TAS-88214_0941.mf4"
KEY_B = "test-manager/landing/RIG-04/2026/08/19/bat_cyc_TAS-88214_1042.mf4"
UNREADABLE = "unreadable object"


def _unreadable_body(key: str, **overrides) -> dict:
    # What the pipeline posts for an object whose bytes it could not read.
    # The checksum is empty, and that is the whole difficulty.
    return _body(
        filename=key.rsplit("/", 1)[-1],
        checksum_sha256="",
        checksum_state="unverified",
        quarantine_reason=UNREADABLE,
        storage_ref=key,
        **overrides,
    )


def test_a_quarantined_replay_of_the_same_object_mints_no_second_document(client, files_db):
    # A pipeline restart replays the whole prefix. The same object must resolve
    # to the same document, even with no checksum to key on.
    upsert_run(files_db)
    body = _unreadable_body(KEY_A)

    first = client.post("/api/v1/files", json=body)
    second = client.post("/api/v1/files", json=body)

    assert first.status_code == 201
    assert second.status_code == 200
    file_id = first.json()["file_id"]
    assert second.json()["file_id"] == file_id
    assert files_db["files"].count_documents({}) == 1
    assert _journal_count(files_db, file_id) == 1


def test_a_replayed_quarantine_marker_raises_no_second_alert(client, files_db, caplog):
    """BL-79 (`dev-planning/decode-without-a-database/spec.md` story 4): a
    reset decoder replays the marker for a file that has never decoded, and
    the registry must answer it as the replay it is — one document, one
    journal entry, and no second `QUARANTINE ALERT` line, because the alert
    fires only on the branch that inserts a new document
    (`api/api/routers/files.py:1361-1366`), which a replay never reaches."""
    upsert_run(files_db)
    body = _unreadable_body(KEY_A)

    with caplog.at_level(logging.WARNING, logger=alerts.logger.name):
        first = client.post("/api/v1/files", json=body)
        second = client.post("/api/v1/files", json=body)

    assert first.status_code == 201
    assert second.status_code == 200
    file_id = first.json()["file_id"]
    assert second.json()["file_id"] == file_id
    assert files_db["files"].count_documents({}) == 1
    assert _journal_count(files_db, file_id) == 1

    alert_lines = [
        record
        for record in caplog.records
        if record.levelno == logging.WARNING and record.getMessage().startswith(alerts.ALERT_PREFIX)
    ]
    assert len(alert_lines) == 1


def test_two_unreadable_objects_keep_two_documents(client, files_db):
    # The never-drop half. Two different objects both carry an empty checksum.
    # They are two files, so the registry holds two documents.
    upsert_run(files_db)

    first = client.post("/api/v1/files", json=_unreadable_body(KEY_A))
    second = client.post("/api/v1/files", json=_unreadable_body(KEY_B))

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["file_id"] != second.json()["file_id"]
    assert files_db["files"].count_documents({"status": "quarantined"}) == 2
    assert files_db["files"].count_documents({"storage_ref": KEY_A}) == 1
    assert files_db["files"].count_documents({"storage_ref": KEY_B}) == 1


def test_a_re_upload_under_the_same_key_mints_a_second_document(client, files_db):
    # The same key, new bytes. The first document claimed checksum A, so the
    # new bytes never hide behind that claim.
    upsert_run(files_db)

    first = client.post(
        "/api/v1/files",
        json=_body(checksum_state="mismatch", checksum_sha256=CHECKSUM_A, storage_ref=KEY_A),
    )
    second = client.post(
        "/api/v1/files",
        json=_body(checksum_state="mismatch", checksum_sha256=CHECKSUM_B, storage_ref=KEY_A),
    )

    assert first.status_code == 201
    assert second.status_code == 201
    assert files_db["files"].count_documents({"status": "quarantined"}) == 2


def test_a_registered_replay_still_answers_200_across_two_keys(client, files_db):
    # The registered path did not change. The checksum still wins, so the same
    # bytes under a second key stay one document.
    upsert_run(files_db)

    first = client.post("/api/v1/files", json=_body(storage_ref=KEY_A))
    second = client.post("/api/v1/files", json=_body(storage_ref=KEY_B))

    assert first.status_code == 201
    assert second.status_code == 200
    assert second.json()["file_id"] == first.json()["file_id"]
    assert files_db["files"].count_documents({}) == 1


def test_a_quarantined_file_that_reads_cleanly_resolves_to_one_document(client, files_db):
    # The pipeline never records an unreadable object in its `done` set, so the
    # next poll reads the object again. The clean read carries a real checksum
    # and the same key, and it must resolve to the one document.
    #
    # The document keeps its quarantine. A replay writes nothing, so it never
    # promotes a file to `registered`. The contract states this limit.
    upsert_run(files_db)

    first = client.post("/api/v1/files", json=_unreadable_body(KEY_A))
    assert first.status_code == 201

    second = client.post("/api/v1/files", json=_body(storage_ref=KEY_A))

    assert second.status_code == 200
    assert second.json()["file_id"] == first.json()["file_id"]
    assert files_db["files"].count_documents({}) == 1
    stored = files_db["files"].find_one({"storage_ref": KEY_A})
    assert stored["status"] == "quarantined"
    assert stored["quarantine_reason"] == UNREADABLE


# --- a blank checksum on the REGISTERED path (21 Aug 2026) ---
#
# The quarantined path learned this lesson already, and the registered path
# did not. A blank checksum makes no claim about the bytes, so it identifies
# nothing. The lookup folded the second file into the first: 201, then 200
# with the first file's id, and one document in Mongo. That is the silent loss
# the never-drop rule forbids.


def test_two_registered_files_with_a_blank_checksum_keep_two_documents(client, files_db):
    # The pipeline sends an empty checksum when it has no digest. Two files
    # with no digest are still two files.
    upsert_run(files_db)

    first = client.post(
        "/api/v1/files",
        json=_body(filename="blank_one.mf4", checksum_sha256="", checksum_state="unverified"),
    )
    second = client.post(
        "/api/v1/files",
        json=_body(filename="blank_two.mf4", checksum_sha256="", checksum_state="unverified"),
    )

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["file_id"] != second.json()["file_id"]
    assert files_db["files"].count_documents({}) == 2
    assert files_db["files"].count_documents({"status": "registered"}) == 2


def test_a_real_checksum_still_folds_a_replay_beside_blank_ones(client, files_db):
    # The blank fix must not cost the normal case. A real checksum still keys
    # the registered file, so its replay answers 200 and writes nothing.
    upsert_run(files_db)

    client.post(
        "/api/v1/files",
        json=_body(filename="blank_one.mf4", checksum_sha256="", checksum_state="unverified"),
    )
    first = client.post("/api/v1/files", json=_body(filename="real.mf4"))
    replay = client.post("/api/v1/files", json=_body(filename="real_again.mf4"))

    assert first.status_code == 201
    assert replay.status_code == 200
    assert replay.json()["file_id"] == first.json()["file_id"]
    assert files_db["files"].count_documents({}) == 2


# --- a replay filling the inventory the first registration lacked (25 Sep 2026) ---
#
# The DBC was absent from DCM when the pipeline first registered these traces,
# so the decode carried no channel and the file registered with an empty
# inventory. The DBC came back and the pipeline re-decoded and replayed the
# same (run, checksum); the replay guard used to discard that second,
# non-empty inventory outright.


def test_a_replay_fills_an_inventory_the_first_registration_lacked(client, files_db):
    upsert_run(files_db, file_count=0, signal_count=0)

    first = client.post("/api/v1/files", json=_body(signals=[]))
    assert first.status_code == 201
    assert first.json()["signal_count"] == 0
    file_id = first.json()["file_id"]

    replay = client.post("/api/v1/files", json=_body(signals=_named_signals(["S1", "S2", "S3"])))

    assert replay.status_code == 200
    assert replay.json()["file_id"] == file_id
    assert files_db["file_signals"].count_documents({"file_id": file_id}) == 3
    stored_file = files_db["files"].find_one({"_id": file_id})
    assert stored_file["signal_count"] == 3
    run = _run(files_db)
    assert run["signal_count"] == 3
    assert files_db["files"].count_documents({}) == 1
    assert _journal_count(files_db, file_id) == 1


def test_a_replay_with_the_same_inventory_writes_nothing_a_second_time(client, files_db):
    # The property the fill must not break: a true duplicate delivery still
    # writes nothing and returns the stored body unchanged.
    upsert_run(files_db, file_count=0, signal_count=0)
    body = _body(signals=_named_signals(["S1", "S2"]))

    first = client.post("/api/v1/files", json=body)
    assert first.status_code == 201
    stored = first.json()
    signals_before = list(files_db["file_signals"].find({"file_id": stored["file_id"]}))

    replay = client.post("/api/v1/files", json=body)

    assert replay.status_code == 200
    assert replay.json() == stored
    signals_after = list(files_db["file_signals"].find({"file_id": stored["file_id"]}))
    assert signals_after == signals_before
    run = _run(files_db)
    assert run["signal_count"] == 2
    assert files_db["files"].count_documents({}) == 1


def test_a_replay_with_a_conflicting_inventory_keeps_the_stored_one(client, files_db):
    # A file already holding an inventory that disagrees with a replay's is a
    # conflict, not a hole. The stored rows must survive untouched.
    upsert_run(files_db, file_count=0, signal_count=0)

    first = client.post(
        "/api/v1/files", json=_body(signals=_named_signals(["S1", "S2", "S3"]))
    )
    assert first.status_code == 201
    file_id = first.json()["file_id"]

    replay = client.post(
        "/api/v1/files",
        json=_body(signals=_named_signals(["S4", "S5", "S6", "S7", "S8"])),
    )

    assert replay.status_code == 200
    assert files_db["file_signals"].count_documents({"file_id": file_id}) == 3
    assert files_db["file_signals"].count_documents({"file_id": file_id, "name": "S4"}) == 0
    stored_file = files_db["files"].find_one({"_id": file_id})
    assert stored_file["signal_count"] == 3
    run = _run(files_db)
    assert run["signal_count"] == 3


def test_ensure_indexes_rebuilds_the_old_checksum_index(files_db):
    # A database seeded before 24 Aug 2026 carries the global one-per-checksum
    # index. `ensure_indexes` builds the compound (run, checksum) key and
    # drops the old one — which would otherwise keep refusing the per-run
    # duplicates the new model allows.
    from pymongo import ASCENDING

    from api.db import ensure_indexes

    files = files_db["files"]
    if "checksum_sha256_1" not in files.index_information():
        files.create_index(
            [("checksum_sha256", ASCENDING)],
            unique=True,
            partialFilterExpression={"status": "registered"},
        )

    ensure_indexes(files_db)

    info = files.index_information()
    assert "checksum_sha256_1" not in info
    spec = info["run_id_1_checksum_sha256_1"]
    assert spec["partialFilterExpression"] == {
        "status": "registered",
        "checksum_sha256": {"$gt": ""},
    }
    assert spec.get("unique") is True
