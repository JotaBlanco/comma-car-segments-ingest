"""A-10 — the interim demo seed. This file is UTF-8: the cast carries "Bergström".

Two things here exist nowhere else in the codebase. The seed is the only code
that calls `ensure_indexes()` at runtime, and it writes the watermark the demo
reset (A-14) compares against. A missing index or a watermark on the wrong side
of a seeded write is found on stage otherwise.

The database mechanism is the shared one from `conftest.py`. This module adds no
second one.
"""

from datetime import UTC, date, datetime, timedelta

import pytest

from seed import fixtures as fx
from seed import seed_demo

HERO = fx.HERO_RUN_ID
INVALID_RUN = "TAS-88209"
# The definition the seed leaves unlinked on purpose (TR-001).
ORPHANED_DEFINITION = "TD-BAT-126"


@pytest.fixture
def seeded(client, routed_db):
    """The Lane A half of the seed, in this test's own database."""
    seed_demo.seed(routed_db, client, inventory=False, filler_records=False)
    return routed_db


def _run(db, run_id: str) -> dict:
    doc = db["test_runs"].find_one({"_id": run_id})
    assert doc is not None, f"the seed wrote no {run_id}"
    return doc


def _counts(db) -> dict[str, int]:
    return {name: db[name].count_documents({}) for name in seed_demo.COLLECTIONS}


# --- The seed runs -----------------------------------------------------------


def test_the_seed_runs_against_a_fresh_database(client, routed_db) -> None:
    counts = seed_demo.seed(routed_db, client, inventory=False, filler_records=False)

    assert counts["test_runs"] == len(fx.NAMED_RUNS)
    assert counts["work_orders"] == len(fx.NAMED_WORK_ORDERS)
    # The named cast, plus the one definition the seed leaves unlinked.
    assert counts["test_definitions"] == len(fx.NAMED_DEFINITIONS) + 1
    assert routed_db["test_runs"].count_documents({}) == len(fx.NAMED_RUNS)


def test_the_seed_writes_named_records_only(seeded) -> None:
    """No filler yet. A-15 grows the cast to the vanity totals."""
    stored = {doc["_id"] for doc in seeded["test_runs"].find({}, {"_id": 1})}

    assert stored == {record["run_id"] for record in fx.NAMED_RUNS}


def test_the_named_runs_read_back_through_the_list_route(client, seeded) -> None:
    response = client.get("/api/v1/test-runs")

    assert response.status_code == 200
    assert response.json()["total"] == len(fx.NAMED_RUNS)


# --- ensure_indexes ----------------------------------------------------------


def test_the_seed_creates_every_index_it_needs(seeded) -> None:
    """The conformance review found nothing calling the index setup at runtime."""
    assert "first_data_at_-1" in seeded["test_runs"].index_information()
    assert "work_order_id_1" in seeded["test_runs"].index_information()
    assert "context_run_id_1" in seeded["journal_entries"].index_information()
    assert "synced_at_1" in seeded["work_orders"].index_information()


def test_the_index_setup_runs_before_the_first_record(client, routed_db, monkeypatch) -> None:
    """An index built after the write is an index the write never used."""
    seen: list[int] = []
    real = seed_demo.ensure_indexes

    def spy(db):
        seen.append(db["test_runs"].count_documents({}))
        real(db)

    monkeypatch.setattr(seed_demo, "ensure_indexes", spy)
    seed_demo.seed(routed_db, client, inventory=False, filler_records=False)

    assert seen == [0]


# --- The watermark -----------------------------------------------------------


def test_the_seed_writes_the_demo_reset_watermark(seeded) -> None:
    """A-14 has nothing to compare against without it."""
    watermark = seed_demo.read_watermark(seeded)

    assert isinstance(watermark, datetime)
    assert watermark.tzinfo is not None
    assert abs((datetime.now(UTC) - watermark).total_seconds()) < 300


