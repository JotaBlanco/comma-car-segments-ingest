# GET /signals/{name} reads the real Mongo catalogue (contract #15).

from datetime import UTC, datetime
from urllib.parse import quote

from tests import factories_signals
from tests.factories_signals import make_signal

# The assignment re-exports the fixture without shadowing an import.
signals_db = factories_signals.signals_db

AT = datetime(2026, 6, 2, 8, 14, 20, tzinfo=UTC)


def test_detail_carries_every_catalogue_field(client, signals_db):
    make_signal(
        signals_db,
        "HV_Batt_Cell_Temp_Max",
        unit="°C",
        unit_source="embedded",
        sensor_ref="PT100-B4-07",
        catalogue_ref="TEMP-CELL-MAX",
        rig_ids=["RIG-04", "RIG-07"],
        field_sources={"unit": {"source": "embedded", "actor": "ingestion", "at": AT}},
    )

    response = client.get("/api/v1/signals/HV_Batt_Cell_Temp_Max")

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "HV_Batt_Cell_Temp_Max"
    assert body["unit"] == "°C"
    assert body["unit_source"] == "embedded"
    assert body["sensor_ref"] == "PT100-B4-07"
    assert body["catalogue_ref"] == "TEMP-CELL-MAX"
    assert body["rig_ids"] == ["RIG-04", "RIG-07"]
    assert body["field_sources"]["unit"] == {
        "source": "embedded",
        "actor": "ingestion",
        "at": "2026-06-02T08:14:20Z",
    }


def test_an_encoded_name_round_trips(client, signals_db):
    name = "Temp_Bergström"
    make_signal(signals_db, name)

    response = client.get(f"/api/v1/signals/{quote(name, safe='')}")

    assert response.status_code == 200
    assert response.json()["name"] == name


def test_an_unknown_name_returns_404(client, signals_db):
    response = client.get("/api/v1/signals/No_Such_Signal")

    assert response.status_code == 404
    body = response.json()
    assert set(body) == {"detail", "code", "errors"}
    assert body["code"] == "signal_not_found"
    assert body["detail"] == "Signal No_Such_Signal not found"
