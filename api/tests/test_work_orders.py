"""A-05 — contract #10 and #11 read the mirrors from Mongo.

The mirrors are read-only. Planning owns every field, so no write route exists
and no document carries `field_sources`. `definition_count`, `run_count`,
`actual_runs` and the definition status derive at read time.
"""

from datetime import UTC, datetime

from tests.factories_planning import make_run, make_work_order, seed_mirror


def _get(client, path: str, **params):
    return client.get(f"/api/v1{path}", params=params or None)


# --- #10 list ---------------------------------------------------------------


def test_the_list_reads_the_mirror_rows(client, routed_db) -> None:
    seed_mirror(routed_db)

    body = _get(client, "/work-orders").json()

    assert body["total"] == 2
    ids = [item["wo_id"] for item in body["items"]]
    # Highest id first, so the newest campaign opens the screen.
    assert ids == ["WO-2026-0847", "WO-2026-0839"]
    assert all(item["synced_at"].endswith("Z") for item in body["items"])


def test_the_rollups_count_definitions_and_runs(client, routed_db) -> None:
    seed_mirror(routed_db)

    rows = {item["wo_id"]: item for item in _get(client, "/work-orders").json()["items"]}

    assert rows["WO-2026-0847"]["definition_count"] == 2
    assert rows["WO-2026-0847"]["run_count"] == 2
    assert rows["WO-2026-0839"]["definition_count"] == 1
    assert rows["WO-2026-0839"]["run_count"] == 1


def test_the_status_filter_filters(client, routed_db) -> None:
    seed_mirror(routed_db)

    body = _get(client, "/work-orders", status="closed").json()

    assert [item["wo_id"] for item in body["items"]] == ["WO-2026-0839"]
    assert body["total"] == 1


def test_the_project_filter_filters(client, routed_db) -> None:
    seed_mirror(routed_db)

    body = _get(client, "/work-orders", project="EX90").json()

    assert [item["wo_id"] for item in body["items"]] == ["WO-2026-0847"]


def test_q_matches_the_id_and_the_title_case_insensitively(client, routed_db) -> None:
    seed_mirror(routed_db)

    by_title = _get(client, "/work-orders", q="INVERTER").json()
    by_id = _get(client, "/work-orders", q="0847").json()

    assert [item["wo_id"] for item in by_title["items"]] == ["WO-2026-0839"]
    assert [item["wo_id"] for item in by_id["items"]] == ["WO-2026-0847"]


def test_a_regex_metacharacter_returns_no_match_not_an_error(client, routed_db) -> None:
    seed_mirror(routed_db)

    response = _get(client, "/work-orders", q="(")

    assert response.status_code == 200
    assert response.json()["items"] == []


def test_the_filters_combine(client, routed_db) -> None:
    seed_mirror(routed_db)

    body = _get(client, "/work-orders", status="active", project="EC40").json()

    assert body["items"] == []
    assert body["total"] == 0


def test_page_two_differs_from_page_one(client, routed_db) -> None:
    seed_mirror(routed_db)

    first = _get(client, "/work-orders", page=1, page_size=10).json()
    second = _get(client, "/work-orders", page=2, page_size=10).json()

    assert len(first["items"]) == 2
    assert second["items"] == []
    assert first["total_pages"] == 1


def test_an_empty_mirror_lists_nothing(client, routed_db) -> None:
    body = _get(client, "/work-orders").json()

    assert body["items"] == []
    assert body["total"] == 0
    assert body["total_pages"] == 0


# --- #11 detail -------------------------------------------------------------


def test_the_detail_embeds_definitions_and_runs(client, routed_db) -> None:
    seed_mirror(routed_db)

    body = _get(client, "/work-orders/WO-2026-0847").json()

    assert body["wo_id"] == "WO-2026-0847"
    assert body["requestor"] == "M. Ekholm · Propulsion"
    assert [d["td_id"] for d in body["definitions"]] == ["TD-EM-201", "TD-EM-204"]
    assert [r["run_id"] for r in body["runs"]] == ["TAS-88213", "TAS-88212"]