def test_the_watermark_is_never_older_than_a_seeded_planning_write(seeded) -> None:
    """The reset reverts `api:planning` writes newer than the watermark.

    A seeded write on the wrong side of it means toggle-off eats the seed.
    """
    watermark = seed_demo.read_watermark(seeded)
    stamps = [
        entry["at"]
        for doc in seeded["test_runs"].find()
        for entry in (doc.get("field_sources") or {}).values()
        if entry["source"] == "api:planning"
    ]

    assert stamps, "no seeded run carries a planning-sourced field"
    assert max(stamps) <= watermark


def test_the_watermark_is_never_older_than_a_seeded_mirror(seeded) -> None:
    """The reset removes mirror rows newer than the watermark."""
    watermark = seed_demo.read_watermark(seeded)
    stamps = [doc["synced_at"] for doc in seeded["work_orders"].find()]

    assert max(stamps) <= watermark


def test_read_watermark_answers_none_on_an_unseeded_database(routed_db) -> None:
    assert seed_demo.read_watermark(routed_db) is None


# --- Idempotency -------------------------------------------------------------


def test_a_second_seed_duplicates_no_record(client, seeded) -> None:
    before = _counts(seeded)

    seed_demo.seed(seeded, client, inventory=False, filler_records=False)

    assert _counts(seeded) == before


def test_a_second_seed_writes_no_second_journal_entry(client, seeded) -> None:
    """A replayed manual write is same-rank, so only a value check stops it."""
    before = list(seeded["journal_entries"].find({}, {"_id": 1}))

    seed_demo.seed(seeded, client, inventory=False, filler_records=False)

    assert list(seeded["journal_entries"].find({}, {"_id": 1})) == before


def test_a_second_seed_keeps_the_hero_field_sources(client, seeded) -> None:
    before = _run(seeded, HERO)["field_sources"]["operator"]

    seed_demo.seed(seeded, client, inventory=False, filler_records=False)

    assert _run(seeded, HERO)["field_sources"]["operator"] == before


def test_a_second_seed_moves_the_watermark_forward(client, seeded) -> None:
    """Each run restates the baseline. One document, one value."""
    first = seed_demo.read_watermark(seeded)

    seed_demo.seed(seeded, client, inventory=False, filler_records=False)

    assert seeded[seed_demo.META_COLLECTION].count_documents({}) == 1
    assert seed_demo.read_watermark(seeded) >= first


# --- --reset -----------------------------------------------------------------


def test_reset_drops_the_stored_records_first(client, seeded) -> None:
    seeded["test_runs"].insert_one({"_id": "TAS-00000"})
    seeded["files"].insert_one({"_id": "f-stray"})

    seed_demo.seed(seeded, client, reset=True, inventory=False, filler_records=False)

    assert seeded["test_runs"].find_one({"_id": "TAS-00000"}) is None
    assert seeded["files"].count_documents({}) == 0
    assert seeded["test_runs"].count_documents({}) == len(fx.NAMED_RUNS)


def test_a_seed_without_reset_keeps_a_foreign_record(client, seeded) -> None:
    """`--reset` is the flag that deletes. A plain seed never does."""
    seeded["test_runs"].insert_one({"_id": "TAS-00000"})

    seed_demo.seed(seeded, client, inventory=False, filler_records=False)

    assert seeded["test_runs"].find_one({"_id": "TAS-00000"}) is not None


def test_reset_rebuilds_the_indexes_it_dropped(client, seeded) -> None:
    seed_demo.seed(seeded, client, reset=True, inventory=False, filler_records=False)

    assert "first_data_at_-1" in seeded["test_runs"].index_information()


