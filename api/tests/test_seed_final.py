"""A-15 — the final seed: demo scale, and a self-verify that runs on stage.

The seed is re-run on the morning of the demo, so it has to prove itself then
and there. The self-verify walks the money shot — toggle on, check, toggle off,
reset, check the restore is exact — and leaves the state OFF, because the demo
opens amber. A stale or wrong seed must fail here, in a terminal, not on stage.
"""

from datetime import UTC, date, datetime, timedelta

import pytest

from api.planning_sync import demo_reset
from seed import filler, seed_demo

HERO = "TAS-88214"
HERO_WO = "WO-2026-0851"


@pytest.fixture
def planning(planning_offline):
    """The shared override fixture (conftest.py, lane A region), by the name
    this module has always used."""
    return planning_offline


@pytest.fixture
def seeded(client, routed_db, planning):
    """A full seed, the way the demo morning runs it."""
    seed_demo.seed(routed_db, client, reset=True, inventory=False, filler_records=True)
    return routed_db


# --- demo scale -------------------------------------------------------------


def test_the_seed_reaches_the_demo_run_count(seeded) -> None:
    assert seeded["test_runs"].count_documents({}) == filler.DEMO_RUN_COUNT


def test_the_seed_reaches_the_demo_work_order_count(seeded) -> None:
    assert seeded["work_orders"].count_documents({}) == filler.DEMO_WORK_ORDER_COUNT


def test_enough_runs_arrived_today(seeded) -> None:
    """The Home screen says "6 today". A stale seed makes that a lie."""
    midnight = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)

    today = seeded["test_runs"].count_documents({"first_data_at": {"$gte": midnight}})

    assert today >= filler.RUNS_TODAY


def test_the_hero_run_arrived_on_the_seed_day(seeded) -> None:
    hero = seeded["test_runs"].find_one({"_id": HERO})

    assert hero["first_data_at"].date() == datetime.now(UTC).date()


def test_the_filler_never_needs_attention(seeded) -> None:
    """Filler must not inflate the needs-attention block."""
    assert seeded["test_runs"].count_documents({"status": "awaiting_work_order"}) == 1
    assert seeded["test_runs"].count_documents({"status": "invalid"}) == 1


def test_the_hero_starts_amber(seeded) -> None:
    hero = seeded["test_runs"].find_one({"_id": HERO})

    assert hero["work_order_id"] is None
    assert hero["status"] == "awaiting_work_order"


def test_the_work_order_that_arrives_on_the_toggle_is_not_seeded(seeded) -> None:
    assert seeded["work_orders"].find_one({"_id": HERO_WO}) is None


# --- the self-verify --------------------------------------------------------


def test_the_self_verify_passes_on_a_fresh_seed(client, seeded) -> None:
    report = seed_demo.self_verify(seeded, client)

    assert report["ok"] is True
    assert report["failures"] == []


def test_the_self_verify_leaves_the_demo_amber(client, seeded) -> None:
    """It walks the beat, then puts the stage back to its opening state."""
    seed_demo.self_verify(seeded, client)

    hero = seeded["test_runs"].find_one({"_id": HERO})
    assert hero["work_order_id"] is None
    assert hero["status"] == "awaiting_work_order"
    assert seeded["work_orders"].find_one({"_id": HERO_WO}) is None


def test_the_self_verify_proves_the_flip_happened(client, seeded) -> None:
    report = seed_demo.self_verify(seeded, client)

    assert report["checks"]["hero_went_green"] is True
    assert report["checks"]["work_order_mirrored"] is True


def test_the_self_verify_proves_the_restore_is_exact(client, seeded) -> None:
    report = seed_demo.self_verify(seeded, client)

    assert report["checks"]["restore_is_exact"] is True


def test_the_precision_check_runs_before_the_restore_check(client, seeded) -> None:
    """A microsecond mismatch must not read as a reset bug (guard 3, A-01)."""
    report = seed_demo.self_verify(seeded, client)

    order = list(report["checks"])
    assert order.index("timestamps_survive_mongo") < order.index("restore_is_exact")


