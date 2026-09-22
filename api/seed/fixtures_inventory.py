"""Named seed records for files, signals, samples and results. Lane B owns this file.

Tickets B-11 (interim cast) and B-17 (final cast). **This file is UTF-8.** The
data carries "°C". Read and write it as UTF-8, never as the Windows code page.

**The time-basing rule (BE-PLAN §7).** Every record below holds a literal
reference timestamp on `REFERENCE_DAY` (2026-08-14, the prototype's "today").
`build(seed_day)` shifts every timestamp by whole days. **Dates rebase. Values
never rebase.** The statistic values (18.2 / 47.9 / 33.4 / 6.21 …) stay literal,
because the screens must match the approved concept.

**The write path (day-one decision 7, seam 5).** `write_inventory()` writes
through the public API. `POST /files` registers each file, its `file_signals`
rows and its catalogue rows (B-05). `POST /results` stores the result (B-16).
**No raw insert remains for files, inventory rows or results.** The seam-5 TODO
is closed.

One raw write survives on purpose. `upsert_catalogue_raw()` stamps the curated
catalogue fields on top: `description`, `sensor_ref`, `catalogue_ref`,
`first_seen` and `rig_ids`. `POST /files` can only state what a file header
carries, and the contract gives `catalogue_ref` no write route at all. Run this
function **after** the files, or the embedded defaults win.

**The statistics path (B-17, 2026-08-17).** QuixLake stores no statistic. It
stores samples and computes min, max, mean and standard deviation with DuckDB.
Seeding the twelve numbers therefore achieves nothing, because nothing reads
them. `HERO_RUN_STATS` keeps the exact prototype values as the **target**, and
`lake_samples()` builds sample values whose statistics equal those targets.
`write_lake_samples()` inserts the samples, so the lake query returns the
numbers the screens show. Read the "one-line change point" note below the
`LAKE_` constants before you touch the table name or a column name.

**Preconditions.** Lane A seeds `test_runs` first. `POST /files` quarantines a
file whose run it cannot resolve, so an unseeded run leaves the hero files
unlinked. `write_inventory()` checks this and stops loudly.

**Spelling.** Contract v1.1 landed on 2026-08-17. The field is `catalogue_ref`
and the source tag is `api:catalogue`. Never write the old spelling here.

**Scope note.** These are named records only. Lane A's seed adds the filler that
carries the prototype's vanity totals (128 runs, 512 files, 6 412 signals).
"""

import csv
import hashlib
import io
import logging
import math
import os
from datetime import UTC, date, datetime, timedelta

import httpx

from api.services import lake
from api.services.file_bytes import blob_key
from api.services.file_writes import result_blob_key
from ingest.fixtures import FIXTURES, mf4_bytes, put_object
from ingest.store import build_store, stamp_workspace

logger = logging.getLogger(__name__)

# --- Identity: these ids match api/api/stub_data.py. There is one set only. ---

HERO_RUN_ID = "TAS-88214"
HERO_WORK_ORDER_ID = "WO-2026-0847"
HERO_SIGNAL_NAME = "HV_Batt_Cell_Temp_Max"

# Every route sits under this prefix (api/api/main.py).
API_PREFIX = "/api/v1"

# The prototype's "today". Every timestamp below sits on or before this day.
REFERENCE_DAY = date(2026, 8, 14)

# File keys are local handles. Mongo ids are minted by POST /files, so a record
# never pins one. The writer returns the key -> minted id map.
FILE_KEY_BAT = "bat_cyc"
FILE_KEY_INCA = "inca_cal"
FILE_KEY_CSV = "chamber_log"
FILE_KEY_QUARANTINE = "em_eff_quarantined"


def _dt(*args: int) -> datetime:
    """Build a UTC timestamp on the reference calendar."""
    return datetime(*args, tzinfo=UTC)


def _rebase(when: datetime, seed_day: date) -> datetime:
    """Move one reference timestamp onto the seed day. The clock time survives."""
    return when + timedelta(days=(seed_day - REFERENCE_DAY).days)


# --- The four named files (B-17: "4 named files") ---
#
# The hero run's three files plus the named quarantine case. These are the files
# the screens show: the File-detail screen and the /files?status=quarantined
# deep link. BE-PLAN §7 names a second quarantined file ("no run key") but gives
# it no name, so Lane A's filler carries it.
#
# `storage_ref` used to name `blob://quixlake-prod/...`. That name was false: the
# measurement files live in a SAG blob prefix, and QuixLake holds only the samples.
# The prefix is `test-manager/landing` (`api/ingest/store.py`). The ingestion
# pipeline writes the plain SAG key with no scheme.

