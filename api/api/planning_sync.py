"""Planning sync pass and demo-reset watermark logic (BE-PLAN §4.4).

The demo mocks the source system, never the mechanism. This pass is the real
one: pull, mirror, backfill, journal. Only the planning system behind it is a
mock, and the demo toggle flips that mock's switch.

**The arrow is being turned around.** `apply_planning_push` is the same
mechanism driven from the other end: planning polls the registry for the runs
still waiting, matches them against its own catalog, and posts the catalog and
the links it decided. Arrows point INTO the Test Manager, so `run_sync_pass` —
the last outbound fetch — retires once the push is proven in the cloud. Both
halves share `_mirror_work_orders`, `_mirror_definitions` and `_write_link`, so
neither can drift from the other while both live.

**The reset in this module belongs to the seed alone.** A real registry never
un-remembers, so no toggle calls it. `python -m seed.seed_demo` drives the seed
from the command line, and the seed calls the reset on the top-up path, where a
rehearsal may have left sync writes behind. Its delete scope is deliberately narrow: only `api:planning`
writes that are newer than the seed's watermark. Widening that scope would let
it eat a person's edits, which is exactly what it must never do.

**The planning-sync toggle called it until 20 Aug 2026.** That was the hazard:
the reset cannot tell a row a person pushed in from a row the sync fetched, so
a presenter's own work order left on a toggle. The toggle only stops the sync
now.
"""

import logging
from datetime import UTC, datetime
from typing import Any, Protocol

import httpx
from pymongo.database import Database

from api import config_push
from api.models.common import Source
from api.models.journal import EMPTY
from api.provenance import add_event, derive_status, mirror_tags, plain_values, set_field
from api.requirement_lifecycle import DERIVED_STATUSES
from api.services import queries_requirements
from api.services.queries_runs import CLAIM_RETAINED
from api.settings import get_settings

log = logging.getLogger("api.planning_sync")

# The fields planning owns on a run. The backfill writes these and nothing else.
PLANNING_FIELDS = ("work_order_id", "definition_ids", "project")

# The journal label of each planning field (contract §A). `definition_ids` reads
# `run.definition`, the label the timeline carried while the field was scalar.
_LINK_LABELS = {
    "work_order_id": "run.work_order",
    "definition_ids": "run.definition",
    "project": "run.project",
}

OFFLINE_REASON = "planning system offline"

SYNC_ACTOR = "planning-sync"

# The status a work order takes when planning states none. `WorkOrderStatus`
# holds two values, and a work order planning has not closed is open.
DEFAULT_WORK_ORDER_STATUS = "active"

# The mirror fields a journal entry reports, per collection. Planning owns
# every one of them, so a change here is planning changing its mind, and the
# screens must be able to say who moved the title and when.
_JOURNALLED_FIELDS = {
    "work_orders": ("title", "project", "status"),
    "test_definitions": ("title", "work_order_id", "planned_runs"),
}

_META_ID = "planning_sync"
_WATERMARK_ID = "demo_reset_watermark"


class PlanningClient(Protocol):
    """What this module needs from a planning system: a GET and a POST."""

    def get(self, url: str, **kwargs: Any) -> httpx.Response: ...

    def post(self, url: str, **kwargs: Any) -> httpx.Response: ...


def _client() -> httpx.Client:
    return httpx.Client(base_url=get_settings().planning_api_url, timeout=10.0)


def get_planning_client():
    """FastAPI dependency: a client for the planning system.

    Tests override this with an in-process client, so no test opens a socket.
    """
    with _client() as client:
        yield client


def set_planning_online(client: PlanningClient, online: bool) -> None:
    """Flip the planning system's switch. The demo toggle calls this.

    A planning system that cannot be reached is already offline, so a failure
    here is not an error.
    """
    try:
        client.post("/admin/state", json={"online": online})
    except httpx.HTTPError as exc:
        log.info("could not reach the planning switch: %s", exc)


