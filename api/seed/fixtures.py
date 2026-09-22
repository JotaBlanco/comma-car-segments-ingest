"""Named seed records for runs, work orders and definition mirrors.

**This file is UTF-8.** The cast carries "Bergström", "−20 °C" and "Åkesson".

**One planning cast, defined once.** The pre-mirrored work orders, the
definition mirrors and every run's planning linkage are READ from
`api/mock_planning/fixture.json` — the same file the planning mock serves. A
sync pass therefore refreshes a seeded mirror row with the values it already
holds, and the toggle-off reset has nothing to restore. Editing the cast means
editing that one JSON file.

**The time-basing rule (BE-PLAN §7).** Every run timestamp below sits on
`REFERENCE_DAY`, the prototype's "today". `build(seed_day)` shifts every run
timestamp by whole days. **Run dates rebase. Planning dates do not** — a work
order's `created_at` is the planning system's clock, the mock serves it
verbatim, and a rebased copy would stop matching the mock's on the first
refresh. Lane B's `fixtures_inventory.py` rebases the same way from the same
reference day, so both halves of the demo cast always land on one calendar.

**The battery history (BE-PLAN §7).** Ten history runs TAS-88104…88198 carry
the twelve-run trend of `HV_Batt_Cell_Temp_Max` together with TAS-88207 and
the hero. Their `started_at` values are pinned to Lane B's
`fixtures_inventory.HERO_RUN_STATS` rows, which put lake samples on exactly
these clocks — a drifted date here empties the statistics screen's history.

**WO-2026-0851 and TD-BAT-114 are never seeded.** They live in the planning
mock and arrive with the toggle, which is the amber-to-green beat of the demo
(BE-PLAN §6.7: the only visible delta on toggle-on). `SYNC_WORK_ORDER_ID` and
`SYNC_DEFINITION_ID` name them so a test can assert their absence.

**Who owns which field.** A run's `rig_id`, `description`, `test_cell` and time
range ride the registration call, so they are `embedded`. Everything else comes
from a system that knows better: the operator from a person, the bench software
from the config API, and the work order, definition and project from planning.
The `tags` list on each record states that, and `seed_demo.py` writes it through
`api/provenance.py::set_field`.

**The custom property map is a person's own fact.** A run carries `vehicle` and
`test-phase` because somebody typed them, so the map is `manual` and every run
in the whole cast carries it. See the property block below.
"""

import copy
import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from api.models.common import Source

# --- Identity: one set of demo ids, shared with api/api/stub_data.py ---

HERO_RUN_ID = "TAS-88214"
HERO_WORK_ORDER_ID = "WO-2026-0847"

# The work order and definition the planning mock holds back. The seed never
# writes them; they arrive on toggle-on and leave on toggle-off.
SYNC_WORK_ORDER_ID = "WO-2026-0851"
SYNC_DEFINITION_ID = "TD-BAT-114"

# The prototype's "today". Every run timestamp below sits on or before this day.
REFERENCE_DAY = date(2026, 8, 14)

# api/api/main.py mounts every route under this prefix.
API_PREFIX = "/api/v1"

# The services that write a tagged field. An actor names a person or a service.
INGESTION_ACTOR = "ingestion"
CONFIG_ACTOR = "config-sync"
PLANNING_ACTOR = "planning-sync"

BENCH_SW = "TAS 7.4.2 · fw 2.11"

# --- The planning cast, read from the mock's own fixture ---

CAST_PATH = Path(__file__).resolve().parents[1] / "mock_planning" / "fixture.json"

_CAST = json.loads(CAST_PATH.read_text(encoding="utf-8"))


def _parse_when(value: str) -> datetime:
    """Read one planning timestamp. The mock serves ISO-8601 with `Z`."""
    return datetime.fromisoformat(value)


# The pre-mirrored rows: everything the mock serves except the toggle's own
# work order and definition. `raw` keeps the exact row the mock will serve, so
# a sync refresh writes the values the row already carries.

NAMED_WORK_ORDERS: list[dict] = [
    {
        "_id": row["id"],
        "title": row["title"],
        "project": row["project"],
        "status": row["status"],
        "requestor": row["requestor"],
        "department": row["department"],
        "priority": row["priority"],
        "created_at_source": _parse_when(row["created_at"]),
        "raw": row,
    }
    for row in _CAST["work_orders"]
    if row["id"] != SYNC_WORK_ORDER_ID
]

# Planning's clock for a requirements document. It is a planning date, so it
# never rebases with the run dates. See the time-basing rule above.
REQUIREMENTS_UPDATED_AT = datetime(2026, 8, 14, tzinfo=UTC)


