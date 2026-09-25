"""The demo seed — tickets A-10 and A-15. **This file is UTF-8.**

What one run writes, in this order:

0. the planning switch, off — the live system first, then our copy of it, so
   a rehearsal cannot leave it reading on;
1. every index of BE-PLAN §3, before the first record;
2. the fifteen named runs (five story, ten battery history), through
   `POST /test-runs`;
3. the fields no route carries yet, through `api/provenance.py::set_field`;
4. the five pre-mirrored work orders and their six definitions — read from
   the planning mock's own `fixture.json` (see `seed/fixtures.py`), so the
   seed and the mock can never disagree about the cast — plus the one
   `ORPHANED_DEFINITION` no work order owns (TR-001);
5. Lane B's inventory, through `POST /files` and `POST /results`;
6. the filler that carries the demo to its stated scale — 128 runs, 42 work
   orders, 512 files, 6 412 signals (`seed/filler.py`);
7. `meta.demo_reset_watermark`, last of all.

**The seed calls `ensure_indexes()` itself.** The conformance review found no
other code path that builds an index at runtime.

**The watermark is written last on purpose.** The demo reset (A-14) reverts
`api:planning` writes and removes mirror rows that are **newer** than the
watermark. Every record this seed writes must therefore be older than it, or
the demo reset would eat the seed. `read_watermark()` is the reader A-14 needs.
For the same reason, a re-seed WITHOUT `--reset` first runs the demo reset:
sync writes from a rehearsal would otherwise end up older than the new
watermark, where no later reset could ever reach them.

**The hero opens its own campaign.** TAS-88214 registers claiming a work order
no mirror holds, so `POST /test-runs` opens it and links the run in the same
request. The work-order line of the report counts that row, because the seed
wrote it (`seed/fixtures.py`).

**WO-2026-0851 and TD-BAT-114 are not here.** They are the pair the seed holds
back from the mock's cast, so a sync pass has a row that visibly arrives and
the demo reset has one to remove (BE-PLAN §7).

**Two resets, and they are not the same.** `demo_reset` undoes what a sync pass
wrote after the seed, and nothing else.
`seed --reset` resets the world: it drops every collection first, and it drops
the QuixLake sample table too. `POST /insert` appends, so without that drop a
second `--reset` run would double the samples and the statistics would drift.
The lake drop needs permission, and the Mongo half never does. The seed owns the
table it names itself. `TM_LAKE_TABLE` points it at a table another writer owns,
and the seed then skips the lake step whole and says so. `TM_SEED_MAY_DROP` must
name that exact table to permit the drop.

**Idempotent.** A second run writes no second record and no second journal
entry. `POST /test-runs` ignores a replay by itself; a tagged field is skipped
once the stored value already matches; the filler upserts on fixed ids.

Run it:

    uv run python -m seed.seed_demo --reset
"""

import argparse
import os
from datetime import UTC, date, datetime, timedelta

import httpx
from pymongo.database import Database

from api.db import ensure_indexes, get_db
from api.models.common import Source
from api.planning_sync import demo_reset, record_switch
from api.provenance import derive_status, mirror_tags, plain_values, set_field
from api.services import queries_signals
from api.settings import get_settings
from seed import filler, fixtures_inventory
from seed import fixtures as fx

# The definition no work order owns. TR-001 asks the screen to flag it for
# review, so the demo needs one row to flag. It is NOT in the planning mock,
# so a sync pass never adopts it and it stays orphaned.
ORPHANED_DEFINITION = {
    "_id": "TD-BAT-126",
    "work_order_id": None,
    "title": "HV battery thermal cycling · fast-charge soak",
    "planned_runs": 2,
}

# Every collection `--reset` drops. The eight of BE-PLAN §3, plus the meta
# document that holds the watermark.
COLLECTIONS = (
    "test_runs",
    "work_orders",
    "test_definitions",
    "files",
    "signals",
    "file_signals",
    "processed_results",
    "journal_entries",
    "meta",
)

META_COLLECTION = "meta"
WATERMARK_ID = "demo_reset_watermark"

# The journal shows a display path, not a document field (BE-PLAN §3.8).
_FIELD_LABELS = {
    "work_order_id": "run.work_order",
    "definition_ids": "run.definition",
}

_HTTP_TIMEOUT_SECONDS = 60.0


# --- The database side -------------------------------------------------------


def drop_everything(db: Database) -> None:
    """Drop every seeded collection. This is the `--reset` half of the world."""
    for name in COLLECTIONS:
        db.drop_collection(name)


