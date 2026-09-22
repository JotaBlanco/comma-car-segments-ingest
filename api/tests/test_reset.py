"""A-14 — the reset. The only code in the project that deletes data.

**The planning-sync toggle called it until 20 Aug 2026.** It belongs to the
seed now: `python -m seed.seed_demo` runs `seed.seed_demo.seed`, and the top-up
path calls `demo_reset` to undo the sync writes a rehearsal left. A person runs
that command by name. No toggle deletes a row, and no route does either.

It undoes exactly what the sync did after the seed, and nothing else.

Most of this file is about what the reset must **not** touch. Those are the
tests that matter, and they did not change with the owner: a reset that eats a
person's edit destroys the audit story the demo is selling. Never widen the
delete scope to make a gap go away.

`tests/test_seed.py::test_the_seed_top_up_runs_the_reset` pins the new caller.
Every test below calls `planning_sync.demo_reset` straight, because that is the
code the seed runs.
"""

from datetime import UTC, datetime, timedelta

import pytest

from api import planning_sync
from tests.factories_planning import make_run

HERO = "TAS-88214"
HERO_WO = "WO-2026-0851"


@pytest.fixture
def planning(planning_client):
    planning_client.post("/admin/reset")
    planning_client.post("/admin/state", json={"online": True})
    return planning_client


def _watermark(db, at: datetime | None = None) -> datetime:
    """Stamp the seed baseline, the way the seed script does."""
    at = at or datetime.now(UTC)
    db["meta"].replace_one({"_id": "demo_reset_watermark"}, {"_id": "demo_reset_watermark", "at": at}, upsert=True)
    return at


def _seed_hero(db) -> None:
    db["test_runs"].insert_one(
        make_run(
            run_id=HERO,
            work_order_id=None,
            definition_id=None,
            project=None,
            status="awaiting_work_order",
            # Pair-only planning (24 Aug 2026): the hero CLAIMS its pair; the
            # sync links the claim, never a run-id plan.
            claimed_work_order_id=HERO_WO,
            claimed_definition_id="TD-BAT-114",
            field_sources={},
        )
    )


def _synced_state(db, planning) -> None:
    """Seed, then run one pass — the state the demo is in after toggle-on."""
    _seed_hero(db)
    _watermark(db, datetime.now(UTC) - timedelta(seconds=1))
    planning_sync.run_sync_pass(db, client=planning)


# --- what the reset undoes --------------------------------------------------


def test_the_reset_takes_the_run_back_to_amber(db, planning) -> None:
    _synced_state(db, planning)

    planning_sync.demo_reset(db)

    run = db["test_runs"].find_one({"_id": HERO})
    assert run.get("work_order_id") is None
    assert run["status"] == "awaiting_work_order"


def test_the_reset_removes_the_source_tags_it_reverted(db, planning) -> None:
    _synced_state(db, planning)

    planning_sync.demo_reset(db)

    sources = db["test_runs"].find_one({"_id": HERO})["field_sources"]
    assert "work_order_id" not in sources


def test_the_reset_removes_the_mirror_rows_the_sync_created(db, planning) -> None:
    _synced_state(db, planning)
    assert db["work_orders"].find_one({"_id": HERO_WO}) is not None

    planning_sync.demo_reset(db)

    assert db["work_orders"].find_one({"_id": HERO_WO}) is None


def test_the_reset_removes_the_planning_journal_entries(db, planning) -> None:
    _synced_state(db, planning)

    planning_sync.demo_reset(db)

    assert db["journal_entries"].count_documents({"source": "api:planning"}) == 0


def test_a_full_round_trip_restores_the_run(db, planning) -> None:
    """Toggle on, toggle off, and the hero run is what it was."""
    _seed_hero(db)
    _watermark(db, datetime.now(UTC) - timedelta(seconds=1))
    before = db["test_runs"].find_one({"_id": HERO})

    planning_sync.run_sync_pass(db, client=planning)
    planning_sync.demo_reset(db)

    after = db["test_runs"].find_one({"_id": HERO})
    for field in ("work_order_id", "definition_id", "project", "status"):
        assert after.get(field) == before.get(field), field


# --- what the reset must never touch ----------------------------------------