def _requirements_files(row: dict) -> list[dict]:
    """The requirements documents of one cast definition, stamped as planning.

    The mirror stamps the same four keys on a sync pass
    (`api/planning_sync.py`), so a seeded row and a synced row read the same.
    Planning names no person, so `updated_by` is null.
    """
    return [
        {
            "name": document["name"],
            "content": document["content"],
            "source": "planning",
            "updated_at": REQUIREMENTS_UPDATED_AT,
            "updated_by": None,
        }
        for document in row.get("requirements_files") or []
    ]


NAMED_DEFINITIONS: list[dict] = [
    {
        "_id": row["id"],
        "work_order_id": row["work_order_id"],
        "title": row["title"],
        "planned_runs": row.get("planned_runs", 0),
        "requirements_files": _requirements_files(row),
        # Pair-only planning (24 Aug 2026): the mock serves run_ids stamped
        # to [], so a seeded mirror row matches a synced one byte-for-byte.
        "raw": {**row, "run_ids": []},
    }
    for row in _CAST["test_definitions"]
    if row["work_order_id"] != SYNC_WORK_ORDER_ID
]

# Run → (work order, definition, project). Stated HERE, not derived from the
# fixture: planning holds no plan of run ids (24 Aug 2026, TR-002) — these are
# the claims the seeded runs CARRIED when their data arrived, which is registry
# knowledge. TAS-88214 (TD-BAT-114) is deliberately absent, so the hero seeds
# without a planning tag and reads amber for the toggle demo.

_WO_PROJECT = {row["id"]: row["project"] for row in _CAST["work_orders"]}

_RUN_LINKS: dict[str, tuple[str, str, str]] = {
    "TAS-88104": ("WO-2026-0836", "TD-BAT-091", "EX90"),
    "TAS-88123": ("WO-2026-0836", "TD-BAT-091", "EX90"),
    "TAS-88141": ("WO-2026-0836", "TD-BAT-091", "EX90"),
    "TAS-88150": ("WO-2026-0836", "TD-BAT-091", "EX90"),
    "TAS-88159": ("WO-2026-0836", "TD-BAT-091", "EX90"),
    "TAS-88168": ("WO-2026-0836", "TD-BAT-091", "EX90"),
    "TAS-88177": ("WO-2026-0836", "TD-BAT-091", "EX90"),
    "TAS-88183": ("WO-2026-0836", "TD-BAT-091", "EX90"),
    "TAS-88190": ("WO-2026-0836", "TD-BAT-091", "EX90"),
    "TAS-88198": ("WO-2026-0836", "TD-BAT-091", "EX90"),
    "TAS-88201": ("WO-2026-0847", "TD-EM-201", "EX90"),
    "TAS-88207": ("WO-2026-0839", "TD-BAT-102", "EX90"),
    "TAS-88209": ("WO-2026-0843", "TD-INV-077", "EC40"),
    "TAS-88213": ("WO-2026-0847", "TD-EM-201", "EX90"),
    "TAS-90001": ("WO-2026-0853", "TD-RLD-301", "EX90"),
    "TAS-90002": ("WO-2026-0853", "TD-RLD-301", "EX90"),
    "TAS-90003": ("WO-2026-0853", "TD-RLD-301", "EX90"),
    "TAS-90004": ("WO-2026-0853", "TD-RLD-301", "EX90"),
    "TAS-90005": ("WO-2026-0853", "TD-RLD-301", "EX90"),
    "TAS-90006": ("WO-2026-0853", "TD-RLD-301", "EX90"),
}


def _dt(*args: int) -> datetime:
    """Build a UTC timestamp on the reference calendar."""
    return datetime(*args, tzinfo=UTC)


def _tag(field: str, value, source: Source, actor: str) -> dict:
    """State one field that no registration call can carry."""
    return {"field": field, "value": value, "source": source, "actor": actor}


def _planning_for(run_id: str) -> list[dict]:
    """The three fields planning owns, read from the cast's linkage."""
    link = _RUN_LINKS.get(run_id)
    if link is None:
        return []
    work_order_id, definition_id, project = link
    return [
        _tag("work_order_id", work_order_id, Source.API_PLANNING, PLANNING_ACTOR),
        _tag("definition_ids", [definition_id], Source.API_PLANNING, PLANNING_ACTOR),
        _tag("project", project, Source.API_PLANNING, PLANNING_ACTOR),
    ]


def _bench(version: str = BENCH_SW) -> dict:
    return _tag("bench_sw", version, Source.API_CONFIG, CONFIG_ACTOR)