def switch_planning_off(client) -> None:
    """Put the LIVE planning system offline — the state the demo opens in.

    The toggle route is what this calls, not `record_switch`: contract #20
    probes the live system, so recording our copy alone would leave the topbar
    reading ON. It runs FIRST, so a planning system still switched on cannot
    push a row into the world the seed is about to write.

    A planning system nobody can reach is already offline, so a failure here
    is not a seed failure.
    """
    try:
        client.post(f"{fx.API_PREFIX}/planning-sync/toggle", json={"online": False})
    except httpx.HTTPError as exc:
        print(f"could not reach the planning switch: {exc}")


def write_watermark(db: Database, at: datetime) -> datetime:
    """Stamp the demo-reset baseline. One document, one value."""
    db[META_COLLECTION].replace_one(
        {"_id": WATERMARK_ID}, {"_id": WATERMARK_ID, "at": at}, upsert=True
    )
    return at


def read_watermark(db: Database) -> datetime | None:
    """Read the demo-reset baseline. An unseeded database has none."""
    doc = db[META_COLLECTION].find_one({"_id": WATERMARK_ID})
    return doc["at"] if doc else None


# --- The runs ----------------------------------------------------------------


def register_run(client, record: dict) -> None:
    """Register one run through the public ingestion route.

    The route mints the document, tags every field it wrote as `embedded` and
    journals the registration event. The seed never inserts a run by hand.
    """
    body = {
        "run_id": record["run_id"],
        "rig_id": record["rig_id"],
        "description": record["description"],
        "test_cell": record["test_cell"],
        "started_at": record["started_at"].isoformat(),
        "ended_at": record["ended_at"].isoformat(),
    }
    # A record may state its campaign and the platform it ran on, the way a
    # TAS-produced file does in its own header. A campaign no mirror holds is
    # OPENED by the route, with the platform as its project, and the claim
    # then resolves in the same request.
    for field in ("work_order_id", "platform"):
        if record.get(field):
            body[field] = record[field]
    response = client.post(f"{fx.API_PREFIX}/test-runs", json=body)
    if response.status_code not in (200, 201):
        raise RuntimeError(
            f"POST /test-runs rejected {record['run_id']}: "
            f"{response.status_code} {response.text}"
        )


def _tag_field(run: dict, tag: dict, update: dict) -> dict | None:
    """Write one tagged field. Return its journal entry, or None when it is set.

    A second seed run offers the same value again. `manual` beats nothing and
    ties with `manual`, so precedence lets that write through; only the value
    check below keeps the timeline free of a duplicate line.
    """
    if run.get(tag["field"]) == tag["value"]:
        return None
    return set_field(
        update,
        tag["field"],
        tag["value"],
        tag["source"],
        tag["actor"],
        current_doc=run,
        entity_id=run["_id"],
        field_label=_FIELD_LABELS.get(tag["field"], f"run.{tag['field']}"),
    )


def _flag_invalid(run: dict, flag: dict, update: dict) -> dict | None:
    """Flag one run invalid. Return the journal entry, or None when it is set.

    The write is `manual`, the top rank, so precedence never blocks it and the
    helper always answers an entry.
    """
    if (run.get("invalid") or {}).get("flagged"):
        return None

    entry = set_field(
        update,
        "invalid",
        {"flagged": True, "reason": flag["reason"], "actor": flag["actor"], "at": flag["at"]},
        Source.MANUAL,
        flag["actor"],
        note=flag["reason"],
        current_doc=run,
        entity_id=run["_id"],
        field_label="run.invalid_flag",
    )
    # The stored value is a block, and a block reads badly in a timeline. The
    # journal shows the flag state, the way every other run entry does.
    # `queries_runs._note_rig_conflict` corrects its display side the same way.
    entry["old"] = "false"
    entry["new"] = "true"
    return entry


def apply_tags(db: Database, record: dict) -> list[dict]:
    """Write every field of one run that no route carries yet.

    Returns the journal entries. The run is read back first, so precedence
    compares against what is stored and the journal states a truthful old value.
    """
    run = db["test_runs"].find_one({"_id": record["run_id"]})
    if run is None:
        raise RuntimeError(f"{record['run_id']} is not registered, so no tag can land")

    update: dict = {}
    entries = [entry for tag in record["tags"] if (entry := _tag_field(run, tag, update))]

    if record["invalid"]:
        entry = _flag_invalid(run, record["invalid"], update)
        if entry is not None:
            entries.append(entry)

    if update:
        update["status"] = derive_status({**run, **plain_values(update)})
        update["updated_at"] = datetime.now(UTC)
        db["test_runs"].update_one({"_id": record["run_id"]}, {"$set": update})
    if entries:
        db["journal_entries"].insert_many(entries)
    return entries