def test_the_self_verify_reports_a_stale_seed(client, seeded) -> None:
    """Move the hero back a week: the check must fail, and say why."""
    seeded["test_runs"].update_one(
        {"_id": HERO}, {"$set": {"first_data_at": datetime.now(UTC) - timedelta(days=7)}}
    )

    report = seed_demo.self_verify(seeded, client)

    assert report["ok"] is False
    assert any("seed day" in failure for failure in report["failures"])


# --- the two resets ---------------------------------------------------------


def test_reset_drops_the_world_and_rebuilds_it(client, routed_db, planning) -> None:
    seed_demo.seed(routed_db, client, reset=True, inventory=False, filler_records=True)
    routed_db["test_runs"].insert_one({"_id": "TAS-HANDMADE", "rig_id": "RIG-99"})

    seed_demo.seed(routed_db, client, reset=True, inventory=False, filler_records=True)

    assert routed_db["test_runs"].find_one({"_id": "TAS-HANDMADE"}) is None
    assert routed_db["test_runs"].count_documents({}) == filler.DEMO_RUN_COUNT


def test_a_second_seed_without_reset_adds_no_run(client, routed_db, planning) -> None:
    seed_demo.seed(routed_db, client, reset=True, inventory=False, filler_records=True)

    seed_demo.seed(routed_db, client, inventory=False, filler_records=True)

    assert routed_db["test_runs"].count_documents({}) == filler.DEMO_RUN_COUNT


def test_the_watermark_is_newer_than_every_seeded_record(seeded) -> None:
    """The reset compares against it, so nothing seeded may postdate it."""
    watermark = seed_demo.read_watermark(seeded)

    newest = seeded["test_runs"].find_one(sort=[("updated_at", -1)])
    assert newest["updated_at"] <= watermark


def test_no_seeded_record_postdates_the_watermark_when_a_slot_is_ahead(
    client, routed_db, planning
) -> None:
    """The filler puts the seed day's runs on a 07:00 grid, so a seed that runs
    before that hour mints a record in the future. A seed day of tomorrow puts
    every slot ahead of the watermark, whatever the clock says.
    """
    tomorrow = datetime.now(UTC).date() + timedelta(days=1)

    seed_demo.seed(
        routed_db,
        client,
        seed_day=tomorrow,
        reset=True,
        inventory=False,
        filler_records=True,
    )

    watermark = seed_demo.read_watermark(routed_db)
    for collection in ("test_runs", "files"):
        newest = routed_db[collection].find_one(sort=[("updated_at", -1)])
        assert newest["updated_at"] <= watermark, collection


def test_the_seed_day_can_be_pinned(client, routed_db, planning) -> None:
    """The tests need a fixed day; the demo uses today."""
    seed_demo.seed(
        routed_db, client, seed_day=date(2026, 8, 14), reset=True, inventory=False
    )

    hero = routed_db["test_runs"].find_one({"_id": HERO})
    assert hero["first_data_at"].date() == date(2026, 8, 14)


# --- the review round: one cast, exact restores, safe rehearsals -------------
#
# Promoted from the 17 Aug post-implementation review's probes. Each of these
# was red against the code of that morning.


def test_a_sync_and_a_reset_leave_every_mirror_row_byte_identical(client, seeded) -> None:
    """The seed reads the mock's own cast, so a refresh changes nothing.

    Review finding: the two casts disagreed, the sync rewrote the seeded rows
    with mock values, and the reset — correctly — did not touch them.
    `synced_at` is the one field a refresh may move.

    The toggle-off ran the reset until 20 Aug 2026. The reset is a named step
    now, so this test calls it. The rule it guards did not change.
    """
    before = seed_demo._mirror_snapshot(seeded)

    client.post("/api/v1/planning-sync/toggle", json={"online": True})
    client.post("/api/v1/planning-sync/toggle", json={"online": False})
    demo_reset(seeded)

    assert seed_demo._mirror_snapshot(seeded) == before


def test_no_definition_points_at_a_missing_work_order_after_the_reset(client, seeded) -> None:
    """The definition that rides the toggle must leave with its work order.

    A null `work_order_id` is the deliberate orphan of TR-001, so this check
    reads the definitions that NAME a work order. A named id must resolve.
    """
    client.post("/api/v1/planning-sync/toggle", json={"online": True})
    client.post("/api/v1/planning-sync/toggle", json={"online": False})
    demo_reset(seeded)

    known = {row["_id"] for row in seeded["work_orders"].find({}, {"_id": 1})}
    dangling = [
        row["_id"]
        for row in seeded["test_definitions"].find({"work_order_id": {"$ne": None}})
        if row["work_order_id"] not in known
    ]
    assert dangling == []


