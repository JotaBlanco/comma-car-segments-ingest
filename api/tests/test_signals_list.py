# GET /signals reads the real Mongo catalogue (contract #14).

from tests import factories_signals
from tests.factories_signals import make_signal

# The assignment re-exports the fixture without shadowing an import.
signals_db = factories_signals.signals_db


def _names(body: dict) -> list[str]:
    return [item["name"] for item in body["items"]]


def test_filters_combine_with_and(client, signals_db):
    make_signal(signals_db, "Cell_Temp_C_Rig04", unit="°C", rig_ids=["RIG-04"])
    make_signal(signals_db, "Cell_Temp_C_Rig07", unit="°C", rig_ids=["RIG-07"])
    make_signal(signals_db, "Pack_Press_Bar_Rig04", unit="bar", rig_ids=["RIG-04"])

    response = client.get("/api/v1/signals", params={"unit": "°C", "rig": "RIG-04"})

    assert response.status_code == 200
    assert _names(response.json()) == ["Cell_Temp_C_Rig04"]


def test_a_unit_with_no_match_returns_an_empty_page(client, signals_db):
    make_signal(signals_db, "Cell_Temp_C", unit="°C")

    response = client.get("/api/v1/signals", params={"unit": "bar"})

    assert response.status_code == 200
    body = response.json()
    assert body["items"] == []
    assert body["total"] == 0


def test_a_signal_without_a_unit_still_lists(client, signals_db):
    make_signal(signals_db, "Chamber_Humidity", unit=None)

    response = client.get("/api/v1/signals")

    assert response.status_code == 200
    row = response.json()["items"][0]
    assert row["name"] == "Chamber_Humidity"
    assert row["unit"] is None


def test_missing_unit_splits_the_catalogue(client, signals_db):
    make_signal(signals_db, "Chamber_Humidity", unit=None)
    make_signal(signals_db, "EM_Shaft_Torque", unit=None)
    make_signal(signals_db, "Cell_Temp_C", unit="°C")

    # Order-independent: decision box 1 (closed) changed the default sort
    # from ``name asc`` to ``last_seen desc``; both rows share a
    # microsecond-truncated ``last_seen`` so the sort is a tiebreaker toss.
    missing = client.get("/api/v1/signals", params={"missing_unit": "true"})
    assert missing.status_code == 200
    assert set(_names(missing.json())) == {"Chamber_Humidity", "EM_Shaft_Torque"}

    present = client.get("/api/v1/signals", params={"missing_unit": "false"})
    assert present.status_code == 200
    assert _names(present.json()) == ["Cell_Temp_C"]


def test_rig_filter_matches_inside_rig_ids(client, signals_db):
    make_signal(signals_db, "Cell_Temp_C", rig_ids=["RIG-04", "RIG-07"])
    make_signal(signals_db, "EM_Rotor_Temp", rig_ids=["RIG-11"])

    response = client.get("/api/v1/signals", params={"rig": "RIG-07"})

    assert response.status_code == 200
    assert _names(response.json()) == ["Cell_Temp_C"]


def test_rate_filter_matches_the_exact_rate(client, signals_db):
    make_signal(signals_db, "Cell_Temp_C", typical_rate_hz=100.0)
    make_signal(signals_db, "Chamber_Ambient_Temp", typical_rate_hz=1.0)

    exact = client.get("/api/v1/signals", params={"rate": 100})
    assert exact.status_code == 200
    assert _names(exact.json()) == ["Cell_Temp_C"]

    near = client.get("/api/v1/signals", params={"rate": 100.5})
    assert near.status_code == 200
    assert near.json()["items"] == []


def test_q_matches_name_and_description_without_case(client, signals_db):
    make_signal(signals_db, "HV_Batt_Cell_Temp_Max", description="Hottest cell")
    make_signal(signals_db, "Coolant_Flow_Rate", description="Coolant loop volume")
    make_signal(signals_db, "EM_Rotor_Temp", description="Rotor body probe")

    by_name = client.get("/api/v1/signals", params={"q": "hv_batt"})
    assert by_name.status_code == 200
    assert _names(by_name.json()) == ["HV_Batt_Cell_Temp_Max"]

    by_description = client.get("/api/v1/signals", params={"q": "LOOP VOLUME"})
    assert by_description.status_code == 200
    assert _names(by_description.json()) == ["Coolant_Flow_Rate"]

    no_match = client.get("/api/v1/signals", params={"q": "gearbox"})
    assert no_match.status_code == 200
    assert no_match.json()["items"] == []


def test_q_treats_a_regex_character_as_text(client, signals_db):
    # The contract asks for an escaped regex (§22). An unescaped "." matches
    # any character, so the second name would come back too.
    make_signal(signals_db, "HV_Batt.Cell_Temp")
    make_signal(signals_db, "HV_BattXCell_Temp")

    response = client.get("/api/v1/signals", params={"q": "HV_Batt.Cell"})

    assert response.status_code == 200
    assert _names(response.json()) == ["HV_Batt.Cell_Temp"]


def test_an_unbalanced_bracket_in_q_is_not_a_500(client, signals_db):
    # "Temp(" is a broken regex. Unescaped it makes Mongo reject the query.
    make_signal(signals_db, "Cell_Temp")

    response = client.get("/api/v1/signals", params={"q": "Temp("})

    assert response.status_code == 200
    assert response.json()["items"] == []


def test_pages_do_not_overlap(client, signals_db):
    for index in range(25):
        make_signal(signals_db, f"Signal_{index:02d}")

    first = client.get("/api/v1/signals", params={"page": 1, "page_size": 10}).json()
    second = client.get("/api/v1/signals", params={"page": 2, "page_size": 10}).json()

    assert first["total"] == 25
    assert first["total_pages"] == 3
    assert second["page"] == 2
    assert len(first["items"]) == 10
    assert len(second["items"]) == 10
    assert set(_names(first)).isdisjoint(_names(second))