def write_runs(db: Database, client, records: list[dict]) -> int:
    """Register every named run, then stamp the fields the route cannot carry."""
    for record in records:
        register_run(client, record)
        apply_tags(db, record)
    return len(records)


# --- The mirrors -------------------------------------------------------------


# Who wrote a seeded mirror row. The sync pass uses `planning_sync.SYNC_ACTOR`
# for the same work, and the seed states its own name so a reader can tell a
# seeded row from a synced one.
SEED_MIRROR_ACTOR = "seed"


def write_mirrors(db: Database, records: list[dict], collection: str, synced_at: datetime) -> int:
    """Replace one mirror collection's named rows.

    A mirror carries no journal entry: planning owns every field and the UI
    badges the row statically (BE-PLAN §3.1). `raw` is the exact row the
    planning mock serves (`fixtures.py` supplies it), so a sync refresh finds
    nothing to change.

    **This docstring said "no `field_sources`" until 24 Aug 2026, and that is
    what TR-011 called a gap.** A static badge is not a queryable tag: an
    untagged row answers no `source` filter and counts in no source statistic.
    Every planning-owned field carries the `api:planning` tag now, exactly as
    `planning_sync._write_mirror` writes it on a sync pass.
    """
    for record in records:
        doc = {**record, "synced_at": synced_at}
        doc.setdefault("raw", dict(record))
        planning_fields = [key for key in record if key not in ("_id", "raw")]
        doc["field_sources"] = {
            key.removeprefix("field_sources."): value
            for key, value in mirror_tags(
                planning_fields, Source.API_PLANNING, SEED_MIRROR_ACTOR, synced_at
            ).items()
        }
        db[collection].replace_one({"_id": record["_id"]}, doc, upsert=True)
    return len(records)


# --- The whole seed ----------------------------------------------------------


def seed(
    db: Database,
    client,
    seed_day: date | None = None,
    reset: bool = False,
    inventory: bool = True,
    filler_records: bool = True,
) -> dict[str, int]:
    """Write the demo cast and return a count per collection.

    `client` is anything with a `.post(path, json=...)` method, so a test passes
    the FastAPI test client and opens no socket. Set `inventory` to False to
    write the Lane A half alone, and `filler_records` to False for a small cast.
    """
    # Both paths open the demo with planning offline. This stops the live
    # system; the branch below undoes what it wrote.
    switch_planning_off(client)

    if reset:
        drop_everything(db)
    elif (
        read_watermark(db) is not None
        and db[META_COLLECTION].find_one({"_id": "planning_sync"}) is not None
    ):
        # A rehearsal may have left sync writes behind. They would sit OLDER
        # than the new watermark below, where no later reset could ever reach
        # them — so undo them first, and record the switch as off, the state
        # the demo opens in. A database that never saw a sync has no
        # planning_sync meta doc and nothing to undo.
        demo_reset(db)
        record_switch(db, False)
    ensure_indexes(db)

    seed_day = seed_day or datetime.now(UTC).date()
    records = fx.build(seed_day)
    started_at = datetime.now(UTC)
    # BE-PLAN §6: a mirror row reads as pulled shortly before the seed ran.
    synced_at = started_at - timedelta(minutes=5)
    campaigns_before = db["work_orders"].count_documents({})
    counts = {"test_runs": write_runs(db, client, records["runs"])}
    # The report states what the seed WROTE, and the hero's registration writes
    # a work order of its own (`queries_runs._open_claimed_work_order`). A
    # re-seed opens nothing, so this reads zero the second time.
    opened = db["work_orders"].count_documents({}) - campaigns_before
    counts["work_orders"] = opened + write_mirrors(
        db, records["work_orders"], "work_orders", synced_at
    )
    counts["test_definitions"] = write_mirrors(
        db,
        [*records["definitions"], ORPHANED_DEFINITION],
        "test_definitions",
        synced_at,
    )
    if inventory:
        counts.update(fixtures_inventory.write_inventory(db, client, seed_day, reset))
    if filler_records:
        for key, value in _write_filler(db, records, seed_day, synced_at).items():
            counts[key] = counts.get(key, 0) + value

    # FR-DM-111: fill `source_systems` on every catalogue row the seed wrote.
    # The seed inserts the catalogue straight from the fixtures, so the ingest
    # path never runs for those rows and they carry no producing system.
    queries_signals.backfill_source_systems(db)

    # Last, so every record above sits on the safe side of the reset.
    write_watermark(db, datetime.now(UTC))
    return counts