def test_the_seed_top_up_runs_the_reset(client, seeded) -> None:
    """The top-up path undoes the sync writes a rehearsal left behind.

    The planning-sync toggle owned this reset until 20 Aug 2026, and a
    `POST /admin/seed` route owned it for one morning. The seed owns it now, so
    this test pins the caller. `tests/test_reset.py` holds every rule the reset
    itself must obey.
    """
    watermark = datetime.now(UTC) - timedelta(minutes=10)
    seeded["meta"].replace_one(
        {"_id": "demo_reset_watermark"},
        {"_id": "demo_reset_watermark", "at": watermark},
        upsert=True,
    )
    seeded["meta"].replace_one(
        {"_id": "planning_sync"}, {"_id": "planning_sync", "online": True}, upsert=True
    )
    # A mirror row the sync created after the watermark, the way a rehearsal
    # leaves one.
    seeded["work_orders"].insert_one(
        {"_id": "WO-REHEARSAL", "mirrored_at": datetime.now(UTC)}
    )

    seed_demo.seed(seeded, client, inventory=False, filler_records=False)

    assert seeded["work_orders"].find_one({"_id": "WO-REHEARSAL"}) is None


def test_no_route_reseeds_the_registry(client) -> None:
    """`POST /admin/seed` existed on 20 Aug 2026, and we removed it the same day.

    Bearer auth was its only guard, and the platform path asks the Portal for
    workspace `Read` alone. So a read-only member could drop every collection.
    The seed runs from the command line, where a person owns the reset.
    """
    assert client.post("/api/v1/admin/seed").status_code == 404


# --- The hero run ------------------------------------------------------------


def test_the_hero_run_waits_for_its_work_order(client, seeded) -> None:
    body = client.get(f"/api/v1/test-runs/{HERO}").json()

    assert body["work_order_id"] is None
    assert body["status"] == "awaiting_work_order"


def test_the_hero_operator_is_a_manual_entry(client, seeded) -> None:
    body = client.get(f"/api/v1/test-runs/{HERO}").json()

    assert body["operator"] == "A. Bergström"
    assert body["field_sources"]["operator"]["source"] == "manual"
    assert body["field_sources"]["operator"]["actor"] == "a.bergstrom"


def test_the_hero_bench_software_comes_from_the_config_api(client, seeded) -> None:
    body = client.get(f"/api/v1/test-runs/{HERO}").json()

    assert body["bench_sw"] == "TAS 7.4.2 · fw 2.11"
    assert body["field_sources"]["bench_sw"]["source"] == "api:config"


def test_the_hero_rig_stays_embedded(client, seeded) -> None:
    """The registration route wrote it, so the tag proves the API path ran."""
    body = client.get(f"/api/v1/test-runs/{HERO}").json()

    assert body["rig_id"] == "RIG-04"
    assert body["field_sources"]["rig_id"]["source"] == "embedded"


def test_the_hero_journal_states_every_seeded_write(seeded) -> None:
    """Four run entries, one per write the seed made.

    The registration event comes from the route. The operator, the bench
    software and the custom property map each carry a source tag, so each one
    carries a journal line too: `set_field` writes the tag and the line
    together and no caller may split them. BE-PLAN §7 pictures the prototype's
    timeline without the bench line — that is A-15's presentation call, not a
    reason to hide a tagged write.

    **The fourth line joined on 25 Aug 2026 (FR-DM-108).** The seed now writes
    the vehicle and the test phase a person typed, and the hero takes them like
    every other run: a custom group counts only the runs that carry the key, so
    a hero without them would make the group counts fall one short of the runs
    table. The write is real and manual, so the timeline states it.
    """
    fields = [
        entry["field"]
        for entry in seeded["journal_entries"].find({"entity_type": "run", "entity_id": HERO})
    ]

    # The pair-only hero CLAIMS its held-back pair at registration, and an
    # unresolvable claim journals why the run waits - one more honest line.
    assert sorted(fields) == [
        "run.bench_sw",
        "run.custom_properties",
        "run.definition_claim_unresolved",
        "run.operator",
        "run.registered",
        "run.work_order_claim_unresolved",
    ]


def test_the_hero_carries_the_properties_a_person_typed(client, seeded) -> None:
    """FR-DM-108. The workbook groups by `vehicle`, and no run field holds one.

    A person states it as a custom property, so the seed writes it the way a
    person would: `manual`, under their own name.
    """
    body = client.get(f"/api/v1/test-runs/{HERO}").json()

    assert body["custom_properties"] == {
        "vehicle": "EX90-VP014",
        "test-phase": "DV — design verification",
    }
    assert body["field_sources"]["custom_properties"]["source"] == "manual"
    assert body["field_sources"]["custom_properties"]["actor"] == "a.bergstrom"


