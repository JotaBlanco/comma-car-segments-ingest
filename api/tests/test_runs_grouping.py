"""FR-DM-108 — the run grouping route and the `test_cell` filter.

The workbook asks a user to "group results by project, test cell, vehicle,
rig, bench", and it asks for the same answer in the UI, the API and the CLI.
Two of the five names have no field on a run document, so this suite covers
the three that exist: `project`, `test_cell` and `rig`.

The rules under test:

* the group answer states the group key and the run count, biggest first;
* every filter of §2 applies to it, and it selects the same rows the flat
  list selects — the counts must add up to the flat total;
* the pages page over GROUPS, not over runs;
* a bad `group_by` answers 422, never a silent fallback;
* `test_cell` filters the flat list, alone and with another filter.
"""

from datetime import UTC, datetime, timedelta

from api.routers.test_runs import RunGroupBy
from api.services.queries_runs import RUN_GROUP_FIELDS
from tests.factories_planning import make_run

BASE_AT = datetime(2026, 8, 14, 9, 0, tzinfo=UTC)


def _groups(client, **params) -> dict:
    return client.get("/api/v1/test-runs/groups", params=params).json()


def _list(client, **params) -> dict:
    return client.get("/api/v1/test-runs", params=params or None).json()


def _seed_runs(db) -> None:
    """Six runs: three projects, three cells, two rigs, one cell-less run."""
    db["test_runs"].insert_many(
        [
            make_run(
                run_id="TAS-88214", rig_id="RIG-04", project="EX90",
                test_cell="TC-1", status="awaiting_work_order",
                first_data_at=BASE_AT + timedelta(hours=5),
            ),
            make_run(
                run_id="TAS-88213", rig_id="RIG-04", project="EX90",
                test_cell="TC-1", status="complete",
                first_data_at=BASE_AT + timedelta(hours=4),
            ),
            make_run(
                run_id="TAS-88212", rig_id="RIG-04", project="EX90",
                test_cell="TC-2", status="complete",
                first_data_at=BASE_AT + timedelta(hours=3),
            ),
            make_run(
                run_id="TAS-88209", rig_id="RIG-02", project="EC40",
                test_cell="TC-2", status="invalid",
                first_data_at=BASE_AT + timedelta(hours=2),
            ),
            make_run(
                run_id="TAS-88201", rig_id="RIG-02", project="EC40",
                test_cell="TC-3", status="complete",
                first_data_at=BASE_AT + timedelta(hours=1),
            ),
            make_run(
                run_id="TAS-88200", rig_id="RIG-02", project=None,
                test_cell=None, status="complete", first_data_at=BASE_AT,
            ),
        ]
    )


def _pairs(body: dict) -> list[tuple[str | None, int]]:
    return [(item["value"], item["count"]) for item in body["items"]]


# --- one test per group field ------------------------------------------------


def test_group_by_project_counts_each_project(client, routed_db):
    _seed_runs(routed_db)
    body = _groups(client, group_by="project")
    # Biggest group first; the run with no project forms the null group.
    assert _pairs(body) == [("EX90", 3), ("EC40", 2), (None, 1)]
    assert body["total"] == 3


def test_group_by_test_cell_counts_each_cell(client, routed_db):
    _seed_runs(routed_db)
    body = _groups(client, group_by="test_cell")
    assert _pairs(body) == [("TC-1", 2), ("TC-2", 2), (None, 1), ("TC-3", 1)]


def test_group_by_rig_reads_the_rig_id_field(client, routed_db):
    _seed_runs(routed_db)
    body = _groups(client, group_by="rig")
    assert _pairs(body) == [("RIG-02", 3), ("RIG-04", 3)]


def test_every_wire_name_maps_to_a_stored_field(client):
    # The router whitelist and the service field map must not drift: a name
    # in one and not in the other is either a dead option or a 500.
    assert set(RunGroupBy.__args__) == set(RUN_GROUP_FIELDS)


# --- grouping respects every filter ------------------------------------------


def test_grouping_respects_a_filter_the_caller_sent(client, routed_db):
    _seed_runs(routed_db)
    body = _groups(client, group_by="project", rig="RIG-04")
    assert _pairs(body) == [("EX90", 3)]


def test_grouping_respects_two_filters_at_once(client, routed_db):
    _seed_runs(routed_db)
    body = _groups(client, group_by="test_cell", rig="RIG-02", status="complete")
    assert _pairs(body) == [(None, 1), ("TC-3", 1)]


