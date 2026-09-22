# GET /test-runs/facets serves the filter values of the WHOLE runs table
# (contract #2b).

from tests import factories
from tests.factories import upsert_run

# The assignment re-exports the fixture without shadowing an import.
runs_db = factories.files_db

FACETS = "/api/v1/test-runs/facets"


def test_the_route_serves_the_two_lists(client, runs_db):
    upsert_run(runs_db, _id="TAS-88214", rig_id="RIG-04", project="EX90")

    response = client.get(FACETS)

    assert response.status_code == 200
    # `custom_property_keys` joined on 25 Aug 2026 (FR-DM-108). This run carries
    # no property map, so the list is empty.
    assert response.json() == {
        "rigs": ["RIG-04"],
        "projects": ["EX90"],
        "custom_property_keys": [],
    }


def test_every_list_sorts_ascending_and_deduplicates(client, runs_db):
    upsert_run(runs_db, _id="TAS-88214", rig_id="RIG-07", project="EX90")
    upsert_run(runs_db, _id="TAS-88215", rig_id="RIG-02", project="XC40")
    upsert_run(runs_db, _id="TAS-88216", rig_id="RIG-02", project="EX90")

    body = client.get(FACETS).json()

    assert body["rigs"] == ["RIG-02", "RIG-07"]
    assert body["projects"] == ["EX90", "XC40"]


def test_a_null_project_is_no_project_option(client, runs_db):
    # An awaiting_work_order run has no project a person can select.
    upsert_run(runs_db, _id="TAS-88214", rig_id="RIG-04", project=None)
    upsert_run(runs_db, _id="TAS-88215", rig_id="RIG-02", project="EX90")

    body = client.get(FACETS).json()

    assert body["projects"] == ["EX90"]


def test_a_blank_value_is_no_option(client, runs_db):
    # A blank value filters nothing, so it must not offer itself as a filter.
    upsert_run(runs_db, _id="TAS-88214", rig_id="  ", project="  ")
    upsert_run(runs_db, _id="TAS-88215", rig_id="RIG-04", project="EX90")

    body = client.get(FACETS).json()

    assert body == {"rigs": ["RIG-04"], "projects": ["EX90"], "custom_property_keys": []}


def test_an_empty_table_answers_two_empty_lists(client, runs_db):
    body = client.get(FACETS).json()

    assert body == {"rigs": [], "projects": [], "custom_property_keys": []}


def test_facets_is_a_route_and_not_a_run_id(client, runs_db):
    """``/test-runs/{run_id}`` must not swallow the path.

    The detail route answers 404 ``run_not_found`` for an unknown id. A 200
    with the lists proves the facets route matches first.
    """
    response = client.get(FACETS)

    assert response.status_code == 200
    assert set(response.json()) == {"rigs", "projects", "custom_property_keys"}


def test_every_value_the_route_serves_filters_something(client, runs_db):
    """The values must match the fields the #2 filters read."""
    upsert_run(runs_db, _id="TAS-88214", rig_id="RIG-04", project="EX90")
    upsert_run(runs_db, _id="TAS-88215", rig_id="RIG-07", project="XC40")

    body = client.get(FACETS).json()
    for key, values in (("rig", body["rigs"]), ("project", body["projects"])):
        for value in values:
            page = client.get("/api/v1/test-runs", params={key: value})
            assert page.status_code == 200
            assert page.json()["total"] > 0, (key, value)
