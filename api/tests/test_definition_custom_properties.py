"""Custom properties on a test definition.

A test definition is a read-only mirror of the planning system, so a person
cannot edit a planning field. A person still needs to record a fact about the
definition: a rig serial, a coolant mix, a fixture id.

The map therefore lives in its own store, exactly as a manual requirements
document does. Planning owns `title`, `work_order_id`, `planned_runs` and
`requirements_files`, and it names no `manual_custom_properties`. So a sync
pass replaces what planning owns and never reaches the map.

The caps and the refusal codes are the run's. `api/api/models/runs.py` holds
the one checker both routes call, so the two maps can never drift apart.
"""

import httpx
import pytest

from api import quix_identity
from api.models.runs import (
    CUSTOM_PROPERTY_KEY_MAX,
    CUSTOM_PROPERTY_MAX_COUNT,
    CUSTOM_PROPERTY_VALUE_MAX,
)
from tests.factories_planning import make_definition, make_work_order

PORTAL = "https://portal-api.test.quix.io"

# A test-only value. It is not a real credential.
LIVE_TOKEN = "live-platform-token-not-a-secret"

PROFILE = {
    "userId": "auth0|64f0c1",
    "email": "emanuel@volvo.test",
    "firstName": "Emanuel",
    "lastName": "Nilsson",
}

# The name the platform proves for LIVE_TOKEN.
VERIFIED = "Emanuel Nilsson"

TD = "TD-EM-201"
WO = "WO-2026-0847"

ROUTE = f"/api/v1/test-definitions/{TD}/custom-properties"

PROPERTIES = {"rig serial": "R-9", "coolant": "50/50"}


@pytest.fixture(autouse=True)
def no_workspace(monkeypatch):
    """Ask the platform for the identity only, never for the blob store."""
    monkeypatch.delenv(quix_identity.WORKSPACE_VAR, raising=False)