def test_the_grouped_counts_equal_the_flat_count_for_the_same_filter(client, routed_db):
    _seed_runs(routed_db)
    for filters in ({}, {"rig": "RIG-04"}, {"status": "complete"}, {"project": "EC40"}):
        for field in RUN_GROUP_FIELDS:
            grouped = _groups(client, group_by=field, page_size=500, **filters)
            flat = _list(client, page_size=500, **filters)
            summed = sum(item["count"] for item in grouped["items"])
            assert summed == flat["total"], (field, filters)


def test_an_empty_result_answers_an_empty_page(client, routed_db):
    _seed_runs(routed_db)
    body = _groups(client, group_by="project", rig="RIG-99")
    assert body["items"] == []
    assert body["total"] == 0
    assert body["total_pages"] == 0


# --- paging pages over groups ------------------------------------------------


def test_paging_pages_over_groups_and_never_over_runs(client, routed_db):
    _seed_runs(routed_db)
    # Four cell groups over six runs. `total` reports the 4 groups, never the
    # 6 runs, because the page holds groups.
    head = _groups(client, group_by="test_cell", page_size=10)
    assert head["total"] == 4
    assert head["total_pages"] == 1
    assert sum(item["count"] for item in head["items"]) == 6


def test_every_page_together_holds_every_group_once(client, routed_db):
    _seed_runs(routed_db)
    whole = _groups(client, group_by="test_cell", page_size=500)
    walked: list = []
    page = 1
    while True:
        body = _groups(client, group_by="test_cell", page_size=10, page=page)
        walked.extend(body["items"])
        if page >= body["total_pages"]:
            break
        page += 1
    assert walked == whole["items"]
    assert sum(item["count"] for item in walked) == _list(client)["total"]


def test_a_page_past_the_end_answers_no_groups(client, routed_db):
    _seed_runs(routed_db)
    body = _groups(client, group_by="test_cell", page_size=10, page=4)
    assert body["items"] == []
    assert body["total"] == 4


# --- the refusals ------------------------------------------------------------


def test_a_group_field_outside_the_whitelist_answers_422(client, routed_db):
    _seed_runs(routed_db)
    response = client.get("/api/v1/test-runs/groups", params={"group_by": "vehicle"})
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert body["errors"][0]["loc"] == ["query", "group_by"]


def test_a_missing_group_field_answers_422(client, routed_db):
    _seed_runs(routed_db)
    response = client.get("/api/v1/test-runs/groups")
    assert response.status_code == 422
    assert response.json()["errors"][0]["loc"] == ["query", "group_by"]


def test_the_groups_path_is_never_read_as_a_run_id(client, routed_db):
    # The route sits above GET /test-runs/{run_id}. Without that order this
    # call would answer 404 run_not_found for a run named "groups".
    response = client.get("/api/v1/test-runs/groups", params={"group_by": "rig"})
    assert response.status_code == 200


def test_grouping_needs_the_bearer_token(bare_client, routed_db):
    response = bare_client.get("/api/v1/test-runs/groups", params={"group_by": "rig"})
    assert response.status_code == 401


# --- the test_cell filter on the flat list -----------------------------------


def test_the_test_cell_filter_alone(client, routed_db):
    _seed_runs(routed_db)
    body = _list(client, test_cell="TC-1")
    assert {item["run_id"] for item in body["items"]} == {"TAS-88214", "TAS-88213"}
    assert body["total"] == 2


def test_the_test_cell_filter_takes_repeated_values(client, routed_db):
    _seed_runs(routed_db)
    body = _list(client, test_cell=["TC-1", "TC-3"])
    assert body["total"] == 3


def test_the_test_cell_filter_combines_with_another_filter(client, routed_db):
    _seed_runs(routed_db)
    body = _list(client, test_cell="TC-2", rig="RIG-04")
    assert {item["run_id"] for item in body["items"]} == {"TAS-88212"}


def test_a_blank_test_cell_filters_nothing(client, routed_db):
    # A cleared filter chip still sends its key. Same rule as rig and project.
    _seed_runs(routed_db)
    assert _list(client, test_cell="")["total"] == _list(client)["total"]


def test_the_test_cell_filter_matches_no_run_when_the_cell_is_unknown(client, routed_db):
    _seed_runs(routed_db)
    body = _list(client, test_cell="TC-9")
    assert body["items"] == []
    assert body["total"] == 0
