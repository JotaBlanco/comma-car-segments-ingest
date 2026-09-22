"""A-08 — contract #19, `GET /search`.

One box over six collections. The query is text, never a pattern: a lone
bracket is a search for a bracket, not a broken regex (guard test 7).
"""

from tests.factories_planning import make_definition, make_run, make_work_order
from tests.factories_results import seed_result


def _search(client, q: str, **params):
    return client.get("/api/v1/search", params={"q": q, **params})


def _seed(db) -> None:
    db["test_runs"].insert_many(
        [
            make_run(run_id="TAS-88214", description="HV battery thermal cycling", rig_id="RIG-04"),
            make_run(run_id="TAS-88213", description="E-machine efficiency map", rig_id="RIG-02"),
        ]
    )
    db["work_orders"].insert_one(
        make_work_order(wo_id="WO-2026-0847", title="E-machine efficiency characterisation")
    )
    db["files"].insert_one(
        {
            "_id": "f-1",
            "filename": "bat_cyc_20260814_0941.mf4",
            "run_id": "TAS-88214",
            "checksum_sha256": "9f2c8a41",
            "status": "registered",
            "size_bytes": 1_331_439_862,
            "source_system": "TAS",
        }
    )
    db["signals"].insert_one(
        {"_id": "HV_Batt_Cell_Temp_Max", "description": "cell temperature, maximum"}
    )
    db["test_definitions"].insert_one(
        make_definition(title="Coolant loop characterisation")
    )
    seed_result(db)


def _groups(body: dict) -> dict:
    return {group["type"]: group["items"] for group in body["groups"]}


def test_the_search_groups_hits_by_type(client, routed_db) -> None:
    _seed(routed_db)

    groups = _groups(_search(client, "88214").json())

    assert "test_runs" in groups
    assert groups["test_runs"][0]["id"] == "TAS-88214"


def test_it_reads_all_six_collections(client, routed_db) -> None:
    _seed(routed_db)

    assert "test_runs" in _groups(_search(client, "TAS-88214").json())
    assert "work_orders" in _groups(_search(client, "WO-2026-0847").json())
    assert "files" in _groups(_search(client, "bat_cyc").json())
    assert "signals" in _groups(_search(client, "HV_Batt").json())
    assert "test_definitions" in _groups(_search(client, "TD-EM-201").json())
    assert "processed_results" in _groups(_search(client, "thermal_summary").json())


def test_one_query_can_match_several_types(client, routed_db) -> None:
    """"E-machine" names both a run and a work order."""
    _seed(routed_db)

    groups = _groups(_search(client, "E-machine").json())

    assert set(groups) == {"test_runs", "work_orders"}


def test_the_match_is_case_insensitive(client, routed_db) -> None:
    _seed(routed_db)

    assert _groups(_search(client, "THERMAL").json())["test_runs"][0]["id"] == "TAS-88214"


def test_regex_metachar_returns_200_no_match(client, routed_db) -> None:
    """Guard test 7. A lone bracket is text, not a pattern."""
    _seed(routed_db)

    response = _search(client, "(")

    assert response.status_code == 200
    assert response.json()["groups"] == []


def test_a_query_that_matches_nothing_returns_no_groups(client, routed_db) -> None:
    _seed(routed_db)

    body = _search(client, "unobtainium").json()

    assert body["groups"] == []
    assert body["query"] == "unobtainium"


def test_an_empty_query_is_rejected(client, routed_db) -> None:
    _seed(routed_db)

    assert _search(client, "").status_code == 422


def test_each_group_caps_at_the_limit(client, routed_db) -> None:
    _seed(routed_db)
    for index in range(12):
        routed_db["test_runs"].insert_one(
            make_run(run_id=f"TAS-770{index:02d}", description="capped set")
        )

    groups = _groups(_search(client, "capped", limit_per_group=4).json())

    assert len(groups["test_runs"]) == 4


def test_the_limit_has_a_ceiling(client, routed_db) -> None:
    _seed(routed_db)

    assert _search(client, "TAS", limit_per_group=50).status_code == 422


def test_a_hit_carries_what_the_screen_needs(client, routed_db) -> None:
    _seed(routed_db)

    hit = _groups(_search(client, "TAS-88214").json())["test_runs"][0]

    assert hit["id"] == "TAS-88214"
    assert hit["sub"]
    assert hit["nav"]


# --- contract #19 hit shapes -------------------------------------------------


def test_a_run_hit_matches_the_contract_shape(client, routed_db) -> None:
    _seed(routed_db)

    hit = _groups(_search(client, "88214").json())["test_runs"][0]

    assert set(hit) == {"id", "sub", "status", "nav"}
    assert hit["id"] == "TAS-88214"
    assert hit["sub"] == "HV battery thermal cycling · RIG-04"
    assert hit["nav"] == {"run_id": "TAS-88214"}


