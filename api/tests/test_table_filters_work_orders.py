"""Table-filters coverage for GET /work-orders (contract §2.2, §2.3, §2.4).

* multi-value ``status`` / ``project`` — OR within a key, AND across keys;
  single-value calls stay byte-identical.
* **No sort params** (decision box 2, closed — the "light treatment"):
  sending ``sort`` OR ``order`` → 422 ``validation_error`` with a
  ``["query", ...]`` loc.
* view_counts keys ``{"all", "active", "closed"}`` — whole-table and
  filter-independent.

Style follows tests/test_work_orders.py exactly.
"""

from tests.factories_planning import make_work_order, seed_mirror


def _get(client, **params):
    response = client.get("/api/v1/work-orders", params=params or None)
    return response


def _wos(body: dict) -> list[str]:
    return [item["wo_id"] for item in body["items"]]


def _seed_wos(db) -> None:
    """Four work orders across two statuses and three projects."""
    db["work_orders"].insert_many(
        [
            make_work_order(
                wo_id="WO-2026-0847", project="EX90", status="active"
            ),
            make_work_order(
                wo_id="WO-2026-0839", project="EC40", status="closed"
            ),
            make_work_order(
                wo_id="WO-2026-0812", project="EC40", status="active"
            ),
            make_work_order(
                wo_id="WO-2026-0801", project="XC90", status="closed"
            ),
        ]
    )


# --- multi-value filters (§2.2) --------------------------------------------


def test_status_two_values_return_the_union(client, routed_db) -> None:
    _seed_wos(routed_db)

    body = _get(client, status=["active", "closed"]).json()

    assert body["total"] == 4


def test_project_two_values_return_the_union(client, routed_db) -> None:
    _seed_wos(routed_db)

    body = _get(client, project=["EX90", "EC40"]).json()

    assert set(_wos(body)) == {"WO-2026-0847", "WO-2026-0839", "WO-2026-0812"}


def test_status_and_project_combine_with_and(client, routed_db) -> None:
    _seed_wos(routed_db)

    body = _get(client, status="active", project=["EX90", "EC40"]).json()

    assert set(_wos(body)) == {"WO-2026-0847", "WO-2026-0812"}


def test_status_single_value_matches_pre_change_behavior(client, routed_db) -> None:
    _seed_wos(routed_db)

    body = _get(client, status="closed").json()

    assert set(_wos(body)) == {"WO-2026-0839", "WO-2026-0801"}
    assert body["total"] == 2


def test_project_single_value_matches_pre_change_behavior(client, routed_db) -> None:
    _seed_wos(routed_db)

    body = _get(client, project="EX90").json()

    assert _wos(body) == ["WO-2026-0847"]


def test_absent_filters_return_the_whole_collection(client, routed_db) -> None:
    _seed_wos(routed_db)

    body = _get(client).json()

    assert body["total"] == 4


# --- no sort params (§2.3, decision box 2 CLOSED) --------------------------


def test_sort_param_returns_422_validation_error(client, routed_db) -> None:
    """The light-treatment table has no sort; sending it → 422 (never 400)."""
    response = client.get("/api/v1/work-orders", params={"sort": "wo_id"})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert body["errors"][0]["loc"] == ["query", "sort"]


def test_order_param_returns_422_validation_error(client, routed_db) -> None:
    response = client.get("/api/v1/work-orders", params={"order": "asc"})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert body["errors"][0]["loc"] == ["query", "order"]


def test_sort_and_order_together_return_422(client, routed_db) -> None:
    response = client.get("/api/v1/work-orders", params={"sort": "wo_id", "order": "asc"})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    # The dependency reports whichever param it validates first; both are
    # unacceptable, so the loc names one of them.
    assert body["errors"][0]["loc"][0] == "query"
    assert body["errors"][0]["loc"][1] in ("sort", "order")


# --- view_counts (§2.4) -----------------------------------------------------


def test_view_counts_carries_the_three_keys(client, routed_db) -> None:
    _seed_wos(routed_db)

    view_counts = _get(client).json()["view_counts"]

    assert set(view_counts) == {"all", "active", "closed"}


def test_view_counts_match_the_seeded_data(client, routed_db) -> None:
    _seed_wos(routed_db)

    view_counts = _get(client).json()["view_counts"]

    assert view_counts == {"all": 4, "active": 2, "closed": 2}


def test_view_counts_are_filter_independent(client, routed_db) -> None:
    """Applying a filter must not change the whole-table counts."""
    _seed_wos(routed_db)

    unfiltered = _get(client).json()["view_counts"]
    filtered = _get(client, status="active").json()["view_counts"]
    also_filtered = _get(client, project=["EC40"]).json()["view_counts"]

    assert filtered == unfiltered
    assert also_filtered == unfiltered


def test_view_counts_carry_the_full_seed_mirror(client, routed_db) -> None:
    """Sanity across the two-work-order mirror the golden requests seed."""
    seed_mirror(routed_db)

    view_counts = _get(client).json()["view_counts"]

    assert view_counts["all"] == view_counts["active"] + view_counts["closed"]
    assert view_counts["all"] == 2
    assert view_counts["active"] == 1
    assert view_counts["closed"] == 1


# --- pagination + filter (§2.2) --------------------------------------------


def test_pagination_slices_the_filtered_result(client, routed_db) -> None:
    """Filter + paging = disjoint slices; total reflects the filter."""
    active_wos = [
        make_work_order(wo_id=f"WO-2026-{index:04d}", project="EX90", status="active")
        for index in range(12)
    ]
    closed_wos = [
        make_work_order(wo_id=f"WO-2025-{index:04d}", project="EX90", status="closed")
        for index in range(5)
    ]
    routed_db["work_orders"].insert_many(active_wos + closed_wos)

    first = _get(client, status="active", page=1, page_size=10).json()
    second = _get(client, status="active", page=2, page_size=10).json()

    assert first["total"] == 12
    assert first["total_pages"] == 2
    assert len(first["items"]) == 10
    assert len(second["items"]) == 2
    first_ids = set(_wos(first))
    second_ids = set(_wos(second))
    assert first_ids.isdisjoint(second_ids)
    # And no closed work order leaks into either page.
    for wo_id in first_ids | second_ids:
        assert wo_id.startswith("WO-2026-")


def test_q_combines_with_filters_by_and(client, routed_db) -> None:
    """The mock's search box narrows *within* the current filter selection."""
    seed_mirror(routed_db)

    body = _get(client, status="closed", q="inverter").json()

    assert _wos(body) == ["WO-2026-0839"]
