# PATCH /signals/{name} writes value, source tag and journal (ticket B-09, contract #17).

from datetime import UTC, datetime

import pytest

from api import provenance
from api.models.common import Source
from tests import factories_signals
from tests.factories import upsert_run
from tests.factories_signals import make_signal

# The assignment re-exports the fixture without shadowing an import.
signals_db = factories_signals.signals_db

NAME = "HV_Batt_Cell_Temp_Max"
ACTOR = "a.bergstrom"
NOTE = "Unit absent from file header — set from rig sensor sheet."

DETAIL_FIELDS = {
    "name",
    "description",
    "unit",
    "unit_source",
    "dtype",
    "typical_rate_hz",
    "run_count",
    "first_seen",
    "last_seen",
    "sensor_ref",
    "catalogue_ref",
    "rig_ids",
    # `69eda20` added `source_systems` (FR-DM-111). The catalogue row grows the
    # array with `$addToSet`, the way it grows `rig_ids`, so the detail serves
    # every producing system that wrote a file carrying this signal.
    "source_systems",
    "field_sources",
}


def _patch(client, body: dict, name: str = NAME):
    return client.patch(f"/api/v1/signals/{name}", json=body)


def _stored(db, name: str = NAME) -> dict:
    return db["signals"].find_one({"_id": name})


def _entries(db, name: str = NAME) -> list[dict]:
    return list(db["journal_entries"].find({"entity_id": name}))


def _second() -> datetime:
    """Now, without microseconds. Mongo keeps milliseconds only."""
    return datetime.now(UTC).replace(microsecond=0)


def test_a_hand_set_unit_carries_manual_source_and_a_fresh_timestamp(client, signals_db):
    make_signal(signals_db, NAME, unit=None, unit_source="embedded", field_sources={})
    before = _second()

    response = _patch(client, {"unit": "°C", "actor": ACTOR, "note": NOTE})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["unit"] == "°C"
    assert body["unit_source"] == "manual"

    stored = _stored(signals_db)
    assert stored["unit"] == "°C"
    assert stored["unit_source"] == "manual"
    source = stored["field_sources"]["unit"]
    assert source["source"] == "manual"
    assert source["actor"] == ACTOR
    assert source["at"] >= before


