"""Filler records that carry the demo to its stated scale — ticket A-15.

The Home screen counts live documents, so "128 runs", "42 work orders",
"512 files" and "6 412 signals" have to be that many real rows. The named cast
in `seed/fixtures.py` and Lane B's `fixtures_inventory.py` are what the demo
talks about; this file is the crowd behind them.

The crowd is harmless but not lifeless. Every filler run is **complete** and
belongs to a linked campaign, so it never enters a needs-attention count — but
descriptions, campaigns, requestors, filenames and signal names all vary, so a
browsed list reads like a lived-in lab and not like a copy-paste. Everything
derives from the record's index — no randomness — so a re-seed writes the very
same rows and the `$setOnInsert` upserts stay idempotent.

Every filler run carries the same custom property map the named cast carries
(`fixtures.custom_properties`), so a grouping by `vehicle` or by `test-phase`
counts the whole table and not a fraction of it (FR-DM-108).

One filler file is **quarantined and unlinked**: BE-PLAN §7 names a second
quarantine case ("no run key") but gives it no name, so the filler carries it
(`fixtures_inventory.py` says so at its named-files block).

Filler files carry no per-file signal inventory (`file_signals` rows), and
filler signals belong to no run (`run_count` 0 — the honest value, since no
stored row backs them). For the same reason every filler run's stored
`file_count` and `signal_count` are DERIVED from the file rows built beside
it (`_derive_run_counts`), never stated as independent literals — so a run's
badge always agrees with the rows a drill-down actually finds.
"""

import hashlib
from collections import Counter
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta

from api.models.common import Source
from ingest.store import DEFAULT_PREFIX, stamp_workspace
from seed.fixtures import PROPERTY_ACTOR, custom_properties

# The scale the contract examples quote (BE-PLAN §7). `api/api/stub_data.py`
# and `tests/factories_planning.py` pad the stub cast to the same numbers.
DEMO_RUN_COUNT = 128
DEMO_WORK_ORDER_COUNT = 42
DEMO_FILE_COUNT = 512
DEMO_SIGNAL_COUNT = 6412

# How much must carry the seed day. The Home screen says "6 today" and "31".
RUNS_TODAY = 6
FILES_TODAY = 31

# Filler spreads back over this many weeks, so the lists look lived-in.
HISTORY_WEEKS = 6

# Four rigs in the whole cast — the count the contract's Home example shows.
# The named runs use RIG-02, RIG-04 and RIG-07; the filler adds RIG-01 only.
_RIGS = ("RIG-01", "RIG-02", "RIG-04", "RIG-07")
_PROJECTS = ("EX90", "EC40", "EX30")

# What a filler run was doing: description, filename slug, test cell, minutes,
# rough file size in MB, distinct signals. The exact string "HV battery
# thermal cycling" is reserved for the named battery history (a test counts
# those twelve by it), so the battery filler soaks instead of cycling.
_RUN_KINDS = (
    ("HV battery thermal soak", "bat_soak", "TC-2", 95, 1240, 18),
    ("E-machine load spectrum", "em_load", "TC-1", 120, 830, 22),
    ("Inverter switching loss sweep", "inv_loss", "TC-4", 45, 610, 14),
    ("DCDC ripple characterisation", "dcdc_rip", "TC-3", 40, 380, 12),
    ("Charge curve validation", "chg_curve", "TC-5", 150, 520, 16),
    ("Coolant loop step response", "cool_step", "TC-3", 35, 260, 10),
    ("EMC conducted emissions", "emc_cond", "TC-6", 60, 310, 8),
    ("Gearbox endurance block", "gbx_end", "TC-1", 160, 940, 20),
)