NAMED_FILES: list[dict] = [
    {
        "key": FILE_KEY_BAT,
        "filename": "bat_cyc_20260814_0941.mf4",
        "run_id": HERO_RUN_ID,
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 1_331_439_861,
        "checksum_sha256": (
            "9f2c8a41d6e0b3f73d5a1e8c04d9b6273fa08e51c47d92e6b30f14c2ad90e1a7"
        ),
        "checksum_state": "verified",
        "quarantine_reason": None,
        "storage_ref": "blob://test-manager/landing/rig-04/2026/08/14/bat_cyc_20260814_0941.mf4",
        "ingestion_job_id": "ing-20260814-0941-77c2",
        "time_start": _dt(2026, 8, 14, 9, 41, 7),
        "time_end": _dt(2026, 8, 14, 11, 18, 52),
    },
    {
        "key": FILE_KEY_INCA,
        "filename": "inca_cal_20260814_0941.mf4",
        "run_id": HERO_RUN_ID,
        "source_system": "INCA",
        "format": "MDF 4.10",
        "size_bytes": 327_155_712,
        "checksum_sha256": (
            "41bb7e02c9d5a8134f60eb27d491c8a5023f7b6e19d0c4825a7e3f1b6d4809c3"
        ),
        "checksum_state": "verified",
        "quarantine_reason": None,
        "storage_ref": "blob://test-manager/landing/rig-04/2026/08/14/inca_cal_20260814_0941.mf4",
        "ingestion_job_id": "ing-20260814-0941-77c3",
        "time_start": _dt(2026, 8, 14, 9, 41, 10),
        "time_end": _dt(2026, 8, 14, 11, 18, 40),
    },
    {
        "key": FILE_KEY_CSV,
        "filename": "chamber_log_0941.csv",
        "run_id": HERO_RUN_ID,
        "source_system": "ifile",
        "format": "CSV",
        "size_bytes": 2_516_582,
        "checksum_sha256": (
            "b7d04e91a2c85f37d6b0e814c92a7f53e1d68b04a9c2735fe80d1b6c93a44421"
        ),
        "checksum_state": "verified",
        "quarantine_reason": None,
        "storage_ref": "blob://test-manager/landing/rig-04/2026/08/14/chamber_log_0941.csv",
        "ingestion_job_id": "ing-20260814-0941-77c4",
        "time_start": _dt(2026, 8, 14, 9, 41),
        "time_end": _dt(2026, 8, 14, 11, 19),
    },
    {
        # The quarantine case. run_id is null, so the file lists as unlinked.
        # quarantine_reason stays null on purpose: the checksum rule fires first
        # and the server writes "checksum mismatch" itself (B-01, contract order).
        "key": FILE_KEY_QUARANTINE,
        "filename": "em_eff_20260813_1726.mf4",
        "run_id": None,
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 966_367_641,
        "checksum_sha256": (
            "6c1f9a2e07d4b8535e2a91c6f03d7b48a15e60c9d2f8b7341a0ce65d98b2f7e4"
        ),
        "checksum_state": "mismatch",
        "quarantine_reason": None,
        "storage_ref": (
            "blob://test-manager/landing/quarantine/2026/08/13/em_eff_20260813_1726.mf4"
        ),
        "ingestion_job_id": "ing-20260813-1726-41d8",
        "time_start": _dt(2026, 8, 13, 17, 26),
        "time_end": _dt(2026, 8, 13, 18, 44),
    },
]


# --- The hero signal's per-run statistics (B-17: 12 rows, exact values) ---
#
# These are the exact prototype numbers, extracted and checked. They are the
# **target**, not a stored record. Nothing writes a statistic anywhere, because
# QuixLake computes every statistic from samples. `lake_samples()` turns each
# row below into sample values that produce exactly these four numbers.
#
# The signal-detail screen says "seen in 12 runs", so the demo must answer with
# 12 real rows or the deep page comes back empty on stage.
#
# Column order: run_id, reference day, first-data clock, min, max, mean, std.

HERO_RUN_STATS: list[dict] = [
    {
        "run_id": run_id,
        "run_started_at": _dt(*day, *clock),
        "stats": {
            "min": lo, "max": hi, "mean": mean, "std": std,
            # The same six keys the file rows carry (24 Aug 2026): rms is
            # the mathematically consistent value for the stated numbers.
            "rms": round((mean * mean + std * std) ** 0.5, 2),
            "sample_count": 5400,
        },
    }
    for run_id, day, clock, lo, hi, mean, std in [
        ("TAS-88214", (2026, 8, 14), (9, 41, 7), 18.2, 47.9, 33.4, 6.21),
        ("TAS-88207", (2026, 8, 13), (14, 3, 11), 19.4, 46.2, 32.8, 5.98),
        ("TAS-88198", (2026, 8, 8), (9, 12, 41), 21.0, 48.3, 34.9, 6.4),
        ("TAS-88190", (2026, 8, 1), (9, 12, 41), 24.6, 49.7, 38.2, 5.7),
        ("TAS-88183", (2026, 7, 24), (9, 12, 41), 25.1, 49.4, 37.6, 5.5),
        ("TAS-88177", (2026, 7, 17), (9, 12, 41), 23.8, 48.9, 36.4, 5.8),
        ("TAS-88168", (2026, 7, 9), (9, 12, 41), 24.2, 47.6, 36.9, 5.6),
        ("TAS-88159", (2026, 7, 1), (9, 12, 41), 15.8, 44.1, 29.6, 6.9),
        ("TAS-88150", (2026, 6, 24), (9, 12, 41), 16.3, 43.5, 30.2, 6.7),
        ("TAS-88141", (2026, 6, 17), (9, 12, 41), 22.7, 46.8, 35.1, 5.9),
        ("TAS-88123", (2026, 6, 9), (9, 12, 41), 15.2, 42.8, 28.9, 7.0),
        ("TAS-88104", (2026, 6, 2), (9, 12, 41), 16.1, 43.9, 29.8, 6.8),
    ]
]


# --- The lake sample write path (B-17) ---
#
# **THE ONE-LINE CHANGE POINT.** No code in this repository has ever reached a
# real QuixLake (`plans/STATUS.md`, risk 1). The table name and the column names
# come from prior art, not from the lake's source. If the real lake disagrees,
# change one constant below and change nothing else.
#
# The read side must agree with these names, or the query returns no row.
# `api/api/services/queries_stats.py` groups by `run_id`, filters on `signal`
# and aggregates `value`. It reads the same `TM_LAKE_TABLE` variable and the
# same default. `test_seed_lake_samples.py` pins the two sides together.

LAKE_TABLE = "test_signal_samples"
# **The fifth column is `filename`, decided 2026-08-19.** This writer called it
# `file_id` and `api/ingest/lake.py` called it `filename`, so one table grew two
# half-empty columns. The sample writer states a file name for every row it
# writes, so that name won. `test_lake_writer.py` holds the two lists equal.
LAKE_COLUMNS = ("run_id", "signal", "timestamp", "value", "filename")
LAKE_HIVE_COLUMNS = "run_id,signal"
LAKE_TIMESTAMP_COLUMN = "timestamp"
LAKE_TIMESTAMP_FORMAT = "day"

# The name the fifth cell carries for the hero run. It reads out of
# `NAMED_FILES`, so the seed can never name a file the registry does not hold.
HERO_FILENAME = next(row["filename"] for row in NAMED_FILES if row["key"] == FILE_KEY_BAT)

# The lake derives year/month/day partitions only when `hive_columns` holds a
# time part (`duck_db_service.py:2912-2918`). It does not here, so `timestamp`
# stays a plain epoch-millisecond column. The statistics query never reads it.
# The two constants above keep the documented insert shape.

