"""Demo-only admin routes: the planning system LEARNS at runtime.

The shipped mock knows one fixed cast (`fixture.json`) and can only reload it.
The demo needs planning to learn what the bench just planned, the way a real
planning system would hold a plan before the rig runs it:

* `POST /admin/catalog` — create (or update) a work order and, optionally, a
  test definition under it. A bench batch that CLAIMS a new pair the registry
  has never mirrored keeps the claim; the next sync mirrors the row and
  `_link_retained_claims` closes the loop.

Planning is deliberately UNAWARE of test run ids (24 Aug 2026): the pair is
known up front, the TAS mints run ids at execution, and the claim each run
carries correlates it to the pair. `without_planned_runs` strips any planned
run-id list at every outward surface, so upstream's plan rule in
`decide_links` and the registry's `_backfill_runs` are fed nothing — the
claim does all the linking. (`POST /admin/plan` existed until then; it named
run ids under a definition, and it is gone.)
* `GET /admin/push` — what the last push pass did, so a person can see the
  30-second worker working (or failing) instead of reading the pod log.

In-memory, like the rest of the cast: a mock restart forgets it, and also
lands the switch off. Overlay file (`scripts/sync.config.json`); `main.py`
includes the router and records the push through a two-line fixup.
"""

from __future__ import annotations

import re

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

demo = APIRouter(prefix="/admin", tags=["demo"])


def _planning():
    # Imported lazily: main.py imports this module while it is itself still
    # loading, and the state it owns must be read at call time, never copied.
    import mock_planning.main as planning

    return planning


class WorkOrderBody(BaseModel):
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    project: str = Field(min_length=1)
    status: str = "active"
    requestor: str = "Test Bench"
    department: str = "Demo"
    priority: str = "P2 — standard"


class DefinitionBody(BaseModel):
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    work_order_id: str = Field(min_length=1)


class CatalogBody(BaseModel):
    work_order: WorkOrderBody | None = None
    test_definition: DefinitionBody | None = None


def _find(rows: list[dict], row_id: str) -> dict | None:
    return next((row for row in rows if row.get("id") == row_id), None)


def without_planned_runs(rows: list[dict]) -> list[dict]:
    """The definitions with any planned run-ID list stripped — counts stay.

    `planned_runs` is a COUNT: how many runs the office plans for the pair,
    which a real planning system legitimately states (the planned-vs-actual
    screens read it). `run_ids` would name WHICH runs — that is the TAS's to
    mint (TR-002), so serving an id list would let the plan rule in
    `decide_links` and the registry's backfill link runs planning should
    know nothing about. Stripping ids at every outward surface is what makes
    the unawareness structural rather than a convention.
    """
    return [
        {**row, "run_ids": [], "planned_runs": row.get("planned_runs", 0)}
        for row in rows
    ]


# Overlay file, and estate-specific on purpose: an adopted row has to read in
# the vocabulary of the estate it appears in. This is a VEHICLE estate — CAN
# recordings off a comma device, decoded against the DBCs in dcm-seed-dbc — so
# the themes below are its families. They carried an Airbus A350 flight-test
# vocabulary when this app arrived from the PCAP estate, which would put a work
# order titled "Ground vibration survey" in a car campaign the first time a rig
# claimed an id planning had not published.
#
# The key is the first alphabetic run of the definition id, so TD-BAT-THERM and
# TD-BAT-CYCLE share "BAT".
_THEMES = {
    # The four the cast itself publishes — pinned by tests/test_demo_planning_admin.py.
    "BAT": ("HV battery thermal validation", "Battery Lab"),
    "EM": ("E-machine efficiency characterisation", "Powertrain Lab"),
    "INV": ("Inverter thermal derating", "Powertrain Lab"),
    "RLD": ("Road load data acquisition", "Vehicle Dynamics"),
    # Families this estate's DBCs make plausible but the cast does not publish.
    # An id family with no entry falls to _DEFAULT_THEME, which is correct and
    # vague; these make the common ones specific instead.
    "ACC": ("Adaptive cruise control clearance", "ADAS Lab"),
    "AEB": ("Autonomous emergency braking", "ADAS Lab"),
    "BRK": ("Braking and deceleration", "Vehicle Dynamics"),
    "BUS": ("CAN bus integrity and bus load", "Vehicle Networks"),
    "CHG": ("Charging and thermal management", "Battery Lab"),
    "ECU": ("ECU software integration", "Software Integration"),
    "HVAC": ("Cabin climate and thermal comfort", "Climate Lab"),
    "LKA": ("Lane keeping and steering assist", "ADAS Lab"),
    "NVH": ("Noise, vibration and harshness", "Vehicle Dynamics"),
    "PIPE": ("Data pipeline acceptance", "Test Data Engineering"),
    "RAD": ("Radar and perception sensors", "ADAS Lab"),
}
# The estate's files are road drives (CAN bus + decoded vehicle dynamics on
# EX90-class cars), so an id family we cannot place still reads as road data.
_DEFAULT_THEME = ("Road data capture", "Vehicle Dynamics")


