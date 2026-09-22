"""POST /access-requests — UC-003 step 4, "request access" (contract D-Access).

The Test Manager holds no scoped access, so this route grants nothing. It
records the ask in the journal and a person acts on it outside the system.
Each test below holds one rule of that box.
"""

import pytest

from api.routers.journal import ACCESS_REQUEST_FIELD
from tests.factories import register_file, upsert_run

ACCESS = "/api/v1/access-requests"
JOURNAL = "/api/v1/journal"

ACTOR = "Ingrid Karlsson"
REASON = "I need the raw MF4 for the cell-temperature investigation on WO-2026-0847."


def _body(**overrides) -> dict:
    body = {
        "entity_type": "file",
        "entity_id": "f-unknown",
        "reason": REASON,
        "actor": ACTOR,
    }
    body.update(overrides)
    return body


def test_the_route_records_the_request(client, routed_db) -> None:
    file = register_file(routed_db)

    response = client.post(ACCESS, json=_body(entity_id=file["_id"]))

    assert response.status_code == 201, response.text
    entry = response.json()
    assert entry["id"].startswith("j-")
    assert entry["kind"] == "event"
    assert entry["field"] == ACCESS_REQUEST_FIELD
    assert entry["source"] == "manual"
    # The stated reason is the only part a reviewer can act on.
    assert entry["note"] == REASON
    # An access request changes no field, so both sides stay empty.
    assert entry["old"] is None
    assert entry["new"] is None


def test_the_entry_names_the_entity_and_the_actor(client, routed_db) -> None:
    file = register_file(routed_db)

    client.post(ACCESS, json=_body(entity_id=file["_id"]))

    stored = routed_db["journal_entries"].find_one({"field": ACCESS_REQUEST_FIELD})
    assert stored is not None
    assert stored["entity_type"] == "file"
    assert stored["entity_id"] == file["_id"]
    assert stored["actor"] == ACTOR
    # The demo path runs on the shared static token, which names a token
    # holder and never a person. So the platform proved nobody here.
    assert stored.get("actor_id") is None


def test_the_request_reads_back_on_the_entity_timeline(client, routed_db) -> None:
    file = register_file(routed_db)

    client.post(ACCESS, json=_body(entity_id=file["_id"]))

    page = client.get(f"/api/v1/files/{file['_id']}/journal")
    assert page.status_code == 200, page.text
    fields = [entry["field"] for entry in page.json()["items"]]
    assert ACCESS_REQUEST_FIELD in fields


def test_a_reviewer_reads_the_whole_queue_by_field(client, routed_db) -> None:
    upsert_run(routed_db)
    file = register_file(routed_db)
    client.post(ACCESS, json=_body(entity_id=file["_id"]))
    client.post(ACCESS, json=_body(entity_type="run", entity_id="TAS-88214"))

    page = client.get(JOURNAL, params={"field": ACCESS_REQUEST_FIELD})

    assert page.status_code == 200, page.text
    assert page.json()["total"] == 2


@pytest.mark.parametrize(
    ("entity_type", "entity_id", "code"),
    [
        ("file", "f-nobody-holds-this", "file_not_found"),
        ("run", "TAS-00000", "run_not_found"),
        ("work_order", "WO-0000-0000", "wo_not_found"),
    ],
)
def test_a_missing_entity_answers_404(
    client, routed_db, entity_type, entity_id, code
) -> None:
    response = client.post(ACCESS, json=_body(entity_type=entity_type, entity_id=entity_id))

    assert response.status_code == 404, response.text
    assert response.json()["code"] == code
    # The route refused before it wrote, so no entry names an entity nobody holds.
    assert routed_db["journal_entries"].count_documents({}) == 0


def test_the_caller_must_be_authenticated(bare_client) -> None:
    response = bare_client.post(ACCESS, json=_body())

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


def test_a_wrong_token_is_refused(bare_client) -> None:
    response = bare_client.post(
        ACCESS, json=_body(), headers={"Authorization": "Bearer wrong-token"}
    )

    assert response.status_code == 401


@pytest.mark.parametrize("reason", ["", "   "])
def test_a_blank_reason_answers_422(client, routed_db, reason) -> None:
    file = register_file(routed_db)

    response = client.post(ACCESS, json=_body(entity_id=file["_id"], reason=reason))

    assert response.status_code == 422, response.text
    assert routed_db["journal_entries"].count_documents({}) == 0


def test_an_actor_that_names_nobody_answers_422(client, routed_db) -> None:
    file = register_file(routed_db)

    response = client.post(ACCESS, json=_body(entity_id=file["_id"], actor="current-user"))

    assert response.status_code == 422, response.text


def test_an_export_entity_type_answers_422(client, routed_db) -> None:
    """`export` is a journal entity, and no caller may name it in a body.

    The route checks the entity against `_ENTITIES`, and that table holds no
    export row, so the check used to raise `KeyError` and answer 500.
    """
    response = client.post(ACCESS, json=_body(entity_type="export", entity_id="files"))

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "validation_error"
    assert routed_db["journal_entries"].count_documents({}) == 0