def test_reset_keeps_manual_invalid_embedded(db, planning) -> None:
    """Guard test 13. The three sources the reset must leave alone."""
    _seed_hero(db)
    _watermark(db, datetime.now(UTC) - timedelta(seconds=1))
    planning_sync.run_sync_pass(db, client=planning)

    now = datetime.now(UTC)
    db["test_runs"].update_one(
        {"_id": HERO},
        {
            "$set": {
                "operator": "A. Bergström",
                "field_sources.operator": {"source": "manual", "actor": "a.b", "at": now},
                "rig_id": "RIG-04",
                "field_sources.rig_id": {"source": "embedded", "actor": "ingestion", "at": now},
                "invalid": {"flagged": True, "reason": "drift", "actor": "e.l", "at": now},
            }
        },
    )

    planning_sync.demo_reset(db)

    run = db["test_runs"].find_one({"_id": HERO})
    assert run["operator"] == "A. Bergström", "a manual edit survives the reset"
    assert run["rig_id"] == "RIG-04", "an embedded write survives the reset"
    assert run["invalid"]["flagged"] is True, "an invalid flag survives the reset"
    assert run["status"] == "invalid", "and the status still reflects it"


def test_the_reset_keeps_a_note(db, planning) -> None:
    _synced_state(db, planning)
    db["journal_entries"].insert_one(
        {
            "_id": "j-note",
            "entity_type": "run",
            "entity_id": HERO,
            "field": None,
            "kind": "note",
            "old": None,
            "new": None,
            "source": "manual",
            "actor": "a.bergstrom",
            "note": "checked the bench",
            "at": datetime.now(UTC),
        }
    )

    planning_sync.demo_reset(db)

    assert db["journal_entries"].find_one({"_id": "j-note"}) is not None


def test_the_reset_keeps_a_file_registered_after_the_seed(db, planning) -> None:
    """An embedded write from the watcher is not the sync's to undo."""
    _synced_state(db, planning)
    db["journal_entries"].insert_one(
        {
            "_id": "j-file",
            "entity_type": "file",
            "entity_id": "f-1",
            "field": "file.registered",
            "kind": "event",
            "old": None,
            "new": None,
            "source": "embedded",
            "actor": "file-watcher",
            "note": None,
            "at": datetime.now(UTC),
        }
    )

    planning_sync.demo_reset(db)

    assert db["journal_entries"].find_one({"_id": "j-file"}) is not None


def test_the_reset_keeps_the_mirrors_the_seed_wrote(db, planning) -> None:
    """Only rows newer than the watermark go. The seed's own mirrors stay."""
    _seed_hero(db)
    db["work_orders"].insert_one(
        {"_id": "WO-2026-0847", "title": "seeded", "synced_at": datetime.now(UTC)}
    )
    _watermark(db)
    planning_sync.run_sync_pass(db, client=planning)

    planning_sync.demo_reset(db)

    assert db["work_orders"].find_one({"_id": "WO-2026-0847"}) is not None


# --- the cases the presenter will actually hit ------------------------------


def test_toggling_off_twice_is_a_no_op(db, planning) -> None:
    _synced_state(db, planning)
    planning_sync.demo_reset(db)
    state = db["test_runs"].find_one({"_id": HERO})

    planning_sync.demo_reset(db)

    assert db["test_runs"].find_one({"_id": HERO}) == state


def test_on_off_on_is_safe(db, planning) -> None:
    """The second pass recreates the sync's writes with new timestamps."""
    _synced_state(db, planning)
    planning_sync.demo_reset(db)

    planning_sync.run_sync_pass(db, client=planning)

    run = db["test_runs"].find_one({"_id": HERO})
    assert run["work_order_id"] == HERO_WO
    assert run["status"] == "complete"


def test_a_reset_without_a_watermark_does_nothing(db, planning) -> None:
    """No seed, no baseline, no delete. Never guess what to remove."""
    _seed_hero(db)
    planning_sync.run_sync_pass(db, client=planning)

    result = planning_sync.demo_reset(db)

    assert result == {"mirrors_removed": 0, "runs_reverted": 0, "entries_removed": 0}
    assert db["test_runs"].find_one({"_id": HERO})["work_order_id"] == HERO_WO


def test_the_reset_clears_the_recorded_sync_result(db, planning) -> None:
    _synced_state(db, planning)

    planning_sync.demo_reset(db)

    meta = db["meta"].find_one({"_id": "planning_sync"})
    assert meta["last_sync_at"] is None