def is_planning_online(client: PlanningClient) -> bool:
    """Report the planning system's switch. Unreachable reads as offline.

    A 200 with a non-JSON body is a broken planning system, not a crash of
    ours, so it reads as offline like every other failure here. `_fetch`
    already guards its own read the same way. Without this guard
    `GET /planning-sync/status` answered 500.
    """
    try:
        response = client.get("/admin/state")
    except httpx.HTTPError:
        return False
    if response.status_code >= 400:
        return False
    try:
        state = response.json()
    except ValueError:
        log.warning("planning system answered a non-JSON body for /admin/state")
        return False
    return bool(state.get("online", False)) if isinstance(state, dict) else False


def record_switch(db: Database, online: bool) -> None:
    """Persist the toggle's switch state.

    The Home summary reads it from here (contract #1), so the tile and the
    topbar agree; contract #20 still probes the live system. The seed also
    records `False` on a re-seed, so a rehearsal can never leave a stale
    `True` behind that would turn the next toggle-on into a no-op.
    """
    db["meta"].update_one({"_id": _META_ID}, {"$set": {"online": online}}, upsert=True)


def switch_state(db: Database) -> bool:
    """The last state the toggle recorded. A fresh database reads as off."""
    meta = db["meta"].find_one({"_id": _META_ID}) or {}
    return bool(meta.get("online", False))


def sync_status(db: Database, client: PlanningClient) -> dict:
    """Everything contract #20 reports."""
    meta = db["meta"].find_one({"_id": _META_ID}) or {}
    return {
        "online": is_planning_online(client),
        "last_sync_at": meta.get("last_sync_at"),
        "last_sync_result": meta.get("last_sync_result"),
        "work_orders_mirrored": db["work_orders"].count_documents({}),
    }


def _fetch(client: PlanningClient, path: str) -> list[dict] | None:
    """Read one planning list. `None` means the system is offline."""
    try:
        response = client.get(f"/api/v1/{path}")
    except httpx.HTTPError as exc:
        log.info("planning system unreachable: %s", exc)
        return None
    if response.status_code == 503:
        return None
    if response.status_code >= 400:
        log.warning("planning system answered %s for %s", response.status_code, path)
        return None
    try:
        return response.json().get("items", [])
    except ValueError:
        # A 200 with a non-JSON body is a broken planning system, not a crash
        # of ours. It reads as offline, like every other failure here.
        log.warning("planning system answered a non-JSON body for %s", path)
        return None


def run_sync_pass(db: Database, client: PlanningClient | None = None) -> dict:
    """Pull planning, mirror it, and fill the runs that were waiting.

    Returns `{"synced": False, "reason": ...}` when planning is offline. That is
    not an error: a run without a work order is a normal amber state, and
    ingestion never waits for planning.
    """
    owned = client is None
    client = client or _client()
    try:
        work_orders = _fetch(client, "work-orders")
        definitions = _fetch(client, "test-definitions")
    finally:
        if owned:
            client.close()

    if work_orders is None or definitions is None:
        return {"synced": False, "reason": OFFLINE_REASON}

    now = datetime.now(UTC)
    _mirror_work_orders(db, work_orders, now)
    _mirror_definitions(db, definitions, now)
    backfilled = _backfill_runs(db, definitions) + _link_retained_claims(db)

    result = {
        "work_orders": len(work_orders),
        "definitions": len(definitions),
        "runs_backfilled": backfilled,
    }
    db["meta"].update_one(
        {"_id": _META_ID},
        {"$set": {"last_sync_at": now, "last_sync_result": result}},
        upsert=True,
    )
    return {"synced": True, **result}


def _parse_when(value) -> datetime | None:
    """Read one planning timestamp. Planning serves ISO-8601 with `Z`.

    The mirror stores a datetime, like every other date in the registry — a
    refresh of a seeded row must write the same type the seed wrote.
    """
    if value is None or isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value))


def _display(value) -> str:
    """Render one journal side. An absent value reads as the empty marker.

    The same convention `api/provenance.py` applies to a field write.
    """
    return EMPTY if value is None else str(value)