@pytest.fixture
def platform(monkeypatch):
    """Turn the platform identity check on, and name one person."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == quix_identity.PERMISSIONS_PATH:
            return httpx.Response(200, json=True)
        return httpx.Response(200, json=PROFILE)

    monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, PORTAL)
    quix_identity.TRANSPORT = httpx.MockTransport(handler)
    return {"Authorization": f"Bearer {LIVE_TOKEN}"}


@pytest.fixture
def mirror(routed_db):
    """One work order and one definition, with no property on it."""
    routed_db["work_orders"].insert_one(make_work_order(wo_id=WO))
    routed_db["test_definitions"].insert_one(make_definition(td_id=TD, work_order_id=WO))
    return routed_db


def _write(client, properties, headers=None, **extra) -> httpx.Response:
    return client.patch(
        ROUTE, json={"custom_properties": properties, **extra}, headers=headers
    )


def _detail(client) -> dict:
    response = client.get(f"/api/v1/test-definitions/{TD}")
    assert response.status_code == 200, response.text
    return response.json()


def _stored(db) -> dict:
    return db["test_definitions"].find_one({"_id": TD})


def _entries(db) -> list[dict]:
    """The journal entries this route left, oldest first."""
    query = {"field": "test_definition.custom_properties"}
    return list(db["journal_entries"].find(query).sort("at", 1))


def _push(client, **definition) -> httpx.Response:
    """One planning sync pass over the same definition."""
    return client.post(
        "/api/v1/planning/sync",
        json={
            "work_orders": [{"id": WO, "title": "E-machine", "project": "EX90"}],
            "test_definitions": [
                {
                    "id": TD,
                    "work_order_id": WO,
                    "title": "E-machine efficiency map",
                    "planned_runs": 2,
                    **definition,
                }
            ],
            "links": [],
        },
    )


# --- the read ---------------------------------------------------------------


def test_a_definition_with_no_property_reads_an_empty_map(client, mirror) -> None:
    assert _detail(client)["custom_properties"] == {}


def test_the_write_lands_on_the_detail(client, mirror) -> None:
    assert _write(client, PROPERTIES).status_code == 200

    assert _detail(client)["custom_properties"] == PROPERTIES


def test_the_route_answers_the_stored_map(client, mirror) -> None:
    body = _write(client, PROPERTIES).json()

    assert body == {"custom_properties": PROPERTIES}


# --- the write --------------------------------------------------------------


def test_the_map_replaces_the_stored_map_whole(client, mirror) -> None:
    _write(client, PROPERTIES)

    body = _write(client, {"coolant": "60/40"}).json()

    assert body["custom_properties"] == {"coolant": "60/40"}


def test_an_empty_map_clears_every_property(client, mirror) -> None:
    _write(client, PROPERTIES)

    assert _write(client, {}).json()["custom_properties"] == {}


def test_the_store_sits_beside_the_mirror_and_never_on_it(client, mirror) -> None:
    """The wire says `custom_properties`; the store says `manual_...`.

    A reader of the raw document therefore cannot mistake the map for a field
    planning sent.
    """
    _write(client, PROPERTIES)

    document = _stored(mirror)

    assert document["manual_custom_properties"] == PROPERTIES
    assert "custom_properties" not in document


def test_an_unknown_body_key_answers_422(client, mirror) -> None:
    """Every write body forbids an extra key, so a typo never loses a value."""
    response = _write(client, PROPERTIES, customProperties={})

    assert response.status_code == 422


def test_an_unknown_definition_answers_404(client, routed_db) -> None:
    response = _write(client, PROPERTIES)

    assert response.status_code == 404
    assert response.json()["code"] == "td_not_found"


def test_the_write_needs_the_bearer_token(bare_client, mirror) -> None:
    response = bare_client.patch(ROUTE, json={"custom_properties": PROPERTIES})

    assert response.status_code == 401


# --- a sync pass never erases the map ---------------------------------------


def test_a_sync_pass_keeps_the_properties(client, mirror) -> None:
    """The point of the whole design. Planning names no such field."""
    _write(client, PROPERTIES)

    assert _push(client).status_code == 200

    assert _stored(mirror)["manual_custom_properties"] == PROPERTIES
    assert _detail(client)["custom_properties"] == PROPERTIES


def test_a_sync_pass_that_sends_no_document_keeps_the_properties(client, mirror) -> None:
    """A pass empties the planning document list. The map still stands."""
    _write(client, PROPERTIES)

    _push(client, requirements_files=[])

    assert _detail(client)["custom_properties"] == PROPERTIES
    assert _detail(client)["requirements_files"] == []


def test_a_sync_pass_never_tags_the_map_as_planning(client, mirror) -> None:
    """The map carries `manual`, and a pass tags the planning fields only."""
    _write(client, PROPERTIES)
    _push(client)

    sources = _stored(mirror)["field_sources"]

    assert sources["manual_custom_properties"]["source"] == "manual"
    assert sources["title"]["source"] == "api:planning"
    # Planning writes no property map at all, so it tags no such field.
    assert "custom_properties" not in sources


def test_a_write_after_a_sync_pass_still_lands(client, mirror) -> None:
    _push(client)

    assert _write(client, PROPERTIES).status_code == 200
    assert _detail(client)["custom_properties"] == PROPERTIES


# --- the provenance and the journal -----------------------------------------


def test_the_map_carries_the_manual_source(client, mirror) -> None:
    _write(client, PROPERTIES)

    tag = _stored(mirror)["field_sources"]["manual_custom_properties"]

    assert tag["source"] == "manual"


def test_the_write_leaves_one_journal_entry(client, mirror) -> None:
    _write(client, PROPERTIES)

    entries = _entries(mirror)

    assert len(entries) == 1
    assert entries[0]["entity_type"] == "test_definition"
    assert entries[0]["entity_id"] == TD
    assert entries[0]["source"] == "manual"


def test_the_journal_entry_carries_the_note(client, mirror) -> None:
    _write(client, PROPERTIES, note="read off the rig label")

    assert _entries(mirror)[0]["note"] == "read off the rig label"


def test_the_journal_names_the_verified_caller(client, mirror, platform) -> None:
    """A person pressed Save, so the row names the person the platform proved."""
    _write(client, PROPERTIES, headers=platform)

    entry = _entries(mirror)[0]

    assert entry["actor"] == VERIFIED
    assert entry["actor_id"] == PROFILE["userId"]


def test_an_unchanged_map_writes_nothing_and_journals_nothing(client, mirror) -> None:
    """The history carries edits, not noise. Same rule as `patch_run`."""
    _write(client, PROPERTIES)

    response = _write(client, dict(PROPERTIES))

    assert response.status_code == 200
    assert response.json()["custom_properties"] == PROPERTIES
    assert len(_entries(mirror)) == 1


def test_the_entry_reaches_the_definition_journal(client, mirror) -> None:
    _write(client, PROPERTIES)

    response = client.get(f"/api/v1/test-definitions/{TD}/journal")

    assert response.status_code == 200
    fields = [entry["field"] for entry in response.json()["items"]]
    assert "test_definition.custom_properties" in fields


# --- the caps, shared with the run ------------------------------------------


def test_an_empty_key_answers_422(client, mirror) -> None:
    response = _write(client, {"": "R-9"})

    assert response.status_code == 422
    assert response.json()["code"] == "custom_property_key_required"


def test_a_blank_key_answers_422(client, mirror) -> None:
    response = _write(client, {"   ": "R-9"})

    assert response.status_code == 422
    assert response.json()["code"] == "custom_property_key_required"


def test_an_oversized_key_answers_422(client, mirror) -> None:
    response = _write(client, {"k" * (CUSTOM_PROPERTY_KEY_MAX + 1): "R-9"})

    assert response.status_code == 422
    assert response.json()["code"] == "custom_property_key_too_long"


def test_a_key_at_the_cap_passes(client, mirror) -> None:
    assert _write(client, {"k" * CUSTOM_PROPERTY_KEY_MAX: "R-9"}).status_code == 200


def test_an_oversized_value_answers_422(client, mirror) -> None:
    response = _write(client, {"note": "v" * (CUSTOM_PROPERTY_VALUE_MAX + 1)})

    assert response.status_code == 422
    assert response.json()["code"] == "custom_property_value_too_long"


def test_a_value_at_the_cap_passes(client, mirror) -> None:
    assert _write(client, {"note": "v" * CUSTOM_PROPERTY_VALUE_MAX}).status_code == 200


def test_too_many_properties_answer_422(client, mirror) -> None:
    oversized = {f"k{index}": "v" for index in range(CUSTOM_PROPERTY_MAX_COUNT + 1)}

    response = _write(client, oversized)

    assert response.status_code == 422
    assert response.json()["code"] == "too_many_custom_properties"


def test_the_count_at_the_cap_passes(client, mirror) -> None:
    full = {f"k{index}": "v" for index in range(CUSTOM_PROPERTY_MAX_COUNT)}

    assert _write(client, full).status_code == 200


def test_a_refused_map_stores_nothing(client, mirror) -> None:
    _write(client, {"": "R-9"})

    assert _stored(mirror).get("manual_custom_properties") is None


def test_a_value_that_is_not_a_string_answers_422(client, mirror) -> None:
    response = _write(client, {"cycles": 12})

    assert response.status_code == 422
