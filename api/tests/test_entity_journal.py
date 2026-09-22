"""The five entity journal reads (FR-DM-055, NFR-DM-049, TR-012).

The journal covers six entity types. Only a run could be read, so a file, a
signal, a work order, a result and a test definition each kept a history nobody
could see. These tests hold the five other reads to the shape of the run read:
the same `kind` filter, the same default page size, the same `at`-descending
order and the same envelope.
"""

from datetime import UTC, datetime

import pytest

from api.db import ensure_indexes
from api.models.common import Source
from api.provenance import add_event
from tests.factories import register_file, upsert_run
from tests.factories_planning import make_definition, make_work_order
from tests.factories_results import seed_result
from tests.factories_signals import make_signal

RUN = "TAS-88214"
SIGNAL = "HV_Batt_Cell_Temp_Max"
WO = "WO-2026-0847"
TD = "TD-EM-201"
ACTOR = "a.bergstrom"


def _write(db, entity_type: str, entity_id: str, field: str, at: datetime) -> dict:
    """Store one journal event with a stated moment."""
    entry = add_event(entity_type, entity_id, field, Source.MANUAL, ACTOR)
    entry["at"] = at
    db["journal_entries"].insert_one(entry)
    return entry


def _note(db, entity_type: str, entity_id: str, at: datetime) -> dict:
    """Store one journal note, so the `kind` filter has two kinds to sort."""
    entry = add_event(entity_type, entity_id, None, Source.MANUAL, ACTOR, note="Checked.")
    entry["kind"] = "note"
    entry["at"] = at
    db["journal_entries"].insert_one(entry)
    return entry


def _moment(day: int) -> datetime:
    return datetime(2026, 8, day, 9, 0, tzinfo=UTC)


@pytest.fixture
def entities(routed_db):
    """One document of every journalled type, plus the run they hang from."""
    ensure_indexes(routed_db)
    upsert_run(routed_db)
    file = register_file(routed_db)
    make_signal(routed_db, SIGNAL)
    routed_db["work_orders"].replace_one({"_id": WO}, make_work_order(), upsert=True)
    routed_db["test_definitions"].replace_one({"_id": TD}, make_definition(td_id=TD), upsert=True)
    result = seed_result(routed_db)
    return {
        "file": file["_id"],
        "signal": SIGNAL,
        "work_order": WO,
        "result": result["_id"],
        "test_definition": TD,
    }


# The path of each entity type, and the 404 code its read answers.
CASES = [
    ("file", "/api/v1/files/{}/journal", "file_not_found"),
    ("signal", "/api/v1/signals/{}/journal", "signal_not_found"),
    ("work_order", "/api/v1/work-orders/{}/journal", "wo_not_found"),
    ("result", "/api/v1/results/{}/journal", "result_not_found"),
    ("test_definition", "/api/v1/test-definitions/{}/journal", "td_not_found"),
]


@pytest.mark.parametrize("entity_type,template,code", CASES, ids=[c[0] for c in CASES])
def test_the_read_serves_the_entity_history_newest_first(
    client, routed_db, entities, entity_type, template, code
) -> None:
    entity_id = entities[entity_type]
    _write(routed_db, entity_type, entity_id, "first", _moment(12))
    _write(routed_db, entity_type, entity_id, "second", _moment(14))

    body = client.get(template.format(entity_id)).json()

    assert [entry["field"] for entry in body["items"]] == ["second", "first"]
    assert body["total"] == 2
    assert body["page"] == 1
    assert body["page_size"] == 50
    assert body["total_pages"] == 1


@pytest.mark.parametrize("entity_type,template,code", CASES, ids=[c[0] for c in CASES])
def test_the_read_serves_the_canonical_entry_shape(
    client, routed_db, entities, entity_type, template, code
) -> None:
    entity_id = entities[entity_type]
    _write(routed_db, entity_type, entity_id, "only", _moment(12))

    entry = client.get(template.format(entity_id)).json()["items"][0]

    assert set(entry) == {
        "id",
        "entity_type",
        "entity_id",
        "field",
        "kind",
        "old",
        "new",
        "source",
        "actor",
        "note",
        "at",
        "received_at",
        "actor_id",
    }
    assert entry["entity_type"] == entity_type
    assert entry["entity_id"] == entity_id
    assert entry["actor"] == ACTOR
    assert entry["actor_id"] is None
    assert entry["at"].endswith("Z")