def _mirror_journal(
    entity_type: str,
    entity_id: str,
    stored: dict | None,
    values: dict,
    fields: tuple[str, ...],
) -> list[dict]:
    """Report what one mirror write did, as journal entries.

    A row the mirror never held reports one `mirrored` event. A row it already
    held reports one `change` entry per field planning moved, with the old and
    the new value. A refresh that moves nothing writes nothing, so a second
    pass over the same catalog journals silence and stays idempotent.

    `add_event` owns the entry shape, as everywhere else. A change carries an
    old and a new value, which an event never does, so this sets those three
    keys on the built row — the pattern `queries_runs.add_run_note` uses for a
    note.
    """
    if stored is None:
        return [
            add_event(
                entity_type,
                entity_id,
                f"{entity_type}.mirrored",
                Source.API_PLANNING,
                SYNC_ACTOR,
                note="Mirrored from planning.",
            )
        ]

    entries = []
    for field in fields:
        if stored.get(field) == values[field]:
            continue
        entry = add_event(
            entity_type,
            entity_id,
            f"{entity_type}.{field}",
            Source.API_PLANNING,
            SYNC_ACTOR,
            note="Changed by planning.",
        )
        entry["kind"] = "change"
        entry["old"] = _display(stored.get(field))
        entry["new"] = _display(values[field])
        entries.append(entry)
    return entries


def _write_mirror(
    db: Database,
    collection: str,
    entity_type: str,
    entity_id: str,
    values: dict,
    raw: dict,
    now: datetime,
) -> None:
    """Upsert one mirror row and journal what planning decided.

    The one write path for both mirrors, whichever direction carried the row.
    It reads the stored row first, because the journal states an old value and
    an upsert cannot report one.
    """
    stored = db[collection].find_one({"_id": entity_id})
    # TR-011: planning owns every field written here, so each one carries the
    # `api:planning` tag. Without it a mirrored row answered no source filter
    # and counted in no source statistic.
    tags = mirror_tags(values, Source.API_PLANNING, SYNC_ACTOR, now)
    db[collection].update_one(
        {"_id": entity_id},
        {
            "$set": {**values, **tags, "synced_at": now, "raw": raw},
            # When this row first appeared here. The reset removes the rows
            # the sync CREATED, so refreshing a seeded row must not mark it
            # for deletion (BE-PLAN §4.4).
            "$setOnInsert": {"mirrored_at": now},
        },
        upsert=True,
    )
    entries = _mirror_journal(
        entity_type, entity_id, stored, values, _JOURNALLED_FIELDS[collection]
    )
    if entries:
        db["journal_entries"].insert_many(entries)


def _mirror_work_orders(db: Database, rows: list[dict], now: datetime) -> None:
    """Replace the work-order mirror. Planning owns every field here.

    **`title`, `project` and `status` are coerced on the way in.** The read
    models require a string for all three (`models/planning.py`), and planning
    may state none. A stored null answered 500 for the WHOLE work-order page
    until 21 Aug 2026, because a response `ValidationError` is not a request
    error and no per-row handler catches it. An absent title or project reads
    as the empty string, and an unstated status reads `active`. `raw` still
    holds what planning actually said, so the audit loses nothing.
    """
    changed: list[dict] = []
    for row in rows:
        # New, changed, or never delivered: only those go to Dynamic
        # Configuration below -- the sync re-mirrors every pass, and
        # re-pushing an identical work order each 30 s would count phantom
        # versions there. A row with no `config_pushed_at` stamp covers the
        # BACKFILL (rows that predate the integration, and every reseed) and
        # the RETRY of a push that failed (25 Aug 2026).
        stored = db["work_orders"].find_one(
            {"_id": row["id"]}, {"raw": 1, "config_pushed_at": 1}
        )
        if (
            stored is None
            or stored.get("raw") != row
            or not stored.get("config_pushed_at")
        ):
            changed.append(row)
        values = {
            "title": row.get("title") or "",
            "project": row.get("project") or "",
            "status": row.get("status") or DEFAULT_WORK_ORDER_STATUS,
            "requestor": row.get("requestor"),
            "department": row.get("department"),
            "priority": row.get("priority"),
            # Planning calls it `created_at`; the mirror records whose clock
            # it was.
            "created_at_source": _parse_when(row.get("created_at")),
        }
        _write_mirror(db, "work_orders", "work_order", row["id"], values, row, now)
    # One chokepoint covers every arrival: the pull, the inbound push and
    # planning's adoption all mirror work orders through here. Only ids the
    # config API actually TOOK are stamped, so the rest retry next pass.
    for pushed_id in config_push.push_work_orders(changed):
        db["work_orders"].update_one(
            {"_id": pushed_id}, {"$set": {"config_pushed_at": now}}
        )