# --- The custom property map a person defines (FR-DM-108) ---
#
# A person types these pairs in the run metadata dialog, so they carry the
# `manual` source, exactly like the hero's operator name does.
#
# The workbook asks a person to group runs by `vehicle`, and no run document
# holds such a field. A custom property is how a person states that fact
# themselves, so the seed writes one and the Group-by control offers it.
# `test-phase` is the second fact a test engineer keeps by hand: the gateway
# the run answers.
#
# A car belongs to one project, so the fleet is keyed by project. Grouping by
# `vehicle` therefore never disagrees with grouping by `project`.

PROPERTY_ACTOR = "a.bergstrom"

# VP is a verification prototype, PP a pre-production car.
FLEET: dict[str, tuple[str, ...]] = {
    "EX90": ("EX90-VP014", "EX90-VP021", "EX90-PP103"),
    "EC40": ("EC40-VP007", "EC40-PP044"),
    "EX30": ("EX30-VP002",),
}

# Weighted the way a programme runs: most work verifies the design, less of it
# validates production, and a few runs answer the sign-off gate.
PHASE_POOL = (
    "DV — design verification",
    "PV — production validation",
    "DV — design verification",
    "Sign-off",
    "DV — design verification",
    "PV — production validation",
)


def vehicle_for(project: str, index: int) -> str:
    """One car of that project's fleet. The index picks it, so a re-seed matches.

    A project with no fleet raises. That is a seed bug, and it must stop in a
    terminal instead of putting the wrong car on a demo screen.
    """
    fleet = FLEET[project]
    return fleet[index % len(fleet)]


def phase_for(index: int) -> str:
    """The gateway one run answers. The index picks it, so a re-seed matches."""
    return PHASE_POOL[index % len(PHASE_POOL)]


def custom_properties(project: str, index: int) -> dict[str, str]:
    """The property map of one run. EVERY seeded run carries both keys.

    A custom group counts only the runs that carry the key
    (`api/api/services/queries_runs.py::_group_expression`), so a map on the
    named cast alone would make the group counts fall short of the runs
    table's own total. `seed/filler.py` calls this for the crowd behind them.
    """
    return {"vehicle": vehicle_for(project, index), "test-phase": phase_for(index)}


def _project_of(run_id: str) -> str:
    """The project a named run belongs to.

    The hero is linked to nothing while it reads amber, so its project comes
    from the work order that arrives on the toggle. The car it ran on is a
    fact whatever the planning system already knows.
    """
    link = _RUN_LINKS.get(run_id)
    return link[2] if link else _WO_PROJECT[SYNC_WORK_ORDER_ID]


# --- The five story runs (BE-PLAN §7) ---
#
# The hero run comes first. It carries no planning tag, so it reads
# `awaiting_work_order` — the normal amber state, never an error.

STORY_RUNS: list[dict] = [
    {
        "run_id": HERO_RUN_ID,
        "rig_id": "RIG-04",
        "test_cell": "TC-2",
        # The pair-only toggle beat (24 Aug 2026): the hero ARRIVES CLAIMING
        # the held-back pair, exactly as a TAS-produced file would. The mirror
        # does not hold WO-2026-0851 until the toggle, so the claim is
        # retained and the run waits amber; toggle-on mirrors the pair and
        # _link_retained_claims turns the hero green. Planning still never
        # learns a run id.
        "work_order_id": SYNC_WORK_ORDER_ID,
        "definition_id": SYNC_DEFINITION_ID,
        "description": "HV battery thermal cycling",
        "started_at": _dt(2026, 8, 14, 9, 41, 7),
        "ended_at": _dt(2026, 8, 14, 11, 18, 52),
        "tags": [
            # A person typed this name. Precedence protects it from re-ingestion.
            _tag("operator", "A. Bergström", Source.MANUAL, "a.bergstrom"),
            _bench(),
        ],
        "invalid": None,
    },
    {
        "run_id": "TAS-88213",
        "rig_id": "RIG-02",
        "test_cell": "TC-1",
        "description": "E-machine efficiency map",
        "started_at": _dt(2026, 8, 14, 8, 12, 9),
        "ended_at": _dt(2026, 8, 14, 10, 5, 41),
        "tags": [*_planning_for("TAS-88213"), _bench()],
        "invalid": None,
    },
    {
        "run_id": "TAS-88209",
        "rig_id": "RIG-07",
        "test_cell": "TC-4",
        "description": "Inverter derating sweep",
        "started_at": _dt(2026, 8, 13, 17, 26, 12),
        "ended_at": _dt(2026, 8, 13, 18, 44, 3),
        "tags": [
            *_planning_for("TAS-88209"),
            _bench("TAS 7.4.1 · fw 2.10"),
        ],
        "invalid": {
            "reason": "Torque flange calibration expired — readings suspect",
            "actor": "e.lindqvist",
            "at": _dt(2026, 8, 13, 18, 2),
        },
    },
    {
        "run_id": "TAS-88207",
        "rig_id": "RIG-04",
        "test_cell": "TC-2",
        "description": "HV battery thermal cycling",
        "started_at": _dt(2026, 8, 13, 14, 3, 11),
        "ended_at": _dt(2026, 8, 13, 15, 41, 58),
        "tags": [*_planning_for("TAS-88207"), _bench()],
        "invalid": None,
    },
    {
        "run_id": "TAS-88201",
        "rig_id": "RIG-02",
        "test_cell": "TC-1",
        "description": "E-machine efficiency map",
        "started_at": _dt(2026, 8, 13, 11, 47, 4),
        "ended_at": _dt(2026, 8, 13, 13, 39, 50),
        "tags": [*_planning_for("TAS-88201"), _bench()],
        "invalid": None,
    },
]