# DuckDB reads `stddev(x)` as `stddev_samp`, so it divides by n - 1. Set this to
# False if the lake ever answers the population deviation instead.
LAKE_SAMPLE_STDDEV = True

# One sample per second, counted from the first data of the run.
_SAMPLE_PERIOD_MS = 1000

# The search stops here. A real target needs about fourteen samples.
_MAX_SAMPLES = 400

# A seed insert carries a few hundred rows, so it needs no long timeout.
_LAKE_TIMEOUT_SECONDS = 120.0


def lake_table() -> str:
    """Name the table the samples go into. `TM_LAKE_TABLE` wins.

    `api/api/services/queries_stats.py` resolves the read table the same way,
    so the writer and the reader can never name two different tables.
    """
    return os.environ.get("TM_LAKE_TABLE", "").strip() or LAKE_TABLE


# --- The reset may drop only a table the seed owns ---
#
# The seed owns the table it names itself, and it owns no other. `TM_LAKE_TABLE`
# points the seed at somebody else's table. The demo API deployment sets that
# variable to the project value `mf4-sink` writes (`test_signal_samples_v3`), so
# an unguarded `seed --reset` would drop the ingestion pipeline's rows.
#
# The guard is a NAME check first: an unset `TM_LAKE_TABLE` means the seed uses
# its own constant, and it created that table itself. An operator who does point
# the seed elsewhere states the table name in `TM_SEED_MAY_DROP`. A missing
# value permits nothing.
SEED_MAY_DROP_VAR = "TM_SEED_MAY_DROP"


class LakeDropRefused(RuntimeError):
    """The reset asked to drop a table the seed does not own."""


def may_drop_lake_table(table: str) -> bool:
    """Answer whether the reset may drop `table`.

    Two ways to earn the permission, and neither one is a default:

    1. Nothing sets `TM_LAKE_TABLE`, so `table` is the seed's own constant. The
       seed created that table and it is the only writer.
    2. `TM_SEED_MAY_DROP` names that exact table. The operator states the name,
       so `true`, a typo or a stale name permits nothing.
    """
    if os.environ.get(SEED_MAY_DROP_VAR, "").strip() == table:
        return True
    return not os.environ.get("TM_LAKE_TABLE", "").strip()


def samples_for_stats(stats: dict) -> list[float]:
    """Build the smallest sample set whose statistics equal `stats`.

    The set holds the minimum, the maximum and a run of middle values. The
    middle values sit in pairs at `mean + shift` plus or minus `spread`. The
    pair cancels its own deviation, so `shift` lands the mean exactly and
    `spread` then buys the wanted standard deviation.

    A small set cannot hold a far minimum and a small deviation at the same
    time, so the search adds two samples and tries again.
    """
    low = float(stats["min"])
    high = float(stats["max"])
    mean = float(stats["mean"])
    std = float(stats["std"])
    for count in range(4, _MAX_SAMPLES + 1, 2):
        pairs = count - 2
        divisor = count - 1 if LAKE_SAMPLE_STDDEV else count
        spare = std * std * divisor - (low - mean) ** 2 - (high - mean) ** 2
        shift = (2 * mean - low - high) / pairs
        square = spare / pairs - shift * shift
        if square < 0:
            continue
        spread = math.sqrt(square)
        if mean + shift - spread < low or mean + shift + spread > high:
            continue
        middle = [
            mean + shift + (spread if index % 2 == 0 else -spread)
            for index in range(pairs)
        ]
        return [low, high, *middle]
    raise ValueError(f"no sample set of {_MAX_SAMPLES} values or less matches {stats}")


def lake_samples(
    seed_day: date | None = None, file_ids: dict[str, str] | None = None
) -> list[dict]:
    """Build one lake row per sample value, for every run of the hero signal.

    Each row names its run and its signal, so the DuckDB aggregate groups by
    run and answers one row per run. The timestamp is epoch milliseconds.
    The fifth cell carries the file NAME, the same value `api/ingest/lake.py`
    writes. It held the minted file id until 2026-08-19, so the one table grew
    two half-empty columns. Only the hero run holds a file, so every other row
    carries an empty name. `file_ids` stays in the signature because
    `write_lake_samples()`'s caller passes it, and a caller that names no file
    still seeds a working lake.
    """
    file_ids = file_ids or {}
    hero_filename = HERO_FILENAME if file_ids.get(FILE_KEY_BAT) else ""
    rows: list[dict] = []
    for record in build(seed_day)["hero_run_stats"]:
        start_ms = round(record["run_started_at"].timestamp() * 1000)
        is_hero = record["run_id"] == HERO_RUN_ID
        for index, value in enumerate(samples_for_stats(record["stats"])):
            rows.append(
                {
                    "run_id": record["run_id"],
                    "signal": HERO_SIGNAL_NAME,
                    "timestamp": start_ms + index * _SAMPLE_PERIOD_MS,
                    "value": value,
                    "filename": hero_filename if is_hero else "",
                }
            )
    return rows


def _csv_value(value) -> str:
    """Render one cell. A float keeps every digit, so no statistic drifts."""
    return repr(value) if isinstance(value, float) else str(value)