def _requirements_files(db: Database, row: dict, now: datetime) -> list[dict]:
    """Stamp the requirements documents planning sent.

    Planning states a name and the text. The registry states the rest, so a
    planning system can never claim a document a person wrote: the source is
    `planning`, and `updated_by` is null because planning names no person.

    **`updated_at` is the moment the text last CHANGED, never the moment of the
    last pass.** A pass that re-sends the same text keeps the stored stamp. So
    a refresh that moves nothing leaves the row exactly as it found it, which
    is the rule `seed_demo._mirror_snapshot` holds.

    A document with no name or no text is dropped. Planning owns the field, so
    one bad document must not fail the whole push.
    """
    stored = db["test_definitions"].find_one({"_id": row["id"]}, {"requirements_files": 1}) or {}
    held = {
        document["name"]: document for document in stored.get("requirements_files") or []
    }

    stamped = []
    for document in row.get("requirements_files") or []:
        name = str(document.get("name") or "").strip()
        content = document.get("content")
        if not name or not content:
            continue
        previous = held.get(name)
        unchanged = previous is not None and previous.get("content") == content
        stamped.append(
            {
                "name": name,
                "content": content,
                "source": "planning",
                "updated_at": previous["updated_at"] if unchanged else now,
                "updated_by": None,
            }
        )
    return stamped


def _mirror_definitions(db: Database, rows: list[dict], now: datetime) -> None:
    """Replace the definition mirror.

    `title` is coerced for the same reason the work-order title is: the
    definition list requires a string. `planned_runs` needs no coercion —
    both readers already fall back to 0 — and `work_order_id` is nullable by
    design, because an orphaned definition names no work order (TR-001).

    `requirements_files` holds the documents planning sent, and planning owns
    that list wholesale: a pass replaces it, and a pass that sends none empties
    it. A document a person uploaded lives in `manual_requirements_files`, so
    no sync pass ever reaches it.

    `covers_req_ids` is the authored direction of the requirement link (BP5):
    planning states which requirements a test case verifies, and it too is
    replaced wholesale on every pass.
    """
    for row in rows:
        values = {
            "work_order_id": row.get("work_order_id"),
            "title": row.get("title") or "",
            "planned_runs": row.get("planned_runs"),
            "requirements_files": _requirements_files(db, row, now),
            "covers_req_ids": row.get("covers_req_ids") or [],
        }
        _write_mirror(db, "test_definitions", "test_definition", row["id"], values, row, now)


