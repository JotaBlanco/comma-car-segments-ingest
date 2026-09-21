"""Where the signal series come from.

Two sources, one interface. :func:`load_frame` returns the wide, forward-filled
:class:`~.criteria.Frame` a test case is evaluated over, plus a label saying which source
produced it, and that label travels all the way to the report so nobody has to guess.

* **lake** - ``POST {Quix__Lakehouse__Query__Url}/query`` with a plain-text SQL body and a
  CSV response. One single-level SELECT filtered on the Hive partition columns
  (``platform`` / ``device`` / ``route``), which prunes to a handful of parquet files.
  Deliberately no CTE - the DuckDB-backed Query API returns zero rows for ``WITH``, with
  no error - and deliberately no SQL aggregation: it is slow enough to hit the query
  timeout on a derived table, and a 2 s trailing mean is not natural SQL anyway. Every
  reduction happens in :mod:`.criteria`.
* **fixture** - ``fixtures/acc_signals.csv.gz``, the same three measurements at their
  native rasters. This is what renders in local development, where the platform injects no
  lakehouse variables at all, and it is the safety net that stops the report ever being
  empty. See ``fixtures/README.md`` for how it is generated.

The lake is tried first whenever it is configured; any failure falls back to the fixture
rather than failing the run, because a demo that shows nothing is worse than a demo that
shows the same numbers from a committed copy.
"""

from __future__ import annotations

import csv
import gzip
import io
import logging
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import httpx

from ..settings import Settings
from .criteria import Frame

logger = logging.getLogger(__name__)

#: The decoded-signal table in the lakehouse. Long format: one row per (signal, sample).
LAKE_TABLE = "mf4_signals_v4"

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "acc_signals.csv.gz"

#: Seconds to wait on the Query API. A partition-pruned scan of three routes returns in
#: well under this; anything slower is a fault and the fixture is the better answer.
QUERY_TIMEOUT_S = 30.0

SOURCE_LAKE = "lake"
SOURCE_FIXTURE = "fixture"


@dataclass(frozen=True)
class LakePartition:
    """Where one test case's measurement landed in the lake.

    ``platform`` / ``device`` / ``route`` are physical Hive partitions; ``segment`` carries
    the ``tc_id`` and is a plain column, which is why it is not in the WHERE clause below -
    the three partition predicates already select exactly this run.
    """

    platform: str
    device: str
    route: str
    segment: str
    scenario: str

    @property
    def locator(self) -> str:
        return f"{self.platform}/{self.device}/{self.route}/{self.segment}"

    @property
    def trace_key(self) -> str:
        """A trace key with no path separators, so ``GET /vmodel/traces/{key}`` resolves."""
        return f"{self.platform}__{self.device}__{self.route}__{self.segment}"


class SignalSourceError(RuntimeError):
    """Neither the lake nor the fixture could supply a test case's signals."""


def build_query(partition: LakePartition, signals: tuple[str, ...]) -> str:
    """One single-level SELECT. See the module docstring for why it looks like this."""
    in_list = ", ".join(f"'{signal}'" for signal in signals)
    return (
        f"SELECT signal, ts_ms, value FROM {LAKE_TABLE} "
        f"WHERE platform = '{partition.platform}' "
        f"AND device = '{partition.device}' "
        f"AND route = '{partition.route}' "
        f"AND signal IN ({in_list})"
    )


def _parse_csv(text: str, signals: tuple[str, ...]) -> list[tuple[str, int, float]]:
    """CSV response -> ``(signal, ts_ms, value)`` rows, NULL values dropped.

    A row whose ``value`` is empty is an enumerated signal carrying its label in
    ``value_text``; it is not a zero and must not become one.
    """
    wanted = set(signals)
    rows: list[tuple[str, int, float]] = []
    for record in csv.DictReader(io.StringIO(text)):
        signal = (record.get("signal") or "").strip()
        if signal not in wanted:
            continue
        raw_value = (record.get("value") or "").strip()
        raw_ts = (record.get("ts_ms") or "").strip()
        if not raw_value or not raw_ts:
            continue
        try:
            rows.append((signal, int(float(raw_ts)), float(raw_value)))
        except ValueError:
            continue
    return rows


def query_lake(
    settings: Settings, partition: LakePartition, signals: tuple[str, ...]
) -> list[tuple[str, int, float]]:
    """Run the scan against the Query API. Raises on any transport or HTTP failure."""
    base = (settings.lakehouse_query_url or "").rstrip("/")
    if not base:
        raise SignalSourceError("Quix__Lakehouse__Query__Url is not configured")

    with httpx.Client(timeout=QUERY_TIMEOUT_S) as client:
        response = client.post(
            f"{base}/query",
            content=build_query(partition, signals).encode("utf-8"),
            headers={
                "Content-Type": "text/plain",
                "Accept": "text/csv",
                "Authorization": f"Bearer {settings.sdk_token}",
            },
        )
    response.raise_for_status()
    return _parse_csv(response.text, signals)


def _iter_fixture(segment: str, signals: tuple[str, ...]) -> Iterator[tuple[str, int, float]]:
    """Stream the committed fixture, filtered to one test case's signals."""
    if not FIXTURE_PATH.exists():
        raise SignalSourceError(f"signal fixture missing: {FIXTURE_PATH}")
    wanted = set(signals)
    with gzip.open(FIXTURE_PATH, "rt", encoding="utf-8", newline="") as handle:
        for record in csv.DictReader(handle):
            if record.get("segment") != segment or record.get("signal") not in wanted:
                continue
            yield (str(record["signal"]), int(record["ts_ms"]), float(record["value"]))


def load_fixture(segment: str, signals: tuple[str, ...]) -> list[tuple[str, int, float]]:
    return list(_iter_fixture(segment, signals))


@dataclass(frozen=True)
class LoadedSignals:
    """A test case's signals plus the provenance of the bytes they came from."""

    frame: Frame
    source: str
    row_count: int
    note: str = ""

    @property
    def duration_s(self) -> float:
        return (self.frame.t_s[-1] - self.frame.t_s[0]) if self.frame.size else 0.0


def load_frame(
    settings: Settings, partition: LakePartition, signals: tuple[str, ...]
) -> LoadedSignals:
    """Load one test case's signals, lake first, fixture as the fallback."""
    note = ""
    if settings.lakehouse_query_url:
        try:
            rows = query_lake(settings, partition, signals)
            if rows:
                return LoadedSignals(Frame.build(rows), SOURCE_LAKE, len(rows))
            note = f"lakehouse returned no rows for {partition.locator}; used the fixture"
            logger.warning(note)
        except (httpx.HTTPError, SignalSourceError, ValueError) as exc:
            note = f"lakehouse query failed ({exc.__class__.__name__}); used the fixture"
            logger.warning("%s: %s", note, exc)
    else:
        note = "no lakehouse configured; evaluated against the committed fixture"

    rows = load_fixture(partition.segment, signals)
    if not rows:
        raise SignalSourceError(
            f"no signal rows for {partition.segment} in the lake or in {FIXTURE_PATH.name}"
        )
    return LoadedSignals(Frame.build(rows), SOURCE_FIXTURE, len(rows), note)