# The campaigns the filler work orders belong to. Title = campaign — phase.
_CAMPAIGNS = (
    "EM durability",
    "HV battery ageing",
    "Inverter thermal margin",
    "DCDC efficiency",
    "Charging interoperability",
    "Coolant system validation",
    "EMC compliance",
    "Driveline NVH",
)
_PHASES = ("phase 1", "phase 2", "winter cycle", "summer cycle", "batch 3", "pre-series")
_REQUESTORS = (
    "L. Åkesson · Battery",
    "S. Vidal · Powertrain",
    "M. Ekholm · Propulsion",
    "J. Lindberg · Charging",
    "A. Kowalski · EMC",
    "R. Tanaka · Thermal",
    "E. Holm · NVH",
    "P. Svensson · Driveline",
)
_DEPARTMENTS = (
    "Propulsion Test Labs",
    "Battery Test Labs",
    "Powertrain Test Labs",
    "Charging Systems Lab",
)
# Weighted the way a lab feels: mostly standard, some background, a few rushed.
_PRIORITIES = ("P2 — standard", "P2 — standard", "P3 — background", "P1 — expedite")

_SOURCE_SYSTEMS = ("TAS", "TAS", "TAS", "INCA", "TAS", "ifile")

# The signal-name space: domain · component · metric · qualifier. Roomy
# enough (10 · 22 · 10 · 6 = 13 200) to mint 6 400 unique names, and shaped
# so a generated name never looks like a bare numbered counter.
_SIGNAL_DOMAINS = (
    "HV_Batt", "EM_Stator", "EM_Rotor", "INV", "DCDC",
    "CHG", "BMS", "TC_Cell", "Cool", "LV",
)
_SIGNAL_COMPONENTS = tuple(f"Module{m:02d}" for m in range(1, 13)) + (
    "PhaseA", "PhaseB", "PhaseC", "Inlet", "Outlet",
    "Front", "Rear", "Core", "Bridge", "Link",
)
_SIGNAL_METRICS = (
    ("Temp", "°C", "temperature"),
    ("Volt", "V", "voltage"),
    ("Curr", "A", "current"),
    ("Pwr", "kW", "power"),
    ("Spd", "rpm", "speed"),
    ("Trq", "Nm", "torque"),
    ("Press", "bar", "pressure"),
    ("Flow", "l/min", "flow"),
    ("SOC", "%", "state of charge"),
    ("Res", "mΩ", "resistance"),
)
_SIGNAL_QUALIFIERS = ("Max", "Min", "Avg", "Raw", "Filt", "RMS")
_SIGNAL_RATES = (1.0, 10.0, 100.0)


def _not_future(at: datetime) -> datetime:
    """Hold a timestamp at now.

    The seed writes the demo reset watermark last, so every seeded record must
    be older than it. A record with a later time survives a reset that must
    remove it, and the stage stays green.
    """
    return min(at, datetime.now(UTC))


def _at(seed_day: date, days_back: int, minute: int) -> datetime:
    """A timestamp on the seed day, or that many days before it.

    The seed day's slots sit on a 07:00 grid. A seed that runs earlier than
    the slot would mint a record in the future, so the grid stops at now.
    """
    base = datetime.combine(seed_day, datetime.min.time(), tzinfo=UTC)
    return _not_future(base - timedelta(days=days_back) + timedelta(hours=7, minutes=minute))


def _run_ids(count: int) -> list[str]:
    """The filler run ids, deterministic so a re-seed upserts the same rows."""
    return [f"TAS-7{index:04d}" for index in range(count)]


def _files_per_run(run_count: int, linked_files: int) -> list[int]:
    """Spread the linked filler files evenly over the filler runs."""
    if run_count == 0:
        return []
    base, extra = divmod(linked_files, run_count)
    return [base + 1 if index < extra else base for index in range(run_count)]


