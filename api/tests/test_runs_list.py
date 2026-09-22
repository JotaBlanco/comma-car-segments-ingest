"""A-03 — contract #2 and #3 read the runs from Mongo.

Every filter filters. The stub ignored all seven and echoed the same page for
every request, so each one gets a test that would fail if it stopped applying.
"""

from datetime import UTC, datetime

from tests.factories_planning import make_run

RUN = "TAS-88214"


def _list(client, **params) -> dict:
    return client.get("/api/v1/test-runs", params=params or None).json()


def _seed_runs(db) -> None:
    """Four runs that differ in exactly the fields the filters use."""
    db["test_runs"].insert_many(
        [
            make_run(
                run_id=RUN,
                description="HV battery thermal cycling",
                work_order_id=None,
                definition_id=None,
                project=None,
                rig_id="RIG-04",
                status="awaiting_work_order",
                first_data_at=datetime(2026, 8, 14, 9, 41, tzinfo=UTC),
            ),
            make_run(
                run_id="TAS-88213",
                description="E-machine efficiency map",
                rig_id="RIG-02",
                first_data_at=datetime(2026, 8, 14, 8, 12, tzinfo=UTC),
            ),
            make_run(
                run_id="TAS-88209",
                description="Inverter derating sweep",
                work_order_id="WO-2026-0839",
                definition_id="TD-INV-077",
                project="EC40",
                rig_id="RIG-01",
                status="invalid",
                invalid={
                    "flagged": True,
                    "reason": "Torque flange calibration expired",
                    "actor": "e.lindqvist",
                    "at": datetime(2026, 8, 14, 12, 0, tzinfo=UTC),
                },
                first_data_at=datetime(2026, 8, 13, 17, 26, tzinfo=UTC),
            ),
            make_run(
                run_id="TAS-88201",
                description="Chamber soak",
                rig_id="RIG-04",
                first_data_at=datetime(2026, 8, 12, 7, 0, tzinfo=UTC),
            ),
        ]
    )


# --- #2 list ----------------------------------------------------------------


def test_the_list_sorts_newest_first(client, routed_db) -> None:
    """The sort is fixed: `first_data_at` descending. No sort parameter in v1."""
    _seed_runs(routed_db)

    body = _list(client)

    assert [item["run_id"] for item in body["items"]] == [
        RUN,
        "TAS-88213",
        "TAS-88209",
        "TAS-88201",
    ]
    assert body["total"] == 4


def test_the_status_filter_filters(client, routed_db) -> None:
    _seed_runs(routed_db)

    assert [i["run_id"] for i in _list(client, status="invalid")["items"]] == ["TAS-88209"]
    assert [i["run_id"] for i in _list(client, status="awaiting_work_order")["items"]] == [RUN]
    assert len(_list(client, status="complete")["items"]) == 2


def test_the_rig_filter_filters(client, routed_db) -> None:
    _seed_runs(routed_db)

    body = _list(client, rig="RIG-04")

    assert [i["run_id"] for i in body["items"]] == [RUN, "TAS-88201"]
    assert body["total"] == 2


def test_the_project_filter_filters(client, routed_db) -> None:
    _seed_runs(routed_db)

    assert [i["run_id"] for i in _list(client, project="EC40")["items"]] == ["TAS-88209"]


def test_the_definition_filter_filters(client, routed_db) -> None:
    _seed_runs(routed_db)

    assert [i["run_id"] for i in _list(client, definition="TD-INV-077")["items"]] == [
        "TAS-88209"
    ]


def test_the_work_order_filter_filters(client, routed_db) -> None:
    _seed_runs(routed_db)

    assert [i["run_id"] for i in _list(client, work_order="WO-2026-0839")["items"]] == [
        "TAS-88209"
    ]


def test_the_signal_filter_returns_the_runs_holding_that_signal(client, routed_db) -> None:
    """Drives the signal-detail screen's "view as run filter" link.

    The inventory is Lane B's collection. Reading it is allowed; writing is not.
    """
    _seed_runs(routed_db)
    routed_db["file_signals"].insert_many(
        [
            {"_id": "fs-1", "file_id": "f-1", "run_id": RUN, "name": "HV_Batt_Cell_Temp_Max"},
            {"_id": "fs-2", "file_id": "f-2", "run_id": RUN, "name": "Coolant_Inlet_Temp"},
            {
                "_id": "fs-3",
                "file_id": "f-3",
                "run_id": "TAS-88201",
                "name": "HV_Batt_Cell_Temp_Max",
            },
        ]
    )

    body = _list(client, signal="HV_Batt_Cell_Temp_Max")

    assert [i["run_id"] for i in body["items"]] == [RUN, "TAS-88201"]
    assert body["total"] == 2


def test_an_unseen_signal_matches_nothing(client, routed_db) -> None:
    _seed_runs(routed_db)

    body = _list(client, signal="Nothing_Recorded_This")

    assert body["items"] == []
    assert body["total"] == 0


def test_q_searches_the_id_description_rig_definition_and_work_order(
    client, routed_db
) -> None:
    _seed_runs(routed_db)

    assert [i["run_id"] for i in _list(client, q="88209")["items"]] == ["TAS-88209"]
    assert [i["run_id"] for i in _list(client, q="thermal")["items"]] == [RUN]
    assert [i["run_id"] for i in _list(client, q="RIG-02")["items"]] == ["TAS-88213"]
    assert [i["run_id"] for i in _list(client, q="TD-INV")["items"]] == ["TAS-88209"]
    assert [i["run_id"] for i in _list(client, q="WO-2026-0839")["items"]] == ["TAS-88209"]


