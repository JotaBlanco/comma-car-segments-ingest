"""R-07 — the work-orders list must open on the active campaign.

The screen has no sort control (decision box 2, closed), so the server order
is the only order a user sees. The demo holds 42 work orders and one of them
is active. An ascending id sort put that row last on the last page, and the
first screen showed 20 rows of closed filler.

The list now sorts on the id, highest first. The active campaign carries the
highest id, so it is the first row of page one.

Style follows tests/test_work_orders.py.
"""

from tests.factories_planning import make_work_order

# The demo scale: 42 mirrored work orders, one of them active.
FILLER_COUNT = 41
ACTIVE_WO = "WO-2026-0847"


def _list(client, **params) -> dict:
    return client.get("/api/v1/work-orders", params=params or None).json()


def _seed_42_work_orders(db) -> None:
    """41 closed campaigns with lower ids, plus the one active campaign."""
    filler = [
        make_work_order(
            wo_id=f"WO-2025-{index:04d}",
            title=f"Closed campaign {index}",
            status="closed",
        )
        for index in range(FILLER_COUNT)
    ]
    db["work_orders"].insert_many(
        filler
        + [
            make_work_order(
                wo_id=ACTIVE_WO,
                title="E-machine efficiency characterisation",
                status="active",
            )
        ]
    )


def test_the_active_work_order_is_the_first_row_of_page_one(client, routed_db) -> None:
    _seed_42_work_orders(routed_db)

    body = _list(client)

    assert body["total"] == 42
    assert body["items"][0]["wo_id"] == ACTIVE_WO
    assert body["items"][0]["status"] == "active"


def test_the_list_sorts_the_ids_highest_first(client, routed_db) -> None:
    _seed_42_work_orders(routed_db)

    ids = [item["wo_id"] for item in _list(client)["items"]]

    assert ids == sorted(ids, reverse=True)


def test_no_page_holds_a_row_twice(client, routed_db) -> None:
    """A stable order must not repeat a row across the pages."""
    _seed_42_work_orders(routed_db)

    seen = []
    for page in (1, 2, 3):
        seen += [item["wo_id"] for item in _list(client, page=page, page_size=20)["items"]]

    assert len(seen) == 42
    assert len(set(seen)) == 42


def test_a_filter_keeps_the_highest_first_order(client, routed_db) -> None:
    _seed_42_work_orders(routed_db)

    ids = [item["wo_id"] for item in _list(client, status="closed")["items"]]

    assert ids[0] == "WO-2025-0040"
    assert ids == sorted(ids, reverse=True)
