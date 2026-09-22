"""STUB DATA — the test-factory cast.

No route reads this module any more: every contract endpoint answers from
MongoDB, and api/stub_state.py is deleted. It survives because the test
factories (tests/factories.py, factories_planning.py, factories_signals.py)
build the golden-request cast from seed_state() below, mirroring the FE mock
seed (frontend/lib/mock/seed.ts).
Nothing here touches the database.
"""

from datetime import UTC, datetime


def dt(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


def _at(day: str, time: str) -> datetime:
    return datetime.fromisoformat(f"{day}T{time}+00:00")


# --- Seed identifiers (contract §A; ids match the FE seed) ---

HERO_RUN_ID = "TAS-88214"
HERO_WO_ID = "WO-2026-0847"
HERO_DEFINITION_ID = "TD-BAT-114"
HERO_SIGNAL_NAME = "HV_Batt_Cell_Temp_Max"

SYNC_WO_ID = "WO-2026-0851"
SYNC_TD_ID = "TD-BAT-114"
SYNC_PROJECT = "EX90"
SEED_WO_SYNCED_AT = dt(2026, 8, 13, 16, 20)
HERO_RUN_SEED_UPDATED_AT = dt(2026, 8, 14, 9, 58)

FILE_BAT_ID = "f-9a41c8f2-6d0b-4e17-a35c-72d9e814b061"
FILE_INCA_ID = "f-41bb63e0-7c25-4d98-b1f4-08a3d5c2e917"
FILE_CSV_ID = "f-b7d04c39-2e85-4f1a-9d67-e02a41c5b883"
FILE_QUAR_MISMATCH_ID = "f-6c1f9a2e-07d4-4b85-935e-2a91c6f03d7b"
FILE_EM_0812_ID = "f-c58d3b7a-91e0-4f62-8d1c-25a19b7e3046"
FILE_QUAR_FORMAT_ID = "f-2e7d0c4a-91b6-4f85-b5d3-e8a12c04f9b7"
RESULT_ID = "res-77aa19c4-3d6f-4b02-8e51-a9c04d1e7b26"

# Prototype vanity totals — the seeded rows are the drill-down subset.
VANITY_COUNTS = {
    "test_runs": 128,
    "files": 512,
    "signals": 6412,
    "work_orders": 42,
    "runs_today": 6,
    "files_today": 31,
    "rig_count": 4,
}

# The sidebar/status vanity constant. The FE reports 42 before and after a
# sync pass, so the BE does too.
WORK_ORDERS_MIRRORED = 42


def _no_flag() -> dict:
    return {"flagged": False, "reason": None, "actor": None, "at": None}


def _src(source: str, actor: str, at: datetime) -> dict:
    return {"source": source, "actor": actor, "at": at}


# --- Runs (15, matching the FE seed) ---


def _battery_run(
    run_id: str,
    description: str,
    definition_id: str,
    work_order_id: str,
    day: str,
    **overrides,
) -> dict:
    registered_at = _at(day, "09:12:33")
    run = {
        "run_id": run_id,
        "description": description,
        "definition_id": definition_id,
        "work_order_id": work_order_id,
        "project": "EX90",
        "rig_id": "RIG-04",
        "test_cell": "TC-2",
        "operator": None,
        "bench_sw": "TAS 7.4.2 · fw 2.11",
        "started_at": _at(day, "09:12:41"),
        "ended_at": _at(day, "10:48:20"),
        "first_data_at": _at(day, "09:12:00"),
        "file_count": 3,
        "signal_count": 142,
        "invalid": _no_flag(),
        "field_sources": {
            "rig_id": _src("embedded", "ingestion", registered_at),
            "bench_sw": _src("api:config", "config-sync", registered_at),
        },
        "created_at": registered_at,
        "updated_at": registered_at,
    }
    run.update(overrides)
    return run


def _seed_runs() -> list[dict]:
    return [
        {
            "run_id": HERO_RUN_ID,
            "description": "HV battery thermal cycling",
            "definition_id": None,
            "work_order_id": None,
            "project": None,
            "rig_id": "RIG-04",
            "test_cell": "TC-2",
            "operator": "A. Bergström",
            "bench_sw": "TAS 7.4.2 · fw 2.11",
            "started_at": dt(2026, 8, 14, 9, 41, 7),
            "ended_at": dt(2026, 8, 14, 11, 18, 52),
            "first_data_at": dt(2026, 8, 14, 9, 41),
            "file_count": 3,
            "signal_count": 142,
            "invalid": _no_flag(),
            "field_sources": {
                "rig_id": _src("embedded", "ingestion", dt(2026, 8, 14, 9, 41, 33)),
                "operator": _src("manual", "a.bergstrom", dt(2026, 8, 14, 9, 58)),
                "bench_sw": _src("api:config", "config-sync", dt(2026, 8, 14, 9, 42)),
            },
            "created_at": dt(2026, 8, 14, 9, 41, 33),
            "updated_at": HERO_RUN_SEED_UPDATED_AT,
        },
        {
            "run_id": "TAS-88213",
            "description": "E-machine efficiency map",
            "definition_id": "TD-EM-201",
            "work_order_id": HERO_WO_ID,
            "project": "EX90",
            "rig_id": "RIG-02",
            "test_cell": "TC-1",
            "operator": None,
            "bench_sw": "TAS 7.4.2 · fw 2.11",
            "started_at": dt(2026, 8, 14, 8, 12, 9),
            "ended_at": dt(2026, 8, 14, 10, 5, 41),
            "first_data_at": dt(2026, 8, 14, 8, 12),
            "file_count": 5,
            "signal_count": 96,
            "invalid": _no_flag(),
            "field_sources": {
                "rig_id": _src("embedded", "ingestion", dt(2026, 8, 14, 8, 12, 30)),
                "bench_sw": _src("api:config", "config-sync", dt(2026, 8, 14, 8, 12, 35)),
            },
            "created_at": dt(2026, 8, 14, 8, 12, 30),
            "updated_at": dt(2026, 8, 14, 8, 12, 30),
        },
        {
            "run_id": "TAS-88209",
            "description": "Inverter derating sweep",
            "definition_id": "TD-INV-077",
            "work_order_id": "WO-2026-0843",
            "project": "EC40",
            "rig_id": "RIG-07",
            "test_cell": "TC-4",
            "operator": None,
            "bench_sw": "TAS 7.4.1 · fw 2.10",
            "started_at": dt(2026, 8, 13, 17, 26, 12),
            "ended_at": dt(2026, 8, 13, 18, 44, 3),
            "first_data_at": dt(2026, 8, 13, 17, 26),
            "file_count": 2,
            "signal_count": 64,
            "invalid": {
                "flagged": True,
                "reason": (
                    "Torque ripple sensor fault from cycle 6 — derating sweep data unusable."
                ),
                "actor": "e.lindqvist",
                "at": dt(2026, 8, 13, 18, 2),
            },
            "field_sources": {
                "rig_id": _src("embedded", "ingestion", dt(2026, 8, 13, 17, 26, 40)),
                "bench_sw": _src("api:config", "config-sync", dt(2026, 8, 13, 17, 26, 45)),
            },
            "created_at": dt(2026, 8, 13, 17, 26, 40),
            "updated_at": dt(2026, 8, 13, 18, 2),
        },
        _battery_run(
            "TAS-88207",
            "HV battery thermal cycling",
            "TD-BAT-114",
            "WO-2026-0839",
            "2026-08-13",
            started_at=dt(2026, 8, 13, 14, 3, 11),
            ended_at=dt(2026, 8, 13, 15, 41, 58),
            first_data_at=dt(2026, 8, 13, 14, 3),
            created_at=dt(2026, 8, 13, 14, 3, 29),
            updated_at=dt(2026, 8, 13, 14, 3, 29),
            field_sources={
                "rig_id": _src("embedded", "ingestion", dt(2026, 8, 13, 14, 3, 29)),
                "bench_sw": _src("api:config", "config-sync", dt(2026, 8, 13, 14, 3, 35)),
            },
            file_count=4,
        ),
        {
            "run_id": "TAS-88201",
            "description": "E-machine efficiency map",
            "definition_id": "TD-EM-201",
            "work_order_id": HERO_WO_ID,
            "project": "EX90",
            "rig_id": "RIG-02",
            "test_cell": "TC-1",
            "operator": None,
            "bench_sw": "TAS 7.4.2 · fw 2.11",
            "started_at": dt(2026, 8, 13, 11, 47, 4),
            "ended_at": dt(2026, 8, 13, 13, 39, 50),
            "first_data_at": dt(2026, 8, 13, 11, 47),
            "file_count": 5,
            "signal_count": 96,
            "invalid": _no_flag(),
            "field_sources": {
                "rig_id": _src("embedded", "ingestion", dt(2026, 8, 13, 11, 47, 22)),
                "bench_sw": _src("api:config", "config-sync", dt(2026, 8, 13, 11, 47, 28)),
            },
            "created_at": dt(2026, 8, 13, 11, 47, 22),
            "updated_at": dt(2026, 8, 13, 11, 47, 22),
        },
        _battery_run(
            "TAS-88198", "HV battery thermal cycling", "TD-BAT-114", "WO-2026-0812", "2026-08-08"
        ),
        _battery_run(
            "TAS-88190",
            "HV battery thermal cycling — summer cycle",
            "TD-BAT-102",
            "WO-2026-0839",
            "2026-08-01",
        ),
        _battery_run(
            "TAS-88183",
            "HV battery thermal cycling — summer cycle",
            "TD-BAT-102",
            "WO-2026-0839",
            "2026-07-24",
        ),
        _battery_run(
            "TAS-88177",
            "HV battery thermal cycling — summer cycle",
            "TD-BAT-102",
            "WO-2026-0812",
            "2026-07-17",
        ),
        _battery_run(
            "TAS-88168",
            "HV battery thermal cycling — summer cycle",
            "TD-BAT-102",
            "WO-2026-0812",
            "2026-07-09",
        ),
        _battery_run(
            "TAS-88159",
            "HV battery thermal cycling — winter cycle",
            "TD-BAT-114",
            "WO-2026-0812",
            "2026-07-01",
        ),
        _battery_run(
            "TAS-88150",
            "HV battery thermal cycling — winter cycle",
            "TD-BAT-114",
            "WO-2026-0812",
            "2026-06-24",
        ),
        _battery_run(
            "TAS-88141",
            "HV battery thermal cycling — summer cycle",
            "TD-BAT-102",
            "WO-2026-0812",
            "2026-06-17",
        ),
        _battery_run(
            "TAS-88123",
            "HV battery thermal cycling — winter cycle",
            "TD-BAT-114",
            "WO-2026-0812",
            "2026-06-09",
        ),
        _battery_run(
            "TAS-88104",
            "HV battery thermal cycling — winter cycle",
            "TD-BAT-114",
            "WO-2026-0812",
            "2026-06-02",
        ),
    ]


# --- Work orders (4 mirrored + the hidden winter-cycle WO) ---


def _seed_work_orders() -> list[dict]:
    def wo(
        wo_id: str,
        title: str,
        project: str,
        status: str,
        requestor: str,
        priority: str,
        created: datetime,
        mirrored: bool,
    ) -> dict:
        return {
            "wo_id": wo_id,
            "title": title,
            "project": project,
            "status": status,
            "requestor": requestor,
            "department": "Propulsion Test Labs",
            "priority": priority,
            "created_at_source": created,
            "synced_at": SEED_WO_SYNCED_AT,
            # mirrored=False: exists only in the hidden planning system
            # until a sync pass mirrors it.
            "mirrored": mirrored,
        }

    return [
        wo(
            HERO_WO_ID,
            "E-machine efficiency characterisation",
            "EX90",
            "active",
            "M. Ekholm · Propulsion",
            "P2 — standard",
            dt(2026, 8, 3),
            True,
        ),
        wo(
            "WO-2026-0843",
            "Inverter thermal derating — phase 2",
            "EC40",
            "closed",
            "S. Vidal · Powertrain",
            "P2 — standard",
            dt(2026, 7, 28),
            True,
        ),
        wo(
            "WO-2026-0839",
            "HV battery thermal validation — summer cycle",
            "EX90",
            "closed",
            "L. Åkesson · Battery",
            "P2 — standard",
            dt(2026, 7, 20),
            True,
        ),
        wo(
            "WO-2026-0812",
            "HV battery thermal validation — phase 1",
            "EX90",
            "closed",
            "L. Åkesson · Battery",
            "P2 — standard",
            dt(2026, 5, 28),
            True,
        ),
        wo(
            SYNC_WO_ID,
            "HV battery thermal validation — winter cycle",
            "EX90",
            "active",
            "L. Åkesson · Battery",
            "P1 — expedite",
            dt(2026, 8, 12),
            False,
        ),
    ]


def _seed_definitions() -> list[dict]:
    return [
        {"td_id": "TD-BAT-102", "title": "HV battery thermal cycling · +10 °C → +45 °C", "mirrored": True},
        {"td_id": "TD-BAT-114", "title": "HV battery thermal cycling · −20 °C → +40 °C", "mirrored": True},
        {"td_id": "TD-BAT-118", "title": "HV battery thermal cycling · cold-soak extension", "mirrored": False},
        {"td_id": "TD-EM-201", "title": "E-machine efficiency map — WLTP points", "mirrored": True},
        {"td_id": "TD-EM-204", "title": "E-machine efficiency map — high-load extension", "mirrored": True},
        {"td_id": "TD-INV-077", "title": "Inverter derating sweep · thermal limits", "mirrored": True},
    ]


def _seed_wo_definitions() -> list[dict]:
    return [
        {"wo_id": HERO_WO_ID, "td_id": "TD-EM-201", "planned_runs": 2},
        {"wo_id": HERO_WO_ID, "td_id": "TD-EM-204", "planned_runs": 1},
        {"wo_id": "WO-2026-0843", "td_id": "TD-INV-077", "planned_runs": 1},
        {"wo_id": "WO-2026-0839", "td_id": "TD-BAT-114", "planned_runs": 1},
        {"wo_id": "WO-2026-0839", "td_id": "TD-BAT-102", "planned_runs": 2},
        {"wo_id": "WO-2026-0812", "td_id": "TD-BAT-114", "planned_runs": 5},
        {"wo_id": "WO-2026-0812", "td_id": "TD-BAT-102", "planned_runs": 3},
        {"wo_id": SYNC_WO_ID, "td_id": "TD-BAT-114", "planned_runs": 4},
        {"wo_id": SYNC_WO_ID, "td_id": "TD-BAT-118", "planned_runs": 2},
    ]


# --- Files (6, matching the FE seed) ---


def _file_sources(at: datetime) -> dict:
    return {
        "size_bytes": _src("embedded", "ingestion", at),
        "checksum_sha256": _src("embedded", "ingestion", at),
    }


def _seed_files() -> list[dict]:
    return [
        {
            "file_id": FILE_BAT_ID,
            "filename": "bat_cyc_20260814_0941.mf4",
            "run_id": HERO_RUN_ID,
            "source_system": "TAS",
            "format": "MDF 4.10",
            "size_bytes": 1331439861,
            "checksum_sha256": "9f2c8a41d6e0b3f73d5a1e8c04d9b6273fa08e51c47d92e6b30f14c2ad90e1a7",
            "checksum_state": "verified",
            "status": "registered",
            "quarantine_reason": None,
            "signal_count": 96,
            "time_start": dt(2026, 8, 14, 9, 41, 7),
            "time_end": dt(2026, 8, 14, 11, 18, 52),
            "registered_at": dt(2026, 8, 14, 9, 41, 33),
            "storage_ref": "blob://test-manager/landing/rig-04/2026/08/14/bat_cyc_20260814_0941.mf4",
            "ingestion_job_id": "ing-20260814-0941-77c2",
            "field_sources": _file_sources(dt(2026, 8, 14, 9, 41, 33)),
        },
        {
            "file_id": FILE_INCA_ID,
            "filename": "inca_cal_20260814_0941.mf4",
            "run_id": HERO_RUN_ID,
            "source_system": "INCA",
            "format": "MDF 4.10",
            "size_bytes": 327155712,
            "checksum_sha256": "41bb7e02c9d5a8134f60eb27d491c8a5023f7b6e19d0c4825a7e3f1b6d4809c3",
            "checksum_state": "verified",
            "status": "registered",
            "quarantine_reason": None,
            "signal_count": 41,
            "time_start": dt(2026, 8, 14, 9, 41, 10),
            "time_end": dt(2026, 8, 14, 11, 18, 40),
            "registered_at": dt(2026, 8, 14, 9, 42, 5),
            "storage_ref": "blob://test-manager/landing/rig-04/2026/08/14/inca_cal_20260814_0941.mf4",
            "ingestion_job_id": "ing-20260814-0941-77c3",
            "field_sources": _file_sources(dt(2026, 8, 14, 9, 42, 5)),
        },
        {
            "file_id": FILE_CSV_ID,
            "filename": "chamber_log_0941.csv",
            "run_id": HERO_RUN_ID,
            "source_system": "ifile",
            "format": "CSV",
            "size_bytes": 2516582,
            "checksum_sha256": "b7d04e91a2c85f37d6b0e814c92a7f53e1d68b04a9c2735fe80d1b6c93a44421",
            "checksum_state": "verified",
            "status": "registered",
            "quarantine_reason": None,
            "signal_count": 5,
            "time_start": dt(2026, 8, 14, 9, 41),
            "time_end": dt(2026, 8, 14, 11, 19),
            "registered_at": dt(2026, 8, 14, 9, 42, 18),
            "storage_ref": "blob://test-manager/landing/rig-04/2026/08/14/chamber_log_0941.csv",
            "ingestion_job_id": "ing-20260814-0941-77c4",
            "field_sources": _file_sources(dt(2026, 8, 14, 9, 42, 18)),
        },
        {
            "file_id": FILE_QUAR_MISMATCH_ID,
            "filename": "em_eff_20260813_1726.mf4",
            "run_id": None,
            "source_system": "TAS",
            "format": "MDF 4.10",
            "size_bytes": 966367641,
            "checksum_sha256": "6c1f9a2e07d4b8535e2a91c6f03d7b48a15e60c9d2f8b7341a0ce65d98b2f7e4",
            "checksum_state": "mismatch",
            "status": "quarantined",
            "quarantine_reason": (
                "Checksum mismatch against rig manifest — retained for inspection, never dropped."
            ),
            "signal_count": 0,
            "time_start": dt(2026, 8, 13, 17, 26),
            "time_end": dt(2026, 8, 13, 18, 44),
            "registered_at": dt(2026, 8, 13, 18, 45, 12),
            "storage_ref": "blob://test-manager/landing/quarantine/2026/08/13/em_eff_20260813_1726.mf4",
            "ingestion_job_id": "ing-20260813-1726-41d8",
            "field_sources": _file_sources(dt(2026, 8, 13, 18, 45, 12)),
        },
        {
            "file_id": FILE_EM_0812_ID,
            "filename": "em_eff_20260814_0812.mf4",
            "run_id": "TAS-88213",
            "source_system": "TAS",
            "format": "MDF 4.10",
            "size_bytes": 2254857830,
            "checksum_sha256": "c58d3b7a91e0f624d8c25a19b7e3046fa9d1c8e2530b6f47e19a2d0c4b8577f2",
            "checksum_state": "verified",
            "status": "registered",
            "quarantine_reason": None,
            "signal_count": 96,
            "time_start": dt(2026, 8, 14, 8, 12, 9),
            "time_end": dt(2026, 8, 14, 10, 5, 41),
            "registered_at": dt(2026, 8, 14, 8, 12, 30),
            "storage_ref": "blob://test-manager/landing/rig-02/2026/08/14/em_eff_20260814_0812.mf4",
            "ingestion_job_id": "ing-20260814-0812-19aa",
            "field_sources": _file_sources(dt(2026, 8, 14, 8, 12, 30)),
        },
        {
            "file_id": FILE_QUAR_FORMAT_ID,
            "filename": "inv_derate_20260812_1518.mf4",
            "run_id": None,
            "source_system": "INCA",
            "format": "MDF 4.10",
            "size_bytes": 155189248,
            "checksum_sha256": "2e7d0c4a91b6f8535d3e8a12c04f9b76e2a1d5c8340f7b6e91c2d8a05e3f6b14",
            "checksum_state": "unverified",
            "status": "quarantined",
            "quarantine_reason": (
                "Unreadable MDF data block at offset 0x3f10 — format validation failed."
            ),
            "signal_count": 0,
            "time_start": dt(2026, 8, 12, 15, 18),
            "time_end": dt(2026, 8, 12, 16, 2),
            "registered_at": dt(2026, 8, 12, 16, 3, 40),
            "storage_ref": "blob://test-manager/landing/quarantine/2026/08/12/inv_derate_20260812_1518.mf4",
            "ingestion_job_id": "ing-20260812-1518-c30f",
            "field_sources": _file_sources(dt(2026, 8, 12, 16, 3, 40)),
        },
    ]


# --- Per-file signal inventories ---
# The FE seeds unit_source: null for unit-less rows; the BE FileSignal model
# requires a source tag, so those rows keep "embedded" here (documented drift,
# no screen keys on it — the missing-unit badge keys on unit is null).


def _fsig(name: str, unit: str | None, unit_source: str, rate_hz: int, dtype: str, stats: dict) -> dict:
    return {
        "name": name,
        "unit": unit,
        "unit_source": unit_source,
        "rate_hz": rate_hz,
        "dtype": dtype,
        "stats": stats,
    }


def _seed_file_signals() -> dict[str, list[dict]]:
    return {
        FILE_BAT_ID: [
            _fsig("HV_Batt_Cell_Temp_Max", "°C", "embedded", 100, "float64", {"min": 18.2, "max": 47.9, "mean": 33.4, "std": 6.21}),
            _fsig("HV_Batt_Pack_Voltage", "V", "embedded", 100, "float64", {"min": 312.4, "max": 398.7, "mean": 361.2, "std": 18.4}),
            _fsig("HV_Batt_Pack_Current", "A", "embedded", 100, "float64", {"min": -214.0, "max": 187.5, "mean": -3.8, "std": 64.02}),
            _fsig("Coolant_Inlet_Temp", "°C", "manual", 10, "float64", {"min": 15.1, "max": 28.6, "mean": 21.9, "std": 3.12}),
            _fsig("Coolant_Flow_Rate", "l/min", "embedded", 10, "float64", {"min": 4.1, "max": 12.0, "mean": 8.7, "std": 1.84}),
            _fsig("Chamber_Ambient_Temp", "°C", "embedded", 1, "float64", {"min": -19.8, "max": 40.2, "mean": 11.6, "std": 17.3}),
            _fsig("HV_Batt_Cell_Temp_Min", "°C", "embedded", 100, "float64", {"min": 17.4, "max": 38.6, "mean": 28.9, "std": 5.02}),
            _fsig("Coolant_Outlet_Temp", "°C", "embedded", 10, "float64", {"min": 16.8, "max": 33.1, "mean": 25.4, "std": 3.9}),
        ],
        FILE_INCA_ID: [
            _fsig("HV_Batt_SOC", "%", "embedded", 10, "float64", {"min": 21.5, "max": 96.0, "mean": 62.3, "std": 22.1}),
            _fsig("Cycle_Counter", "count", "embedded", 1, "int32", {"min": 1, "max": 22, "mean": 11.5, "std": 6.35}),
        ],
        FILE_CSV_ID: [
            _fsig("Chamber_Ambient_Temp", "°C", "embedded", 1, "float64", {"min": -19.8, "max": 40.2, "mean": 11.6, "std": 17.3}),
            _fsig("Chamber_Humidity", None, "embedded", 1, "float64", {"min": 12.1, "max": 78.4, "mean": 45.2, "std": 14.6}),
        ],
        FILE_EM_0812_ID: [
            _fsig("EM_Rotor_Temp", "°C", "embedded", 100, "float64", {"min": 24.3, "max": 118.7, "mean": 76.2, "std": 21.4}),
            _fsig("EM_Shaft_Torque", None, "embedded", 100, "float64", {"min": -12.4, "max": 348.9, "mean": 142.6, "std": 88.3}),
        ],
    }


# --- Signals catalogue (14, matching the FE seed) ---


def _seed_signals() -> list[dict]:
    def sig(
        name: str,
        description: str,
        unit: str | None,
        unit_source: str,
        dtype: str,
        rate: int,
        run_count: int,
        first_seen: datetime,
        last_seen: datetime,
        rig_ids: list[str],
        sensor_ref: str | None = None,
        catalogue_ref: str | None = None,
        field_sources: dict | None = None,
    ) -> dict:
        return {
            "name": name,
            "description": description,
            "unit": unit,
            "unit_source": unit_source,
            "dtype": dtype,
            "typical_rate_hz": rate,
            "run_count": run_count,
            "first_seen": first_seen,
            "last_seen": last_seen,
            "sensor_ref": sensor_ref,
            "catalogue_ref": catalogue_ref,
            "rig_ids": rig_ids,
            "field_sources": (
                field_sources
                if field_sources is not None
                else {"unit": _src("embedded", "ingestion", first_seen)}
            ),
        }

    embedded_jun2 = {"unit": _src("embedded", "ingestion", dt(2026, 6, 2, 8, 14, 20))}
    return [
        sig(
            HERO_SIGNAL_NAME,
            "Hottest cell temperature across pack",
            "°C",
            "embedded",
            "float64",
            100,
            12,
            dt(2026, 6, 2),
            dt(2026, 8, 14, 9, 41, 33),
            ["RIG-04", "RIG-07"],
            sensor_ref="PT100-B4-07",
            catalogue_ref="TEMP-CELL-MAX",
            field_sources={
                "unit": _src("embedded", "ingestion", dt(2026, 6, 2, 8, 14, 20)),
                "sensor_ref": _src("manual", "a.bergstrom", dt(2026, 6, 3, 10, 2)),
                "catalogue_ref": _src(
                    "api:catalogue", "catalog-sync", dt(2026, 6, 2, 9, 0)
                ),
            },
        ),
        sig(
            "HV_Batt_Cell_Temp_Min",
            "Coldest cell temperature across pack",
            "°C",
            "embedded",
            "float64",
            100,
            12,
            dt(2026, 6, 2),
            dt(2026, 8, 14, 9, 41, 33),
            ["RIG-04"],
            catalogue_ref="TEMP-CELL-MIN",
            field_sources=dict(embedded_jun2),
        ),
        sig(
            "HV_Batt_Pack_Voltage",
            "Pack terminal voltage",
            "V",
            "embedded",
            "float64",
            100,
            12,
            dt(2026, 6, 2),
            dt(2026, 8, 14, 9, 41, 33),
            ["RIG-04"],
            field_sources=dict(embedded_jun2),
        ),
        sig(
            "HV_Batt_Pack_Current",
            "Pack current, discharge negative",
            "A",
            "embedded",
            "float64",
            100,
            12,
            dt(2026, 6, 2),
            dt(2026, 8, 14, 9, 41, 33),
            ["RIG-04"],
            field_sources=dict(embedded_jun2),
        ),
        sig(
            "HV_Batt_SOC",
            "State of charge, BMS estimate",
            "%",
            "embedded",
            "float64",
            10,
            12,
            dt(2026, 6, 2),
            dt(2026, 8, 14, 9, 41, 33),
            ["RIG-04"],
            field_sources=dict(embedded_jun2),
        ),
        sig(
            "Coolant_Inlet_Temp",
            "Coolant temperature at pack inlet",
            "°C",
            "manual",
            "float64",
            10,
            8,
            dt(2026, 6, 18),
            dt(2026, 8, 14, 9, 41, 33),
            ["RIG-04"],
            field_sources={"unit": _src("manual", "a.bergstrom", dt(2026, 8, 14, 10, 12))},
        ),
        sig(
            "Coolant_Outlet_Temp",
            "Coolant temperature at pack outlet",
            "°C",
            "embedded",
            "float64",
            10,
            8,
            dt(2026, 6, 18),
            dt(2026, 8, 14, 9, 41, 33),
            ["RIG-04"],
            field_sources={"unit": _src("embedded", "ingestion", dt(2026, 6, 18, 9, 30))},
        ),
        sig(
            "Coolant_Flow_Rate",
            "Volumetric flow, conditioning loop",
            "l/min",
            "embedded",
            "float64",
            10,
            8,
            dt(2026, 6, 18),
            dt(2026, 8, 14, 9, 41, 33),
            ["RIG-04"],
            field_sources={"unit": _src("embedded", "ingestion", dt(2026, 6, 18, 9, 30))},
        ),
        sig(
            "Chamber_Ambient_Temp",
            "Climate chamber air temperature",
            "°C",
            "embedded",
            "float64",
            1,
            21,
            dt(2026, 6, 2),
            dt(2026, 8, 14, 9, 42, 18),
            ["RIG-04", "RIG-07"],
            field_sources=dict(embedded_jun2),
        ),
        # unit is null: FE seeds unit_source null; the BE model needs a tag.
        sig(
            "Chamber_Humidity",
            "Climate chamber relative humidity",
            None,
            "embedded",
            "float64",
            1,
            21,
            dt(2026, 6, 2),
            dt(2026, 8, 14, 9, 42, 18),
            ["RIG-04", "RIG-07"],
            field_sources={},
        ),
        sig(
            "EM_Rotor_Temp",
            "E-machine rotor temperature, estimated",
            "°C",
            "embedded",
            "float64",
            100,
            9,
            dt(2026, 6, 5),
            dt(2026, 8, 14, 8, 12, 30),
            ["RIG-02"],
            field_sources={"unit": _src("embedded", "ingestion", dt(2026, 6, 5, 7, 50))},
        ),
        sig(
            "EM_Shaft_Torque",
            "Dyno shaft torque, HBM flange",
            None,
            "embedded",
            "float64",
            100,
            9,
            dt(2026, 6, 5),
            dt(2026, 8, 14, 8, 12, 30),
            ["RIG-02"],
            field_sources={},
        ),
        sig(
            "INV_DC_Bus_Voltage",
            "Inverter DC-link voltage",
            "V",
            "embedded",
            "float64",
            100,
            6,
            dt(2026, 6, 11),
            dt(2026, 8, 13, 17, 26, 41),
            ["RIG-07"],
            field_sources={"unit": _src("embedded", "ingestion", dt(2026, 6, 11, 13, 20))},
        ),
        sig(
            "Cycle_Counter",
            "Test sequence cycle index",
            "count",
            "embedded",
            "int32",
            1,
            14,
            dt(2026, 6, 2),
            dt(2026, 8, 14, 9, 42, 5),
            ["RIG-02", "RIG-04", "RIG-07"],
            field_sources=dict(embedded_jun2),
        ),
    ]


# --- Per-run stats (the "seen in 12 runs" table, matching the FE seed) ---


def _seed_signal_run_stats() -> dict[str, list[dict]]:
    rows = [
        ("TAS-88214", 18.2, 47.9, 33.4, 6.21),
        ("TAS-88207", 19.4, 46.2, 32.8, 5.98),
        ("TAS-88198", 21.0, 48.3, 34.9, 6.4),
        ("TAS-88190", 24.6, 49.7, 38.2, 5.7),
        ("TAS-88183", 25.1, 49.4, 37.6, 5.5),
        ("TAS-88177", 23.8, 48.9, 36.4, 5.8),
        ("TAS-88168", 24.2, 47.6, 36.9, 5.6),
        ("TAS-88159", 15.8, 44.1, 29.6, 6.9),
        ("TAS-88150", 16.3, 43.5, 30.2, 6.7),
        ("TAS-88141", 22.7, 46.8, 35.1, 5.9),
        ("TAS-88123", 15.2, 42.8, 28.9, 7.0),
        ("TAS-88104", 16.1, 43.9, 29.8, 6.8),
    ]
    return {
        HERO_SIGNAL_NAME: [
            {"run_id": run_id, "min": lo, "max": hi, "mean": mean, "std": std}
            for run_id, lo, hi, mean, std in rows
        ]
    }


# --- Results ---


def _seed_results() -> list[dict]:
    return [
        {
            "result_id": RESULT_ID,
            "run_id": HERO_RUN_ID,
            "name": "thermal_summary_v1.parquet",
            "result_key": "thermal_summary",
            "version": 1,
            "supersedes": None,
            "description": "Cycle-level aggregates",
            "storage_ref": "blob://results/tas-88214/thermal_summary_v1.parquet",
            "provenance": {
                "tool": "bat-post",
                "tool_version": "2.3.1",
                "parameters": "--cycles all --dt 0.1",
                "input_file_ids": [FILE_BAT_ID, FILE_CSV_ID],
                "produced_by": "e.lindqvist",
                "produced_at": dt(2026, 8, 14, 12, 2),
            },
            "provenance_status": "verified",
            "created_at": dt(2026, 8, 14, 12, 2, 31),
        }
    ]


# --- Journal (8 entries, matching the FE seed) ---
# context_run_id: signal edits made in run context surface in that run's
# journal (contract §8). sync_generated: reverted on demo reset. Both keys
# are internal — the JournalEntry model drops them on the wire.


def _seed_journal() -> list[dict]:
    return [
        {
            "id": "j-4c2e91a7-05d8-4b36-9f12-e7a80c4d5b19",
            "entity_type": "signal",
            "entity_id": "Coolant_Inlet_Temp",
            "field": "signal.Coolant_Inlet_Temp.unit",
            "kind": "change",
            "old": "(missing)",
            "new": "°C",
            "source": "manual",
            "actor": "a.bergstrom",
            "note": "Unit absent from file header — set from rig sensor sheet.",
            "at": dt(2026, 8, 14, 10, 12),
            "context_run_id": HERO_RUN_ID,
        },
        {
            "id": "j-8b3d02f6-71c4-4e95-a2d8-0c1f6e94a752",
            "entity_type": "run",
            "entity_id": HERO_RUN_ID,
            "field": "run.operator",
            "kind": "change",
            "old": "(empty)",
            "new": "A. Bergström",
            "source": "manual",
            "actor": "a.bergstrom",
            "note": None,
            "at": dt(2026, 8, 14, 9, 58),
        },
        {
            "id": "j-1f60e8d3-92a5-4c07-b4e1-5d28a7c39f84",
            "entity_type": "run",
            "entity_id": HERO_RUN_ID,
            "field": "run.registered",
            "kind": "event",
            "old": None,
            "new": None,
            "source": "embedded",
            "actor": "ingestion",
            "note": (
                "Run created automatically — 3 files parsed, 142 signals cataloged, "
                "checksums verified."
            ),
            "at": dt(2026, 8, 14, 9, 41, 33),
        },
        {
            "id": "j-a95c17e0-3b64-4d28-8f0a-c2e51d97b346",
            "entity_type": "file",
            "entity_id": FILE_BAT_ID,
            "field": "file.detected",
            "kind": "event",
            "old": None,
            "new": None,
            "source": "embedded",
            "actor": "ingestion",
            "note": "bat_cyc_20260814_0941.mf4 arrived through mf4-import.",
            "at": dt(2026, 8, 14, 9, 41, 12),
        },
        {
            "id": "j-d27f04b8-6e19-4a53-92c7-1b8e0f5a4d62",
            "entity_type": "file",
            "entity_id": FILE_BAT_ID,
            "field": "file.checksum_verified",
            "kind": "event",
            "old": None,
            "new": None,
            "source": "embedded",
            "actor": "ingestion",
            "note": "sha256 matches manifest — file admitted for parsing.",
            "at": dt(2026, 8, 14, 9, 41, 19),
        },
        {
            "id": "j-63a8f2c1-0d97-4e46-b5a3-9f14c6d20e78",
            "entity_type": "file",
            "entity_id": FILE_BAT_ID,
            "field": "file.header_parsed",
            "kind": "event",
            "old": None,
            "new": None,
            "source": "embedded",
            "actor": "ingestion",
            "note": "MDF 4.10 header read — 96 signals cataloged with units and rates.",
            "at": dt(2026, 8, 14, 9, 41, 31),
        },
        {
            "id": "j-05e9b7d4-8a12-4f60-93c8-6d2a1e0f7b45",
            "entity_type": "file",
            "entity_id": FILE_BAT_ID,
            "field": "file.registered",
            "kind": "event",
            "old": None,
            "new": None,
            "source": "embedded",
            "actor": "ingestion",
            "note": "Linked to run TAS-88214 (idempotent upsert).",
            "at": dt(2026, 8, 14, 9, 41, 33),
        },
        {
            "id": "j-e71b39a6-2c50-4d84-a1f7-08d6c4e29b53",
            "entity_type": "run",
            "entity_id": "TAS-88209",
            "field": "run.invalid_flag",
            "kind": "change",
            "old": "false",
            "new": "true",
            "source": "manual",
            "actor": "e.lindqvist",
            "note": "Torque ripple sensor fault from cycle 6 — derating sweep data unusable.",
            "at": dt(2026, 8, 13, 18, 2),
        },
    ]


def seed_state() -> dict:
    """Build one fresh, fully mutable copy of the seed state."""
    return {
        "planning_online": False,
        "last_sync_at": None,
        "last_sync_result": None,
        "runs": _seed_runs(),
        "work_orders": _seed_work_orders(),
        "definitions": _seed_definitions(),
        "wo_definitions": _seed_wo_definitions(),
        "files": _seed_files(),
        "file_signals": _seed_file_signals(),
        "signals": _seed_signals(),
        "signal_run_stats": _seed_signal_run_stats(),
        "results": _seed_results(),
        "journal": _seed_journal(),
    }