def test_every_named_run_carries_both_property_keys(seeded) -> None:
    """A custom group counts only the runs that carry the key, so a run
    without the map would make the group counts fall short of the table."""
    for doc in seeded["test_runs"].find({}):
        assert set(doc["custom_properties"]) == {"vehicle", "test-phase"}, doc["_id"]


# --- The invalid run ---------------------------------------------------------


def test_the_invalid_run_reads_back_invalid(client, seeded) -> None:
    body = client.get(f"/api/v1/test-runs/{INVALID_RUN}").json()

    assert body["status"] == "invalid"
    assert body["invalid"]["flagged"] is True
    assert body["invalid"]["reason"] == "Torque flange calibration expired — readings suspect"
    assert body["invalid"]["actor"] == "e.lindqvist"


def test_the_invalid_flag_journals_one_manual_change(seeded) -> None:
    entries = list(
        seeded["journal_entries"].find({"entity_id": INVALID_RUN, "field": "run.invalid_flag"})
    )

    assert len(entries) == 1
    assert entries[0]["kind"] == "change"
    assert entries[0]["source"] == "manual"
    assert entries[0]["actor"] == "e.lindqvist"
    assert (entries[0]["old"], entries[0]["new"]) == ("false", "true")
    assert entries[0]["note"] == "Torque flange calibration expired — readings suspect"


# --- The mirrors -------------------------------------------------------------


def test_the_five_named_work_orders_are_mirrored(seeded) -> None:
    # WO-2026-0853 (road-load acquisition) pre-mirrors DELIBERATELY: it shows
    # as planned-awaiting-data before the ingestion beat fills it; only the
    # toggle work order (0851) arrives with the sync.
    stored = {doc["_id"] for doc in seeded["work_orders"].find({}, {"_id": 1})}

    assert stored == {
        "WO-2026-0836",
        "WO-2026-0839",
        "WO-2026-0843",
        "WO-2026-0847",
        "WO-2026-0853",
    }


def test_the_sync_work_order_is_never_seeded(seeded) -> None:
    """WO-2026-0851 lives in the planning mock and arrives with the toggle."""
    assert seeded["work_orders"].find_one({"_id": fx.SYNC_WORK_ORDER_ID}) is None


def test_every_linked_definition_points_at_a_mirrored_work_order(seeded) -> None:
    """A stated work order must resolve. A null one is the deliberate orphan."""
    known = {doc["_id"] for doc in seeded["work_orders"].find({}, {"_id": 1})}
    owners = {
        doc["work_order_id"]
        for doc in seeded["test_definitions"].find({"work_order_id": {"$ne": None}})
    }

    assert owners <= known


def test_the_seed_writes_one_orphaned_definition(seeded) -> None:
    """TR-001 flags a definition no work order owns. The demo opens with one."""
    orphans = [
        doc["_id"] for doc in seeded["test_definitions"].find({"work_order_id": None})
    ]

    assert orphans == [ORPHANED_DEFINITION]


def test_every_run_work_order_is_mirrored(seeded) -> None:
    known = {doc["_id"] for doc in seeded["work_orders"].find({}, {"_id": 1})}
    used = {
        doc["work_order_id"] for doc in seeded["test_runs"].find() if doc["work_order_id"]
    }

    assert used <= known


def test_a_mirror_row_tags_every_planning_field(seeded) -> None:
    """Every mirror field is planning's, and it carries the tag that says so.

    **This test asserted the opposite until 24 Aug 2026.** The rule read
    "a mirror carries no field_sources; the UI badges it statically (§3.1)",
    and TR-011 called that the gap: a static badge is not a queryable tag, so
    an untagged row answered no `source` filter and counted in no source
    statistic.
    """
    for collection in ("work_orders", "test_definitions"):
        for doc in seeded[collection].find():
            tags = doc["field_sources"]
            assert tags, doc["_id"]
            for field, entry in tags.items():
                assert entry["source"] == "api:planning", field
            # `raw` is what planning said, not a field of the mirror row.
            assert "raw" not in tags
            assert "_id" not in tags