def test_description_and_sensor_ref_are_patchable(client, signals_db):
    make_signal(signals_db, NAME, description="Old text", sensor_ref=None)

    response = _patch(
        client,
        {"description": "Hottest cell temperature", "sensor_ref": "PT100-B4-07", "actor": ACTOR},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["description"] == "Hottest cell temperature"
    assert body["sensor_ref"] == "PT100-B4-07"

    stored = _stored(signals_db)
    assert stored["description"] == "Hottest cell temperature"
    assert stored["sensor_ref"] == "PT100-B4-07"
    assert stored["field_sources"]["description"]["source"] == "manual"
    assert stored["field_sources"]["sensor_ref"]["source"] == "manual"


def test_every_changed_field_gets_its_own_journal_entry(client, signals_db):
    # Three fields change, so the journal keeps three lines. A route that
    # wrote only the first line would lose two audit rows in silence.
    make_signal(signals_db, NAME, unit=None, description="Old text", sensor_ref=None)

    response = _patch(
        client,
        {
            "unit": "°C",
            "description": "Hottest cell temperature",
            "sensor_ref": "PT100-B4-07",
            "actor": ACTOR,
        },
    )

    assert response.status_code == 200, response.text
    entries = _entries(signals_db)
    assert sorted(entry["field"] for entry in entries) == [
        f"signal.{NAME}.description",
        f"signal.{NAME}.sensor_ref",
        f"signal.{NAME}.unit",
    ]
    by_field = {entry["field"]: entry for entry in entries}
    assert by_field[f"signal.{NAME}.unit"]["new"] == "°C"
    assert by_field[f"signal.{NAME}.description"]["old"] == "Old text"
    assert by_field[f"signal.{NAME}.sensor_ref"]["new"] == "PT100-B4-07"


def test_an_unchanged_field_beside_a_changed_one_writes_one_entry(client, signals_db):
    # Only the changed field belongs in the journal, and unit_source must not
    # move when the unit itself did not move.
    make_signal(
        signals_db, NAME, unit="°C", unit_source="embedded", description="Old text"
    )

    response = _patch(
        client, {"unit": "°C", "description": "New text", "actor": ACTOR}
    )

    assert response.status_code == 200, response.text
    assert [entry["field"] for entry in _entries(signals_db)] == [
        f"signal.{NAME}.description"
    ]
    stored = _stored(signals_db)
    assert stored["unit_source"] == "embedded"
    assert "unit" not in stored["field_sources"]


def test_actor_is_required(client, signals_db):
    make_signal(signals_db, NAME)

    response = _patch(client, {"unit": "°C"})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert "actor" in body["detail"]
    assert _stored(signals_db)["unit_source"] == "embedded"


@pytest.mark.parametrize(
    "actor",
    [
        "",
        "   ",
        "\t\n",
        "current-user",
        "Current-User",
        "  CURRENT-USER  ",
        "unknown",
        "system",
        "null",
        "none",
        "user",
        "quix user",
        "Quix User",
    ],
)
def test_an_actor_that_names_nobody_returns_422(client, signals_db, actor):
    # A blank or placeholder actor is a caller error, never a server error.
    make_signal(signals_db, NAME, unit="K", unit_source="embedded")

    response = _patch(client, {"unit": "°C", "actor": actor})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert "actor" in body["detail"]
    assert _stored(signals_db)["unit"] == "K"
    assert _entries(signals_db) == []


def test_a_padded_actor_is_stored_stripped(client, signals_db):
    make_signal(signals_db, NAME, unit=None)

    response = _patch(client, {"unit": "°C", "actor": f"  {ACTOR}  "})

    assert response.status_code == 200, response.text
    assert _stored(signals_db)["field_sources"]["unit"]["actor"] == ACTOR
    assert _entries(signals_db)[0]["actor"] == ACTOR


def test_catalogue_ref_in_the_body_returns_422(client, signals_db):
    make_signal(signals_db, NAME, catalogue_ref="TEMP-CELL-MAX")

    response = _patch(client, {"catalogue_ref": "TEMP-OTHER", "actor": ACTOR})

    assert response.status_code == 422
    assert "catalogue_ref" in response.json()["detail"]
    assert _stored(signals_db)["catalogue_ref"] == "TEMP-CELL-MAX"


def test_an_unknown_field_returns_422_naming_the_field(client, signals_db):
    make_signal(signals_db, NAME)

    response = _patch(client, {"unit": "°C", "actor": ACTOR, "wrong_field": 1})

    assert response.status_code == 422
    body = response.json()
    assert "wrong_field" in body["detail"]
    # The detail is a friendly string, never a raw Pydantic dump.
    assert isinstance(body["detail"], str)
    assert not body["detail"].startswith("[")


@pytest.mark.parametrize(
    "body",
    [
        {"unit": {"value": "°C"}, "actor": ACTOR},
        {"unit": "°C", "actor": {"name": ACTOR}},
        {"unit": "°C", "actor": ACTOR, "note": {"text": NOTE}},
        {"unit": "°C", "actor": ACTOR, "context_run_id": ["TAS-88214"]},
        {"unit": "°C", "actor": ACTOR, "field_sources": {"unit": {"source": "manual"}}},
    ],
)
def test_a_nested_object_where_a_string_belongs_returns_422(client, signals_db, body):
    # A caller mistake is never a server fault. The detail stays a friendly
    # string, so a nested key can not leak a raw Pydantic dump.
    make_signal(signals_db, NAME, unit="K", unit_source="embedded")

    response = _patch(client, body)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "validation_error"
    assert isinstance(response.json()["detail"], str)
    assert _stored(signals_db)["unit"] == "K"
    assert _entries(signals_db) == []


def test_null_keeps_stored_value(client, signals_db):
    # Guard test #9. A field sent as null counts as absent.
    make_signal(signals_db, NAME, unit="°C", unit_source="embedded", description="Old text")

    response = _patch(client, {"unit": None, "description": "New text", "actor": ACTOR})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["unit"] == "°C"
    assert body["unit_source"] == "embedded"
    assert body["description"] == "New text"

    stored = _stored(signals_db)
    assert stored["unit"] == "°C"
    assert stored["unit_source"] == "embedded"
    assert "unit" not in stored["field_sources"]
    assert [entry["field"] for entry in _entries(signals_db)] == [
        f"signal.{NAME}.description"
    ]


def test_the_edit_persists_across_a_refetch(client, signals_db):
    make_signal(signals_db, NAME, unit=None)

    patched = _patch(client, {"unit": "°C", "actor": ACTOR})
    assert patched.status_code == 200, patched.text

    refetched = client.get(f"/api/v1/signals/{NAME}")
    assert refetched.status_code == 200
    body = refetched.json()
    assert body["unit"] == "°C"
    assert body["unit_source"] == "manual"
    assert body["field_sources"]["unit"]["source"] == "manual"


def test_the_journal_entry_names_the_signal_and_the_field(client, signals_db):
    make_signal(signals_db, NAME, unit=None)

    response = _patch(client, {"unit": "°C", "actor": ACTOR, "note": NOTE})

    assert response.status_code == 200, response.text
    entries = _entries(signals_db)
    assert len(entries) == 1
    entry = entries[0]
    assert entry["entity_type"] == "signal"
    assert entry["entity_id"] == NAME
    assert entry["field"] == f"signal.{NAME}.unit"
    assert entry["kind"] == "change"
    assert entry["new"] == "°C"
    assert entry["source"] == "manual"
    assert entry["actor"] == ACTOR
    assert entry["note"] == NOTE


def test_context_run_id_lands_on_the_journal_entry(client, signals_db):
    make_signal(signals_db, NAME, unit=None)
    upsert_run(signals_db, _id="TAS-88214")

    response = _patch(
        client,
        {"unit": "°C", "actor": ACTOR, "context_run_id": "TAS-88214"},
    )

    assert response.status_code == 200, response.text
    entries = _entries(signals_db)
    assert len(entries) == 1
    assert entries[0]["context_run_id"] == "TAS-88214"


def test_without_context_run_id_the_entry_carries_null(client, signals_db):
    make_signal(signals_db, NAME, unit=None)

    response = _patch(client, {"unit": "°C", "actor": ACTOR})

    assert response.status_code == 200, response.text
    entries = _entries(signals_db)
    assert len(entries) == 1
    assert entries[0]["context_run_id"] is None


def test_the_entry_keeps_the_helper_shape(client, signals_db):
    # The route writes through provenance.set_field only. It never builds an
    # entry by hand, so the stored keys match the helper's keys.
    make_signal(signals_db, NAME, unit=None)

    response = _patch(client, {"unit": "°C", "actor": ACTOR})

    assert response.status_code == 200, response.text
    entries = _entries(signals_db)
    assert len(entries) == 1
    from_helper = provenance.set_field({}, "unit", "°C", Source.MANUAL, ACTOR)
    assert set(entries[0]) == set(from_helper)


def test_the_response_body_is_the_catalogue_detail(client, signals_db):
    """The PATCH answers the whole catalogue detail, key for key.

    `69eda20` added the `source_systems` key to `SignalDetail`, so this test
    expected one key too few. The new shape is right and this list follows it.
    """
    make_signal(signals_db, NAME, unit=None, rig_ids=["RIG-04", "RIG-07"])

    response = _patch(client, {"unit": "°C", "actor": ACTOR})

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == DETAIL_FIELDS
    assert body["name"] == NAME
    assert body["rig_ids"] == ["RIG-04", "RIG-07"]


def test_the_entry_keeps_the_previous_value(client, signals_db):
    make_signal(signals_db, NAME, unit="K")

    response = _patch(client, {"unit": "°C", "actor": ACTOR})

    assert response.status_code == 200, response.text
    entry = _entries(signals_db)[0]
    assert entry["old"] == "K"
    assert entry["new"] == "°C"


def test_an_unchanged_value_writes_no_journal_entry(client, signals_db):
    make_signal(signals_db, NAME, unit="°C", unit_source="embedded")

    response = _patch(client, {"unit": "°C", "actor": ACTOR})

    assert response.status_code == 200, response.text
    assert _entries(signals_db) == []
    assert _stored(signals_db)["unit_source"] == "embedded"


def test_a_body_without_a_patchable_field_returns_400(client, signals_db):
    make_signal(signals_db, NAME, unit="°C")

    response = _patch(client, {"unit": None, "actor": ACTOR})

    assert response.status_code == 400
    assert response.json()["code"] == "no_fields_to_update"
    assert _stored(signals_db)["unit"] == "°C"


def test_an_unknown_signal_returns_404(client, signals_db):
    response = _patch(client, {"unit": "°C", "actor": ACTOR}, name="No_Such_Signal")

    assert response.status_code == 404
    body = response.json()
    assert set(body) == {"detail", "code", "errors"}
    assert body["code"] == "signal_not_found"
    assert body["detail"] == "Signal No_Such_Signal not found"
    assert signals_db["journal_entries"].count_documents({}) == 0