def _mirror_requirements(db: Database, rows: list[dict], now: datetime) -> None:
    """Mirror the requirement catalog, one field write per field (BL-35 §9.1).

    **This is the one departure from `_write_mirror`.** A manual edit
    (`dev-planning/authoring-controls/spec.md`) can coexist with a planning
    push on the same row, so the wholesale overwrite every other mirror uses
    would let a push erase a person's edit outright. `set_field` decides per
    field instead: `manual` outranks `api:planning`, so a push naming a field
    a person already edited skips that field only and lands every other one —
    the precedence `_write_link` already holds for a run.

    `normative_sha256` is computed off the MERGED state (the fields this pass
    actually wrote, layered over what was already stored), never off the raw
    push, so a field a manual edit blocked keeps its manual value in the hash.
    It moves, and `normative_changed_at` stamps the moment, only when the
    digest actually differs from the one stored (§4.6).

    One value the mirror never lands is a `status` in `DERIVED_STATUSES`: the
    planning door is not a way around the status gate
    (requirement-status-gates §4.1).
    """
    collection = db["requirements"]
    for row in rows:
        req_id = row["id"]
        stored = collection.find_one({"_id": req_id})
        values = {
            "title": row.get("title") or "",
            "text": row.get("text") or "",
            "text_rendered": row.get("text_rendered"),
            "status": row.get("status") or "",
            "system": row.get("system"),
            "chapter": row.get("chapter"),
            "ears_pattern": row.get("ears_pattern"),
            "revision": row.get("revision"),
            "measurand": row.get("measurand") or [],
            "system_states": row.get("system_states") or [],
            "verification_method": row.get("verification_method"),
            "verification_criteria": row.get("verification_criteria"),
            "rationale": row.get("rationale"),
            "source": row.get("source") or [],
            "related_reqs": row.get("related_reqs") or [],
            "figure_refs": row.get("figure_refs") or [],
        }
        if values["status"] in DERIVED_STATUSES:
            # `Implemented` and `Tested` are read off `verification_state` and
            # are never stored (requirement-status-gates §4.1), whichever door
            # states them. A push naming one lands every other field and leaves
            # the status where it was; a row born on such a push starts with
            # the empty status a push that omits the field already writes.
            values["status"] = (stored.get("status") or "") if stored else ""

        update: dict = {}
        entries: list[dict] = []
        for field, value in values.items():
            entry = set_field(
                update,
                field,
                value,
                Source.API_PLANNING,
                SYNC_ACTOR,
                note="Mirrored from planning.",
                current_doc=stored,
                entity_type="requirement",
                entity_id=req_id,
                field_label=f"requirement.{field}",
            )
            if entry is not None:
                entries.append(entry)

        if stored is None:
            entries = [
                add_event(
                    "requirement",
                    req_id,
                    "requirement.mirrored",
                    Source.API_PLANNING,
                    SYNC_ACTOR,
                    note="Mirrored from planning.",
                )
            ]

        merged = {**(stored or {}), **plain_values(update)}
        fresh_normative = queries_requirements.normative_sha256(merged)
        if (stored or {}).get("normative_sha256") != fresh_normative:
            update["normative_sha256"] = fresh_normative
            update["normative_changed_at"] = now

        # `content_sha256`/`item_version` are the authoring API's concurrency
        # guard (dev-planning/authoring-controls/spec.md §6), and they apply
        # here too: a planning push is a content change like any other, so it
        # mints the same way an authored edit does — one hash, one rule,
        # whichever side wrote it. A brand new row always mints version 1
        # here, because `stored` carries no `content_sha256` to match.
        fresh_content = queries_requirements.content_sha256(merged)
        if (stored or {}).get("content_sha256") != fresh_content:
            update["content_sha256"] = fresh_content
            update["item_version"] = ((stored or {}).get("item_version") or 0) + 1

        update["raw"] = row
        update["synced_at"] = now

        collection.update_one(
            {"_id": req_id},
            {"$set": update, "$setOnInsert": {"mirrored_at": now}},
            upsert=True,
        )
        if entries:
            db["journal_entries"].insert_many(entries)


def _write_link(
    db: Database,
    run: dict,
    work_order_id: str,
    definition_ids: list[str],
    project: str | None,
    note: str,
) -> bool:
    """Write planning's link onto one run. Report whether anything changed.

    The ONE write path for a planning link, whichever direction carried it: the
    outbound pass's backfill and the inbound `POST /planning/sync` both land
    here, so neither can drift from the other's provenance rules.

    Every write goes through the provenance helper, so the precedence decides:
    a `manual` value is never overwritten, and an `embedded` value — the
    ingestion pipeline's link claim — is corrected. A run that already holds
    the same value writes nothing and journals nothing, and this returns False.

    The definitions MERGE. A run fulfils a set of them, planning states one per
    link, and the union is what makes two links for one run additive and a
    re-post of the same links a no-op. A definition leaves a run through
    `DELETE /test-runs/{run_id}/definitions/{definition_id}`, or through
    `PATCH /test-runs/{run_id}`, which replaces the set.
    """
    update: dict = {}
    entries: list[dict] = []
    merged = sorted(set(run.get("definition_ids") or []) | set(definition_ids))
    values = {
        "work_order_id": work_order_id,
        # An empty set states nothing, and the loop below skips a None.
        "definition_ids": merged or None,
        "project": project,
    }
    for field, value in values.items():
        if value is None or run.get(field) == value:
            continue
        entry = set_field(
            update,
            field,
            value,
            Source.API_PLANNING,
            SYNC_ACTOR,
            note=note,
            current_doc=run,
            field_label=_LINK_LABELS[field],
        )
        if entry is not None:
            entries.append(entry)

    if not update:
        return False

    update["status"] = derive_status({**run, **plain_values(update)})
    update["updated_at"] = datetime.now(UTC)
    db["test_runs"].update_one({"_id": run["_id"]}, {"$set": update})
    if entries:
        db["journal_entries"].insert_many(entries)
    return True


