# Pagination is real logic. These tests came before the implementation.
#
# The routes that answer here read Mongo, so a test that expects a 200 asks for
# a database. The 422 cases are rejected before any read, so they need none.
#
# The paged cases state their own runs and assert literal numbers. A page count
# the test computes from the answer proves nothing: a route that always said
# zero would pass it.

from datetime import UTC, datetime, timedelta

import pytest

from tests.factories_planning import make_run

# The paged cases share one cast. 137 runs leave a part-full last page at every
# allowed page size, so an off-by-one in the page count shows.
RUN_TOTAL = 137

# page size -> the page count and the row count of page 1, both by hand.
# 500 joined the allow-list on 19 Aug 2026, so a 261-signal run fits one page.
PAGE_COUNTS = {
    10: (14, 10),
    20: (7, 20),
    50: (3, 50),
    100: (2, 100),
    200: (1, 137),
    500: (1, 137),
}


@pytest.fixture
def many_runs(routed_db):
    """137 runs and nothing else. This test states its own data."""
    start = datetime(2026, 8, 14, 9, 0, tzinfo=UTC)
    routed_db["test_runs"].insert_many(
        [
            make_run(
                run_id=f"TAS-9{index:04d}",
                first_data_at=start - timedelta(minutes=index),
            )
            for index in range(RUN_TOTAL)
        ]
    )
    return routed_db


def test_page_size_37_rejected(client):
    response = client.get("/api/v1/test-runs", params={"page_size": 37})
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert "page_size" in body["detail"]
    assert isinstance(body["errors"], list) and body["errors"]
    # The message states the whole allow-list, so a caller reads the fix in the
    # answer. A message that names one value hides the other five.
    assert "10, 20, 50, 100, 200, 500" in body["errors"][0]["msg"]


def test_page_size_500_is_the_largest_the_allow_list_holds(client, many_runs):
    """501 is a 422. The allow-list ends at 500, so nobody pulls a whole table."""
    assert client.get("/api/v1/test-runs", params={"page_size": 501}).status_code == 422
    assert client.get("/api/v1/test-runs", params={"page_size": 500}).status_code == 200


def test_page_zero_rejected(client):
    response = client.get("/api/v1/test-runs", params={"page": 0})
    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


def test_every_allowed_page_size_is_accepted(client, many_runs):
    for size, (total_pages, rows) in PAGE_COUNTS.items():
        response = client.get("/api/v1/test-runs", params={"page_size": size})
        assert response.status_code == 200, size
        body = response.json()
        assert body["page_size"] == size, size
        assert body["total"] == 137, size
        assert body["total_pages"] == total_pages, size
        assert len(body["items"]) == rows, size


def test_envelope_shape_and_total_pages(client, many_runs):
    response = client.get("/api/v1/test-runs", params={"page": 2, "page_size": 50})
    assert response.status_code == 200
    body = response.json()
    # Contract §2.4 adds ``view_counts`` to the list envelope (optional per
    # §3.6). Older callers get the same core keys plus this additive one.
    assert {"items", "total", "page", "page_size", "total_pages"}.issubset(body)
    assert body["page"] == 2
    assert body["page_size"] == 50
    assert body["total"] == 137
    assert body["total_pages"] == 3
    assert len(body["items"]) == 50


def test_the_last_page_carries_the_remainder(client, many_runs):
    """137 runs over 50 leave 37 rows on page 3. A round count hides a bug."""
    body = client.get("/api/v1/test-runs", params={"page": 3, "page_size": 50}).json()

    assert body["page"] == 3
    assert body["total_pages"] == 3
    assert len(body["items"]) == 37


def test_journal_defaults_to_page_size_50(client, seeded_db):
    response = client.get("/api/v1/test-runs/TAS-88214/journal")
    assert response.status_code == 200
    assert response.json()["page_size"] == 50