def _write_filler(db: Database, records: dict, seed_day: date, synced_at: datetime) -> dict:
    """Pad the cast to the demo's scale. Idempotent, like the rest of the seed.

    The file and signal counts are read live, so the filler tops up exactly to
    the DEMO_* constants whatever the named cast and the inventory wrote. The
    inventory registers its files at seed time, so they all count as today's.
    """
    named_runs = records["runs"]
    named_today = sum(
        1
        for run in named_runs
        if (run.get("first_data_at") or run.get("started_at"))
        and (run.get("first_data_at") or run["started_at"]).date() == seed_day
    )
    named_files = db["files"].count_documents({})
    # The campaigns the named cast accounts for: the mirrored rows, plus the one
    # the hero's registration opened from its own claim. Stated from the cast and
    # not counted off the database, so the filler bundle is the same every run.
    named_campaigns = {row["_id"] for row in records["work_orders"]} | {
        fx.HERO_CLAIMED_WORK_ORDER_ID
    }

    bundle = filler.build(
        seed_day,
        named_runs=len(named_runs),
        named_runs_today=named_today,
        named_files=named_files,
        named_files_today=named_files,
        named_signals=db["signals"].count_documents({}),
        named_work_orders=len(named_campaigns),
        synced_at=synced_at,
        taken_signal_names=frozenset(db["signals"].distinct("_id")),
    )

    written = {"test_runs": 0, "files": 0, "signals": 0, "work_orders": 0}
    for collection, key in (
        ("test_runs", "runs"),
        ("files", "files"),
        ("signals", "signals"),
        ("work_orders", "work_orders"),
    ):
        for doc in bundle[key]:
            result = db[collection].update_one(
                {"_id": doc["_id"]}, {"$setOnInsert": doc}, upsert=True
            )
            written[collection] += 1 if result.upserted_id else 0

    return written


# --- The self-verify ----------------------------------------------------------


def self_verify(db: Database) -> dict:
    """Walk the state the demo opens in and prove the seed can carry it.

    Check the hero arrived on the seed day, that the campaign it claimed was
    opened and linked, then run the demo reset and prove it moved nothing the
    seed wrote. That reset runs on every top-up seed, so a wrong scope would
    eat the cast between two rehearsals.

    Every check is reported, not raised, so one run tells the whole story. A
    stale seed fails here, in a terminal, and never on stage.
    """
    checks: dict[str, bool] = {}
    failures: list[str] = []

    def record(name: str, ok: bool, message: str) -> None:
        checks[name] = ok
        if not ok:
            failures.append(message)

    today = datetime.now(UTC).date()
    hero = db["test_runs"].find_one({"_id": fx.HERO_RUN_ID})
    record("hero_run_exists", hero is not None, f"The hero run {fx.HERO_RUN_ID} is missing.")
    if hero is None:
        return {"ok": False, "checks": checks, "failures": failures}

    record(
        "hero_arrived_on_the_seed_day",
        hero["first_data_at"].date() == today,
        f"The hero run is dated {hero['first_data_at'].date()}, not the seed day. Re-run the seed.",
    )

    midnight = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    runs_today = db["test_runs"].count_documents({"first_data_at": {"$gte": midnight}})
    record(
        "enough_runs_arrived_today",
        runs_today >= filler.RUNS_TODAY,
        f"Only {runs_today} runs are dated today; the Home screen promises {filler.RUNS_TODAY}.",
    )

    record(
        "the_upload_opened_its_campaign",
        db["work_orders"].find_one({"_id": fx.HERO_CLAIMED_WORK_ORDER_ID}) is not None,
        f"{fx.HERO_CLAIMED_WORK_ORDER_ID} was never opened. The hero's registration "
        "did not open the campaign it claimed.",
    )
    record(
        "the_hero_links_its_campaign",
        hero.get("work_order_id") == fx.HERO_CLAIMED_WORK_ORDER_ID
        and hero.get("status") == "complete",
        "The hero run did not link the campaign it claimed, so the stage opens amber.",
    )

    # Before the restore check: a microsecond mismatch would otherwise read as a
    # reset bug (guard 3, A-01).
    record(
        "timestamps_survive_mongo",
        _timestamps_round_trip(db),
        "A timestamp changed on the way through Mongo, so a restore can never compare equal.",
    )

    mirrors_before = _mirror_snapshot(db)
    before = db["test_runs"].find_one({"_id": fx.HERO_RUN_ID})
    demo_reset(db)
    after = db["test_runs"].find_one({"_id": fx.HERO_RUN_ID})

    record(
        "restore_is_exact",
        _same_run(before, after),
        "The demo reset moved the hero run. Its scope is wrong, and a top-up seed "
        "would eat the cast.",
    )
    record(
        "mirror_restore_is_exact",
        _mirror_snapshot(db) == mirrors_before,
        "The demo reset moved a work-order or definition mirror row. Its scope is wrong.",
    )
    record(
        "every_link_resolves",
        _linked_definitions_resolve(db),
        "A definition names a work order that is not in the mirror.",
    )

    return {"ok": not failures, "checks": checks, "failures": failures}