def build(
    seed_day: date,
    named_runs: int,
    named_runs_today: int,
    named_files: int,
    named_files_today: int,
    named_signals: int,
    named_work_orders: int,
    synced_at: datetime,
    taken_signal_names: frozenset[str] = frozenset(),
) -> dict[str, list[dict]]:
    """Build every filler record, already shaped as stored documents.

    Returns runs, files, signals and work orders together, because they must
    agree: a run's project matches its campaign's, a filename carries its
    run's slug and date, and a run's `file_count` states how many filler
    files name it. The `named_*` counts are what the named cast already
    wrote, so the totals land exactly on the DEMO_* constants.
    `taken_signal_names` is the live catalogue — a generated name never
    collides with one, so the signal total stays exact.
    """
    run_count = max(DEMO_RUN_COUNT - named_runs, 0)
    # One filler file is the unlinked quarantine case; the rest link to runs.
    # A re-seed on a full cast tops up nothing, so the counts floor at zero.
    linked_files = max(DEMO_FILE_COUNT - named_files - 1, 0)
    per_run = _files_per_run(run_count, linked_files)

    work_orders = build_work_orders(named_work_orders, synced_at)
    wo_ids = [row["_id"] for row in work_orders] or ["WO-2025-0000"]
    runs = build_runs(seed_day, named_runs, named_runs_today, wo_ids)
    files = _build_files(seed_day, runs, per_run, named_files_today)
    _derive_run_counts(runs, files)

    return {
        "runs": runs,
        "files": files,
        "signals": _build_signals(seed_day, named_signals, taken_signal_names),
        "work_orders": work_orders,
    }


def _derive_run_counts(
    runs: list[dict], files: list[dict], file_signals: Sequence[dict] = ()
) -> None:
    """Stamp every run's stored counts from the rows built beside it.

    Mirrors `queries_runs.run_facts`, the run's one read model and the rule
    the watcher's ingestion path applies: `file_count` counts the `files` rows
    naming the run — with NO status filter, so a quarantined file that still
    names its run counts too; both seeded quarantine cases carry
    `run_id: None`, so neither reaches any run — and `signal_count` counts the
    distinct `file_signals` names of the run. The
    filler seeds no `file_signals` rows, so every filler run derives 0: its
    Signals tab is empty, and its badge now says so.
    """
    linked = Counter(doc["run_id"] for doc in files if doc["run_id"])
    names_by_run: dict[str, set[str]] = {}
    for row in file_signals:
        if row.get("run_id"):
            names_by_run.setdefault(row["run_id"], set()).add(row["name"])

    for run in runs:
        run["file_count"] = linked.get(run["_id"], 0)
        run["signal_count"] = len(names_by_run.get(run["_id"], ()))


def build_runs(
    seed_day: date,
    named_count: int,
    named_today: int = 0,
    wo_ids: list[str] | None = None,
) -> list[dict]:
    """Build the filler runs, already shaped as stored documents.

    The first few land on the seed day, so the Home "today" counts hold on any
    day the seed runs. The rest spread backwards. The stride over the campaign
    pool is co-prime with its size, so runs land on many campaigns with
    naturally uneven counts.

    `file_count` and `signal_count` start at 0 here: `build()` stamps them
    from the file rows it builds beside the runs (`_derive_run_counts`), so
    the stored counts can never contradict the seeded inventory. A caller who
    builds runs alone gets the honest counts for a run with no files.
    """
    wanted = max(DEMO_RUN_COUNT - named_count, 0)
    today_wanted = max(RUNS_TODAY - named_today, 0)
    wo_ids = wo_ids or ["WO-2025-0000"]

    runs = []
    for index, run_id in enumerate(_run_ids(wanted)):
        description, _slug, cell, minutes, _mb, _signals = _RUN_KINDS[index % len(_RUN_KINDS)]
        wo_index = (index * 7) % len(wo_ids)
        # The first `today_wanted` land today; the rest walk backwards.
        days_back = 0 if index < today_wanted else 1 + (index % (HISTORY_WEEKS * 7))
        at = _at(seed_day, days_back, index % 60)
        project = _PROJECTS[wo_index % len(_PROJECTS)]
        runs.append(
            {
                "_id": run_id,
                "description": description,
                "work_order_id": wo_ids[wo_index],
                "definition_ids": [],
                "project": project,
                "rig_id": _RIGS[index % len(_RIGS)],
                "test_cell": cell,
                "operator": None,
                "bench_sw": None,
                "started_at": at,
                "ended_at": at + timedelta(minutes=minutes),
                "first_data_at": at,
                "invalid": {"flagged": False, "reason": None, "actor": None, "at": None},
                # Placeholders. `build()` derives both from the built file and
                # file_signals rows (`_derive_run_counts`) — never a literal.
                "file_count": 0,
                "signal_count": 0,
                "status": "complete",
                # A person typed the vehicle and the phase, so the map is
                # `manual` and carries the tag every manual write carries.
                # Every run in the cast holds both keys, or a custom group
                # would count fewer runs than the table shows.
                "custom_properties": custom_properties(project, index),
                "field_sources": {
                    "custom_properties": {
                        "source": Source.MANUAL.value,
                        "actor": PROPERTY_ACTOR,
                        "at": at,
                    }
                },
                "created_at": at,
                "updated_at": at,
            }
        )
    return runs


