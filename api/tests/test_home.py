"""A-08 — contract #1, `GET /home/summary`.

The Home screen is one round trip. Every count is live, because a stale count
on the opening frame of the demo is the cheapest possible way to look wrong.
"""

from datetime import UTC, datetime, timedelta

from tests.factories_planning import make_definition, make_run, make_work_order

NOW = datetime.now(UTC)

# Today's records anchor to the day's START, not to the clock. Seeding at
# "NOW minus two hours" broke the today-counts between 00:00 and 02:00 UTC
# (review finding). The counts have both bounds, so a same-day future
# timestamp still counts as today at any run time.
MIDNIGHT = NOW.replace(hour=0, minute=0, second=0, microsecond=0)


def _summary(client) -> dict:
    return client.get("/api/v1/home/summary").json()


def _seed(db) -> None:
    db["test_runs"].insert_many(
        [
            make_run(
                run_id="TAS-88214",
                work_order_id=None,
                status="awaiting_work_order",
                rig_id="RIG-04",
                first_data_at=MIDNIGHT + timedelta(hours=2),
            ),
            make_run(
                run_id="TAS-88213", rig_id="RIG-02", first_data_at=MIDNIGHT + timedelta(hours=1)
            ),
            make_run(
                run_id="TAS-88209",
                rig_id="RIG-01",
                status="invalid",
                invalid={"flagged": True, "reason": "drift", "actor": "e.lindqvist", "at": NOW},
                first_data_at=MIDNIGHT - timedelta(days=3),
            ),
        ]
    )
    db["work_orders"].insert_one(make_work_order())
    db["files"].insert_many(
        [
            {
                "_id": "f-1",
                "run_id": "TAS-88214",
                "status": "registered",
                "registered_at": MIDNIGHT + timedelta(hours=1),
            },
            {
                "_id": "f-2",
                "run_id": None,
                "status": "quarantined",
                "registered_at": MIDNIGHT - timedelta(days=5),
            },
        ]
    )
    db["signals"].insert_many([{"_id": "SigA"}, {"_id": "SigB"}])


def test_the_counts_are_live(client, routed_db) -> None:
    _seed(routed_db)

    counts = _summary(client)["counts"]

    assert counts["test_runs"] == 3
    assert counts["files"] == 2
    assert counts["signals"] == 2
    assert counts["work_orders"] == 1
    assert counts["test_definitions"] == 0, "the seed mirrors no definition"


def test_a_new_run_moves_the_count(client, routed_db) -> None:
    """The stub returned a fixed number. A live count has to react."""
    _seed(routed_db)
    before = _summary(client)["counts"]["test_runs"]

    client.post("/api/v1/test-runs", json={"run_id": "TAS-99001", "rig_id": "RIG-07"})

    assert _summary(client)["counts"]["test_runs"] == before + 1


def test_today_counts_only_today(client, routed_db) -> None:
    """`runs_today` compares against the server's current UTC date (v1.1)."""
    _seed(routed_db)

    counts = _summary(client)["counts"]

    assert counts["runs_today"] == 2, "the third run arrived three days ago"
    assert counts["files_today"] == 1


def test_a_future_dated_document_does_not_count_as_today(client, routed_db) -> None:
    """Today has two ends. A clock-skewed future document stays out of both counts."""
    _seed(routed_db)
    routed_db["test_runs"].insert_one(
        make_run(run_id="TAS-99900", first_data_at=MIDNIGHT + timedelta(days=2))
    )
    routed_db["files"].insert_one(
        {
            "_id": "f-9",
            "run_id": None,
            "status": "registered",
            "registered_at": MIDNIGHT + timedelta(days=2),
        }
    )

    counts = _summary(client)["counts"]

    assert counts["runs_today"] == 2
    assert counts["files_today"] == 1


def test_the_rig_count_is_distinct(client, routed_db) -> None:
    _seed(routed_db)

    assert _summary(client)["counts"]["rig_count"] == 3


def test_needs_attention_counts_the_three_states(client, routed_db) -> None:
    _seed(routed_db)

    attention = _summary(client)["needs_attention"]

    assert attention["awaiting_work_order"] == 1
    assert attention["quarantined_files"] == 1
    assert attention["invalid_runs"] == 1