def test_the_orphaned_definition_survives_the_toggle_pair(client, seeded) -> None:
    """TR-001 needs a row to flag on stage, before and after the beat.

    The row is not in the planning mock, so a sync pass never adopts it and
    the demo reset never removes it.
    """
    client.post("/api/v1/planning-sync/toggle", json={"online": True})
    client.post("/api/v1/planning-sync/toggle", json={"online": False})

    orphans = [
        row["_id"] for row in seeded["test_definitions"].find({"work_order_id": None})
    ]

    assert orphans == [seed_demo.ORPHANED_DEFINITION["_id"]]


def test_a_reseed_after_a_rehearsal_goes_back_to_amber(client, seeded) -> None:
    """Rehearse, forget to toggle off, re-seed WITHOUT --reset: still amber.

    Review finding: the new watermark used to strand the sync's writes on its
    safe side, where no later reset could ever reach them.
    """
    client.post("/api/v1/planning-sync/toggle", json={"online": True})
    assert seeded["test_runs"].find_one({"_id": HERO})["status"] == "complete"

    seed_demo.seed(seeded, client, inventory=False, filler_records=True)

    hero = seeded["test_runs"].find_one({"_id": HERO})
    assert hero["status"] == "awaiting_work_order"
    assert hero["work_order_id"] is None
    assert seeded["work_orders"].find_one({"_id": HERO_WO}) is None


def test_the_self_verify_refuses_a_stage_that_opens_green(client, seeded) -> None:
    """A green stage means a stale rehearsal. The verifier says so, and it
    must not run the beat on top of state it cannot restore."""
    client.post("/api/v1/planning-sync/toggle", json={"online": True})

    report = seed_demo.self_verify(seeded, client)

    assert report["ok"] is False
    assert report["checks"]["stage_opens_amber"] is False
    assert "hero_went_green" not in report["checks"]


def test_the_self_verify_proves_the_mirror_restore(client, seeded) -> None:
    report = seed_demo.self_verify(seeded, client)

    assert report["checks"]["mirror_restore_is_exact"] is True
    assert report["checks"]["every_link_resolves"] is True


def test_the_filler_reads_like_a_lab_not_a_copy_paste(seeded) -> None:
    """Cast polish, 18 Aug: the crowd varies — many descriptions, many
    campaigns, real requestors — while still never needing attention."""
    filler_runs = list(seeded["test_runs"].find({"_id": {"$regex": "^TAS-7"}}))

    assert len({run["description"] for run in filler_runs}) >= 5
    assert len({run["work_order_id"] for run in filler_runs}) >= 10

    campaign = seeded["work_orders"].find_one({"_id": "WO-2025-0003"})
    assert campaign["requestor"] is not None
    assert campaign["department"] is not None


def test_the_twelve_battery_history_runs_are_seeded(seeded) -> None:
    """Lane B's lake fixture answers statistics for twelve runs. The run
    documents must exist, or the signal-history screen joins to nothing
    (BE-PLAN §7)."""
    battery = seeded["test_runs"].count_documents(
        {"description": "HV battery thermal cycling"}
    )
    assert battery == 12


# --- the criterion a person defines (FR-DM-108) -----------------------------
#
# The Group-by control offers a "Custom property" option group and lists the
# keys the runs table really holds. The seed writes two of them, so the control
# offers something and the grouping demonstrates itself on stage.
#
# The pairs below are what a presenter sees. The route sorts the biggest group
# first, then by value, so a tie reads in a fixed order.

VEHICLE_GROUPS = [
    ("EX30-VP002", 36),
    ("EC40-VP007", 21),
    ("EX90-VP014", 19),
    ("EX90-VP021", 18),
    ("EC40-PP044", 17),
    ("EX90-PP103", 17),
]

PHASE_GROUPS = [
    ("DV — design verification", 65),
    ("PV — production validation", 42),
    ("Sign-off", 21),
]


