"""The QuixLake sample writer (BE-PLAN §5.2, new 2026-08-17).

QuixLake stores the signal samples. MongoDB holds the registry only. A
statistics question queries the lake, so this module never computes min, max,
mean or standard deviation.

**The caller, since 19 Aug 2026.** The file watcher owned this client, and the
watcher moved to the ingestion pipeline (`plans/design/INGEST-SPLIT.md`). The
Test Manager keeps the client for one door: `POST /test-runs/{run_id}/signals`
reaches it by deferred import (`api/api/routers/test_runs.py`). That caller
sends samples it received over the API, so the Test Manager still opens no
measurement file.

**Why the CSV insert and not Parquet.** The lake takes two write paths.

1. `POST /insert` with a CSV body. The server parses the CSV, derives the
   partitions and writes the Parquet itself.
2. Write Parquet to blob storage, then `POST /tables/{table}/refresh`.

Path 1 wins. It needs one HTTP call and no new dependency. Path 2 needs
`pyarrow` to write Parquet, needs the writer to know the bucket layout, and
needs a second call to make the rows visible. The lead ruled out pandas, and
path 1 is the only one that holds without it.

**This client never calls `POST /create-table`.** `POST /insert` creates the
table when the catalogue does not hold it
(`Quix.DataLake.Timeseries/quix-ts-datalake-api/duck_db_service.py:2893-2901`
and `:2925`). It answers 409 only when the table exists with other partition
columns (`duck_db_service.py:1882-1887`, `main.py:1538-1549`). The reader sends
`union_by_name=true` (`api/api/services/lake.py`), so an extra column is safe.

**Why the synchronous insert.** `async=true` answers a task id, and the
caller then polls `/tasks/{id}`. That is a second loop for no gain here: the
caller already sends one file at a time and a demo file is small. The client
raises the HTTP timeout instead.
"""

from __future__ import annotations

import csv
import io
import logging
import math
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

import httpx

log = logging.getLogger("ingest.lake")


@dataclass(frozen=True)
class ChannelSamples:
    """The numeric samples of one channel, for the QuixLake write.

    `offsets_s` are seconds from the start of the recording. The client turns
    them into absolute timestamps.

    The shape lived in the parser before 19 Aug 2026, because the parser built
    it. The parser moved to the ingestion pipeline, so the shape lives beside
    the one writer that still takes it.
    """

    name: str
    offsets_s: list[float]
    values: list[float]


# The table this product owns, and its layout.
#
# **Corrected 2026-08-17, on the backend lead's decision.** The first build wrote
# `mdf_file_test` with `file_name,channel`. That table is QuixLab's, and its
# layout carries no `run_id`. The query side groups the statistics by `run_id`
# (`api/api/services/queries_stats.py`), so no query could ever read what the
# writer wrote. The query side is right and the writer changed.
#
# The reader names the same table and the same columns. `TM_LAKE_TABLE` overrides
# the name on both sides. `test_lake_schema_matches_the_query_side` pins them.
DEFAULT_TABLE = "test_signal_samples"
HIVE_COLUMNS = "run_id,signal"
TIMESTAMP_COLUMN = "timestamp"
TIMESTAMP_FORMAT = "day"

# The fifth column traces a sample back to the file that produced it.
#
# **One name, decided 2026-08-19.** The two writers named it twice: this module
# wrote `filename` and `api/seed/fixtures_inventory.py` wrote `file_id`. Two
# names build two half-empty columns in one table. The name is `filename`,
# because this writer states it for every row of every file. The seed now uses
# the same name (`LAKE_COLUMNS`), and
# `test_the_two_writers_name_the_same_columns` holds the two lists equal.
#
# An earlier note here said the file id costs a flow change, because the writer
# ran before `POST /files` minted the id. The lake call takes the file name
# only, so `filename` is the honest cell today.
COLUMNS = ("run_id", "signal", "timestamp", "value", "filename")


def table_name() -> str:
    """Name the lake table. `TM_LAKE_TABLE` overrides it, the same way the reader does."""
    return os.environ.get("TM_LAKE_TABLE", "").strip() or DEFAULT_TABLE

# A lake write moves every sample of the file, so it takes longer than an API call.
TIMEOUT_SECONDS = 300.0

# The URL names the platform injects. The reader reads the same two, in the same
# order (`api/api/services/lake.py`). Keep the two lists equal.
URL_VARS = ("Quix__Lakehouse__Query__Url", "QUIX_LAKE_URL")


class LakeClient(Protocol):
    """What a sample writer needs from the lake."""

    def write_samples(
        self,
        *,
        filename: str,
        run_id: str | None,
        time_start: datetime | None,
        samples: list[ChannelSamples],
    ) -> int:
        """Write every sample. Return the number of rows written."""
        ...