def _timestamps_round_trip(db: Database) -> bool:
    """Write a microsecond timestamp, read it back, compare at Mongo's precision."""
    written = datetime.now(UTC)
    db[META_COLLECTION].replace_one(
        {"_id": "self_verify_probe"}, {"_id": "self_verify_probe", "at": written}, upsert=True
    )
    read = db[META_COLLECTION].find_one({"_id": "self_verify_probe"})["at"]
    db[META_COLLECTION].delete_one({"_id": "self_verify_probe"})
    return abs((read - written).total_seconds()) < 0.001


def _same_run(before: dict, after: dict) -> bool:
    """Compare two run documents whole.

    `updated_at` moves on every write, the reset's included, so it is the one
    field the compare ignores. Everything else — values, source tags, the
    invalid block — must come back exactly.
    """
    def strip(doc: dict) -> dict:
        return {key: value for key, value in doc.items() if key != "updated_at"}

    return strip(before) == strip(after)


def _mirror_snapshot(db: Database) -> dict:
    """Every work-order and definition row, without what a legal refresh moves.

    `synced_at` is the refresh clock. `field_sources` carries the same clock
    per field, plus the name of whoever ran the refresh — the seed writes
    `seed` and a sync pass writes `planning-sync` (TR-011, 24 Aug 2026). Both
    move on a refresh that changes no value, so neither can prove a reset bug.
    The values themselves still must come back exactly.
    """
    rows: dict = {}
    for collection in ("work_orders", "test_definitions"):
        for doc in db[collection].find({}):
            doc.pop("synced_at", None)
            doc.pop("field_sources", None)
            rows[(collection, doc["_id"])] = doc
    return rows


def _linked_definitions_resolve(db: Database) -> bool:
    """Every work order a definition NAMES must exist in the mirror.

    A null `work_order_id` is the deliberate orphan of TR-001, not a broken
    link, so it passes. A stated id that resolves to nothing is still a bug:
    the seed and the planning mock disagree about the cast.
    """
    known = {row["_id"] for row in db["work_orders"].find({}, {"_id": 1})}
    return all(
        row["work_order_id"] in known
        for row in db["test_definitions"].find(
            {"work_order_id": {"$ne": None}}, {"work_order_id": 1}
        )
    )


# --- The command line --------------------------------------------------------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed the Test Manager demo registry.")
    parser.add_argument(
        "--reset",
        action="store_true",
        help=(
            "Drop every collection before the write. This resets the world. "
            "The lake table drops only when the seed owns it, or when "
            "TM_SEED_MAY_DROP names it."
        ),
    )
    parser.add_argument(
        "--api-url",
        default=os.environ.get("TM_API_URL", "http://localhost:8000"),
        help="Base URL of the running API. The seed writes through it.",
    )
    parser.add_argument(
        "--self-verify",
        action="store_true",
        help="Check the state the demo opens in, instead of seeding. Runs the demo reset.",
    )
    return parser.parse_args(argv)


def api_client(base_url: str) -> httpx.Client:
    """Build the HTTP client the write path needs, with the bearer token."""
    token = get_settings().api_token
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return httpx.Client(base_url=base_url, headers=headers, timeout=_HTTP_TIMEOUT_SECONDS)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    db = get_db()

    if args.self_verify:
        report = self_verify(db)
        for name, ok in report["checks"].items():
            print(f"{'PASS' if ok else 'FAIL':5} {name}")
        for failure in report["failures"]:
            print(f"\n  {failure}")
        print("\nThe demo is ready." if report["ok"] else "\nFix these before the demo.")
        return 0 if report["ok"] else 1

    with api_client(args.api_url) as client:
        counts = seed(db, client, reset=args.reset)

    for name, count in sorted(counts.items()):
        print(f"{name:20} {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
