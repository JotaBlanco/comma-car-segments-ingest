"""The server stamps `received_at` beside the caller's `at` (contract §A, §D).

`POST /journal` keeps the caller's `at`, so a caller can date an entry 2020.
`received_at` is the server clock, so a reader sees the date that lies. `at`
stays the sort key, and the file timeline still reads forwards.
"""

import uuid
from datetime import UTC, datetime, timedelta

from api.db import ensure_indexes
from tests.factories import register_file, upsert_run

FILES = "/api/v1/files"
JOURNAL = "/api/v1/journal"
RUN_JOURNAL = "/api/v1/test-runs/TAS-88214/journal"

ACTOR = "file-watcher"
NOTE = "New file observed in blob storage for RIG-04."

# The moment the watcher saw the file. It is older than every call below.
EVENT_AT = datetime(2026, 8, 14, 9, 41, 12, tzinfo=UTC)

# A caller states a date six years in the past. Nothing else contradicts it.
LYING_AT = datetime(2020, 1, 1, 0, 0, 0, tzinfo=UTC)


def _iso(value: datetime) -> str:
    """Render one timestamp the way the contract writes it."""
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _body(**overrides) -> dict:
    body = {
        "entity_type": "file",
        "entity_id": "f-unknown",
        "field": "file.detected",
        "kind": "event",
        "note": NOTE,
        "source": "embedded",
        "actor": ACTOR,
        "at": _iso(EVENT_AT),
    }
    body.update(overrides)
    return body


def _register_body(**overrides) -> dict:
    """A POST /files body that registers against the seeded run."""
    body = {
        "filename": "bat_cyc_20260814_0941.mf4",
        "run_id": "TAS-88214",
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 2048,
        "checksum_sha256": "d" * 64,
        "checksum_state": "verified",
        "storage_ref": "blob://quixlake-prod/rig-04/bat_cyc_20260814_0941.mf4",
    }
    body.update(overrides)
    return body


def test_an_entry_carries_both_stamps(client, routed_db) -> None:
    """The response and the stored document both hold `at` and `received_at`."""
    file = register_file(routed_db)
    before = datetime.now(UTC)

    response = client.post(JOURNAL, json=_body(entity_id=file["_id"]))

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["at"] == _iso(EVENT_AT)
    assert body["received_at"] is not None
    assert body["received_at"].endswith("Z")

    stored = routed_db["journal_entries"].find_one({"_id": body["id"]})
    assert stored["at"] == EVENT_AT
    assert before <= stored["received_at"] <= datetime.now(UTC)


def test_a_caller_at_in_the_past_keeps_its_at_and_gets_a_truthful_received_at(
    client, routed_db
) -> None:
    """The cost the security review named. The lie shows against the clock."""
    file = register_file(routed_db)
    before = datetime.now(UTC)

    response = client.post(JOURNAL, json=_body(entity_id=file["_id"], at=_iso(LYING_AT)))

    assert response.status_code == 201, response.text
    body = response.json()
    # The server never replaces the caller's statement.
    assert body["at"] == _iso(LYING_AT)

    stored = routed_db["journal_entries"].find_one({"_id": body["id"]})
    assert stored["at"] == LYING_AT
    # The server clock contradicts it, so a reader sees the gap.
    assert stored["received_at"] >= before
    assert stored["received_at"] - stored["at"] > timedelta(days=365 * 5)


def test_a_body_that_sends_received_at_returns_422(client, routed_db) -> None:
    """The server owns the second stamp. A caller never sets it."""
    file = register_file(routed_db)

    response = client.post(
        JOURNAL,
        json=_body(entity_id=file["_id"], received_at=_iso(EVENT_AT)),
    )

    assert response.status_code == 422, response.text
    assert "received_at" in response.text


def test_the_timeline_still_sorts_by_at(client, routed_db) -> None:
    """The ordering rule. `received_at` runs the other way and never sorts."""
    ensure_indexes(routed_db)
    upsert_run(routed_db)
    registered = client.post(FILES, json=_register_body())
    assert registered.status_code == 201, registered.text
    file_id = registered.json()["file_id"]

    steps = {
        "file.detected": EVENT_AT,
        "file.checksum_verified": EVENT_AT + timedelta(seconds=5),
        "file.header_parsed": EVENT_AT + timedelta(seconds=9),
        "file.samples_written": EVENT_AT + timedelta(seconds=21),
    }
    # The server registers the file first, so `received_at` orders the four
    # events after `file.registered`. Only `at` puts the story straight.
    scrambled = [
        "file.header_parsed",
        "file.samples_written",
        "file.detected",
        "file.checksum_verified",
    ]
    for field in scrambled:
        response = client.post(
            JOURNAL,
            json=_body(entity_id=file_id, field=field, at=_iso(steps[field])),
        )
        assert response.status_code == 201, response.text

    detail = client.get(f"{FILES}/{file_id}")

    assert detail.status_code == 200, detail.text
    timeline = detail.json()["ingestion_timeline"]
    assert [entry["field"] for entry in timeline] == [
        "file.detected",
        "file.checksum_verified",
        "file.header_parsed",
        "file.samples_written",
        "file.registered",
    ]
    # `file.registered` landed first and every other entry carries an older
    # `at`. A sort on `received_at` therefore reverses the story.
    assert timeline[-1]["field"] == "file.registered"
    assert timeline[-1]["received_at"] < timeline[0]["received_at"]


def test_an_old_row_with_no_received_at_still_reads(client, routed_db) -> None:
    """A seeded row predates the second stamp. It reads null, not a guess."""
    upsert_run(routed_db)
    old_row = {
        "_id": f"j-{uuid.uuid4()}",
        "entity_type": "run",
        "entity_id": "TAS-88214",
        "field": "run.work_order",
        "kind": "change",
        "old": "(empty)",
        "new": "WO-2026-0851",
        "source": "api:planning",
        "actor": "planning-sync",
        "note": None,
        "context_run_id": None,
        "at": EVENT_AT,
    }
    routed_db["journal_entries"].insert_one(old_row)

    response = client.get(RUN_JOURNAL)

    assert response.status_code == 200, response.text
    rows = {row["id"]: row for row in response.json()["items"]}
    assert old_row["_id"] in rows
    entry = rows[old_row["_id"]]
    assert entry["received_at"] is None
    assert entry["at"] == _iso(EVENT_AT)


def test_an_old_file_row_reads_in_the_ingestion_timeline(client, routed_db) -> None:
    """The same rule on the file detail read, which inlines the entries."""
    file = register_file(routed_db)
    old_row = {
        "_id": f"j-{uuid.uuid4()}",
        "entity_type": "file",
        "entity_id": file["_id"],
        "field": "file.registered",
        "kind": "event",
        "old": None,
        "new": None,
        "source": "embedded",
        "actor": "ingestion",
        "note": "Linked to run TAS-88214.",
        "context_run_id": None,
        "at": EVENT_AT,
    }
    routed_db["journal_entries"].insert_one(old_row)

    response = client.get(f"{FILES}/{file['_id']}")

    assert response.status_code == 200, response.text
    timeline = response.json()["ingestion_timeline"]
    assert [entry["field"] for entry in timeline] == ["file.registered"]
    assert timeline[0]["received_at"] is None