def _custom_groups(client, key: str) -> list[tuple[str, int]]:
    body = client.get(
        "/api/v1/test-runs/groups",
        params={"group_by": f"custom:{key}", "page_size": 100},
    ).json()
    return [(item["value"], item["count"]) for item in body["items"]]


def test_every_seeded_run_carries_both_property_keys(seeded) -> None:
    """The crowd carries them too, or the group counts would not add up."""
    missing = [
        doc["_id"]
        for doc in seeded["test_runs"].find({})
        if set(doc.get("custom_properties") or {}) != {"vehicle", "test-phase"}
    ]

    assert missing == []


def test_the_seeded_properties_carry_the_manual_source(seeded) -> None:
    """A person typed them, so they are nobody else's facts."""
    for doc in seeded["test_runs"].find({}):
        tag = doc["field_sources"]["custom_properties"]
        assert tag["source"] == "manual", doc["_id"]
        assert tag["actor"] == "a.bergstrom", doc["_id"]


def test_grouping_by_the_vehicle_answers_the_seeded_fleet(client, seeded) -> None:
    assert _custom_groups(client, "vehicle") == VEHICLE_GROUPS


def test_grouping_by_the_test_phase_answers_three_buckets(client, seeded) -> None:
    assert _custom_groups(client, "test-phase") == PHASE_GROUPS


def test_the_custom_groups_add_up_to_the_runs_table(client, seeded) -> None:
    """The padding runs carry the keys, so no count falls short on stage."""
    total = client.get("/api/v1/test-runs", params={"page_size": 10}).json()["total"]

    assert total == filler.DEMO_RUN_COUNT
    assert sum(count for _value, count in _custom_groups(client, "vehicle")) == total
    assert sum(count for _value, count in _custom_groups(client, "test-phase")) == total


def test_the_facets_offer_the_seeded_property_keys(client, seeded) -> None:
    """The Group-by control reads these, so it can offer a real criterion."""
    body = client.get("/api/v1/test-runs/facets").json()

    assert body["custom_property_keys"] == ["test-phase", "vehicle"]


def test_the_full_seed_matches_the_contract_home_example(client, routed_db, planning) -> None:
    """Contract §B #1, against the REAL demo seed — not the factory cast."""
    seed_demo.seed(routed_db, client, reset=True, inventory=True, filler_records=True)

    body = client.get("/api/v1/home/summary").json()
    assert body["counts"]["test_runs"] == 128
    assert body["counts"]["files"] == 512
    assert body["counts"]["signals"] == 6412
    assert body["counts"]["work_orders"] == 42
    assert body["counts"]["runs_today"] == 6
    assert body["counts"]["files_today"] == 31
    assert body["counts"]["rig_count"] == 4
    assert body["needs_attention"] == {
        "awaiting_work_order": 1, "quarantined_files": 2, "invalid_runs": 1,
        "orphaned_definitions": 1,
    }


# --- the stored counts state the seeded inventory (2026-08-18 meta-review §2) --
#
# The seed used to stamp literal `signal_count` / `file_count` / `run_count`
# values that contradicted its own rows on 113 of 130 runs. These two tests are
# the acceptance criterion: every stored count equals what the ingestion path
# (`apply_file_rollup`, `upsert_file_signals`) would derive from the very rows
# the seed wrote — quarantined-but-linked files included, since the rollup
# applies no status filter.


@pytest.fixture
def fully_seeded(client, routed_db, planning):
    """The whole cast — named runs, inventory and filler — like the demo morning."""
    seed_demo.seed(routed_db, client, reset=True, inventory=True, filler_records=True)
    return routed_db


def test_every_stored_run_count_matches_the_seeded_inventory(fully_seeded) -> None:
    for run in fully_seeded["test_runs"].find({}):
        files = fully_seeded["files"].count_documents({"run_id": run["_id"]})
        names = fully_seeded["file_signals"].distinct("name", {"run_id": run["_id"]})
        assert run["file_count"] == files, run["_id"]
        assert run["signal_count"] == len(names), run["_id"]


def test_every_stored_signal_run_count_matches_the_seeded_inventory(fully_seeded) -> None:
    for signal in fully_seeded["signals"].find({}):
        runs = fully_seeded["file_signals"].distinct(
            "run_id", {"name": signal["_id"], "run_id": {"$ne": None}}
        )
        assert signal["run_count"] == len(runs), signal["_id"]
