"""Table-filters coverage for GET /test-runs (contract §2.2, §2.3, §2.4).

Owns the deep tests for the three deltas on the runs list:

* multi-value ``status``/``rig``/``project`` filters — OR within a key, AND
  across keys; single-value calls stay byte-identical to the pre-change
  behavior (regression pin — the deep-link `/runs?status=invalid` and its
  siblings must not change meaning).
* ``sort`` + ``order`` params over the whitelist ``first_data_at`` — the
  default is ``first_data_at desc`` (identical to today's fixed sort); a bad
  ``sort`` or ``order`` value returns 422 ``validation_error`` with a
  ``loc`` of ``["query", "sort" | "order"]``.
* ``view_counts`` — whole-table, filter-independent counts with keys
  ``{"all", "attention", "invalid"}``, moved by a state change on the run.

Style follows tests/test_runs_list.py exactly.
"""

from datetime import UTC, datetime, timedelta

from tests.factories_planning import make_run

BASE_AT = datetime(2026, 8, 14, 9, 0, tzinfo=UTC)


def _list(client, **params) -> dict:
    return client.get("/api/v1/test-runs", params=params or None).json()


def _seed_runs(db) -> None:
    """Four runs across two rigs, two projects and every status."""
    db["test_runs"].insert_many(
        [
            make_run(
                run_id="TAS-88214",
                description="HV battery thermal cycling",
                rig_id="RIG-04",
                project="EX90",
                status="awaiting_work_order",
                first_data_at=BASE_AT + timedelta(hours=3),
            ),
            make_run(
                run_id="TAS-88213",
                description="E-machine efficiency map",
                rig_id="RIG-02",
                project="EX90",
                status="complete",
                first_data_at=BASE_AT + timedelta(hours=2),
            ),
            make_run(
                run_id="TAS-88209",
                description="Inverter derating sweep",
                rig_id="RIG-01",
                project="EC40",
                status="invalid",
                first_data_at=BASE_AT + timedelta(hours=1),
            ),
            make_run(
                run_id="TAS-88201",
                description="Chamber soak",
                rig_id="RIG-04",
                project="EC40",
                status="complete",
                first_data_at=BASE_AT,
            ),
        ]
    )


# --- multi-value filters (§2.2) --------------------------------------------


def test_status_two_values_return_the_union_default_sorted(client, routed_db) -> None:
    _seed_runs(routed_db)

    body = _list(client, status=["awaiting_work_order", "invalid"])

    # Union of the two statuses, ordered by the default first_data_at desc.
    assert [i["run_id"] for i in body["items"]] == ["TAS-88214", "TAS-88209"]
    assert body["total"] == 2


def test_status_needs_attention_pair_matches_the_non_complete_runs(client, routed_db) -> None:
    """FE `Needs attention` quick view = status=awaiting_work_order&status=invalid."""
    _seed_runs(routed_db)

    body = _list(client, status=["awaiting_work_order", "invalid"])

    assert {i["run_id"] for i in body["items"]} == {"TAS-88214", "TAS-88209"}
    # Every returned row is truly non-complete.
    assert all(i["status"] != "complete" for i in body["items"])


def test_rig_two_values_return_the_union(client, routed_db) -> None:
    _seed_runs(routed_db)

    body = _list(client, rig=["RIG-01", "RIG-04"])

    assert {i["run_id"] for i in body["items"]} == {"TAS-88214", "TAS-88209", "TAS-88201"}
    assert body["total"] == 3


def test_project_two_values_return_the_union(client, routed_db) -> None:
    _seed_runs(routed_db)

    body = _list(client, project=["EX90", "EC40"])

    assert body["total"] == 4


def test_status_and_rig_combine_with_and(client, routed_db) -> None:
    """Multi-value within a key OR; distinct keys AND (unchanged from v1)."""
    _seed_runs(routed_db)

    body = _list(client, status=["complete", "invalid"], rig=["RIG-01", "RIG-04"])

    # complete ∩ (RIG-01 ∪ RIG-04) → TAS-88201; invalid ∩ same → TAS-88209.
    assert {i["run_id"] for i in body["items"]} == {"TAS-88201", "TAS-88209"}