def _backfill_runs(db: Database, definitions: list[dict]) -> int:
    """Fill the runs a definition names, and correct the ones planning outranks.

    **This selector used to read `work_order_id: None`, and that was the wrong
    guard.** It made the FIRST writer the owner, so a pipeline claim could
    never be corrected and planning stopped being the master of its own field.
    The provenance rank is the guard now. Changed 19 Aug 2026, with the run
    link claims of `POST /test-runs`.
    """
    backfilled = 0
    for definition in definitions:
        work_order_id = definition.get("work_order_id")
        if not work_order_id:
            continue
        project = (db["work_orders"].find_one({"_id": work_order_id}) or {}).get("project")
        note = f"Backfilled from planning — definition {definition['id']}."

        for run_id in definition.get("run_ids") or []:
            run = db["test_runs"].find_one({"_id": run_id})
            if run is None:
                continue
            if _write_link(db, run, work_order_id, [definition["id"]], project, note):
                backfilled += 1

    return backfilled


def _link_retained_claims(db: Database) -> int:
    """Honour the claims the registry could not resolve when they arrived.

    A run produced before planning knew its work order keeps the id it claimed
    (`queries_runs.CLAIM_RETAINED`). Once the mirror holds that row — pulled by
    `run_sync_pass` or pushed to `apply_planning_push` — the loop closes here.
    Without this the claim survived only as prose inside a journal note, and
    the repair path read a definition's `run_ids`, which a bench-generated id
    never appears in.

    The write is at PLANNING provenance, because the registry can vouch for the
    id now: the mirror holds the row. The claim only decided which link to look
    for; it never supplies the authority.

    A repair FILLS a hole and never corrects one. The selector takes the runs
    still waiting, so a stale bench claim can never re-point a link planning or
    a person already made, and both callers run it AFTER their own links, so an
    explicit planning decision always takes the field first. `_write_link` is
    the second guard and the one write path.
    """
    # Per FIELD, not per run: a manually linked work order does not close the
    # run's definition hole, and the retained definition claim must still fill
    # it (pair-only planning, 24 Aug 2026). Each write stays rank-guarded, so
    # a filled field is never re-pointed.
    #
    # A run holds no definition when the array is empty, and a document written
    # before the array existed holds no key at all — `$in` covers both.
    waiting = {
        "$or": [
            {"work_order_id": None, CLAIM_RETAINED["work_order_id"]: {"$ne": None}},
            {
                "definition_ids": {"$in": [None, []]},
                CLAIM_RETAINED["definition_id"]: {"$ne": None},
            },
        ],
    }

    linked = 0
    for run in db["test_runs"].find(waiting):
        resolved = _resolve_retained_claim(db, run)
        if resolved is None:
            continue
        work_order_id, definition_id, claimed = resolved
        project = (db["work_orders"].find_one({"_id": work_order_id}) or {}).get("project")
        note = f"Linked by planning — the run claimed {claimed}, now mirrored."
        ids = [definition_id] if definition_id else []
        if _write_link(db, run, work_order_id, ids, project, note):
            linked += 1

    return linked


