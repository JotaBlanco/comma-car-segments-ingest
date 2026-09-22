"""A-12 — the planning sync pass (BE-PLAN §4.4).

The mechanism is real; only the source is a mock. A pass pulls the work orders
and definitions, mirrors them, and backfills the runs that were waiting for a
work order. That backfill is the amber-to-green flip the demo turns on.

An offline planning system is not an error. A registry that cannot reach
planning simply has nothing to sync, and ingestion carries on.
"""

from datetime import UTC, datetime

import pytest

from api import planning_sync
from tests.factories_planning import make_run

HERO = "TAS-88214"
HERO_WO = "WO-2026-0851"
HERO_DEFINITION = "TD-BAT-114"


@pytest.fixture
def planning(planning_client):
    """The planning mock, switched on. It starts off, because the demo does."""
    planning_client.post("/admin/reset")
    planning_client.post("/admin/state", json={"online": True})
    return planning_client


@pytest.fixture
def offline_planning(planning_client):
    planning_client.post("/admin/reset")
    return planning_client


def _seed_hero(db) -> None:
    """The hero run as the seed leaves it: waiting for its work order,
    CLAIMING the pair it arrived with (pair-only planning, 24 Aug 2026) —
    the retained claim is what the sync pass honours."""
    db["test_runs"].insert_one(
        make_run(
            run_id=HERO,
            work_order_id=None,
            definition_id=None,
            project=None,
            status="awaiting_work_order",
            claimed_work_order_id=HERO_WO,
            claimed_definition_id=HERO_DEFINITION,
            field_sources={},
        )
    )


def test_a_pass_mirrors_the_work_orders(db, planning) -> None:
    result = planning_sync.run_sync_pass(db, client=planning)

    assert result["synced"] is True
    assert result["work_orders"] > 0
    assert db["work_orders"].count_documents({}) == result["work_orders"]


def test_a_pass_mirrors_the_definitions(db, planning) -> None:
    result = planning_sync.run_sync_pass(db, client=planning)

    assert db["test_definitions"].count_documents({}) == result["definitions"]


def test_the_mirror_carries_the_sync_time_and_the_raw_payload(db, planning) -> None:
    planning_sync.run_sync_pass(db, client=planning)

    row = db["work_orders"].find_one({"_id": HERO_WO})
    assert row["synced_at"] is not None
    assert row["raw"], "the mirror keeps the payload verbatim for audit"


def test_the_planning_field_names_are_mapped(db, planning) -> None:
    """The mock says `created_at`; the mirror stores `created_at_source`."""
    planning_sync.run_sync_pass(db, client=planning)

    assert "created_at_source" in db["work_orders"].find_one({"_id": HERO_WO})


def test_the_backfill_flips_the_hero_run_green(db, planning) -> None:
    """The demo's money shot, asserted."""
    _seed_hero(db)

    result = planning_sync.run_sync_pass(db, client=planning)

    run = db["test_runs"].find_one({"_id": HERO})
    assert result["runs_backfilled"] == 1
    assert run["work_order_id"] == HERO_WO
    assert run["definition_id"] == HERO_DEFINITION
    assert run["status"] == "complete"


def test_the_backfill_tags_its_writes_as_planning(db, planning) -> None:
    _seed_hero(db)

    planning_sync.run_sync_pass(db, client=planning)

    sources = db["test_runs"].find_one({"_id": HERO})["field_sources"]
    assert sources["work_order_id"]["source"] == "api:planning"
    assert sources["work_order_id"]["actor"] == "planning-sync"


def test_the_backfill_journals_the_change(db, planning) -> None:
    _seed_hero(db)

    planning_sync.run_sync_pass(db, client=planning)

    entries = list(db["journal_entries"].find({"entity_id": HERO, "field": "run.work_order"}))
    assert len(entries) == 1
    assert entries[0]["old"] == "(empty)"
    assert entries[0]["new"] == HERO_WO
    assert entries[0]["source"] == "api:planning"


def test_the_backfill_leaves_a_manual_value_alone(db, planning) -> None:
    """Precedence holds against the sync too: a person outranks planning."""
    _seed_hero(db)
    db["test_runs"].update_one(
        {"_id": HERO},
        {
            "$set": {
                "project": "set by hand",
                "field_sources.project": {
                    "source": "manual",
                    "actor": "a.bergstrom",
                    "at": datetime.now(UTC),
                },
            }
        },
    )

    planning_sync.run_sync_pass(db, client=planning)

    assert db["test_runs"].find_one({"_id": HERO})["project"] == "set by hand"


def test_a_run_that_already_holds_the_planning_link_is_left_alone(db, planning) -> None:
    db["test_runs"].insert_one(
        make_run(
            run_id=HERO,
            work_order_id=HERO_WO,
            definition_id=HERO_DEFINITION,
            status="complete",
        )
    )

    result = planning_sync.run_sync_pass(db, client=planning)

    assert result["runs_backfilled"] == 0
    assert db["test_runs"].find_one({"_id": HERO})["work_order_id"] == HERO_WO