def test_a_work_order_hit_matches_the_contract_shape(client, routed_db) -> None:
    _seed(routed_db)

    hit = _groups(_search(client, "WO-2026-0847").json())["work_orders"][0]

    assert set(hit) == {"id", "sub", "status", "nav"}
    assert hit["id"] == "WO-2026-0847"
    assert hit["sub"] == "E-machine efficiency characterisation · EX90"
    assert hit["nav"] == {"wo_id": "WO-2026-0847"}


def test_a_file_hit_names_the_filename_and_navigates_by_file_id(client, routed_db) -> None:
    """Contract #19: the id is what the reader recognizes, the nav is the key."""
    _seed(routed_db)

    hit = _groups(_search(client, "bat_cyc").json())["files"][0]

    assert set(hit) == {"id", "sub", "status", "nav"}
    assert hit["id"] == "bat_cyc_20260814_0941.mf4"
    assert hit["sub"] == "TAS-88214 · 1.24 GB · TAS"
    assert hit["nav"] == {"file_id": "f-1"}


def test_a_definition_hit_matches_the_contract_shape(client, routed_db) -> None:
    """Contract #19: the nav key is the runs-list filter, because no detail route exists."""
    _seed(routed_db)

    hit = _groups(_search(client, "TD-EM-201").json())["test_definitions"][0]

    assert set(hit) == {"id", "sub", "status", "nav"}
    assert hit["id"] == "TD-EM-201"
    assert hit["sub"] == "Coolant loop characterisation · WO-2026-0847"
    assert hit["nav"] == {"definition": "TD-EM-201"}


def test_a_definition_is_found_by_its_title(client, routed_db) -> None:
    _seed(routed_db)

    hits = _groups(_search(client, "Coolant").json())["test_definitions"]

    assert [hit["id"] for hit in hits] == ["TD-EM-201"]


def test_a_result_hit_names_the_file_and_navigates_to_its_run(client, routed_db) -> None:
    """Contract #19: a result has no detail route, so its nav names the run."""
    _seed(routed_db)

    hit = _groups(_search(client, "thermal_summary_v1").json())["processed_results"][0]

    assert set(hit) == {"id", "sub", "status", "nav"}
    assert hit["id"] == "thermal_summary_v1.parquet"
    assert hit["sub"] == "TAS-88214 · v1"
    assert hit["status"] == "verified"
    assert hit["nav"] == {"run_id": "TAS-88214"}


def test_a_result_is_found_by_its_result_key(client, routed_db) -> None:
    _seed(routed_db)

    hits = _groups(_search(client, "thermal_summary").json())["processed_results"]

    assert [hit["id"] for hit in hits] == ["thermal_summary_v1.parquet"]


def test_a_two_word_query_reaches_the_new_groups(client, routed_db) -> None:
    """Guard test 7 word-AND holds for the two collections added on 19 Aug 2026."""
    _seed(routed_db)

    definitions = _groups(_search(client, "Coolant WO-2026-0847").json())
    results = _groups(_search(client, "TAS-88214 thermal_summary").json())

    assert [hit["id"] for hit in definitions["test_definitions"]] == ["TD-EM-201"]
    assert [hit["id"] for hit in results["processed_results"]] == [
        "thermal_summary_v1.parquet"
    ]
    assert _groups(_search(client, "Coolant unobtainium").json()) == {}


def test_a_signal_hit_navigates_by_name(client, routed_db) -> None:
    _seed(routed_db)

    hit = _groups(_search(client, "HV_Batt").json())["signals"][0]

    assert set(hit) == {"id", "sub", "status", "nav"}
    assert hit["id"] == "HV_Batt_Cell_Temp_Max"
    assert hit["nav"] == {"name": "HV_Batt_Cell_Temp_Max"}


# --- blank and multi-word queries --------------------------------------------


def test_a_whitespace_query_answers_no_groups(client, routed_db) -> None:
    """A lone space passes min_length, but a blank needle must not match the world."""
    _seed(routed_db)

    response = _search(client, " ")

    assert response.status_code == 200
    assert response.json()["groups"] == []


def test_words_match_in_any_order(client, routed_db) -> None:
    """Guard test 7 word-AND: `battery thermal` and `thermal battery` agree."""
    _seed(routed_db)

    one = _groups(_search(client, "thermal battery").json())
    other = _groups(_search(client, "battery thermal").json())

    assert [i["id"] for i in one["test_runs"]] == ["TAS-88214"]
    assert one == other


def test_words_may_match_different_fields(client, routed_db) -> None:
    """One word hits the description, the other hits the rig."""
    _seed(routed_db)

    groups = _groups(_search(client, "battery RIG-04").json())

    assert [i["id"] for i in groups["test_runs"]] == ["TAS-88214"]


def test_a_blank_q_on_the_runs_list_filters_nothing(client, routed_db) -> None:
    """A blank q adds no clause, so the list keeps its full page."""
    _seed(routed_db)

    body = client.get("/api/v1/test-runs", params={"q": " "}).json()

    assert body["total"] == 2


def test_a_blank_q_on_the_work_orders_list_filters_nothing(client, routed_db) -> None:
    _seed(routed_db)

    body = client.get("/api/v1/work-orders", params={"q": " "}).json()

    assert body["total"] == 1
