"""The cross-entity journal read (FR-DM-055, NFR-DM-049).

Six routes read one entity each. An auditor asks who touched a field, or what
one person did in a week, and neither question names one entity. `GET /journal`
answers both. These tests hold it to the shape the six serve, and they prove
every filter alone, two filters together, the paging and the guard.
"""

from datetime import UTC, datetime

import pytest

from api.db import ensure_indexes
from api.models.common import Source
from api.provenance import add_event
from tests.factories import register_file, upsert_run

PATH = "/api/v1/journal"
RUN = "TAS-88214"
ANNA = "a.bergstrom"
BO = "b.lindqvist"


def _moment(day: int) -> datetime:
    return datetime(2026, 8, day, 9, 0, tzinfo=UTC)


def _write(
    db, entity_type, entity_id, field, actor, day, kind="event", source=Source.MANUAL
) -> dict:
    """Store one journal entry with a stated moment, actor, kind and source."""
    entry = add_event(entity_type, entity_id, field, source, actor)
    entry["kind"] = kind
    entry["at"] = _moment(day)
    db["journal_entries"].insert_one(entry)
    return entry


@pytest.fixture
def journal(routed_db):
    """Four entries over two entity types, two actors and three days."""
    ensure_indexes(routed_db)
    upsert_run(routed_db)
    file = register_file(routed_db)
    routed_db["journal_entries"].delete_many({})

    _write(routed_db, "run", RUN, "run.operator", ANNA, 12, kind="change")
    _write(routed_db, "run", RUN, "run.invalid_flag", BO, 13, kind="change")
    _write(routed_db, "file", file["_id"], "file.downloaded", ANNA, 14)
    _write(routed_db, "file", file["_id"], "run.operator", BO, 15, kind="note")
    return {"file": file["_id"]}


def _fields(response) -> list[str]:
    return [entry["field"] for entry in response.json()["items"]]


def test_the_read_serves_every_entity_type_newest_first(client, routed_db, journal) -> None:
    body = client.get(PATH).json()

    assert [entry["field"] for entry in body["items"]] == [
        "run.operator",
        "file.downloaded",
        "run.invalid_flag",
        "run.operator",
    ]
    assert {entry["entity_type"] for entry in body["items"]} == {"run", "file"}
    assert body["total"] == 4
    assert body["page"] == 1
    assert body["page_size"] == 50
    assert body["total_pages"] == 1


def test_the_read_serves_the_canonical_entry_shape(client, routed_db, journal) -> None:
    entry = client.get(PATH).json()["items"][0]

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
    assert entry["at"].endswith("Z")


def test_the_entity_type_filter_keeps_one_type(client, routed_db, journal) -> None:
    body = client.get(PATH, params={"entity_type": "file"}).json()

    assert body["total"] == 2
    assert {entry["entity_type"] for entry in body["items"]} == {"file"}


def test_the_entity_id_filter_keeps_one_entity(client, routed_db, journal) -> None:
    body = client.get(PATH, params={"entity_id": RUN}).json()

    assert body["total"] == 2
    assert {entry["entity_id"] for entry in body["items"]} == {RUN}


def test_the_field_filter_keeps_one_field(client, routed_db, journal) -> None:
    """The field crosses the entity types, which is the point of the route."""
    response = client.get(PATH, params={"field": "run.operator"})

    assert response.json()["total"] == 2
    assert {entry["entity_type"] for entry in response.json()["items"]} == {"run", "file"}


def test_the_actor_filter_keeps_one_person(client, routed_db, journal) -> None:
    body = client.get(PATH, params={"actor": ANNA}).json()

    assert body["total"] == 2
    assert {entry["actor"] for entry in body["items"]} == {ANNA}


def test_the_source_filter_keeps_one_source(client, routed_db, journal) -> None:
    """Every fixture entry is manual, so one embedded entry proves the cut."""
    _write(routed_db, "run", RUN, "run.rig_id", "ingestion", 16, source=Source.EMBEDDED)

    embedded = client.get(PATH, params={"source": "embedded"}).json()
    assert embedded["total"] == 1
    assert embedded["items"][0]["field"] == "run.rig_id"

    manual = client.get(PATH, params={"source": "manual"}).json()
    assert manual["total"] == 4
    assert {entry["source"] for entry in manual["items"]} == {"manual"}