def test_the_pull_leaves_a_resolved_link_alone(db, planning) -> None:
    """Pair-only planning (24 Aug 2026): the pull mirrors the catalog and
    honours retained CLAIMS — it holds no plan of run ids, so it cannot and
    must not reassign a link the data already resolved. Correction is the
    PUSH's job now: planning decides links from the claims it polls and
    applies them with api:planning rank (test_mock_planning_push pins that
    side; until 24 Aug this test had the pull correcting from a run-id plan).
    """
    db["test_runs"].insert_one(
        make_run(
            run_id=HERO,
            work_order_id="WO-2026-0847",
            definition_id=None,
            status="complete",
            field_sources={
                "work_order_id": {
                    "source": "embedded",
                    "actor": "ingestion",
                    "at": datetime.now(UTC),
                }
            },
        )
    )

    result = planning_sync.run_sync_pass(db, client=planning)

    assert result["runs_backfilled"] == 0
    assert db["test_runs"].find_one({"_id": HERO})["work_order_id"] == "WO-2026-0847"


def test_a_second_pass_changes_nothing(db, planning) -> None:
    """Re-syncing unchanged data must not duplicate journal entries."""
    _seed_hero(db)
    planning_sync.run_sync_pass(db, client=planning)
    before = db["journal_entries"].count_documents({})

    result = planning_sync.run_sync_pass(db, client=planning)

    assert result["runs_backfilled"] == 0
    assert db["journal_entries"].count_documents({}) == before


def test_an_offline_planning_system_is_not_an_error(db, offline_planning) -> None:
    """Missing work orders are normal. The pass reports it and moves on."""
    _seed_hero(db)

    result = planning_sync.run_sync_pass(db, client=offline_planning)

    assert result["synced"] is False
    assert result["reason"] == "planning system offline"


def test_an_offline_pass_leaves_the_mirrors_alone(db, planning, offline_planning) -> None:
    planning_sync.run_sync_pass(db, client=planning)
    before = db["work_orders"].count_documents({})
    offline_planning.post("/admin/state", json={"online": False})

    planning_sync.run_sync_pass(db, client=offline_planning)

    assert db["work_orders"].count_documents({}) == before


def test_the_pass_records_its_result(db, planning) -> None:
    """`/planning-sync/status` reads this, so the pass has to store it."""
    _seed_hero(db)

    planning_sync.run_sync_pass(db, client=planning)

    meta = db["meta"].find_one({"_id": "planning_sync"})
    assert meta["last_sync_at"] is not None
    assert meta["last_sync_result"]["runs_backfilled"] == 1


# --- the review round: real failure modes, real types ------------------------


class _DeadPlanning:
    """A planning system that is DOWN — not switched off. The demo-day risk."""

    def get(self, url, **kwargs):
        import httpx

        raise httpx.ConnectError("planning is down")

    def post(self, url, **kwargs):
        import httpx

        raise httpx.ConnectError("planning is down")


class _JunkPlanning:
    """A planning system answering 200 with a body that is not JSON."""

    def get(self, url, **kwargs):
        import httpx

        return httpx.Response(200, text="<html>proxy error</html>")

    def post(self, url, **kwargs):
        import httpx

        return httpx.Response(200, text="<html>proxy error</html>")


class _BrokenPlanning:
    """A planning system answering 500 — broken, not switched off."""

    def get(self, url, **kwargs):
        import httpx

        return httpx.Response(500, json={"detail": "boom"})

    def post(self, url, **kwargs):
        import httpx

        return httpx.Response(500, json={"detail": "boom"})


def test_an_unreachable_planning_system_reads_as_offline(db) -> None:
    """A refused connection is the same normal amber as a 503."""
    _seed_hero(db)

    result = planning_sync.run_sync_pass(db, client=_DeadPlanning())

    assert result == {"synced": False, "reason": "planning system offline"}
    assert db["test_runs"].find_one({"_id": HERO})["work_order_id"] is None


def test_a_non_json_answer_reads_as_offline(db) -> None:
    """A 200 with a broken body must not crash the toggle (review finding)."""
    result = planning_sync.run_sync_pass(db, client=_JunkPlanning())

    assert result == {"synced": False, "reason": "planning system offline"}


def test_a_server_error_answer_reads_as_offline(db) -> None:
    """A 500 from planning is treated like a 503: nothing to sync, no crash."""
    result = planning_sync.run_sync_pass(db, client=_BrokenPlanning())

    assert result == {"synced": False, "reason": "planning system offline"}


def test_the_mirror_stores_created_at_as_a_datetime(db, planning) -> None:
    """Planning serves an ISO string; the mirror stores a datetime, like every
    other date in the registry — a refresh of a seeded row must write the same
    type the seed wrote (review finding: the toggle changed the type)."""
    planning_sync.run_sync_pass(db, client=planning)

    row = db["work_orders"].find_one({"_id": HERO_WO})
    assert isinstance(row["created_at_source"], datetime)