def _resolve_retained_claim(db: Database, run: dict) -> tuple[str, str | None, str] | None:
    """Read one run's remembered claim against the mirror.

    Returns the work order, the definition and how to name the claim in the
    journal — or None while the mirror still holds no such row, which is a
    normal amber state and never an error.

    The definition claim is read first because it is the richer of the two: it
    names the definition AND, through the mirrored row, the work order that
    planned it. That is the same order `mock_planning.decide_links` applies at
    the other end.
    """
    definition_id = run.get(CLAIM_RETAINED["definition_id"])
    if definition_id is not None:
        mirror = db["test_definitions"].find_one({"_id": definition_id})
        work_order_id = (mirror or {}).get("work_order_id")
        if work_order_id:
            return work_order_id, definition_id, f"definition {definition_id}"

    work_order_id = run.get(CLAIM_RETAINED["work_order_id"])
    if work_order_id is not None and db["work_orders"].find_one({"_id": work_order_id}, {"_id": 1}):
        return work_order_id, None, f"work order {work_order_id}"

    return None


def apply_planning_push(
    db: Database,
    work_orders: list[dict],
    definitions: list[dict],
    links: list[dict],
    requirements: list[dict] | None = None,
) -> dict:
    """Take a planning push: mirror the catalog, then apply the links it decided.

    The inbound half of the same mechanism `run_sync_pass` runs outbound. The
    mirror helpers are the same ones, so a pushed row and a fetched row are
    byte-identical, and every link lands through `_write_link`, so planning
    still corrects an `embedded` claim and still never overwrites a person.

    Requirements mirror FIRST, so a definition naming one in `covers_req_ids`
    lands after its target exists (order matters for the journal reading
    sensibly, not for correctness — the projection tolerates either order).

    Several links may name one run. Each states one definition, `_write_link`
    unions them onto the run's set, and a re-post of the same links counts
    entirely in `links_unchanged`.

    A link the registry cannot honour is REFUSED, never guessed at: an unknown
    run, or an id naming a row planning did not send. That is the rule
    `queries_runs._resolve_claims` already holds for the ingestion path — the
    registry links nothing planning does not already know — and it keeps a run
    from pointing at a work order no screen can open.

    The mirrored catalog may also honour a claim a waiting run remembered, so
    `_link_retained_claims` runs last and its links count as applied. Planning
    normally decides those itself — `mock_planning.decide_links` reads the same
    retained claims — and this is the idempotent net under it.
    """
    now = datetime.now(UTC)
    requirements = requirements or []
    _mirror_requirements(db, requirements, now)
    _mirror_work_orders(db, work_orders, now)
    _mirror_definitions(db, definitions, now)

    applied = 0
    unchanged = 0
    rejected: list[dict] = []
    # The project of a work order, resolved once however many links name it.
    projects: dict[str, str | None] = {}

    for link in links:
        run_id = link["run_id"]
        work_order_id = link["work_order_id"]
        definition_id = link.get("definition_id")

        run = db["test_runs"].find_one({"_id": run_id})
        if run is None:
            rejected.append({"run_id": run_id, "reason": "unknown run"})
            continue
        if work_order_id not in projects:
            mirror = db["work_orders"].find_one({"_id": work_order_id})
            if mirror is None:
                rejected.append({"run_id": run_id, "reason": "unknown work order"})
                continue
            projects[work_order_id] = mirror.get("project")
        unknown_definition = definition_id is not None and not db["test_definitions"].find_one(
            {"_id": definition_id}, {"_id": 1}
        )
        if unknown_definition:
            rejected.append({"run_id": run_id, "reason": "unknown test definition"})
            continue

        note = f"Linked by planning — work order {work_order_id}."
        ids = [definition_id] if definition_id else []
        if _write_link(db, run, work_order_id, ids, projects[work_order_id], note):
            applied += 1
        else:
            unchanged += 1

    # The claims the waiting runs remembered, honoured against the catalog just
    # mirrored. It runs AFTER planning's own decisions, so an explicit link
    # always takes the field before a claim could, and it counts as an applied
    # link because this push is what made it possible.
    applied += _link_retained_claims(db)

    # Contract #20 reads this, and the Home tile with it. Planning speaking to
    # us is the same event as us fetching from planning, so it lands in the
    # same record and the status screens stay truthful once the fetch retires.
    result = {
        "work_orders": len(work_orders),
        "definitions": len(definitions),
        "runs_backfilled": applied,
    }
    db["meta"].update_one(
        {"_id": _META_ID},
        {"$set": {"last_sync_at": now, "last_sync_result": result}},
        upsert=True,
    )

    return {
        "requirements_mirrored": len(requirements),
        "work_orders_mirrored": len(work_orders),
        "definitions_mirrored": len(definitions),
        "links_applied": applied,
        "links_unchanged": unchanged,
        "links_rejected": rejected,
    }


