# GET /work-orders/facets serves the project values of the WHOLE mirror
# (contract #10b).

from tests import factories
from tests.factories_planning import make_work_order

# The assignment re-exports the fixture without shadowing an import.
mirror_db = factories.files_db

FACETS = "/api/v1/work-orders/facets"


def test_the_route_serves_the_distinct_projects_sorted_ascending(client, mirror_db):
    mirror_db["work_orders"].insert_many(
        [
            make_work_order("WO-2026-0847", project="XC40"),
            make_work_order("WO-2026-0848", project="EX90"),
            make_work_order("WO-2026-0849", project="EX90"),
        ]
    )

    response = client.get(FACETS)

    assert response.status_code == 200
    assert response.json() == {"projects": ["EX90", "XC40"]}


def test_a_blank_project_is_no_option(client, mirror_db):
    mirror_db["work_orders"].insert_many(
        [
            make_work_order("WO-2026-0847", project="  "),
            make_work_order("WO-2026-0848", project="EX90"),
        ]
    )

    body = client.get(FACETS).json()

    assert body["projects"] == ["EX90"]


def test_an_empty_mirror_answers_an_empty_list(client, mirror_db):
    body = client.get(FACETS).json()

    assert body == {"projects": []}


def test_facets_is_a_route_and_not_a_work_order_id(client, mirror_db):
    """``/work-orders/{wo_id}`` must not swallow the path.

    The detail route answers 404 ``wo_not_found`` for an unknown id. A 200
    with the list proves the facets route matches first.
    """
    response = client.get(FACETS)

    assert response.status_code == 200
    assert set(response.json()) == {"projects"}


def test_every_project_the_route_serves_filters_something(client, mirror_db):
    """The values must match the field the ``project`` filter of #10 reads."""
    mirror_db["work_orders"].insert_many(
        [
            make_work_order("WO-2026-0847", project="EX90"),
            make_work_order("WO-2026-0848", project="XC40"),
        ]
    )

    for project in client.get(FACETS).json()["projects"]:
        page = client.get("/api/v1/work-orders", params={"project": project})
        assert page.status_code == 200
        assert page.json()["total"] > 0, project