def test_status_single_value_matches_pre_change_behavior(client, routed_db) -> None:
    """Regression pin: a one-value call plans as the old scalar equality did.

    Guards the #1 deep links `/runs?status=awaiting_work_order` and
    `/runs?status=invalid`, whose contract meaning must not shift.
    """
    _seed_runs(routed_db)

    assert [i["run_id"] for i in _list(client, status="invalid")["items"]] == ["TAS-88209"]
    assert [i["run_id"] for i in _list(client, status="awaiting_work_order")["items"]] == [
        "TAS-88214"
    ]
    assert {i["run_id"] for i in _list(client, status="complete")["items"]} == {
        "TAS-88213",
        "TAS-88201",
    }


def test_rig_single_value_matches_pre_change_behavior(client, routed_db) -> None:
    _seed_runs(routed_db)

    body = _list(client, rig="RIG-04")

    assert [i["run_id"] for i in body["items"]] == ["TAS-88214", "TAS-88201"]
    assert body["total"] == 2


def test_absent_filters_return_the_whole_collection(client, routed_db) -> None:
    _seed_runs(routed_db)

    body = _list(client)

    assert body["total"] == 4


def test_empty_string_status_value_is_a_422(client, routed_db) -> None:
    """A blank ``?status=`` is not a valid ``RunStatus``: never a silent match-all."""
    _seed_runs(routed_db)

    response = client.get("/api/v1/test-runs?status=")

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


# --- sort params (§2.3) -----------------------------------------------------


def test_default_sort_is_first_data_at_desc(client, routed_db) -> None:
    """Absent sort/order = the pre-change fixed sort (byte-identical)."""
    _seed_runs(routed_db)

    body = _list(client)

    assert [i["run_id"] for i in body["items"]] == [
        "TAS-88214",
        "TAS-88213",
        "TAS-88209",
        "TAS-88201",
    ]


def test_sort_first_data_at_asc_reverses_the_default(client, routed_db) -> None:
    _seed_runs(routed_db)

    body = _list(client, sort="first_data_at", order="asc")

    assert [i["run_id"] for i in body["items"]] == [
        "TAS-88201",
        "TAS-88209",
        "TAS-88213",
        "TAS-88214",
    ]


def test_sort_first_data_at_desc_matches_the_default(client, routed_db) -> None:
    _seed_runs(routed_db)

    explicit = _list(client, sort="first_data_at", order="desc")
    default = _list(client)

    assert [i["run_id"] for i in explicit["items"]] == [
        i["run_id"] for i in default["items"]
    ]


def test_ties_break_deterministically_by_id_asc(client, routed_db) -> None:
    """Two runs at the same first_data_at must not shuffle across pages."""
    tied_at = BASE_AT + timedelta(hours=5)
    routed_db["test_runs"].insert_many(
        [
            make_run(run_id="TAS-90003", first_data_at=tied_at),
            make_run(run_id="TAS-90001", first_data_at=tied_at),
            make_run(run_id="TAS-90002", first_data_at=tied_at),
        ]
    )

    body = _list(client)

    # Descending on the tied field, ascending on _id as the tiebreak.
    assert [i["run_id"] for i in body["items"]] == [
        "TAS-90001",
        "TAS-90002",
        "TAS-90003",
    ]


def test_unknown_sort_key_returns_422_validation_error(client, routed_db) -> None:
    response = client.get("/api/v1/test-runs", params={"sort": "created_at"})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert body["errors"][0]["loc"] == ["query", "sort"]


def test_bad_order_value_returns_422_validation_error(client, routed_db) -> None:
    response = client.get("/api/v1/test-runs", params={"order": "sideways"})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert body["errors"][0]["loc"] == ["query", "order"]


# --- view_counts (§2.4) -----------------------------------------------------