def test_the_definition_count_holds_the_whole_mirror(client, routed_db) -> None:
    """The sidebar reads this count. It pages the same set `/test-definitions` does.

    Two of the three below are orphans. The count takes all three, because the
    list screen shows all three when nobody sets the `orphaned` filter.
    """
    _seed(routed_db)
    routed_db["test_definitions"].insert_many(
        [
            make_definition(td_id="TD-EM-201", work_order_id="WO-2026-0847"),
            make_definition(td_id="TD-EM-900", work_order_id=None),
            make_definition(td_id="TD-EM-901", work_order_id="WO-2026-9999"),
        ]
    )

    assert _summary(client)["counts"]["test_definitions"] == 3


def test_needs_attention_counts_the_orphaned_definitions(client, routed_db) -> None:
    """TR-001. A definition with no work order behind it waits for a person.

    Two shapes are orphaned: a null `work_order_id`, and an id that names no
    mirrored work order. The third definition below is linked, so it stays out.
    """
    _seed(routed_db)
    routed_db["test_definitions"].insert_many(
        [
            make_definition(td_id="TD-EM-201", work_order_id="WO-2026-0847"),
            make_definition(td_id="TD-EM-900", work_order_id=None),
            make_definition(td_id="TD-EM-901", work_order_id="WO-2026-9999"),
        ]
    )

    attention = _summary(client)["needs_attention"]

    assert attention["orphaned_definitions"] == 2


def test_attention_rows_name_the_entities_behind_each_count(client, routed_db) -> None:
    """The panel prints the rows, not only the counts, so a person can act."""
    _seed(routed_db)
    routed_db["test_definitions"].insert_many(
        [
            make_definition(td_id="TD-EM-201", work_order_id="WO-2026-0847"),
            make_definition(td_id="TD-EM-900", work_order_id=None, title="Coastdown"),
        ]
    )

    rows = _summary(client)["attention_rows"]

    assert rows["awaiting_work_order"] == [
        {"run_id": "TAS-88214", "rig_id": "RIG-04", "reason": None}
    ]
    assert rows["invalid_runs"] == [
        {"run_id": "TAS-88209", "rig_id": "RIG-01", "reason": "drift"}
    ]
    assert rows["quarantined_files"] == [
        {"file_id": "f-2", "filename": None, "quarantine_reason": None}
    ]
    assert rows["orphaned_definitions"] == [{"td_id": "TD-EM-900", "title": "Coastdown"}]


def test_attention_rows_cap_at_three_and_the_count_stays_the_total(client, routed_db) -> None:
    """The cap trims the rows only. The count beside them stays true, so the
    panel can say how many rows it holds back."""
    _seed(routed_db)
    for index in range(4):
        routed_db["test_runs"].insert_one(
            make_run(
                run_id=f"TAS-7000{index}",
                work_order_id=None,
                status="awaiting_work_order",
                first_data_at=MIDNIGHT + timedelta(hours=20, minutes=index),
            )
        )

    body = _summary(client)

    assert body["needs_attention"]["awaiting_work_order"] == 5
    rows = body["attention_rows"]["awaiting_work_order"]
    assert len(rows) == 3
    assert rows[0]["run_id"] == "TAS-70003", "newest arrival first"


def test_attention_rows_are_empty_on_an_empty_database(client, routed_db) -> None:
    assert _summary(client)["attention_rows"] == {
        "awaiting_work_order": [],
        "quarantined_files": [],
        "invalid_runs": [],
        "orphaned_definitions": [],
    }


def test_recent_runs_holds_the_five_latest_arrivals(client, routed_db) -> None:
    _seed(routed_db)
    for index in range(5):
        # Late in the day, so these five outrank the seed's runs at any hour.
        routed_db["test_runs"].insert_one(
            make_run(
                run_id=f"TAS-9900{index}",
                first_data_at=MIDNIGHT + timedelta(hours=23) - timedelta(minutes=index),
            )
        )

    recent = _summary(client)["recent_runs"]

    assert len(recent) == 5
    assert recent[0]["run_id"] == "TAS-99000", "newest arrival first"


def test_recent_runs_is_short_when_there_are_few_runs(client, routed_db) -> None:
    _seed(routed_db)

    assert len(_summary(client)["recent_runs"]) == 3


def test_the_planning_brief_reports_the_sync_state(client, routed_db) -> None:
    _seed(routed_db)

    brief = _summary(client)["planning_sync"]

    assert brief["online"] is False
    assert brief["last_sync_at"] is None


def test_an_empty_database_answers_zeroes(client, routed_db) -> None:
    body = _summary(client)

    assert body["counts"]["test_runs"] == 0
    assert body["needs_attention"] == {
        "awaiting_work_order": 0,
        "quarantined_files": 0,
        "invalid_runs": 0,
        "orphaned_definitions": 0,
    }
    assert body["recent_runs"] == []