def test_planned_versus_actual_derives_at_read_time(client, routed_db) -> None:
    """TD-EM-201 plans two runs and has both. TD-EM-204 plans one and has none."""
    seed_mirror(routed_db)

    definitions = {
        d["td_id"]: d for d in _get(client, "/work-orders/WO-2026-0847").json()["definitions"]
    }

    assert definitions["TD-EM-201"]["planned_runs"] == 2
    assert definitions["TD-EM-201"]["actual_runs"] == 2
    assert definitions["TD-EM-201"]["status"] == "on_plan"
    assert definitions["TD-EM-204"]["actual_runs"] == 0
    assert definitions["TD-EM-204"]["status"] == "awaiting_data"


def test_a_definition_short_of_its_plan_reads_as_awaiting_data(client, routed_db) -> None:
    """Two planned, one delivered — the screen must say the plan is not met."""
    seed_mirror(routed_db)
    routed_db["test_runs"].delete_one({"_id": "TAS-88212"})

    definitions = {
        d["td_id"]: d for d in _get(client, "/work-orders/WO-2026-0847").json()["definitions"]
    }

    assert definitions["TD-EM-201"]["actual_runs"] == 1
    assert definitions["TD-EM-201"]["status"] == "awaiting_data"


def test_a_definition_without_a_planned_count_reads_as_on_plan(client, routed_db) -> None:
    """`planned_runs` is nullable. A null plan can never be behind."""
    seed_mirror(routed_db)
    routed_db["test_definitions"].update_one(
        {"_id": "TD-EM-204"}, {"$set": {"planned_runs": None}}
    )

    definitions = {
        d["td_id"]: d for d in _get(client, "/work-orders/WO-2026-0847").json()["definitions"]
    }

    assert definitions["TD-EM-204"]["planned_runs"] == 0
    assert definitions["TD-EM-204"]["status"] == "on_plan"


def test_the_runs_rollup_sorts_newest_first(client, routed_db) -> None:
    seed_mirror(routed_db)
    routed_db["test_runs"].insert_one(
        make_run(
            run_id="TAS-88299",
            definition_id="TD-EM-204",
            first_data_at=datetime(2026, 8, 15, 9, 0, tzinfo=UTC),
        )
    )

    runs = _get(client, "/work-orders/WO-2026-0847").json()["runs"]

    assert [r["run_id"] for r in runs] == ["TAS-88299", "TAS-88213", "TAS-88212"]


def test_an_unknown_work_order_returns_404_wo_not_found(client, routed_db) -> None:
    seed_mirror(routed_db)

    response = _get(client, "/work-orders/WO-9999-9999")

    assert response.status_code == 404
    assert response.json()["code"] == "wo_not_found"
    assert "WO-9999-9999" in response.json()["detail"]


def test_a_work_order_without_definitions_or_runs_reads_empty(client, routed_db) -> None:
    routed_db["work_orders"].insert_one(make_work_order(wo_id="WO-2026-0900"))

    body = _get(client, "/work-orders/WO-2026-0900").json()

    assert body["definitions"] == []
    assert body["runs"] == []


# --- planning owns the content; delete is the one write ---------------------


def test_the_mirror_rejects_content_writes(client, routed_db) -> None:
    """Planning authors a work order, so no route edits one in place."""
    seed_mirror(routed_db)

    for response in (
        client.post("/api/v1/work-orders", json={"title": "x"}),
        client.put("/api/v1/work-orders/WO-2026-0847", json={"title": "x"}),
        client.patch("/api/v1/work-orders/WO-2026-0847", json={"title": "x"}),
    ):
        assert response.status_code == 405


def test_a_work_order_holding_runs_cannot_be_deleted(client, routed_db) -> None:
    """The refusal that stops a campaign holding evidence from leaving."""
    seed_mirror(routed_db)

    response = client.delete("/api/v1/work-orders/WO-2026-0847")

    assert response.status_code == 409
    assert response.json()["code"] == "work_order_has_runs"


def test_the_mirror_carries_no_field_sources(client, routed_db) -> None:
    """Planning owns every mirror field, so the UI badges them statically."""
    seed_mirror(routed_db)

    body = _get(client, "/work-orders/WO-2026-0847").json()

    assert "field_sources" not in body