def build_lake_csv(rows: list[dict]) -> str:
    """Build the CSV body `POST /insert` takes. The first row is the header."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(LAKE_COLUMNS)
    for row in rows:
        writer.writerow([_csv_value(row[column]) for column in LAKE_COLUMNS])
    return buffer.getvalue()


def lake_http() -> httpx.Client:
    """Build the HTTP client the insert needs, with the bearer token.

    The token chain comes from `api.services.lake`, so the writer and the
    reader can never name different variables. `API_AUTH_TOKEN` is absent on
    purpose: it carries no user identity, so the lake answers 200 with zero
    rows and the seed reports a success that wrote nothing readable.
    """
    token = lake._first_env(lake._TOKEN_VARS)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return httpx.Client(headers=headers, timeout=_LAKE_TIMEOUT_SECONDS)


def write_lake_samples(http, rows: list[dict], base_url: str | None = None) -> int:
    """Insert every sample row into QuixLake. Return the row count.

    `http` is anything with a `.post(url, params=, content=, headers=)` method,
    so a test passes a fake and opens no socket. The insert runs synchronously:
    a few hundred rows need no task poll.
    """
    if not rows:
        return 0
    url = (base_url or lake.query_url()).rstrip("/")
    if not url:
        raise RuntimeError("Quix__Lakehouse__Query__Url is not set, so no sample reaches the lake")
    response = http.post(
        f"{url}/insert",
        params={
            "table": lake_table(),
            "hive_columns": LAKE_HIVE_COLUMNS,
            "timestamp_column": LAKE_TIMESTAMP_COLUMN,
            "timestamp_format": LAKE_TIMESTAMP_FORMAT,
        },
        content=build_lake_csv(rows).encode("utf-8"),
        # The lake reads the raw body, and its own integration test sends
        # text/plain (quix-ts-datalake-api\test\test_integration.py:169).
        headers={"Content-Type": "text/plain"},
    )
    if response.status_code >= 400:
        raise RuntimeError(
            f"QuixLake refused the samples: {response.status_code} {response.text}"
        )
    return len(rows)


def drop_lake_table(http, base_url: str | None = None) -> str:
    """Drop the sample table. Return the table name.

    `POST /insert` appends. A second seed would therefore double every sample
    row, and the statistics would drift away from the prototype numbers. Only
    `--reset` calls this. A demo points at a real platform lake, so a drop the
    caller did not ask for would delete real data.

    A first seed finds no table, and that is not a failure. **Measured against a
    real lake on 18 Aug 2026: the drop of an absent table answers 500, with
    "not found" in the body.** A 404 counts as the same case. Every other
    failure still raises, so a real refusal stays loud.

    The drop needs permission. `may_drop_lake_table` states the rule, and this
    function raises `LakeDropRefused` without a permission. The refusal reaches
    no lake, so a table the seed does not own keeps every row.
    """
    url = (base_url or lake.query_url()).rstrip("/")
    if not url:
        raise RuntimeError("Quix__Lakehouse__Query__Url is not set, so no table can drop")
    table = lake_table()
    if not may_drop_lake_table(table):
        raise LakeDropRefused(
            f"the seed refuses to drop lake table {table}: TM_LAKE_TABLE points the seed "
            f"at a table it does not own, and only {SEED_MAY_DROP_VAR}={table} permits "
            "the drop"
        )
    response = http.delete(f"{url}/delete", params={"table": table, "mode": "drop"})
    absent = response.status_code >= 400 and "not found" in response.text.lower()
    if response.status_code == 404 or absent:
        logger.info("QuixLake holds no table %s, so the reset drops nothing", table)
        return table
    if response.status_code >= 400:
        raise RuntimeError(
            f"QuixLake refused the drop: {response.status_code} {response.text}"
        )
    return table


ALL_FILES: list[dict] = NAMED_FILES


# --- Per-file signal inventories ---
#
# One row per (file, signal). This is the inventory `POST /files` accepts, so
# it is registry data and it stays in Mongo. The `stats` block rides the same
# body. **Corrected 2026-08-18 by the B-12 check.** This comment used to say
# "the default provider never reads it: QuixLake answers every statistic".
# That was false. `GET /files/{file_id}` serves this block from the registry,
# because QuixLake answers #7 and #16 alone. The File-detail screen therefore
# always shows these numbers, and its "computed lakeside" caption is false.
# `api/tests/test_demo_wording.py` pins the behavior. The hero file's
# HV_Batt_Cell_Temp_Max row carries the prototype's headline numbers
# 18.2 / 47.9 / 33.4 / 6.21, so the file screen and the lake agree on that run.
#
# **`unit_source` below never reaches the wire. Added 2026-08-18 by the B-11
# front-end run.** `_file_request_body` sends `name`, `unit`, `rate_hz`, `dtype`
# and `stats` only, and `POST /files` takes no per-signal source tag. The route
# writes `embedded` on every `file_signals` row, which is the true answer: the
# unit came from that file's header. So Coolant_Inlet_Temp reads `manual` here
# and the File-detail screen badges it `embedded`. Read the value below as a
# note about the catalogue, never as the tag the screen shows. The catalogue row
# carries the real `manual` tag, and `upsert_catalogue_raw` writes it.
# `test_fe_run_lane_b.py::test_the_two_screens_badge_one_unit_source_differently_on_purpose`
# pins both sides.


def _row(
    file_key: str,
    run_id: str | None,
    name: str,
    unit: str | None,
    unit_source: str,
    rate_hz: float,
    dtype: str,
    stats: dict,
) -> dict:
    return {
        "file_key": file_key,
        "run_id": run_id,
        "name": name,
        "unit": unit,
        "unit_source": unit_source,
        "rate_hz": rate_hz,
        "dtype": dtype,
        "stats": stats,
    }


NAMED_FILE_SIGNALS: list[dict] = [
    _row(FILE_KEY_BAT, HERO_RUN_ID, HERO_SIGNAL_NAME, "°C", "embedded", 100, "float64",
         {"min": 18.2, "max": 47.9, "mean": 33.4, "std": 6.21, "rms": 33.97, "sample_count": 5400}),
    _row(FILE_KEY_BAT, HERO_RUN_ID, "HV_Batt_Cell_Temp_Min", "°C", "embedded", 100, "float64",
         {"min": 17.4, "max": 38.6, "mean": 28.9, "std": 5.02, "rms": 29.33, "sample_count": 5400}),
    _row(FILE_KEY_BAT, HERO_RUN_ID, "HV_Batt_Pack_Voltage", "V", "embedded", 100, "float64",
         {"min": 312.4, "max": 398.7, "mean": 361.2, "std": 18.4, "rms": 361.67, "sample_count": 5400}),
    _row(FILE_KEY_BAT, HERO_RUN_ID, "HV_Batt_Pack_Current", "A", "embedded", 100, "float64",
         {"min": -214.0, "max": 187.5, "mean": -3.8, "std": 64.02, "rms": 64.13, "sample_count": 5400}),
    _row(FILE_KEY_BAT, HERO_RUN_ID, "Coolant_Inlet_Temp", "°C", "manual", 10, "float64",
         {"min": 15.1, "max": 28.6, "mean": 21.9, "std": 3.12, "rms": 22.12, "sample_count": 5400}),
    _row(FILE_KEY_BAT, HERO_RUN_ID, "Coolant_Outlet_Temp", "°C", "embedded", 10, "float64",
         {"min": 16.8, "max": 33.1, "mean": 25.4, "std": 3.9, "rms": 25.7, "sample_count": 5400}),
    _row(FILE_KEY_BAT, HERO_RUN_ID, "Coolant_Flow_Rate", "l/min", "embedded", 10, "float64",
         {"min": 4.1, "max": 12.0, "mean": 8.7, "std": 1.84, "rms": 8.89, "sample_count": 5400}),
    _row(FILE_KEY_BAT, HERO_RUN_ID, "Chamber_Ambient_Temp", "°C", "embedded", 1, "float64",
         {"min": -19.8, "max": 40.2, "mean": 11.6, "std": 17.3, "rms": 20.83, "sample_count": 5400}),
    _row(FILE_KEY_INCA, HERO_RUN_ID, "HV_Batt_SOC", "%", "embedded", 10, "float64",
         {"min": 21.5, "max": 96.0, "mean": 62.3, "std": 22.1, "rms": 66.1, "sample_count": 5400}),
    _row(FILE_KEY_INCA, HERO_RUN_ID, "Cycle_Counter", "count", "embedded", 1, "int32",
         {"min": 1, "max": 22, "mean": 11.5, "std": 6.35, "rms": 13.14, "sample_count": 5400}),
    _row(FILE_KEY_CSV, HERO_RUN_ID, "Chamber_Ambient_Temp", "°C", "embedded", 1, "float64",
         {"min": -19.8, "max": 40.2, "mean": 11.6, "std": 17.3, "rms": 20.83, "sample_count": 5400}),
    # unit is null: this row feeds the missing-unit chip filter.
    _row(FILE_KEY_CSV, HERO_RUN_ID, "Chamber_Humidity", None, "embedded", 1, "float64",
         {"min": 12.1, "max": 78.4, "mean": 45.2, "std": 14.6, "rms": 47.5, "sample_count": 5400}),
]

ALL_FILE_SIGNALS: list[dict] = NAMED_FILE_SIGNALS


def _inventory_run_count(name: str) -> int:
    """The signal's `run_count`, derived from this seed's own inventory.

    Mirrors `queries_signals.upsert_file_signals`, the ingestion rule: a
    signal's run_count is the number of distinct non-null `run_id`s among its
    `file_signals` rows — here, the rows this module itself writes through
    `POST /files`. Only the hero run carries an inventory, so every
    inventoried signal answers 1 and the three signals no seeded file carries
    answer 0. The concept screens print larger figures (12, 8, 21…), but
    those describe runs whose inventories the seed never writes; the stored
    number states what the database can back (2026-08-18 meta-review §2).
    The hero signal's twelve-run history still lives in the LAKE samples —
    per-run statistics, not registry inventory.
    """
    return len(
        {row["run_id"] for row in NAMED_FILE_SIGNALS if row["name"] == name and row["run_id"]}
    )


# --- The catalogue: 14 named signals ---
#
# `unit_source` and `field_sources.unit` say the same thing. Precedence is
# manual > api:* > embedded. Two rows carry `unit: null` on purpose.
# `run_count` is never stated: `_signal` derives it from the file_signals
# rows above, so the catalogue can never contradict the seeded inventory.


def _src(source: str, actor: str, at: datetime) -> dict:
    return {"source": source, "actor": actor, "at": at}


def _signal(
    name: str,
    description: str,
    unit: str | None,
    unit_source: str,
    dtype: str,
    typical_rate_hz: float,
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
        "typical_rate_hz": typical_rate_hz,
        "run_count": _inventory_run_count(name),
        "first_seen": first_seen,
        "last_seen": last_seen,
        "sensor_ref": sensor_ref,
        "catalogue_ref": catalogue_ref,
        "rig_ids": rig_ids,
        "field_sources": field_sources if field_sources is not None else {},
    }


_EMBEDDED_JUN_2 = {"unit": _src("embedded", "ingestion", _dt(2026, 6, 2, 8, 14, 20))}

CATALOGUE_SIGNALS: list[dict] = [
    _signal(
        HERO_SIGNAL_NAME,
        "Hottest cell temperature across pack",
        "°C",
        "embedded",
        "float64",
        100,
        _dt(2026, 6, 2),
        _dt(2026, 8, 14, 9, 41, 33),
        ["RIG-04", "RIG-07"],
        sensor_ref="PT100-B4-07",
        catalogue_ref="TEMP-CELL-MAX",
        field_sources={
            "unit": _src("embedded", "ingestion", _dt(2026, 6, 2, 8, 14, 20)),
            # A person typed this reference. Precedence protects it.
            "sensor_ref": _src("manual", "a.bergstrom", _dt(2026, 6, 3, 10, 2)),
            "catalogue_ref": _src("api:catalogue", "catalog-sync", _dt(2026, 6, 2, 9, 0)),
        },
    ),
    _signal(
        "HV_Batt_Cell_Temp_Min",
        "Coldest cell temperature across pack",
        "°C",
        "embedded",
        "float64",
        100,
        _dt(2026, 6, 2),
        _dt(2026, 8, 14, 9, 41, 33),
        ["RIG-04"],
        catalogue_ref="TEMP-CELL-MIN",
        field_sources=dict(_EMBEDDED_JUN_2),
    ),
    _signal(
        "HV_Batt_Pack_Voltage",
        "Pack terminal voltage",
        "V",
        "embedded",
        "float64",
        100,
        _dt(2026, 6, 2),
        _dt(2026, 8, 14, 9, 41, 33),
        ["RIG-04"],
        field_sources=dict(_EMBEDDED_JUN_2),
    ),
    _signal(
        "HV_Batt_Pack_Current",
        "Pack current, discharge negative",
        "A",
        "embedded",
        "float64",
        100,
        _dt(2026, 6, 2),
        _dt(2026, 8, 14, 9, 41, 33),
        ["RIG-04"],
        field_sources=dict(_EMBEDDED_JUN_2),
    ),
    _signal(
        "HV_Batt_SOC",
        "State of charge, BMS estimate",
        "%",
        "embedded",
        "float64",
        10,
        _dt(2026, 6, 2),
        _dt(2026, 8, 14, 9, 41, 33),
        ["RIG-04"],
        field_sources=dict(_EMBEDDED_JUN_2),
    ),
    _signal(
        "Coolant_Inlet_Temp",
        "Coolant temperature at pack inlet",
        "°C",
        "manual",
        "float64",
        10,
        _dt(2026, 6, 18),
        _dt(2026, 8, 14, 9, 41, 33),
        ["RIG-04"],
        field_sources={"unit": _src("manual", "a.bergstrom", _dt(2026, 8, 14, 10, 12))},
    ),
    _signal(
        "Coolant_Outlet_Temp",
        "Coolant temperature at pack outlet",
        "°C",
        "embedded",
        "float64",
        10,
        _dt(2026, 6, 18),
        _dt(2026, 8, 14, 9, 41, 33),
        ["RIG-04"],
        field_sources={"unit": _src("embedded", "ingestion", _dt(2026, 6, 18, 9, 30))},
    ),
    _signal(
        "Coolant_Flow_Rate",
        "Volumetric flow, conditioning loop",
        "l/min",
        "embedded",
        "float64",
        10,
        _dt(2026, 6, 18),
        _dt(2026, 8, 14, 9, 41, 33),
        ["RIG-04"],
        field_sources={"unit": _src("embedded", "ingestion", _dt(2026, 6, 18, 9, 30))},
    ),
    _signal(
        "Chamber_Ambient_Temp",
        "Climate chamber air temperature",
        "°C",
        "embedded",
        "float64",
        1,
        _dt(2026, 6, 2),
        _dt(2026, 8, 14, 9, 42, 18),
        ["RIG-04", "RIG-07"],
        field_sources=dict(_EMBEDDED_JUN_2),
    ),
    # unit is null. The missing-unit chip filter selects this row.
    _signal(
        "Chamber_Humidity",
        "Climate chamber relative humidity",
        None,
        "embedded",
        "float64",
        1,
        _dt(2026, 6, 2),
        _dt(2026, 8, 14, 9, 42, 18),
        ["RIG-04", "RIG-07"],
    ),
    _signal(
        "EM_Rotor_Temp",
        "E-machine rotor temperature, estimated",
        "°C",
        "embedded",
        "float64",
        100,
        _dt(2026, 6, 5),
        _dt(2026, 8, 14, 8, 12, 30),
        ["RIG-02"],
        field_sources={"unit": _src("embedded", "ingestion", _dt(2026, 6, 5, 7, 50))},
    ),
    # unit is null. The missing-unit chip filter selects this row too.
    _signal(
        "EM_Shaft_Torque",
        "Dyno shaft torque, HBM flange",
        None,
        "embedded",
        "float64",
        100,
        _dt(2026, 6, 5),
        _dt(2026, 8, 14, 8, 12, 30),
        ["RIG-02"],
    ),
    _signal(
        "INV_DC_Bus_Voltage",
        "Inverter DC-link voltage",
        "V",
        "embedded",
        "float64",
        100,
        _dt(2026, 6, 11),
        _dt(2026, 8, 13, 17, 26, 41),
        ["RIG-07"],
        field_sources={"unit": _src("embedded", "ingestion", _dt(2026, 6, 11, 13, 20))},
    ),
    _signal(
        "Cycle_Counter",
        "Test sequence cycle index",
        "count",
        "embedded",
        "int32",
        1,
        _dt(2026, 6, 2),
        _dt(2026, 8, 14, 9, 42, 5),
        ["RIG-02", "RIG-04", "RIG-07"],
        field_sources=dict(_EMBEDDED_JUN_2),
    ),
]


# --- The one processed result ---
#
# thermal_summary version 1, provenance verified. `input_file_keys` names files
# by key; the writer swaps in the ids that POST /files minted.
#
# The record states no `storage_ref`. `_stamp_results` builds it at seed time
# with `result_blob_key`, the helper `POST /results/upload` uses, so the seeded
# reference names the key a real upload would write.

NAMED_RESULTS: list[dict] = [
    {
        "run_id": HERO_RUN_ID,
        "name": "thermal_summary_v1.parquet",
        "result_key": "thermal_summary",
        "version": 1,
        "supersedes": None,
        "description": "Cycle-level aggregates",
        "provenance": {
            "tool": "bat-post",
            "tool_version": "2.3.1",
            "parameters": "--cycles all --dt 0.1",
            "input_file_keys": [FILE_KEY_BAT, FILE_KEY_CSV],
            "produced_by": "e.lindqvist",
            "produced_at": _dt(2026, 8, 14, 12, 2),
        },
        "provenance_status": "verified",
        "created_at": _dt(2026, 8, 14, 12, 2, 31),
    }
]


# --- Build: rebase the dates, keep the values ---

_FILE_DATE_FIELDS = ("time_start", "time_end")


def _rebase_tree(value, seed_day: date):
    """Shift every datetime inside a record. Every other value survives."""
    if isinstance(value, datetime):
        return _rebase(value, seed_day)
    if isinstance(value, dict):
        return {key: _rebase_tree(item, seed_day) for key, item in value.items()}
    if isinstance(value, list):
        return [_rebase_tree(item, seed_day) for item in value]
    return value


def _stamp_files(records: list[dict]) -> list[dict]:
    """Move every file reference under the workspace folder.

    The literals above state the bare landing key, because that is the shape a
    reader checks. This stamp reads `Quix__Workspace__Id` at seed time, so the
    seeded reference names the key the ingestion pipeline would really write
    (`ingest.store.stamp_workspace`). `ingest.blob_seed` then writes the bytes
    at that same key, so the reference and the bytes always agree.
    """
    stamped = []
    for record in records:
        row = dict(record)
        row["storage_ref"] = stamp_workspace(row["storage_ref"])
        stamped.append(row)
    return stamped


def _stamp_results(records: list[dict]) -> list[dict]:
    """Give every result the reference `POST /results/upload` would write.

    `result_blob_key` builds the key, so the seed states one key format and the
    upload route states the same one. The key leads with the workspace folder,
    exactly as the landing prefix does, and a uuid keeps two uploads of one
    filename apart. The `blob://` scheme in front matches what the route stores
    (`api/api/routers/results.py`).

    No bytes lie behind this key. The contract gives a result no download
    route, and `ingest.blob_seed` writes bytes for registered files only. A
    correct reference to an empty key beats a reference to a folder that never
    exists.
    """
    stamped = []
    for record in records:
        row = dict(record)
        row["storage_ref"] = f"blob://{result_blob_key(row['run_id'], row['name'])}"
        stamped.append(row)
    return stamped


# --- The bytes behind the named files (findings 20 and 21, 21 Aug 2026) ---
#
# The seed wrote file DOCUMENTS and no object, so the hero file said 1.24 GB
# and `ingest.blob_seed` later put a 40 kB fixture at the same key. Two numbers
# for one file, on a screen about traceability.
#
# Only the writer of the bytes can state their size and their digest. asammdf
# stamps a few bytes that change on every save, and `ingest.fixtures.START_TIME`
# is read at import, so two processes never mint the same image. So the seed
# mints, writes and registers in one pass.


def _files_with_bytes(records: list[dict]) -> list[dict]:
    """Every named file the byte seed fills: the ones the registry accepts.

    `ingest.blob_seed` fills a registered file only, so a file that will
    quarantine gets no object and keeps the literals above.
    """
    return [
        record
        for record in records
        if record["run_id"] and record["checksum_state"] != "mismatch"
    ]


def write_file_bytes(records: list[dict]) -> dict[str, bytes]:
    """Put one real MF4 behind each named file. Return the key -> bytes map.

    **One fixture per file.** Two files that share a byte image share a digest,
    and `POST /files` replays a registered digest, so the second file would
    never be minted. `ingest.fixtures.FIXTURES` holds three images and the seed
    names three registered files. A fifth named file needs a fourth fixture, or
    it keeps its literal size and this map leaves it out.

    **It never overwrites.** A key the store already holds answers with its own
    bytes, so a real ingested file survives a re-seed and the registry then
    states the digest of the bytes that are really there. A refused read raises
    out of `read_bytes`, and this function reports the failure and returns what
    it has.

    A store this environment cannot build is not an error. The registry half of
    the demo works without bytes, exactly as it works without a lake, so the
    seed reports the reason and finishes.
    """
    payloads: dict[str, bytes] = {}
    try:
        store, _prefix = build_store()
    except Exception as error:  # noqa: BLE001 — no store must not stop the seed.
        logger.warning(
            "the seed reached no blob store, so it writes no file bytes and the "
            "download answers 503: %s",
            error,
        )
        return payloads

    for record, fixture in zip(_files_with_bytes(records), FIXTURES, strict=False):
        key = blob_key(record["storage_ref"])
        try:
            stored = store.read_bytes(key)
            if stored is None:
                stored = mf4_bytes(fixture)
                put_object(store, key, stored)
                logger.info("wrote %s (%d bytes)", key, len(stored))
        except Exception as error:  # noqa: BLE001 — one bad key must not stop it.
            logger.warning("the seed stored no bytes at %s: %s", key, error)
            continue
        payloads[record["key"]] = stored
    return payloads


def stamp_real_bytes(records: list[dict], payloads: dict[str, bytes]) -> list[dict]:
    """State the size and the digest of the bytes the store really holds.

    A record the seed stored no bytes for keeps its literal numbers. Nothing
    then serves those bytes either, so no screen can contradict the other.
    """
    stamped = []
    for record in records:
        row = dict(record)
        payload = payloads.get(row["key"])
        if payload is not None:
            row["size_bytes"] = len(payload)
            row["checksum_sha256"] = hashlib.sha256(payload).hexdigest()
        stamped.append(row)
    return stamped


def build(seed_day: date | None = None) -> dict:
    """Return every record with its dates moved onto the seed day.

    The statistic values never change. Only the timestamps move, and every
    file reference and result reference gains the workspace folder.
    """
    seed_day = seed_day or datetime.now(UTC).date()
    return {
        "files": _stamp_files(_rebase_tree(ALL_FILES, seed_day)),
        "file_signals": _rebase_tree(ALL_FILE_SIGNALS, seed_day),
        "signals": _rebase_tree(CATALOGUE_SIGNALS, seed_day),
        "results": _stamp_results(_rebase_tree(NAMED_RESULTS, seed_day)),
        "hero_run_stats": _rebase_tree(HERO_RUN_STATS, seed_day),
    }


# --- Write path ---


def _file_request_body(record: dict, inventory: list[dict]) -> dict:
    """Turn one file record into a POST /files body."""
    signals = [
        {
            "name": row["name"],
            "unit": row["unit"],
            "rate_hz": row["rate_hz"],
            "dtype": row["dtype"],
            "stats": row["stats"],
        }
        for row in inventory
        if row["file_key"] == record["key"]
    ]
    body = {
        key: value for key, value in record.items() if key not in ("key",)
    }
    body["time_start"] = record["time_start"].isoformat()
    body["time_end"] = record["time_end"].isoformat()
    body["signals"] = signals
    return body


def register_files(client, records: list[dict], inventory: list[dict]) -> dict[str, str]:
    """Register every file through POST /files. Return the key -> file id map.

    `client` is anything with a `.post(path, json=...)` method: httpx.Client or
    fastapi.testclient.TestClient. This is the public path day-one decision 7
    demands. No raw insert happens here.
    """
    minted: dict[str, str] = {}
    for record in records:
        response = client.post(
            f"{API_PREFIX}/files", json=_file_request_body(record, inventory)
        )
        if response.status_code not in (200, 201):
            raise RuntimeError(
                f"POST /files rejected {record['filename']}: "
                f"{response.status_code} {response.text}"
            )
        minted[record["key"]] = response.json()["file_id"]
    return minted


def write_results(client, results: list[dict], file_ids: dict[str, str]) -> int:
    """Store every processed result through POST /results. Return the count.

    The route mints the id and the version, and it applies the provenance gate.
    The seed never inserts a result by hand.
    """
    for result in results:
        provenance = dict(result["provenance"])
        provenance["input_file_ids"] = [
            file_ids[key] for key in provenance.pop("input_file_keys")
        ]
        provenance["produced_at"] = provenance["produced_at"].isoformat()
        body = {
            "run_id": result["run_id"],
            "name": result["name"],
            "result_key": result["result_key"],
            "description": result["description"],
            "storage_ref": result["storage_ref"],
            "provenance": provenance,
        }
        response = client.post(f"{API_PREFIX}/results", json=body)
        if response.status_code not in (200, 201):
            raise RuntimeError(
                f"POST /results rejected {result['name']}: "
                f"{response.status_code} {response.text}"
            )
    return len(results)


def upsert_catalogue_raw(db, signals: list[dict]) -> int:
    """Stamp the curated catalogue fields. Return the row count.

    `POST /files` already created every row from the file headers. This write
    adds what no header carries: the description, the manual `sensor_ref`, the
    `api:catalogue` reference, the first-seen date and the rig list. The
    contract gives `catalogue_ref` no write route, so the seed states it.

    Run this **after** `write_files`, or the embedded defaults win.
    """
    now = datetime.now(UTC)
    for signal in signals:
        doc = dict(signal)
        doc["_id"] = doc.pop("name")
        doc["created_at"] = doc["first_seen"]
        doc["updated_at"] = now
        db["signals"].replace_one({"_id": doc["_id"]}, doc, upsert=True)
    return len(signals)


def write_inventory(
    db, client, seed_day: date | None = None, reset: bool = False
) -> dict:
    """Write the whole Lane B cast. Return a count per collection.

    Order matters:
    1. `write_file_bytes` puts one real MF4 behind each named file, and the
       registration then states the size and the digest of those exact bytes.
    2. `POST /files` registers each file, its inventory rows and its catalogue
       rows.
    3. `upsert_catalogue_raw` stamps the curated catalogue fields on top.
    4. `POST /results` stores the processed result.
    5. `POST /insert` writes the hero signal's samples into QuixLake.

    `reset` drops the lake table before step 4. The caller passes the same flag
    that drops the Mongo collections, so one `--reset` resets both halves.
    The lake half needs permission. `TM_LAKE_TABLE` points the seed at a table
    another writer owns, and the seed then skips step 5 whole: no drop, no
    insert. `TM_SEED_MAY_DROP` names the table to permit it. The Mongo half runs
    either way, so the reset still rebuilds the cast.

    A dead lake does not stop step 4. It reports `lake_samples: 0` and the seed
    finishes, so the watermark lands — see `_seed_lake_or_report`.

    Lane A seeds `test_runs` first. The check below stops a silent run of
    quarantined history rows.
    """
    records = build(seed_day)
    missing = _missing_runs(db, records["files"])
    if missing:
        raise RuntimeError(
            "Lane A must seed these runs before the inventory writes: "
            + ", ".join(sorted(missing))
        )

    payloads = write_file_bytes(records["files"])
    records["files"] = stamp_real_bytes(records["files"], payloads)

    file_ids = register_files(client, records["files"], records["file_signals"])
    return {
        "file_bytes": len(payloads),
        "files": len(file_ids),
        "file_signals": len(records["file_signals"]),
        "signals": upsert_catalogue_raw(db, records["signals"]),
        "processed_results": write_results(client, records["results"], file_ids),
        "lake_samples": _seed_lake_or_report(seed_day, file_ids, reset),
    }


def _seed_lake_or_report(
    seed_day: date | None, file_ids: dict[str, str], reset: bool
) -> int:
    """Write the lake samples. Report a lake failure and let the seed finish.

    A configured lake that does not answer used to stop the whole seed here.
    The lake is the last step, so Mongo already held every row, and the caller
    then wrote no filler and no watermark. A person who re-ran the seed could
    not tell what had landed.

    The registry half of the demo works without a lake, and `seed_lake` already
    says so for an unconfigured lake. A dead lake is the same case for the seed,
    so it takes the same road: write no sample, report zero, finish.

    The printed report is the record of how far the seed reached. A
    `lake_samples 0` line, under the error above it, names the missing half.
    `GET /signals/{name}/stats` then answers no run.

    `seed_lake` itself still raises. Its own guards stand: a refused drop stops
    the insert, so no seed run can double the lake rows, and a drop the seed may
    not make stops the insert as well.
    """
    try:
        return seed_lake(seed_day, file_ids, reset)
    except LakeDropRefused as refusal:
        logger.error("%s. The seed skips the lake step and finishes.", refusal)
        return 0
    except (RuntimeError, httpx.HTTPError) as error:
        logger.error(
            "the QuixLake seed failed, so the seed writes no sample and "
            "GET /signals/%s/stats answers no run: %s",
            HERO_SIGNAL_NAME,
            error,
        )
        return 0


def seed_lake(
    seed_day: date | None = None,
    file_ids: dict[str, str] | None = None,
    reset: bool = False,
) -> int:
    """Write the hero signal's samples into QuixLake. Return the row count.

    `reset` drops the table first, so a second seed does not double the rows.
    The drop needs permission: a table the seed does not own stops the whole
    lake step, so the seed inserts no row into somebody else's table.

    An unconfigured lake writes nothing and says so. The seed must still finish,
    because the registry half of the demo works without a lake. The statistics
    screens do not: `GET /signals/{name}/stats` answers from the lake.
    """
    if not lake.is_configured():
        logger.warning(
            "no QuixLake is configured, so the seed writes no sample and "
            "GET /signals/%s/stats answers no run",
            HERO_SIGNAL_NAME,
        )
        return 0
    with lake_http() as http:
        if reset:
            drop_lake_table(http)
        return write_lake_samples(http, lake_samples(seed_day, file_ids))


def _missing_runs(db, files: list[dict]) -> set[str]:
    """Name every run a file points at that the database does not hold."""
    wanted = {record["run_id"] for record in files if record["run_id"]}
    known = {doc["_id"] for doc in db["test_runs"].find({"_id": {"$in": list(wanted)}}, {"_id": 1})}
    return wanted - known
