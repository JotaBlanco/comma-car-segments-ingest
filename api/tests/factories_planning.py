"""Lane A factories: mirror documents for the work-order and definition reads.

These build the smallest mirror a read test needs, so a test states its own
data and never leans on another test's writes. The demo's real writer is
`seed/seed_demo.py`; this factory cast survives beside it on purpose — the
golden contract requests pin the contract examples (WO-2026-0812 and friends)
independent of the demo cast.
"""

from datetime import UTC, datetime, timedelta

from seed.filler import DEMO_RUN_COUNT, DEMO_WORK_ORDER_COUNT

SYNCED_AT = datetime(2026, 8, 14, 11, 32, 4, tzinfo=UTC)

# The status every run of the demo cast carries, stated by hand. `derive_status`
# owns the rule, so this factory must never call it: a fixture that computes its
# expectation with the function under test cannot fail when that function breaks.
# A new run in `stub_data.seed_state()` needs a line here, and the factory says so.
DEMO_RUN_STATUS = {
    "TAS-88214": "awaiting_work_order",
    "TAS-88213": "complete",
    "TAS-88209": "invalid",
    "TAS-88207": "complete",
    "TAS-88201": "complete",
    "TAS-88198": "complete",
    "TAS-88190": "complete",
    "TAS-88183": "complete",
    "TAS-88177": "complete",
    "TAS-88168": "complete",
    "TAS-88159": "complete",
    "TAS-88150": "complete",
    "TAS-88141": "complete",
    "TAS-88123": "complete",
    "TAS-88104": "complete",
}


def make_work_order(
    wo_id: str = "WO-2026-0847",
    title: str = "E-machine efficiency characterisation",
    project: str = "EX90",
    status: str = "active",
    synced_at: datetime | None = None,
    **extra,
) -> dict:
    """One mirrored work order.

    The default carries no `field_sources`, and a caller that tests the source
    filter states its own. The real mirror tags every planning-owned field
    from 24 Aug 2026 (TR-011); this factory writes the document by hand, so it
    states nothing the caller did not ask for.
    """
    doc = {
        "_id": wo_id,
        "title": title,
        "project": project,
        "status": status,
        "requestor": "M. Ekholm · Propulsion",
        "department": "Propulsion Test Labs",
        "priority": "P2 — standard",
        "created_at_source": datetime(2026, 8, 3, tzinfo=UTC),
        "synced_at": synced_at or SYNCED_AT,
        "raw": {"id": wo_id},
    }
    doc.update(extra)
    return doc


def make_definition(
    td_id: str = "TD-EM-201",
    work_order_id: str = "WO-2026-0847",
    title: str = "E-machine efficiency map — WLTP points",
    planned_runs: int | None = 2,
    synced_at: datetime | None = None,
    **extra,
) -> dict:
    """One mirrored test definition. `status` derives at read time."""
    doc = {
        "_id": td_id,
        "work_order_id": work_order_id,
        "title": title,
        "planned_runs": planned_runs,
        "synced_at": synced_at or SYNCED_AT,
        "raw": {"id": td_id},
    }
    doc.update(extra)
    return doc


def make_run(
    run_id: str = "TAS-88213",
    work_order_id: str | None = "WO-2026-0847",
    definition_id: str | None = "TD-EM-201",
    rig_id: str = "RIG-02",
    status: str = "complete",
    first_data_at: datetime | None = None,
    **extra,
) -> dict:
    """One run document, enough for the work-order rollup."""
    doc = {
        "_id": run_id,
        "description": None,
        "work_order_id": work_order_id,
        "definition_id": definition_id,
        "project": "EX90",
        "rig_id": rig_id,
        "test_cell": "TC-1",
        "operator": None,
        "bench_sw": None,
        "started_at": None,
        "ended_at": None,
        "first_data_at": first_data_at or datetime(2026, 8, 14, 8, 12, tzinfo=UTC),
        "invalid": {"flagged": False, "reason": None, "actor": None, "at": None},
        "file_count": 5,
        "signal_count": 96,
        "status": status,
        "field_sources": {},
        "created_at": SYNCED_AT,
        "updated_at": SYNCED_AT,
    }
    doc.update(extra)
    return doc


