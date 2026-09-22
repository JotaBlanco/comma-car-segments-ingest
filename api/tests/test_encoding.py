# The catalogue must return non-ASCII text exactly as it went in.
#
# The write side crosses the API too. PATCH /signals/{name} carries every
# non-ASCII string in, and the reads carry it back out. A test that seeded the
# strings with pymongo would prove the driver works, never the API.

from urllib.parse import quote

from tests import factories_signals
from tests.factories_signals import make_signal

# The assignment re-exports the fixture without shadowing an import.
signals_db = factories_signals.signals_db

NAME = "Temp_Bergström"
UNIT = "°C"
DESCRIPTION = "Cell temperature at the Bergström rig"
SENSOR_REF = "PT100-Ångström-B4"
ACTOR = "a.bergström"
NOTE = "Unit absent from the file header — måling set by hand."


def _row(body: dict, name: str) -> dict:
    """Return the one row with this name."""
    matches = [item for item in body["items"] if item["name"] == name]
    assert len(matches) == 1, matches
    return matches[0]


def _path(name: str) -> str:
    return f"/api/v1/signals/{quote(name, safe='')}"


def test_utf8_roundtrip(client, signals_db):
    # The seed holds no non-ASCII text. Every character below enters through
    # the API, so the write side is under test and not the Mongo driver.
    make_signal(signals_db, NAME, unit=None, description=None, sensor_ref=None)

    written = client.patch(
        _path(NAME),
        json={
            "unit": UNIT,
            "description": DESCRIPTION,
            "sensor_ref": SENSOR_REF,
            "actor": ACTOR,
            "note": NOTE,
        },
    )
    assert written.status_code == 200, written.text
    body = written.json()
    assert body["name"] == NAME
    assert body["unit"] == UNIT
    assert body["description"] == DESCRIPTION
    assert body["sensor_ref"] == SENSOR_REF
    assert body["field_sources"]["unit"]["actor"] == ACTOR

    detail = client.get(_path(NAME))
    assert detail.status_code == 200
    body = detail.json()
    assert body["name"] == NAME
    assert body["unit"] == UNIT
    assert body["description"] == DESCRIPTION
    assert body["sensor_ref"] == SENSOR_REF

    by_unit = client.get("/api/v1/signals", params={"unit": UNIT})
    assert by_unit.status_code == 200
    assert _row(by_unit.json(), NAME)["unit"] == UNIT

    by_query = client.get("/api/v1/signals", params={"q": "Bergström"})
    assert by_query.status_code == 200
    assert _row(by_query.json(), NAME)["name"] == NAME


def test_the_journal_keeps_the_non_ascii_text(client, signals_db):
    # The journal is a written record. A mangled unit there is an audit defect.
    make_signal(signals_db, NAME, unit=None)

    response = client.patch(
        _path(NAME), json={"unit": UNIT, "actor": ACTOR, "note": NOTE}
    )

    assert response.status_code == 200, response.text
    entries = list(signals_db["journal_entries"].find({"entity_id": NAME}))
    assert len(entries) == 1
    assert entries[0]["field"] == f"signal.{NAME}.unit"
    assert entries[0]["new"] == UNIT
    assert entries[0]["actor"] == ACTOR
    assert entries[0]["note"] == NOTE


def test_the_wire_carries_real_utf8_bytes(client, signals_db):
    # JSON may escape a non-ASCII character as °. The contract wants the
    # real bytes, so this reads response.content and not response.json().
    make_signal(signals_db, NAME, unit=None, description=None)

    written = client.patch(
        _path(NAME),
        json={"unit": UNIT, "description": DESCRIPTION, "actor": ACTOR},
    )
    assert written.status_code == 200, written.text

    # application/json carries no charset parameter. RFC 8259 fixes the
    # encoding at UTF-8, so the bytes are the only thing to check.
    for response in (written, client.get(_path(NAME))):
        assert UNIT.encode("utf-8") in response.content
        assert "Bergström".encode() in response.content
        assert b"\\u00b0" not in response.content
