"""Sink decoded CAN into the Quix Lakehouse.

Consumes can-decoded and writes two Iceberg tables via the Lakehouse Query API:

  can_signals         one row per signal sample, at the grain
                      channel -> sender_node -> frame -> pdu -> signal
  can_unknown_frames  frames with no DBC entry, raw payload preserved

Partitioning is deliberately NOT the full hierarchy. platform/channel/sender_node
is at most 1 x 3 x 14 = 42 partitions, plus a day partition from the timestamp.
frame (331) and especially signal (2150) stay ordinary columns: partitioning on
them would shatter the table into tiny parquet files. Iceberg column statistics
prune on them anyway.
"""

from __future__ import annotations

import logging
import os
import sys

from quixlake import QuixLakeClient
from quixstreams import Application

from lake_sink import CanLakeSink

logging.basicConfig(
    level=os.environ.get("LOGLEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("can-lake-sink")

INPUT_TOPIC = os.environ.get("input", "can-decoded")
CONSUMER_GROUP = os.environ.get("CONSUMER_GROUP", "can-lake-sink")
SIGNALS_TABLE = os.environ.get("SIGNALS_TABLE", "can_signals")
UNKNOWN_TABLE = os.environ.get("UNKNOWN_TABLE", "can_unknown_frames") or None
HIVE_COLUMNS = [
    c.strip()
    for c in os.environ.get("HIVE_COLUMNS", "platform,channel,sender_node").split(",")
    if c.strip()
]
COMMIT_INTERVAL = float(os.environ.get("COMMIT_INTERVAL", "30"))
COMMIT_EVERY = int(os.environ.get("COMMIT_EVERY", "200"))


def main() -> int:
    # On dev these are injected only when the deployment has
    # blobStorage.bind: true - the bind is the injection vehicle for the whole
    # Lakehouse bundle even though this service never touches blob itself.
    query_url = os.environ.get("Quix__Lakehouse__Query__Url") or os.environ.get(
        "QUIXLAKE_URL"
    )
    query_token = os.environ.get("Quix__Lakehouse__Query__AuthToken") or os.environ.get(
        "QUIX_LAKE_TOKEN"
    )
    if not query_url:
        logger.error(
            "no Lakehouse Query URL. Expected Quix__Lakehouse__Query__Url - on dev "
            "that injects only with blobStorage.bind: true; on BYOX it must be "
            "declared in the deployment variables."
        )
        return 1

    logger.info(
        "input=%s signals_table=%s unknown_table=%s hive=%s query_url=%s",
        INPUT_TOPIC,
        SIGNALS_TABLE,
        UNKNOWN_TABLE,
        ",".join(HIVE_COLUMNS),
        query_url,
    )

    client = QuixLakeClient(base_url=query_url, token=query_token)
    sink = CanLakeSink(
        client=client,
        signals_table=SIGNALS_TABLE,
        unknown_table=UNKNOWN_TABLE,
        hive_columns=HIVE_COLUMNS,
    )

    app = Application(
        consumer_group=CONSUMER_GROUP,
        auto_offset_reset="earliest",
        commit_interval=COMMIT_INTERVAL,
        commit_every=COMMIT_EVERY,
    )
    topic = app.topic(INPUT_TOPIC, value_deserializer="json")

    sdf = app.dataframe(topic)
    sdf.sink(sink)
    app.run(sdf)

    return 0


if __name__ == "__main__":
    sys.exit(main())
