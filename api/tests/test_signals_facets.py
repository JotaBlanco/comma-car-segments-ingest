# GET /signals/facets serves the filter values of the WHOLE catalogue
# (contract #14b).

from datetime import UTC, datetime, timedelta

from tests import factories_signals
from tests.factories_signals import make_signal

# The assignment re-exports the fixture without shadowing an import.
signals_db = factories_signals.signals_db

FACETS = "/api/v1/signals/facets"


def test_the_route_reads_the_whole_catalogue_not_the_newest_page(client, signals_db):
    """This is the bug the route exists for.

    The screen built its unit list from one page of ``GET /signals``. That
    list sorts ``last_seen`` desc and ``PATCH /signals/{name}`` does not move
    ``last_seen``. A corrected unit on an old signal therefore stayed out of
    the page, and out of the filter.
    """
    new = datetime.now(UTC).replace(microsecond=0)
    old = new - timedelta(days=400)
    for index in range(12):
        make_signal(signals_db, f"Cell_Temp_{index}", unit="°C", last_seen=new)
    # The old signal carries the corrected unit. No page of the newest rows
    # reaches it.
    make_signal(signals_db, "EM_Shaft_Speed", unit="rpm", last_seen=old)

    page = client.get("/api/v1/signals", params={"page_size": 10})
    assert page.status_code == 200
    assert "rpm" not in {row["unit"] for row in page.json()["items"]}

    facets = client.get(FACETS)
    assert facets.status_code == 200
    assert "rpm" in facets.json()["units"]


def test_every_list_sorts_ascending(client, signals_db):
    make_signal(signals_db, "EM_Shaft_Speed", unit="rpm", typical_rate_hz=100.0, rig_ids=["RIG-07"])
    make_signal(signals_db, "Chamber_Humidity", unit="%RH", typical_rate_hz=1.0, rig_ids=["RIG-01"])
    make_signal(signals_db, "Cell_Temp", unit="°C", typical_rate_hz=12.5, rig_ids=["RIG-04"])

    body = client.get(FACETS).json()

    assert body["units"] == ["%RH", "rpm", "°C"]
    assert body["rates"] == [1.0, 12.5, 100.0]
    assert body["rigs"] == ["RIG-01", "RIG-04", "RIG-07"]


def test_a_missing_unit_is_no_unit_option(client, signals_db):
    make_signal(signals_db, "Chamber_Humidity", unit=None)
    make_signal(signals_db, "Cell_Temp", unit="°C")

    body = client.get(FACETS).json()

    assert body["units"] == ["°C"]


def test_a_blank_unit_is_no_unit_option(client, signals_db):
    # A blank value filters nothing, so it must not offer itself as a filter.
    make_signal(signals_db, "Chamber_Humidity", unit="  ")
    make_signal(signals_db, "Cell_Temp", unit="°C")

    body = client.get(FACETS).json()

    assert body["units"] == ["°C"]


def test_a_rig_of_a_second_signal_still_reaches_the_list(client, signals_db):
    # rig_ids is an array. Every rig of every row must appear exactly once.
    make_signal(signals_db, "Cell_Temp", rig_ids=["RIG-04", "RIG-07"])
    make_signal(signals_db, "Pack_Press", rig_ids=["RIG-04", "RIG-01"])

    body = client.get(FACETS).json()

    assert body["rigs"] == ["RIG-01", "RIG-04", "RIG-07"]


def test_every_rig_the_route_serves_filters_something(client, signals_db):
    """The rig values must match the field the ``rig`` filter of #14 reads."""
    make_signal(signals_db, "Cell_Temp", rig_ids=["RIG-04"])
    make_signal(signals_db, "Pack_Press", rig_ids=["RIG-07"])

    for rig in client.get(FACETS).json()["rigs"]:
        page = client.get("/api/v1/signals", params={"rig": rig})
        assert page.status_code == 200
        assert page.json()["total"] > 0, rig


def test_an_empty_catalogue_answers_five_empty_lists(client, signals_db):
    # Three lists until 24 Aug 2026. FR-DM-111 added `dtypes` and
    # `source_systems`, so the shape states five.
    body = client.get(FACETS).json()

    assert body == {
        "units": [],
        "rates": [],
        "rigs": [],
        "dtypes": [],
        "source_systems": [],
    }


def test_facets_is_a_route_and_not_a_signal_name(client, signals_db):
    """``/signals/{name}`` must not swallow the path.

    The detail route answers 404 ``signal_not_found`` for an unknown name. A
    200 with the three lists proves the facets route matches first.
    """
    response = client.get(FACETS)

    assert response.status_code == 200
    assert set(response.json()) == {
        "units",
        "rates",
        "rigs",
        "dtypes",
        "source_systems",
    }


def test_the_route_takes_no_query_parameter(client, signals_db):
    make_signal(signals_db, "Cell_Temp", unit="°C")
    make_signal(signals_db, "EM_Shaft_Speed", unit="rpm")

    # A filter must not narrow the facets. The whole point is the whole
    # catalogue, so the screen can still add a second unit.
    body = client.get(FACETS, params={"unit": "°C"}).json()

    assert body["units"] == ["rpm", "°C"]