def build_work_orders(named_count: int, synced_at) -> list[dict]:
    """Campaigns that pad the mirror to the demo's work-order count.

    Real-looking rows — titles, requestors, departments, priorities and
    created dates all vary — but mostly closed, so the crowd stays out of the
    demo's way. A few read active, the way a live lab would.
    """
    rows = []
    for index in range(max(DEMO_WORK_ORDER_COUNT - named_count, 0)):
        campaign = _CAMPAIGNS[index % len(_CAMPAIGNS)]
        phase = _PHASES[(index // len(_CAMPAIGNS)) % len(_PHASES)]
        rows.append(
            {
                "_id": f"WO-2025-{index:04d}",
                "title": f"{campaign} — {phase}",
                "project": _PROJECTS[(index * 7) % len(_PROJECTS)],
                "status": "active" if index % 9 == 4 else "closed",
                "requestor": _REQUESTORS[index % len(_REQUESTORS)],
                "department": _DEPARTMENTS[(index * 3) % len(_DEPARTMENTS)],
                "priority": _PRIORITIES[index % len(_PRIORITIES)],
                "created_at_source": synced_at - timedelta(days=30 + (index * 5) % 240),
                "synced_at": synced_at,
                "raw": {},
            }
        )
    return rows


def _build_files(
    seed_day: date,
    runs: list[dict],
    per_run: list[int],
    named_today: int,
) -> list[dict]:
    """The filler files: one per slot of `per_run`, plus the quarantine case.

    A filename carries its run's slug and start date, so the Files list reads
    like an archive of the runs beside it.
    """
    today_wanted = max(FILES_TODAY - named_today, 0)

    slots = [run for run, count in zip(runs, per_run) for _ in range(count)]
    files = []
    for index, run in enumerate(slots):
        # The run id's numeric tail is its build index, so the file inherits
        # the same kind the run was built from.
        kind_index = int(run["_id"][-4:]) % len(_RUN_KINDS)
        _desc, slug, _cell, _minutes, size_mb, sig_count = _RUN_KINDS[kind_index]
        csv = index % 13 == 0
        stamp = run["started_at"].strftime("%Y%m%d_%H%M")
        filename = f"{slug}_{stamp}_{index:04d}.{'csv' if csv else 'mf4'}"
        registered = _not_future(
            _at(seed_day, 0, index % 60)
            if index < today_wanted
            else run["ended_at"] + timedelta(hours=2, minutes=index % 45)
        )
        files.append(
            {
                "_id": f"f-fill-{index:04d}",
                "filename": filename,
                "run_id": run["_id"],
                "source_system": _SOURCE_SYSTEMS[index % len(_SOURCE_SYSTEMS)],
                "format": "CSV" if csv else "MDF 4.10",
                "size_bytes": size_mb * 1_000_000 + index * 37_000,
                "checksum_sha256": hashlib.sha256(f"tm-filler-file-{index}".encode()).hexdigest(),
                "checksum_state": "verified",
                "status": "registered",
                "quarantine_reason": None,
                "storage_ref": stamp_workspace(
                    f"blob://{DEFAULT_PREFIX}/{slug}/{filename}"
                ),
                "ingestion_job_id": None,
                "signal_count": sig_count,
                "time_start": run["started_at"],
                "time_end": run["ended_at"],
                "registered_at": registered,
                "updated_at": registered,
                "field_sources": {},
            }
        )

    files.append(_quarantined_file(len(slots), _at(seed_day, 1, 3)))
    return files


def _quarantined_file(index: int, registered: datetime) -> dict:
    """The second quarantine case of BE-PLAN §7: a file with no run key."""
    return {
        "_id": f"f-fill-{index:04d}",
        "filename": f"unlabeled_{index:04d}.mf4",
        "run_id": None,
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 180_000_000 + index * 37_000,
        "checksum_sha256": hashlib.sha256(f"tm-filler-file-{index}".encode()).hexdigest(),
        "checksum_state": "verified",
        "status": "quarantined",
        "quarantine_reason": "no run key",
        "storage_ref": stamp_workspace(
            f"blob://{DEFAULT_PREFIX}/quarantine/unlabeled_{index:04d}.mf4"
        ),
        "ingestion_job_id": None,
        "signal_count": 0,
        "time_start": registered - timedelta(hours=1, minutes=45),
        "time_end": registered - timedelta(minutes=5),
        "registered_at": registered,
        "updated_at": registered,
        "field_sources": {},
    }


def _build_signals(
    seed_day: date, named_signals: int, taken: frozenset[str]
) -> list[dict]:
    """Pad the signal catalogue to the demo's count.

    Names come from a domain · component · metric · qualifier space, so the
    catalogue browses like a real vehicle's channel list. `taken` holds the
    live catalogue's names — a collision would silently drop the upsert and
    the total would miss the contract's number.
    """
    wanted = max(DEMO_SIGNAL_COUNT - named_signals, 0)
    signals: list[dict] = []
    seen: set[str] = set()
    index = 0
    while len(signals) < wanted:
        domain = _SIGNAL_DOMAINS[index % len(_SIGNAL_DOMAINS)]
        component = _SIGNAL_COMPONENTS[(index // len(_SIGNAL_DOMAINS)) % len(_SIGNAL_COMPONENTS)]
        metric, unit, metric_long = _SIGNAL_METRICS[
            (index // (len(_SIGNAL_DOMAINS) * len(_SIGNAL_COMPONENTS))) % len(_SIGNAL_METRICS)
        ]
        qualifier = _SIGNAL_QUALIFIERS[index % len(_SIGNAL_QUALIFIERS)]
        index += 1

        name = f"{domain}_{component}_{metric}_{qualifier}"
        # The tuple space repeats every 6 600 indexes, and `taken` skips push
        # the walk further — a plain set is the only correct dedup.
        if name in taken or name in seen:
            continue
        seen.add(name)

        count = len(signals)
        first_seen = _at(seed_day, 40 + (count % 200), count % 60)
        signals.append(
            {
                "_id": name,
                "description": f"{domain.replace('_', ' ')} {component} {metric_long}, {qualifier.lower()}",
                "unit": unit,
                "unit_source": "embedded",
                "dtype": "float64",
                "typical_rate_hz": _SIGNAL_RATES[count % len(_SIGNAL_RATES)],
                "run_count": 0,
                "first_seen": first_seen,
                "last_seen": _at(seed_day, 1 + (count % 30), (count * 7) % 60),
                "sensor_ref": None,
                "catalogue_ref": None,
                "rig_ids": [],
                "field_sources": {},
            }
        )
    return signals