def test_view_counts_carries_the_three_keys(client, routed_db) -> None:
    _seed_runs(routed_db)

    view_counts = _list(client)["view_counts"]

    assert set(view_counts) == {"all", "attention", "invalid"}


def test_view_counts_match_the_seeded_data(client, routed_db) -> None:
    _seed_runs(routed_db)

    view_counts = _list(client)["view_counts"]

    # 4 runs, 2 non-complete (TAS-88214 awaiting, TAS-88209 invalid),
    # 1 invalid.
    assert view_counts == {"all": 4, "attention": 2, "invalid": 1}


def test_view_counts_are_filter_independent(client, routed_db) -> None:
    """Applying a filter must not change the whole-table counts."""
    _seed_runs(routed_db)

    unfiltered = _list(client)["view_counts"]
    filtered = _list(client, status="complete")["view_counts"]
    also_filtered = _list(client, rig=["RIG-04"], project=["EX90"])["view_counts"]

    assert filtered == unfiltered
    assert also_filtered == unfiltered


def test_view_counts_move_after_flagging_a_run_invalid(client, routed_db) -> None:
    """A state change through the API must move the segmented control counts."""
    _seed_runs(routed_db)

    before = _list(client)["view_counts"]
    assert before == {"all": 4, "attention": 2, "invalid": 1}

    # Flag one of the two currently-complete runs. TAS-88201 has a work order
    # id of None from make_run defaults... actually the seed here gives
    # work_order_id via factory defaults ("WO-2026-0847"); the flip lands
    # regardless of that field.
    response = client.post(
        "/api/v1/test-runs/TAS-88201/invalid-flag",
        json={"reason": "rehearsal reset", "actor": "e.lindqvist"},
    )
    assert response.status_code == 200

    after = _list(client)["view_counts"]
    # attention gains one (flagged run leaves complete for invalid),
    # invalid gains one, all stays.
    assert after == {"all": 4, "attention": 3, "invalid": 2}


# --- pagination combined with filter and sort (§2.2/§2.3) -------------------


def test_pagination_slices_the_filtered_sorted_result(client, routed_db) -> None:
    """Multi-value filter + non-default sort + paging = disjoint page slices."""
    # Six complete runs on RIG-04 or RIG-02, spread across a rising
    # first_data_at, plus two invalid runs that must not leak into the pages.
    for index in range(6):
        routed_db["test_runs"].insert_one(
            make_run(
                run_id=f"TAS-800{index:02d}",
                rig_id="RIG-04" if index % 2 == 0 else "RIG-02",
                status="complete",
                first_data_at=BASE_AT + timedelta(hours=index),
            )
        )
    routed_db["test_runs"].insert_many(
        [
            make_run(run_id="TAS-INVALID-1", rig_id="RIG-04", status="invalid"),
            make_run(run_id="TAS-INVALID-2", rig_id="RIG-02", status="invalid"),
        ]
    )

    params = {
        "status": "complete",
        "rig": ["RIG-04", "RIG-02"],
        "sort": "first_data_at",
        "order": "asc",
        "page_size": 10,
    }
    first = client.get("/api/v1/test-runs", params={**params, "page": 1}).json()
    second = client.get("/api/v1/test-runs", params={**params, "page": 2}).json()

    ids_page_one = [i["run_id"] for i in first["items"]]
    assert first["total"] == 6
    assert first["total_pages"] == 1
    assert ids_page_one == [
        "TAS-80000",
        "TAS-80001",
        "TAS-80002",
        "TAS-80003",
        "TAS-80004",
        "TAS-80005",
    ]
    assert second["items"] == []
    # And the invalid runs never leaked into the filtered slice.
    assert not any(name.startswith("TAS-INVALID") for name in ids_page_one)


def test_q_combines_with_filters_by_and(client, routed_db) -> None:
    """The mock's search box narrows *within* the current filter selection."""
    _seed_runs(routed_db)

    body = _list(client, rig=["RIG-04"], q="thermal")

    assert [i["run_id"] for i in body["items"]] == ["TAS-88214"]
