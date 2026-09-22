"""B-13 — POST /journal takes one journal event (contract §D, 18 Aug 2026).

The ingestion watcher narrates the file ingestion through this route. Each test
below holds one rule of that box. The ordering rule has its own test, because
a server-stamped `at` makes the timeline read backwards.
"""

from datetime import UTC, datetime, timedelta

import pytest

from api.db import ensure_indexes
from tests.factories import register_file, upsert_run

FILES = "/api/v1/files"
JOURNAL = "/api/v1/journal"

ACTOR = "file-watcher"
NOTE = "New file observed in blob storage for RIG-04."

# Well in the past. The watcher observed the file before it called the API.
EVENT_AT = datetime(2026, 8, 14, 9, 41, 12, tzinfo=UTC)


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
        "checksum_sha256": "c" * 64,
        "checksum_state": "verified",
        "storage_ref": "blob://quixlake-prod/rig-04/bat_cyc_20260814_0941.mf4",
    }
    body.update(overrides)
    return body


def test_a_good_event_answers_201_in_the_canonical_shape(client, routed_db) -> None:
    file = register_file(routed_db)

    response = client.post(JOURNAL, json=_body(entity_id=file["_id"]))

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["id"].startswith("j-")
    assert body["kind"] == "event"
    assert body["old"] is None
    assert body["new"] is None
    assert body["entity_type"] == "file"
    assert body["entity_id"] == file["_id"]
    assert body["field"] == "file.detected"
    assert body["source"] == "embedded"
    assert body["actor"] == ACTOR
    assert body["note"] == NOTE

    stored = routed_db["journal_entries"].find_one({"_id": body["id"]})
    assert stored["actor"] == ACTOR
    assert stored["note"] == NOTE


def test_the_server_keeps_the_at_the_caller_sent(client, routed_db) -> None:
    """The ordering rule. The clock stamp must never replace the sent value."""
    file = register_file(routed_db)

    response = client.post(JOURNAL, json=_body(entity_id=file["_id"]))

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["at"] == _iso(EVENT_AT)
    stored = routed_db["journal_entries"].find_one({"_id": body["id"]})
    assert stored["at"] == EVENT_AT


def test_the_timeline_reads_in_ingestion_order(client, routed_db) -> None:
    """The acceptance test of B-13 box 2.

    The server writes `file.registered` at the insert, so it carries the newest
    stamp. The four watcher events carry older stamps and sort in front of it.
    A server-stamped `at` fails this test.
    """
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


def test_an_unknown_file_returns_404_file_not_found(client, routed_db) -> None:
    response = client.post(JOURNAL, json=_body(entity_id="f-does-not-exist"))

    assert response.status_code == 404
    assert response.json()["code"] == "file_not_found"
    assert routed_db["journal_entries"].count_documents({}) == 0


def test_an_unknown_run_returns_404_run_not_found(client, routed_db) -> None:
    response = client.post(
        JOURNAL, json=_body(entity_type="run", entity_id="TAS-99999", field="run.linked")
    )

    assert response.status_code == 404
    assert response.json()["code"] == "run_not_found"
    assert routed_db["journal_entries"].count_documents({}) == 0


def test_an_unknown_key_returns_422_naming_the_field(client, routed_db) -> None:
    file = register_file(routed_db)

    response = client.post(
        JOURNAL, json=_body(entity_id=file["_id"], context_run_id="TAS-88214")
    )

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert "context_run_id" in body["detail"]


def test_a_kind_other_than_event_returns_422(client, routed_db) -> None:
    """A note has its own route. A change comes from a field write."""
    file = register_file(routed_db)

    for kind in ("note", "change"):
        response = client.post(JOURNAL, json=_body(entity_id=file["_id"], kind=kind))

        assert response.status_code == 422, kind
        assert "kind" in response.json()["detail"]


def test_a_blank_field_returns_422(client, routed_db) -> None:
    file = register_file(routed_db)

    response = client.post(JOURNAL, json=_body(entity_id=file["_id"], field=""))

    assert response.status_code == 422
    assert "field" in response.json()["detail"]


def test_a_missing_at_returns_422(client, routed_db) -> None:
    file = register_file(routed_db)
    body = _body(entity_id=file["_id"])
    body.pop("at")

    response = client.post(JOURNAL, json=body)

    assert response.status_code == 422
    assert "at" in response.json()["detail"]


def test_an_actor_that_names_nobody_returns_422(client, routed_db) -> None:
    file = register_file(routed_db)

    response = client.post(
        JOURNAL, json=_body(entity_id=file["_id"], actor="current-user")
    )

    assert response.status_code == 422
    assert "actor" in response.json()["detail"]


def test_no_bearer_token_returns_401(bare_client, routed_db) -> None:
    file = register_file(routed_db)

    response = bare_client.post(JOURNAL, json=_body(entity_id=file["_id"]))

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"
    assert routed_db["journal_entries"].count_documents({}) == 0


# --- Every entity type takes the existence check (21 Aug 2026) ------------------
#
# A file and a run were the only two checked. A signal, a work order and a
# result went through unchecked, so an entry could name an entity that never
# existed. A journal entry is append-only, so nobody could remove it.


def _exists(routed_db, collection: str, entity_id: str) -> None:
    """Put the smallest document the existence check reads."""
    routed_db[collection].insert_one({"_id": entity_id})


@pytest.mark.parametrize(
    ("entity_type", "code"),
    [
        ("signal", "signal_not_found"),
        ("work_order", "wo_not_found"),
        ("result", "result_not_found"),
        ("test_definition", "td_not_found"),
    ],
)
def test_an_event_on_an_unknown_entity_returns_404(
    client, routed_db, entity_type, code
) -> None:
    response = client.post(
        JOURNAL,
        json=_body(entity_type=entity_type, entity_id="does-not-exist", field="x.observed"),
    )

    assert response.status_code == 404, response.text
    assert response.json()["code"] == code
    assert routed_db["journal_entries"].count_documents({}) == 0


@pytest.mark.parametrize(
    ("entity_type", "collection"),
    [
        ("signal", "signals"),
        ("work_order", "work_orders"),
        ("result", "processed_results"),
        ("test_definition", "test_definitions"),
    ],
)
def test_an_event_on_a_known_entity_answers_201(
    client, routed_db, entity_type, collection
) -> None:
    _exists(routed_db, collection, "e-1")

    response = client.post(
        JOURNAL,
        json=_body(entity_type=entity_type, entity_id="e-1", field="x.observed"),
    )

    assert response.status_code == 201, response.text
    assert response.json()["entity_type"] == entity_type


def test_test_definition_is_a_legal_entity_type(client, routed_db) -> None:
    """It was not, so the mirror had no legal type to journal against."""
    _exists(routed_db, "test_definitions", "TD-BAT-114")

    response = client.post(
        JOURNAL,
        json=_body(
            entity_type="test_definition",
            entity_id="TD-BAT-114",
            field="test_definition.mirrored",
        ),
    )

    assert response.status_code == 201, response.text
    assert response.json()["entity_id"] == "TD-BAT-114"


def test_an_export_entity_type_answers_422(client, routed_db) -> None:
    """`export` is a journal entity, and no caller may name it in a body.

    The export routes write their own row. The check table holds no export
    row, so the check used to raise `KeyError` and answer 500.
    """
    response = client.post(JOURNAL, json=_body(entity_type="export", entity_id="files"))

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "validation_error"
    assert routed_db["journal_entries"].count_documents({}) == 0