# --- The ten battery history runs (BE-PLAN §7, the 12-run trend) ---
#
# One `started_at` per row of Lane B's `HERO_RUN_STATS`, clock 09:12:41. The
# lake samples for `HV_Batt_Cell_Temp_Max` sit on these exact clocks, so the
# statistics screen joins twelve real run documents: these ten, TAS-88207 and
# the hero. Like most named runs they carry no registered file — only the hero
# holds files in the named cast.

_HISTORY_DAYS: list[tuple[str, tuple[int, int, int]]] = [
    ("TAS-88198", (2026, 8, 8)),
    ("TAS-88190", (2026, 8, 1)),
    ("TAS-88183", (2026, 7, 24)),
    ("TAS-88177", (2026, 7, 17)),
    ("TAS-88168", (2026, 7, 9)),
    ("TAS-88159", (2026, 7, 1)),
    ("TAS-88150", (2026, 6, 24)),
    ("TAS-88141", (2026, 6, 17)),
    ("TAS-88123", (2026, 6, 9)),
    ("TAS-88104", (2026, 6, 2)),
]

HISTORY_RUNS: list[dict] = [
    {
        "run_id": run_id,
        "rig_id": "RIG-04" if index % 2 == 0 else "RIG-02",
        "test_cell": "TC-2",
        "description": "HV battery thermal cycling",
        "started_at": _dt(*day, 9, 12, 41),
        "ended_at": _dt(*day, 9, 12, 41) + timedelta(hours=1, minutes=38),
        "tags": [*_planning_for(run_id), _bench("TAS 7.4.1 · fw 2.10")],
        "invalid": None,
    }
    for index, (run_id, day) in enumerate(_HISTORY_DAYS)
]

NAMED_RUNS: list[dict] = [*STORY_RUNS, *HISTORY_RUNS]

# Every named run carries the person's own property map. The index spreads the
# fleet and the phases, so the runs land on several cars with uneven counts.
for _index, _record in enumerate(NAMED_RUNS):
    _record["tags"].append(
        _tag(
            "custom_properties",
            custom_properties(_project_of(_record["run_id"]), _index),
            Source.MANUAL,
            PROPERTY_ACTOR,
        )
    )


# --- Build: rebase the run dates, serve the planning rows verbatim ---


def _rebase(when: datetime, seed_day: date) -> datetime:
    """Move one reference timestamp onto the seed day. The clock time survives."""
    return when + timedelta(days=(seed_day - REFERENCE_DAY).days)


def _rebase_tree(value, seed_day: date):
    """Shift every datetime inside a record. Every other value survives.

    The walk copies, so a call never mutates the records above.
    """
    if isinstance(value, datetime):
        return _rebase(value, seed_day)
    if isinstance(value, dict):
        return {key: _rebase_tree(item, seed_day) for key, item in value.items()}
    if isinstance(value, list):
        return [_rebase_tree(item, seed_day) for item in value]
    return value


def build(seed_day: date | None = None) -> dict:
    """Return every record, run dates moved onto the seed day.

    Work orders and definitions come back as deep copies with their planning
    dates untouched — they must stay equal to what the mock serves.
    """
    seed_day = seed_day or datetime.now(UTC).date()
    return {
        "runs": _rebase_tree(NAMED_RUNS, seed_day),
        "work_orders": copy.deepcopy(NAMED_WORK_ORDERS),
        "definitions": copy.deepcopy(NAMED_DEFINITIONS),
    }