def _theme_for(definition_id: str | None) -> tuple[str, str]:
    match = re.match(r"^TD-([A-Za-z]+)", definition_id or "")
    return _THEMES.get(match.group(1).upper() if match else "", _DEFAULT_THEME)


def adopt_orphan_claims(
    runs: list[dict], work_orders: list[dict], definitions: list[dict]
) -> tuple[list[dict], list[dict]]:
    """Adopt every pair the rigs claim that the catalog lacks (24 Aug 2026).

    A real planning office holds whatever its TAS fleet references; a claim it
    has never heard of is a row it is missing, not a run to strand. So before
    the push decides links, each orphan claim gets a synthesized work order
    and/or definition — themed from the definition id's family (the fixture's
    own vocabulary) and this estate's data — stored in the catalog, mirrored
    to the registry by the same push, and the ordinary claim rule then links
    the run in the same pass. A definition claimed without a work order gets
    a minted parent, because a definition cannot hang in the air (TR-001).
    """
    planning = _planning()
    orders = planning._state["work_orders"]
    catalog_definitions = planning._state["test_definitions"]
    known_orders = {row.get("id") for row in orders}
    known_definitions = {row.get("id") for row in catalog_definitions}
    adopted: list[str] = []

    def _adopt_order(order_id: str, theme: str, department: str, project: str) -> None:
        orders.append(
            {
                "id": order_id,
                "title": f"{theme} — rig-submitted campaign",
                # The platform partition the lake sink reads. It must be a
                # vehicle platform this estate records, so the run that made the
                # claim names its own and the caller passes it rather than a
                # constant.
                "project": project,
                "status": "active",
                "requestor": "Flight test operations",
                "department": department,
                "priority": "P2 — standard",
                # "Z", never "+00:00": pydantic re-serializes the pull/push
                # round-trip as Z, and a raw that flip-flops between the two
                # spellings read as "changed" on EVERY pass — two phantom
                # Dynamic Configuration versions per sync press (25 Aug 2026).
                "created_at": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
            }
        )
        known_orders.add(order_id)
        adopted.append(order_id)

    for run in runs:
        order_id = run.get("claimed_work_order_id") or run.get("work_order_id")
        definition_id = run.get("claimed_definition_id") or run.get("definition_id")
        # The platform the minted work order names. A waiting run has no work
        # order, so it has no `project` to read either — its RIG is the fact
        # that exists, and a work order's `project` is the platform partition
        # the lake sink falls back to.
        project = str(run.get("project") or run.get("rig_id") or "unassigned")
        if definition_id and definition_id not in known_definitions:
            theme, department = _theme_for(definition_id)
            if not order_id:
                # Scan the existing max: len()+1 re-minted an id the registry
                # and config store already held after a catalog reset.
                taken = [
                    int(match.group(1))
                    for row in orders
                    if (match := re.match(r"^WO-\d{4}-A(\d+)$", str(row.get("id") or "")))
                ]
                order_id = f"WO-{datetime.now(UTC).year}-A{max(taken, default=0) + 1:03d}"
            if order_id not in known_orders:
                _adopt_order(order_id, theme, department, project)
            demand = sum(
                1
                for waiting in runs
                if (waiting.get("claimed_definition_id") or waiting.get("definition_id"))
                == definition_id
            )
            catalog_definitions.append(
                {
                    "id": definition_id,
                    "work_order_id": order_id,
                    "title": f"{theme} · rig-submitted procedure",
                    # The rig-submitted demand IS the plan: without a count the
                    # definition screen read "N of 0 planned runs" (25 Aug 2026).
                    "planned_runs": max(demand, 1),
                }
            )
            known_definitions.add(definition_id)
            adopted.append(definition_id)
        elif order_id and order_id not in known_orders:
            theme, department = _theme_for(definition_id)
            _adopt_order(order_id, theme, department, project)

    if adopted:
        # Visible in the pod log AND via GET /admin/catalog: artificial rows
        # must never appear silently.
        import logging

        logging.getLogger("mock-planning.demo").info(
            "adopted orphan claim(s) into the catalog: %s", ", ".join(adopted)
        )
        planning._state["adopted_pairs"] = sorted(
            set(planning._state.get("adopted_pairs", [])) | set(adopted)
        )
    return list(orders), without_planned_runs(catalog_definitions)