def build_csv(
    filename: str, run_id: str, time_start: datetime, samples: list[ChannelSamples]
) -> str:
    """Build the CSV body the lake insert takes.

    The first row is the header. The server resolves every column by name, so
    the column order does not matter — only the `hive_columns` order does.

    The timestamp is epoch milliseconds, and it stays a plain integer.

    **Corrected 2026-08-18, measured against a running QuixLake.** This comment
    said the lake reads a value above 1e12 as milliseconds and turns the column
    into a real datetime. It does not. The lake derives a time partition only
    when `hive_columns` holds a time part (`duck_db_service.py:2912-2918`), and
    ours holds `run_id,signal`. `GET /schema` reports the column as `long`. The
    statistics query never reads it, so nothing breaks.

    **The value contract, new 2026-08-19.** The cell carries
    `repr(float(value))`. The `float()` call is the fix. `repr` of a Python
    float writes the shortest text that reads back as the same double, so the
    cell stays exact and stays readable. `repr` of a numpy scalar writes the
    type name into the cell instead (`np.float64(18.2)` on numpy 2). The
    writer sent `repr(value)` before, so a numpy repr, a `nan` or an `inf`
    reached the lake as text.

    A value that is not finite writes no row. The DuckDB aggregate then answers
    a number JSON cannot carry, and the API turns that into a 503. Real CAN data
    holds such values, so the writer drops the sample and keeps the file. It
    never drops one in silence: it counts the drops and logs one line per file.
    """
    start_ms = time_start.timestamp() * 1000.0
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(COLUMNS)
    skipped = 0
    for block in samples:
        for offset, value in zip(block.offsets_s, block.values, strict=True):
            number = float(value)
            if not math.isfinite(number):
                skipped += 1
                continue
            writer.writerow(
                [run_id, block.name, round(start_ms + offset * 1000.0), repr(number), filename]
            )
    if skipped:
        log.warning(
            "%s holds %d values that are not finite, so those samples stay out of the lake",
            filename,
            skipped,
        )
    return buffer.getvalue()


def row_count(samples: list[ChannelSamples]) -> int:
    """Count the sample rows the CSV body holds.

    A value that is not finite writes no row, so it counts none here either.
    The client answers this number when the lake states no count of its own.
    """
    return sum(
        1 for block in samples for value in block.values if math.isfinite(float(value))
    )


class QuixLakeClient:
    """Write samples into QuixLake through `POST /insert`."""

    def __init__(self, base_url: str, token: str | None, timeout: float = TIMEOUT_SECONDS) -> None:
        self.base_url = base_url.rstrip("/")
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        self._http = httpx.Client(base_url=self.base_url, headers=headers, timeout=timeout)

    def close(self) -> None:
        self._http.close()

    def write_samples(
        self,
        *,
        filename: str,
        run_id: str | None,
        time_start: datetime | None,
        samples: list[ChannelSamples],
    ) -> int:
        """Write every sample of one file. Return the number of rows written.

        The file needs a start time. Sample offsets are seconds from the start
        of the recording, so without it the row carries no honest timestamp.
        A CSV export states no start time, so its samples stay out of the lake
        for now. The registry still holds the file and its signal inventory.

        The file needs a run key too. `run_id` is the first hive partition, so a
        row without one lands in an empty partition that no query filters on.
        """
        if not samples:
            return 0
        if time_start is None:
            log.warning("%s states no start time, so its samples stay out of the lake", filename)
            return 0
        if not run_id:
            log.warning("%s resolves no run key, so its samples stay out of the lake", filename)
            return 0
        body = build_csv(filename, run_id, time_start, samples)
        response = self._http.post(
            "/insert",
            params={
                "table": table_name(),
                "hive_columns": HIVE_COLUMNS,
                "timestamp_column": TIMESTAMP_COLUMN,
                "timestamp_format": TIMESTAMP_FORMAT,
            },
            content=body.encode("utf-8"),
            headers={"Content-Type": "text/csv"},
        )
        response.raise_for_status()
        answered = response.json().get("rows_inserted")
        return int(answered) if isinstance(answered, int) else row_count(samples)


def query_url() -> str:
    """Return the lake URL from the first variable that holds a value.

    The reader accepts the same two names (`api/api/services/lake.py`), and
    `api/README.md` documents the second as the fallback. The writer must
    accept both. One name that only the reader knows splits the two sides: the
    API then answers from the lake while no sample ever reaches it.
    """
    for name in URL_VARS:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def build_lake_client() -> QuixLakeClient | None:
    """Build the lake client from the injected environment.

    The platform injects `Quix__Lakehouse__Query__Url` into a deployment that
    binds workspace blob storage. Without it the caller still records the
    signal inventory, so the builder answers None rather than raising.
    """
    base_url = query_url()
    if not base_url:
        log.warning("%s is not set, so no sample reaches QuixLake", " and ".join(URL_VARS))
        return None
    token = os.environ.get("Quix__Lakehouse__Query__AuthToken") or os.environ.get(
        "Quix__Sdk__Token"
    )
    return QuixLakeClient(base_url, token)


__all__ = [
    "COLUMNS",
    "DEFAULT_TABLE",
    "HIVE_COLUMNS",
    "URL_VARS",
    "ChannelSamples",
    "LakeClient",
    "QuixLakeClient",
    "build_csv",
    "build_lake_client",
    "query_url",
    "row_count",
    "table_name",
]