def test_a_mirror_row_keeps_the_planning_payload(seeded) -> None:
    doc = seeded["work_orders"].find_one({"_id": "WO-2026-0847"})

    assert doc["raw"]["title"] == doc["title"]


def test_the_work_order_detail_reads_planned_against_actual(client, seeded) -> None:
    body = client.get("/api/v1/work-orders/WO-2026-0847").json()
    states = {row["td_id"]: row["status"] for row in body["definitions"]}

    assert states["TD-EM-201"] == "on_plan"
    assert states["TD-EM-204"] == "awaiting_data"


# --- The time base -----------------------------------------------------------


def test_the_records_rebase_onto_the_seed_day(client, routed_db) -> None:
    """Dates rebase, values do not. The hero must arrive on the seed day."""
    seed_day = date(2026, 8, 28)

    seed_demo.seed(routed_db, client, seed_day=seed_day, inventory=False, filler_records=False)

    assert _run(routed_db, HERO)["first_data_at"].date() == seed_day


def test_the_seed_day_defaults_to_today(seeded) -> None:
    assert _run(seeded, HERO)["first_data_at"].date() == datetime.now(UTC).date()


def test_rebasing_keeps_the_clock_time(client, routed_db) -> None:
    seed_demo.seed(routed_db, client, seed_day=date(2026, 8, 28), inventory=False)
    started = _run(routed_db, HERO)["started_at"]

    assert (started.hour, started.minute, started.second) == (9, 41, 7)


# --- The fixtures ------------------------------------------------------------


def test_the_named_cast_matches_the_plan() -> None:
    """BE-PLAN §7: the five story runs, then the ten battery history runs
    whose clocks Lane B's lake samples sit on."""
    assert [record["run_id"] for record in fx.NAMED_RUNS] == [
        "TAS-88214",
        "TAS-88213",
        "TAS-88209",
        "TAS-88207",
        "TAS-88201",
        "TAS-88198",
        "TAS-88190",
        "TAS-88183",
        "TAS-88177",
        "TAS-88168",
        "TAS-88159",
        "TAS-88150",
        "TAS-88141",
        "TAS-88123",
        "TAS-88104",
    ]


def test_only_the_hero_waits_for_a_work_order() -> None:
    waiting = [
        record["run_id"]
        for record in fx.NAMED_RUNS
        if not any(tag["field"] == "work_order_id" for tag in record["tags"])
    ]

    assert waiting == [fx.HERO_RUN_ID]


def test_the_build_leaves_the_stored_records_alone() -> None:
    """`build` must copy. A rebase that mutates the module poisons the next call."""
    before = fx.NAMED_RUNS[0]["started_at"]

    fx.build(date(2026, 8, 28))

    assert fx.NAMED_RUNS[0]["started_at"] == before


# --- The command line --------------------------------------------------------


class _Refusal:
    """A client that refuses every registration."""

    status_code = 500
    text = "boom"

    def post(self, path, json=None):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_the_reset_flag_is_off_by_default() -> None:
    assert seed_demo.parse_args([]).reset is False


def test_the_reset_flag_reads_from_the_command_line() -> None:
    assert seed_demo.parse_args(["--reset"]).reset is True


def test_the_api_client_carries_the_bearer_token(monkeypatch) -> None:
    monkeypatch.setenv("TM_API_TOKEN", "a-token")

    with seed_demo.api_client("http://localhost:8000") as http:
        assert http.headers["Authorization"] == "Bearer a-token"