@pytest.mark.parametrize("entity_type,template,code", CASES, ids=[c[0] for c in CASES])
def test_the_kind_filter_keeps_one_kind(
    client, routed_db, entities, entity_type, template, code
) -> None:
    entity_id = entities[entity_type]
    _write(routed_db, entity_type, entity_id, "an event", _moment(12))
    _note(routed_db, entity_type, entity_id, _moment(13))

    body = client.get(template.format(entity_id), params={"kind": "note"}).json()

    assert body["total"] == 1
    assert body["items"][0]["kind"] == "note"


@pytest.mark.parametrize("entity_type,template,code", CASES, ids=[c[0] for c in CASES])
def test_the_read_pages(client, routed_db, entities, entity_type, template, code) -> None:
    entity_id = entities[entity_type]
    for day in (12, 13, 14):
        _write(routed_db, entity_type, entity_id, f"day {day}", _moment(day))

    page_two = client.get(template.format(entity_id), params={"page": 2, "page_size": 10}).json()

    assert page_two["items"] == []
    assert page_two["total"] == 3
    assert page_two["page_size"] == 10
    assert page_two["total_pages"] == 1


@pytest.mark.parametrize("entity_type,template,code", CASES, ids=[c[0] for c in CASES])
def test_a_page_size_off_the_allow_list_answers_422(
    client, routed_db, entities, entity_type, template, code
) -> None:
    response = client.get(template.format(entities[entity_type]), params={"page_size": 7})
    assert response.status_code == 422


@pytest.mark.parametrize("entity_type,template,code", CASES, ids=[c[0] for c in CASES])
def test_an_unknown_entity_answers_404(
    client, routed_db, entities, entity_type, template, code
) -> None:
    response = client.get(template.format("nothing-names-this"))

    assert response.status_code == 404
    assert response.json()["code"] == code


@pytest.mark.parametrize("entity_type,template,code", CASES, ids=[c[0] for c in CASES])
def test_the_read_needs_the_bearer_token(
    bare_client, routed_db, entities, entity_type, template, code
) -> None:
    response = bare_client.get(template.format(entities[entity_type]))

    assert response.status_code == 401


@pytest.mark.parametrize("entity_type,template,code", CASES, ids=[c[0] for c in CASES])
def test_the_read_is_the_only_verb(
    client, routed_db, entities, entity_type, template, code
) -> None:
    """A journal entry is append-only. No PUT and no DELETE reach this path."""
    path = template.format(entities[entity_type])

    assert client.put(path, json={}).status_code == 405
    assert client.delete(path).status_code == 405


def test_a_read_serves_no_other_entity(client, routed_db, entities) -> None:
    """A file id and a signal name never mix their histories."""
    _write(routed_db, "file", entities["file"], "file.downloaded", _moment(12))
    _write(routed_db, "signal", SIGNAL, "signal.unit", _moment(13))

    files = client.get(f"/api/v1/files/{entities['file']}/journal").json()

    assert [entry["field"] for entry in files["items"]] == ["file.downloaded"]


def test_the_file_read_shows_the_download_the_detail_read_hides(
    client, routed_db, entities
) -> None:
    """`GET /files/{id}` drops `file.downloaded` on purpose. This read keeps it."""
    file_id = entities["file"]
    _write(routed_db, "file", file_id, "file.registered", _moment(12))
    _write(routed_db, "file", file_id, "file.downloaded", _moment(13))

    detail = client.get(f"/api/v1/files/{file_id}").json()["ingestion_timeline"]
    journal = client.get(f"/api/v1/files/{file_id}/journal").json()["items"]

    assert [entry["field"] for entry in detail] == ["file.registered"]
    assert [entry["field"] for entry in journal] == ["file.downloaded", "file.registered"]