def test_q_searches_the_project(client, routed_db) -> None:
    """API MINOR 19: `q=EC40` must find what `project=EC40` finds."""
    _seed_runs(routed_db)

    assert [i["run_id"] for i in _list(client, q="EC40")["items"]] == ["TAS-88209"]
    assert [i["run_id"] for i in _list(client, q="EC40 inverter")["items"]] == ["TAS-88209"]


def test_q_is_case_insensitive(client, routed_db) -> None:
    _seed_runs(routed_db)

    assert [i["run_id"] for i in _list(client, q="THERMAL")["items"]] == [RUN]


def test_q_words_match_in_any_order(client, routed_db) -> None:
    """Guard test 7 word-AND: every word must match, in any order, any field."""
    _seed_runs(routed_db)

    assert [i["run_id"] for i in _list(client, q="thermal battery")["items"]] == [RUN]
    assert [i["run_id"] for i in _list(client, q="battery thermal")["items"]] == [RUN]
    assert [i["run_id"] for i in _list(client, q="thermal RIG-04")["items"]] == [RUN]


def test_q_treats_a_regex_metacharacter_as_text(client, routed_db) -> None:
    _seed_runs(routed_db)

    response = client.get("/api/v1/test-runs", params={"q": "("})

    assert response.status_code == 200
    assert response.json()["items"] == []


def test_the_filters_combine_with_and(client, routed_db) -> None:
    _seed_runs(routed_db)

    body = _list(client, rig="RIG-04", status="complete")

    assert [i["run_id"] for i in body["items"]] == ["TAS-88201"]


def test_page_two_returns_different_rows(client, routed_db) -> None:
    """The stub echoed page one for every page — the conformance review's M3."""
    _seed_runs(routed_db)

    first = _list(client, page=1, page_size=10)
    second = _list(client, page=2, page_size=10)

    assert len(first["items"]) == 4
    assert second["items"] == []
    assert first["total_pages"] == 1


def test_the_page_slice_walks_the_whole_set(client, routed_db) -> None:
    _seed_runs(routed_db)

    first = _list(client, page=1, page_size=20)

    assert first["page_size"] == 20
    assert first["total"] == 4
    assert next(i["run_id"] for i in first["items"]) == RUN


def test_an_empty_collection_lists_nothing(client, routed_db) -> None:
    body = _list(client)

    assert body["items"] == []
    assert body["total"] == 0
    assert body["total_pages"] == 0


def test_a_list_row_carries_the_invalid_block(client, routed_db) -> None:
    _seed_runs(routed_db)

    row = next(i for i in _list(client)["items"] if i["run_id"] == "TAS-88209")

    assert row["invalid"]["flagged"] is True
    assert row["invalid"]["reason"] == "Torque flange calibration expired"


# --- #3 detail --------------------------------------------------------------


def test_the_detail_returns_the_full_body(client, routed_db) -> None:
    _seed_runs(routed_db)

    body = client.get(f"/api/v1/test-runs/{RUN}").json()

    assert body["run_id"] == RUN
    assert body["rig_id"] == "RIG-04"
    assert body["status"] == "awaiting_work_order"
    assert "field_sources" in body
    assert body["created_at"].endswith("Z")


def test_the_detail_counts_results_and_journal_entries(client, routed_db) -> None:
    _seed_runs(routed_db)
    routed_db["processed_results"].insert_one(
        {"_id": "res-1", "run_id": RUN, "result_key": "thermal_summary", "version": 1}
    )
    routed_db["journal_entries"].insert_many(
        [
            {"_id": "j-1", "entity_type": "run", "entity_id": RUN, "kind": "event"},
            {"_id": "j-2", "entity_type": "run", "entity_id": RUN, "kind": "change"},
        ]
    )

    body = client.get(f"/api/v1/test-runs/{RUN}").json()

    assert body["result_count"] == 1
    assert body["journal_count"] == 2


def test_the_journal_count_includes_signal_edits_made_in_run_context(
    client, routed_db
) -> None:
    """A unit edit made from the run screen belongs to that run's timeline."""
    _seed_runs(routed_db)
    routed_db["journal_entries"].insert_many(
        [
            {"_id": "j-1", "entity_type": "run", "entity_id": RUN, "kind": "event"},
            {
                "_id": "j-2",
                "entity_type": "signal",
                "entity_id": "Coolant_Inlet_Temp",
                "kind": "change",
                "context_run_id": RUN,
            },
        ]
    )

    body = client.get(f"/api/v1/test-runs/{RUN}").json()

    assert body["journal_count"] == 2


def test_the_counts_are_zero_without_results_or_journal(client, routed_db) -> None:
    _seed_runs(routed_db)

    body = client.get(f"/api/v1/test-runs/{RUN}").json()

    assert body["result_count"] == 0
    assert body["journal_count"] == 0


def test_an_unknown_run_returns_404_run_not_found(client, routed_db) -> None:
    _seed_runs(routed_db)

    response = client.get("/api/v1/test-runs/TAS-99999")

    assert response.status_code == 404
    assert response.json()["code"] == "run_not_found"
    assert "TAS-99999" in response.json()["detail"]


def test_the_detail_and_the_list_agree_about_one_run(client, routed_db) -> None:
    """One run, two endpoints, no disagreement — the FE reads both."""
    _seed_runs(routed_db)

    row = next(i for i in _list(client)["items"] if i["run_id"] == RUN)
    detail = client.get(f"/api/v1/test-runs/{RUN}").json()

    for field in ("run_id", "description", "rig_id", "status", "first_data_at"):
        assert row[field] == detail[field]