def test_the_source_and_the_actor_narrow_together(client, routed_db, journal) -> None:
    """`source` AND `actor` name Anna's manual entries alone."""
    _write(routed_db, "run", RUN, "run.rig_id", ANNA, 16, source=Source.EMBEDDED)

    alone = client.get(PATH, params={"actor": ANNA}).json()
    assert alone["total"] == 3

    narrowed = client.get(PATH, params={"actor": ANNA, "source": "manual"}).json()
    assert narrowed["total"] == 2
    assert {entry["source"] for entry in narrowed["items"]} == {"manual"}


def test_an_unknown_source_answers_422(client, routed_db, journal) -> None:
    """The source is an enum, so a typo is a caller error, not an empty page."""
    assert client.get(PATH, params={"source": "handwritten"}).status_code == 422


def test_the_kind_filter_keeps_one_kind(client, routed_db, journal) -> None:
    body = client.get(PATH, params={"kind": "change"}).json()

    assert body["total"] == 2
    assert {entry["kind"] for entry in body["items"]} == {"change"}


def test_the_since_bound_is_inclusive(client, routed_db, journal) -> None:
    response = client.get(PATH, params={"since": "2026-08-14T09:00:00Z"})

    assert response.json()["total"] == 2
    assert _fields(response) == ["run.operator", "file.downloaded"]


def test_the_until_bound_is_inclusive(client, routed_db, journal) -> None:
    response = client.get(PATH, params={"until": "2026-08-13T09:00:00Z"})

    assert response.json()["total"] == 2
    assert _fields(response) == ["run.invalid_flag", "run.operator"]


def test_the_two_bounds_make_a_window(client, routed_db, journal) -> None:
    response = client.get(
        PATH, params={"since": "2026-08-13T00:00:00Z", "until": "2026-08-14T23:59:59Z"}
    )

    assert response.json()["total"] == 2
    assert _fields(response) == ["file.downloaded", "run.invalid_flag"]


def test_two_filters_narrow_together(client, routed_db, journal) -> None:
    """`actor` AND `field` name one entry, and each alone names two."""
    response = client.get(PATH, params={"actor": ANNA, "field": "run.operator"})

    assert response.json()["total"] == 1
    assert response.json()["items"][0]["entity_type"] == "run"


def test_the_kind_and_the_entity_type_narrow_together(client, routed_db, journal) -> None:
    response = client.get(PATH, params={"entity_type": "file", "kind": "note"})

    assert response.json()["total"] == 1
    assert response.json()["items"][0]["kind"] == "note"


def test_the_read_pages(client, routed_db, journal) -> None:
    page_two = client.get(PATH, params={"page": 2, "page_size": 10}).json()

    assert page_two["items"] == []
    assert page_two["total"] == 4
    assert page_two["page"] == 2
    assert page_two["page_size"] == 10
    assert page_two["total_pages"] == 1


def test_a_page_holds_the_page_size(client, routed_db, journal) -> None:
    body = client.get(PATH, params={"page_size": 10}).json()

    assert len(body["items"]) == 4
    assert body["total_pages"] == 1


def test_a_page_size_off_the_allow_list_answers_422(client, routed_db, journal) -> None:
    assert client.get(PATH, params={"page_size": 7}).status_code == 422


def test_an_unknown_entity_type_answers_422(client, routed_db, journal) -> None:
    """The type is an enum, so a typo is a caller error and not an empty page."""
    assert client.get(PATH, params={"entity_type": "rig"}).status_code == 422


def test_a_filter_that_matches_nothing_answers_an_empty_page(client, routed_db, journal) -> None:
    body = client.get(PATH, params={"actor": "nobody.at.all"}).json()

    assert body["items"] == []
    assert body["total"] == 0
    assert body["total_pages"] == 0


def test_an_unknown_entity_id_answers_an_empty_page(client, routed_db, journal) -> None:
    """The read checks no id. Nothing to check against, so nothing matches."""
    response = client.get(PATH, params={"entity_id": "nothing-names-this"})

    assert response.status_code == 200
    assert response.json()["total"] == 0


def test_the_read_needs_the_bearer_token(bare_client, routed_db, journal) -> None:
    assert bare_client.get(PATH).status_code == 401


def test_the_read_is_the_only_verb(client, routed_db, journal) -> None:
    """A journal entry is append-only. No PUT and no DELETE reach this path."""
    assert client.put(PATH, json={}).status_code == 405
    assert client.delete(PATH).status_code == 405