def seed_demo_mirror(db) -> None:
    """Write the Lane A half of the demo cast into Mongo.

    The runs, mirrors and results come from `stub_data.seed_state()` — the same
    source Lane B's file seeder reads — so this factory cast is defined once
    and the two halves can never drift. It is NOT the demo cast: the real seed
    is `seed/seed_demo.py`, and whether the golden requests should run against
    that instead is an open question in `plans/STATUS.md`.
    """
    from api import stub_data

    state = stub_data.seed_state()

    runs = []
    for run in state["runs"]:
        run["_id"] = run.pop("run_id")
        # The stub derived status on read. Mongo stores it, so a status filter
        # is a plain index hit (BE-PLAN §3.4). The value is a literal from
        # DEMO_RUN_STATUS, never a call to the function the tests guard.
        if run["_id"] not in DEMO_RUN_STATUS:
            raise KeyError(f"State the status of {run['_id']} in DEMO_RUN_STATUS.")
        run["status"] = DEMO_RUN_STATUS[run["_id"]]
        runs.append(run)

    work_orders = []
    for work_order in state["work_orders"]:
        work_order["_id"] = work_order.pop("wo_id")
        work_orders.append(work_order)

    definitions = []
    for definition in state["definitions"]:
        definition["_id"] = definition.pop("td_id")
        definitions.append(definition)

    results = []
    for result in state["results"]:
        result["_id"] = result.pop("result_id")
        results.append(result)

    runs.extend(_filler_runs(len(runs)))
    work_orders.extend(_filler_work_orders(len(work_orders)))

    db["test_runs"].insert_many(runs)
    db["work_orders"].insert_many(work_orders)
    db["test_definitions"].insert_many(definitions)
    if results:
        db["processed_results"].insert_many(results)


# The demo scale (BE-PLAN §7) is imported from seed/filler.py — one home.


def _filler_work_orders(named: int) -> list[dict]:
    """Pad the mirror up to the demo's work-order count.

    The counts are live, so the contract's "42 work orders" has to be 42 real
    rows. Filler work orders are closed and carry no definitions, so they never
    appear in a rollup or a needs-attention count.
    """
    return [
        make_work_order(
            wo_id=f"WO-2025-{index:04d}",
            title="Closed campaign",
            project="EX90",
            status="closed",
        )
        for index in range(DEMO_WORK_ORDER_COUNT - named)
    ]


def _filler_runs(named: int) -> list[dict]:
    """Pad the named cast up to the demo's run count.

    The Home counts are live, so the contract's "128 runs" has to be 128 real
    documents. THIS cast's filler is all 30 days old, so here it never enters
    a needs-attention count and never displaces a recent run — unlike the real
    seed's filler, which deliberately puts a few runs on the seed day.
    """
    older = SYNCED_AT - timedelta(days=30)
    return [
        make_run(
            run_id=f"TAS-7{index:04d}",
            work_order_id="WO-2026-0843",
            definition_id="TD-BAT-102",
            status="complete",
            first_data_at=older - timedelta(minutes=index),
        )
        for index in range(DEMO_RUN_COUNT - named)
    ]


def seed_mirror(db) -> None:
    """The mirror cast the work-order screens need.

    Two work orders, three definitions and three runs. The cast mirrors the
    contract example: TD-EM-201 plans two runs and has both, so it reads
    `on_plan`; TD-EM-204 plans one and has none, so it reads `awaiting_data`.
    """
    db["work_orders"].insert_many(
        [
            make_work_order(),
            make_work_order(
                wo_id="WO-2026-0839",
                title="Inverter thermal derating",
                project="EC40",
                status="closed",
            ),
        ]
    )
    db["test_definitions"].insert_many(
        [
            make_definition(),
            make_definition(
                td_id="TD-EM-204",
                title="E-machine efficiency map — high-load extension",
                planned_runs=1,
            ),
            make_definition(
                td_id="TD-INV-077",
                work_order_id="WO-2026-0839",
                title="Inverter derating sweep",
                planned_runs=1,
            ),
        ]
    )
    db["test_runs"].insert_many(
        [
            make_run(),
            make_run(
                run_id="TAS-88212",
                first_data_at=datetime(2026, 8, 14, 8, 0, tzinfo=UTC),
            ),
            make_run(
                run_id="TAS-88207",
                work_order_id="WO-2026-0839",
                definition_id="TD-INV-077",
                rig_id="RIG-01",
            ),
        ]
    )