def test_main_hands_the_reset_flag_to_the_seed(monkeypatch, capsys) -> None:
    """The demo-morning step is `seed --reset`. The flag must reach the seed."""
    seen: dict = {}
    monkeypatch.setattr(seed_demo, "get_db", lambda: "a-database")
    monkeypatch.setattr(seed_demo, "api_client", lambda url: _Refusal())
    monkeypatch.setattr(
        seed_demo, "seed", lambda db, client, reset: seen.update(reset=reset) or {"test_runs": 5}
    )

    assert seed_demo.main(["--reset"]) == 0
    assert seen == {"reset": True}
    assert "test_runs" in capsys.readouterr().out


# --- A broken write stops the seed -------------------------------------------


def test_a_refused_registration_stops_the_seed(routed_db) -> None:
    """A partial seed must be loud. A quiet one is found on stage."""
    with pytest.raises(RuntimeError, match="TAS-88214"):
        seed_demo.seed(routed_db, _Refusal(), inventory=False)


def test_a_tag_without_a_registered_run_stops_the_seed(routed_db) -> None:
    with pytest.raises(RuntimeError, match="is not registered"):
        seed_demo.apply_tags(routed_db, fx.NAMED_RUNS[0])


# --- The seam with Lane B ----------------------------------------------------


def test_the_full_seed_writes_the_inventory_half(client, routed_db, monkeypatch) -> None:
    """One seed writes the whole cast. Lane B's files go through POST /files."""
    monkeypatch.delenv("Quix__Lakehouse__Query__Url", raising=False)
    monkeypatch.delenv("QUIX_LAKE_URL", raising=False)

    counts = seed_demo.seed(routed_db, client)

    assert counts["files"] > 0
    assert routed_db["files"].count_documents({}) == counts["files"]
    assert routed_db["signals"].count_documents({}) > 0


def test_a_second_full_seed_duplicates_no_registered_record(
    client, routed_db, monkeypatch
) -> None:
    """The seam is idempotent for every record the design keys.

    A registered file is keyed by its checksum, so a replay writes nothing. A
    **quarantined** file is not: the unique index is partial on
    `status: "registered"`, because two rigs may deliver the same broken bytes
    and the quarantine never drops one (BE-PLAN §3.5). So a second full seed
    adds one more quarantine row, by design. `--reset` is the way back.
    """
    monkeypatch.delenv("Quix__Lakehouse__Query__Url", raising=False)
    monkeypatch.delenv("QUIX_LAKE_URL", raising=False)
    seed_demo.seed(routed_db, client)
    before = _counts(routed_db)
    registered = {"status": "registered"}
    before_registered = routed_db["files"].count_documents(registered)

    seed_demo.seed(routed_db, client)

    assert routed_db["files"].count_documents(registered) == before_registered
    for name in ("test_runs", "work_orders", "test_definitions", "signals", "meta"):
        assert routed_db[name].count_documents({}) == before[name], name


# --- The seed opens the demo with planning offline (21 Aug 2026) ----------------
#
# `record_switch` writes our copy of the switch. Contract #20 probes the LIVE
# system, so a rehearsal that left the planning mock on made the topbar read ON
# over an all-amber stage, and the presenter had to flip it by hand.


def test_a_top_up_seed_switches_the_live_planning_system_off(
    client, routed_db, planning_offline
) -> None:
    planning_offline.post("/admin/state", json={"online": True})

    seed_demo.seed(routed_db, client, inventory=False, filler_records=False)

    assert planning_offline.get("/admin/state").json()["online"] is False
    assert routed_db["meta"].find_one({"_id": "planning_sync"})["online"] is False


def test_a_reset_seed_switches_the_live_planning_system_off(
    client, routed_db, planning_offline
) -> None:
    planning_offline.post("/admin/state", json={"online": True})

    seed_demo.seed(routed_db, client, reset=True, inventory=False, filler_records=False)

    assert planning_offline.get("/admin/state").json()["online"] is False


def test_the_seed_survives_a_planning_system_it_cannot_reach(client, routed_db) -> None:
    """No planning system is offline already. The seed still writes the cast."""
    counts = seed_demo.seed(routed_db, client, inventory=False, filler_records=False)

    assert counts["test_runs"] == len(fx.NAMED_RUNS)
