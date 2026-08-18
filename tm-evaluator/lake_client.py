"""Reading test vectors out of the Lakehouse, and the query rules that matter.

Three constraints shape every query here, all of them learned the hard way:

* **No ``WITH`` / CTE.** The DuckDB-backed Query API silently returns zero rows,
  which is worse than an error because it reads as "the trace has no data".
* **No aggregation in SQL.** ``MIN`` / ``GROUP BY`` / ``FILTER`` on derived tables
  hit a ~30 s timeout. Scan raw and reduce in numpy: a 40 s trace is about 6 400
  rows across all four tables, so a raw scan is the cheap option, not a compromise.
* **Always filter on the partition columns.** ``device_id`` and ``scenario`` are
  the Hive partitions, so equality filters on them push down to an S3 prefix and
  skip non-matching files. ``trace_key`` is not a partition column, so filtering on
  it alone would scan the whole table.

Columns are narrowed to the signals a criterion needs plus the keys, and rows come
back ordered by ``t_s`` - never by ``ts_ms``, which is wall-clock-tainted.
"""

import csv
import io
import logging
import os
import re

import numpy as np
import requests

logger = logging.getLogger(__name__)

TIMEOUT_S = 30
IDENTIFIER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
KEY_COLUMNS = ("t_s", "trace_key", "channel_group", "sample_index")


class LakeUnavailableError(RuntimeError):
    """The Query API is not configured on this deployment."""


class LakeQueryError(RuntimeError):
    """The Query API rejected or failed a query."""


def query_url() -> str:
    return os.environ.get("Quix__Lakehouse__Query__Url") or os.environ.get("QUIXLAKE_URL") or ""


def query_token() -> str:
    return (
        os.environ.get("Quix__Lakehouse__Query__AuthToken")
        or os.environ.get("QUIX_LAKE_TOKEN")
        or ""
    )


def is_available() -> bool:
    return bool(query_url()) and bool(query_token())


def unavailable_reason() -> str | None:
    if is_available():
        return None
    missing = [
        name
        for name, value in (
            ("Quix__Lakehouse__Query__Url", query_url()),
            ("Quix__Lakehouse__Query__AuthToken", query_token()),
        )
        if not value
    ]
    return (
        f"Lakehouse Query API is not configured: {', '.join(missing)} unset. On the dev cluster "
        "these inject only with blobStorage.bind: true; declare them as deployment variables "
        "while the Storage Gateway is unreachable."
    )


def _sql_literal(value: str) -> str:
    """Single-quote a literal, doubling embedded quotes.

    Every value that reaches here is already regex-constrained upstream
    (``device_id``, ``trace_key``); this is the second line of defence, not the
    first.
    """
    return "'" + str(value).replace("'", "''") + "'"


def build_query(
    table: str,
    columns: list[str],
    device_id: str,
    scenario: str | None,
    trace_key: str,
) -> str:
    """One flat SELECT with partition-equality filters and an explicit column list."""
    if not IDENTIFIER_RE.match(table):
        raise LakeQueryError(f"illegal table name {table!r}")
    selected = list(dict.fromkeys([*KEY_COLUMNS, *columns]))
    for column in selected:
        if not IDENTIFIER_RE.match(column):
            raise LakeQueryError(f"illegal column name {column!r}")
    where = [f"device_id = {_sql_literal(device_id)}"]
    if scenario:
        where.append(f"scenario = {_sql_literal(scenario)}")
    where.append(f"trace_key = {_sql_literal(trace_key)}")
    return (
        f"SELECT {', '.join(selected)} FROM {table} "
        f"WHERE {' AND '.join(where)} ORDER BY t_s"
    )


def run_query(sql: str) -> list[dict]:
    lowered = sql.lower()
    if "with " in lowered:
        raise LakeQueryError(
            "query contains a CTE; the DuckDB-backed Query API silently returns zero rows for "
            "WITH. Use a single-level query and reduce in Python."
        )
    if not is_available():
        raise LakeUnavailableError(unavailable_reason() or "Lakehouse Query API unavailable")
    try:
        response = requests.post(
            f"{query_url().rstrip('/')}/query",
            data=sql.encode("utf-8"),
            headers={
                "Authorization": f"Bearer {query_token()}",
                "Content-Type": "text/plain",
            },
            timeout=TIMEOUT_S,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise LakeQueryError(f"lake query failed: {exc}") from exc
    text = response.text
    if not text.strip():
        return []
    return list(csv.DictReader(io.StringIO(text)))


def _to_float_array(rows: list[dict], column: str) -> np.ndarray:
    """CSV strings to float64, with empty and unparseable cells as NaN.

    NaN rather than 0.0 is the honest representation of "no sample": a fabricated
    zero would silently satisfy a deceleration bound.
    """
    values = np.empty(len(rows), dtype=np.float64)
    for index, row in enumerate(rows):
        raw = row.get(column)
        if raw is None or raw == "":
            values[index] = np.nan
            continue
        try:
            values[index] = float(raw)
        except (TypeError, ValueError):
            values[index] = np.nan
    return values


def load_group(
    table: str,
    columns: list[str],
    device_id: str,
    scenario: str | None,
    trace_key: str,
) -> tuple[dict, str]:
    """Load one channel group's samples. Returns ``(group_data, sql)``.

    ``group_data`` is ``{"t_s": ndarray, "signals": {name: ndarray}, "row_count": n}``.
    The SQL is returned so the report can print the exact query that produced a
    verdict - which is most of what makes the report reproducible.
    """
    sql = build_query(table, columns, device_id, scenario, trace_key)
    rows = run_query(sql)
    if not rows:
        return {"t_s": np.empty(0), "signals": {}, "row_count": 0}, sql
    t_s = _to_float_array(rows, "t_s")
    order = np.argsort(t_s, kind="stable")
    signals = {}
    for column in columns:
        if column in rows[0]:
            signals[column] = _to_float_array(rows, column)[order]
    return (
        {"t_s": t_s[order], "signals": signals, "row_count": len(rows)},
        sql,
    )
