"""Contract #19 ranking — FR-DM-015 "ranked by relevance", UC-003 step 2.

The search gathers six groups and used to answer them in database order, so an
exact test id could sit below a partial match. The ranking reorders a group.
It never drops a hit.
"""

from api.services.query_text import rank_by_relevance, relevance_band
from tests.factories_planning import make_run

RANKING_RUNS = [
    # Database order puts the partial matches first on purpose.
    make_run(run_id="PRE-TAS-88214", description="preparation run"),
    make_run(run_id="TAS-88214-RERUN", description="rerun of the cycle"),
    make_run(run_id="TAS-88214", description="HV battery thermal cycling"),
    make_run(run_id="TAS-90001", description="a note about TAS-88214"),
]


def _search(client, q: str, **params):
    return client.get("/api/v1/search", params={"q": q, **params})


def _run_ids(body: dict) -> list[str]:
    for group in body["groups"]:
        if group["type"] == "test_runs":
            return [item["id"] for item in group["items"]]
    return []


# --- the pure function -------------------------------------------------------


def test_the_band_orders_exact_prefix_substring_and_other() -> None:
    assert relevance_band("TAS-88214", "TAS-88214") == 0
    assert relevance_band("TAS-88214", "TAS-88214-RERUN") == 1
    assert relevance_band("TAS-88214", "PRE-TAS-88214") == 2
    assert relevance_band("TAS-88214", "TAS-90001") == 3


def test_the_band_ignores_case_and_surrounding_space() -> None:
    assert relevance_band("  tas-88214 ", "TAS-88214") == 0


def test_a_blank_query_bands_everything_the_same() -> None:
    assert relevance_band("   ", "TAS-88214") == 3


def test_a_missing_identifier_bands_last() -> None:
    assert relevance_band("TAS-88214", "") == 3


def test_the_ranking_keeps_every_item() -> None:
    items = [{"id": name} for name in ["b-2", "TAS-88214", "a-1", "TAS-88214-RERUN"]]

    ranked = rank_by_relevance("TAS-88214", items)

    assert sorted(item["id"] for item in ranked) == sorted(item["id"] for item in items)
    assert len(ranked) == len(items)


def test_one_band_keeps_the_order_it_arrived_in() -> None:
    items = [{"id": "z-other"}, {"id": "y-other"}, {"id": "x-other"}]

    ranked = rank_by_relevance("TAS-88214", items)

    assert [item["id"] for item in ranked] == ["z-other", "y-other", "x-other"]


def test_an_empty_list_ranks_to_an_empty_list() -> None:
    assert rank_by_relevance("TAS-88214", []) == []


# --- the route ---------------------------------------------------------------


def test_the_exact_test_id_ranks_first(client, routed_db) -> None:
    routed_db["test_runs"].insert_many(RANKING_RUNS)

    assert _run_ids(_search(client, "TAS-88214").json())[0] == "TAS-88214"


def test_a_prefix_match_beats_a_match_anywhere(client, routed_db) -> None:
    routed_db["test_runs"].insert_many(RANKING_RUNS)

    ids = _run_ids(_search(client, "TAS-88214").json())

    assert ids.index("TAS-88214-RERUN") < ids.index("PRE-TAS-88214")
    assert ids.index("PRE-TAS-88214") < ids.index("TAS-90001")


def test_the_same_query_answers_the_same_order_twice(client, routed_db) -> None:
    routed_db["test_runs"].insert_many(RANKING_RUNS)

    first = _search(client, "TAS-88214").json()
    second = _search(client, "TAS-88214").json()

    assert first == second


def test_the_ranking_drops_no_hit(client, routed_db) -> None:
    routed_db["test_runs"].insert_many(RANKING_RUNS)

    ids = _run_ids(_search(client, "TAS-88214", limit_per_group=10).json())

    assert sorted(ids) == sorted(run["_id"] for run in RANKING_RUNS)


def test_a_blank_query_still_answers_no_groups(client, routed_db) -> None:
    routed_db["test_runs"].insert_many(RANKING_RUNS)

    response = _search(client, " ")

    assert response.status_code == 200
    assert response.json()["groups"] == []


def test_the_ranking_reaches_the_other_groups(client, routed_db) -> None:
    """A filename hit ranks by the filename the reader sees."""
    routed_db["files"].insert_many(
        [
            {"_id": "f-2", "filename": "pre_bat_cyc.mf4", "status": "registered"},
            {"_id": "f-1", "filename": "bat_cyc.mf4", "status": "registered"},
        ]
    )

    body = _search(client, "bat_cyc.mf4").json()
    files = next(g for g in body["groups"] if g["type"] == "files")

    assert [item["id"] for item in files["items"]] == ["bat_cyc.mf4", "pre_bat_cyc.mf4"]