def record_push(result: dict[str, Any]) -> dict[str, Any]:
    """Keep the outcome of one push pass where `GET /admin/push` can serve it.

    An OFFLINE no-op never overwrites a recorded real result: the 30 s worker
    ticks on while the switch is off, and its no-op used to clobber the
    trigger's adoption seconds after the toast narrated it — the second
    reintroduction of that exact symptom, so the guard now lives at the
    recorder, not at any single caller (25 Aug 2026)."""
    planning = _planning()
    state = planning._state
    stamped = {"at": datetime.now(UTC).isoformat(timespec="seconds"), **result}
    offline_noop = not result.get("pushed") and result.get("reason") == planning.OFFLINE_DETAIL
    if offline_noop and state.get("last_push"):
        return state["last_push"]
    state["last_push"] = stamped
    return stamped


@demo.post("/catalog")
async def learn_catalog(body: CatalogBody) -> dict:
    """Create or update a work order and/or a test definition."""
    planning = _planning()
    if body.work_order is None and body.test_definition is None:
        raise HTTPException(status_code=422, detail="send a work_order and/or a test_definition")
    orders = planning._state["work_orders"]
    definitions = planning._state["test_definitions"]
    changed = False
    created: dict[str, str] = {}

    if body.work_order is not None:
        row = body.work_order.model_dump()
        existing = _find(orders, row["id"])
        if existing is None:
            row["created_at"] = datetime.now(UTC).isoformat(timespec="seconds")
            orders.append(row)
            created["work_order"] = row["id"]
            changed = True
        else:
            for key, value in row.items():
                if existing.get(key) != value:
                    existing[key] = value
                    changed = True

    if body.test_definition is not None:
        row = body.test_definition.model_dump()
        if _find(orders, row["work_order_id"]) is None:
            raise HTTPException(
                status_code=422,
                detail=f"work order {row['work_order_id']} is not in the catalog — send it in the same body",
            )
        existing = _find(definitions, row["id"])
        if existing is None:
            definitions.append(row)
            created["test_definition"] = row["id"]
            changed = True
        elif existing.get("work_order_id") != row["work_order_id"] or existing.get("title") != row["title"]:
            existing["work_order_id"] = row["work_order_id"]
            existing["title"] = row["title"]
            changed = True

    if changed:
        planning._kick()
    return {
        "created": created,
        "changed": changed,
        "work_orders": len(orders),
        "test_definitions": len(definitions),
    }


@demo.get("/catalog")
def read_catalog() -> dict:
    """The catalog, whatever the switch says.

    The `/api/v1` routes answer 503 while planning is offline — that is the
    contract the registry's sync reads. The demo bench is planning's own
    console, not the registry: it must see the plan precisely when planning
    is offline, to say which waiting run the next sync will link.
    """
    planning = _planning()
    return {
        "online": planning._state["online"],
        "work_orders": planning._state["work_orders"],
        "test_definitions": without_planned_runs(planning._state["test_definitions"]),
    }


@demo.post("/push/run")
async def run_push_now() -> dict:
    """One push pass, on demand — the demo Sync button's second half.

    The pass polls the registry's waiting runs, ADOPTS any orphan pair they
    claim (`adopt_orphan_claims`), and posts catalog + links. On demand
    because a presenter pressing Sync must not wait for the 30-second worker,
    and because the pull alone cannot adopt: the catalog is planning's to
    grow, and the registry only mirrors it.
    """
    planning = _planning()
    return record_push(await planning.push_once())


@demo.get("/push")
def last_push() -> dict:
    """The last push pass, or an explicit 'none yet'."""
    last = _planning()._state.get("last_push")
    return last if last is not None else {"at": None, "pushed": None, "reason": "no push pass yet"}