def read_watermark(db: Database) -> datetime | None:
    """The seed's baseline. Everything newer is the sync's own work."""
    row = db["meta"].find_one({"_id": _WATERMARK_ID})
    return row.get("at") if row else None


def demo_reset(db: Database) -> dict:
    """Undo what the sync did after the seed, and nothing else.

    Only the seed calls this, and only the seed command line drives the seed.

    Three things go, all scoped to `api:planning` writes newer than the
    watermark: the mirror rows the sync created, the run fields the backfill
    set, and the journal entries of those writes — the mirror's own entries
    included, because `_mirror_journal` writes them at `api:planning` too.

    **The delete itself is not journalled, and that is deliberate.** Every
    entry it could write would name a row this same call removed, and the
    next call would remove that entry as well. The reseed route is the only
    caller, and a person asks for it by name.

    It must NOT touch a manual edit, an invalid flag, an `embedded` write, a
    note, or any journal entry that is not `api:planning`. Those tests are the
    point of this function — see `test_reset.py`.

    The comparison is a strict `>`: Mongo stores milliseconds, so a `>=` would
    sweep up the seed's own writes.
    """
    watermark = read_watermark(db)
    if watermark is None:
        return {"mirrors_removed": 0, "runs_reverted": 0, "entries_removed": 0}

    # `mirrored_at` is when a row first appeared, not when it was last refreshed.
    # A seeded row that this sync merely refreshed has no `mirrored_at` and stays.
    created_by_sync = {"mirrored_at": {"$gt": watermark}}
    mirrors = db["work_orders"].delete_many(created_by_sync)
    definitions = db["test_definitions"].delete_many(created_by_sync)
    # A requirement can also be born manually (`queries_requirements.
    # create_requirement`), which stamps no `mirrored_at` at all — the same
    # rule that keeps a merely-refreshed seeded row out of this clause keeps a
    # manual row out of it too.
    requirements = db["requirements"].delete_many(created_by_sync)

    runs_reverted = 0
    for run in db["test_runs"].find({}):
        reverted: list[str] = []
        for field in PLANNING_FIELDS:
            entry = (run.get("field_sources") or {}).get(field) or {}
            if entry.get("source") != Source.API_PLANNING.value:
                continue
            at = entry.get("at")
            if at is None or at <= watermark:
                continue
            reverted.append(field)

        if not reverted:
            continue

        # The value goes back to null; the key stays. A run always has a
        # `work_order_id` — null means "not known yet", which is the amber
        # state the contract renders. Only the source entry disappears,
        # because an unset value has no source.
        cleared = {field: None for field in reverted}
        db["test_runs"].update_one(
            {"_id": run["_id"]},
            {
                "$set": {**cleared, "updated_at": datetime.now(UTC)},
                "$unset": {f"field_sources.{field}": "" for field in reverted},
            },
        )
        # The status derives from a FRESH read, never from the cursor's
        # snapshot: an invalid flag raised while this loop walks the
        # collection must win, and this function must never un-flag it.
        fresh = db["test_runs"].find_one({"_id": run["_id"]})
        if fresh is not None:
            db["test_runs"].update_one(
                {"_id": run["_id"]}, {"$set": {"status": derive_status(fresh)}}
            )
        runs_reverted += 1

    entries = db["journal_entries"].delete_many(
        {"source": Source.API_PLANNING.value, "at": {"$gt": watermark}}
    )
    db["meta"].update_one(
        {"_id": _META_ID},
        {"$set": {"last_sync_at": None, "last_sync_result": None}},
        upsert=True,
    )

    return {
        "mirrors_removed": (
            mirrors.deleted_count + definitions.deleted_count + requirements.deleted_count
        ),
        "runs_reverted": runs_reverted,
        "entries_removed": entries.deleted_count,
    }
