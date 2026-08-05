"""A QuixStreams BatchingSink that writes CAN rows to the Quix Lakehouse.

Writes go through the Query API's /insert via quixlake-sdk. Parquet and blob are
never written directly: direct writes bypass the lake service and can corrupt the
Iceberg catalog.
"""

from __future__ import annotations

import logging
import time

import pandas as pd
from quixstreams.sinks import BatchingSink, SinkBackpressureError, SinkBatch

from flatten import SIGNAL_COLUMNS, UNKNOWN_COLUMNS, flatten

logger = logging.getLogger(__name__)


class CanLakeSink(BatchingSink):
    """Flatten envelope messages and insert them as two tables.

    :param client: a QuixLakeClient
    :param signals_table: table for decoded signal samples
    :param unknown_table: table for frames with no DBC entry (None to drop them)
    :param hive_columns: partition columns; must stay low-cardinality
    :param max_attempts: bounded retry - the SDK performs none of its own
    """

    def __init__(
        self,
        client,
        signals_table: str,
        unknown_table: str | None,
        hive_columns: list[str],
        max_attempts: int = 3,
        backoff_seconds: float = 2.0,
    ):
        super().__init__()
        self._client = client
        self._signals_table = signals_table
        self._unknown_table = unknown_table
        self._hive = hive_columns
        self._max_attempts = max_attempts
        self._backoff = backoff_seconds

    def write(self, batch: SinkBatch) -> None:
        signal_rows: list[dict] = []
        unknown_rows: list[dict] = []

        for item in batch:
            value = item.value
            if not isinstance(value, dict):
                continue
            # Kafka's message timestamp is the replay wall-clock. The source has
            # no wall clock at all (rlog logMonoTime is monotonic-since-boot), so
            # this is the only absolute time available to partition on.
            ts = pd.to_datetime(item.timestamp, unit="ms", utc=True)
            sig, unk = flatten(value, ts)
            signal_rows.extend(sig)
            unknown_rows.extend(unk)

        self._insert(self._signals_table, signal_rows, SIGNAL_COLUMNS)
        if self._unknown_table:
            self._insert(self._unknown_table, unknown_rows, UNKNOWN_COLUMNS)

    def _insert(self, table: str, rows: list[dict], columns: list[str]) -> None:
        if not rows:
            return
        df = pd.DataFrame(rows, columns=columns)
        hive = [c for c in self._hive if c in df.columns]

        for attempt in range(1, self._max_attempts + 1):
            try:
                self._client.insert(
                    table_name=table,
                    data=df,
                    hive_columns=hive,
                    timestamp_column="ts",
                    timestamp_format="day",
                )
                logger.info(
                    "inserted %d rows into %s (partitions: %s + day)",
                    len(df),
                    table,
                    ", ".join(hive) or "none",
                )
                return
            except Exception as exc:  # noqa: BLE001 - classified below
                msg = str(exc)
                # 409 means the partition structure does not match the existing
                # table. Retrying cannot fix that, so fail loudly rather than
                # burning the backoff on it.
                if "409" in msg:
                    logger.error(
                        "insert into %s rejected with 409 - partition structure "
                        "mismatch against the existing table (hive_columns=%s). "
                        "Not retryable: align the columns or recreate the table.",
                        table,
                        hive,
                    )
                    raise
                if attempt == self._max_attempts:
                    logger.error(
                        "insert into %s failed after %d attempts: %s",
                        table,
                        attempt,
                        exc,
                    )
                    # Hand it back to QuixStreams to retry rather than losing it.
                    raise SinkBackpressureError(retry_after=30.0) from exc
                logger.warning(
                    "insert into %s failed (attempt %d/%d): %s - retrying",
                    table,
                    attempt,
                    self._max_attempts,
                    exc,
                )
                time.sleep(self._backoff * attempt)
