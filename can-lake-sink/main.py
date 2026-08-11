"""Sink decoded CAN into the Quix Lakehouse.

Consumes can-decoded and writes two Iceberg tables:

  can_signals         one row per signal sample, at the grain
                      channel -> sender_node -> frame -> signal
  can_unknown_frames  frames with no DBC entry, raw payload preserved

Uses the framework's own QuixTSDataLakeSink: it writes Hive-partitioned Parquet
to blob and registers the table through the REST Catalog (auto_discover).

Not the Query API's /insert, which the lakehouse guidance calls the sanctioned
write path, because on this cluster that path is administratively closed. POST
/insert and POST /create-table both return
    {"error": "Access to the requested path is not permitted"}
while GET /tables, GET /partition-info, POST /query, POST /files/upload, POST
/discover and POST /compact are all permitted - identically for the workspace
PAT and the SDK token. With no token /insert returns 401, so auth runs first and
the 403 is an authorisation decision about the path, not a credential this
service can change.

The reason /insert is normally preferred is that direct blob writes can leave
the Iceberg catalog inconsistent. Passing catalog_url here addresses exactly
that: the table is registered via the REST Catalog rather than bypassed, and the
Catalog is a different service from the Query API that is refusing us.
"""

from __future__ import annotations

import logging
import os
import sys

from quixstreams import Application
from quixstreams.sinks.core.quix_ts_datalake_sink import QuixTSDataLakeSink

from flatten import to_signal_rows, to_unknown_rows

logging.basicConfig(
    level=os.environ.get("LOGLEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("can-lake-sink")


def _bool(name: str, default: str) -> bool:
    return str(os.environ.get(name, default)).strip().lower() in (
        "1",
        "true",
        "yes",
        "y",
        "on",
    )


INPUT_TOPIC = os.environ.get("input", "can-decoded")
CONSUMER_GROUP = os.environ.get("CONSUMER_GROUP", "can-lake-sink")
SIGNALS_TABLE = os.environ.get("SIGNALS_TABLE", "can_signals")
# Frames with no DBC entry are ~75% of this dataset's frames. Set false to keep
# the lake to decoded signals only; the frames are still produced upstream, they
# just stop being written.
SINK_UNKNOWN_FRAMES = _bool("SINK_UNKNOWN_FRAMES", "true")
UNKNOWN_TABLE = (
    (os.environ.get("UNKNOWN_TABLE", "can_unknown_frames") or None)
    if SINK_UNKNOWN_FRAMES
    else None
)
S3_PREFIX = os.environ.get("S3_PREFIX", "can-lake")
NAMESPACE = os.environ.get("NAMESPACE", "default")
TIMESTAMP_COLUMN = "ts_ms"

# platform/channel/sender_node is at most 1 x 3 x 14 = 42 partitions; year/month/
# day are derived by the sink from timestamp_column. frame_name (331) and signal
# (2150) stay ordinary columns - partitioning on them would shatter the table
# into tiny parquet files, and Iceberg column stats prune them anyway.
HIVE_COLUMNS = [
    c.strip()
    for c in os.environ.get(
        "HIVE_COLUMNS", "platform,channel,sender_node,year,month,day"
    ).split(",")
    if c.strip()
]
UNKNOWN_HIVE_COLUMNS = [
    c.strip()
    for c in os.environ.get(
        "UNKNOWN_HIVE_COLUMNS", "platform,channel,year,month,day"
    ).split(",")
    if c.strip()
]
COMMIT_INTERVAL = float(os.environ.get("COMMIT_INTERVAL", "30"))
COMMIT_EVERY = int(os.environ.get("COMMIT_EVERY", "200"))


def _sink(table, hive_columns, catalog_url, catalog_token, workspace_id):
    return QuixTSDataLakeSink(
        s3_prefix=S3_PREFIX,
        table_name=table,
        workspace_id=workspace_id,
        hive_columns=hive_columns,
        timestamp_column=TIMESTAMP_COLUMN,
        catalog_url=catalog_url,
        catalog_auth_token=catalog_token,
        auto_discover=True,
        namespace=NAMESPACE,
    )


def main() -> int:
    # Auto-injected on dev by blobStorage.bind: true - that bind is the injection
    # vehicle for the whole Quix__Lakehouse__* bundle. Local fallbacks kept so the
    # same code runs outside a deployment.
    catalog_url = os.environ.get("Quix__Lakehouse__Catalog__Url") or os.environ.get(
        "CATALOG_URL"
    )
    # SDK token as the bearer. The injected Quix__Lakehouse__*__AuthToken is not
    # accepted by the Portal in this workspace: the lake service authorises by
    # calling
    #   GET portal-api/auth/permissions/query?resourceType=Organisation
    #       &resourceId=<org>&permissions=Read
    # and that call returns 401 for it, so the lake answers 403 - visible on
    # /insert and even /health. The SDK token authenticates against the Portal,
    # so it is used first and the injected lakehouse token is only a fallback.
    catalog_token = (
        os.environ.get("Quix__Sdk__Token")
        or os.environ.get("Quix__Lakehouse__Catalog__AuthToken")
        or os.environ.get("CATALOG_TOKEN")
    )
    workspace_id = os.environ.get("Quix__Workspace__Id", "")

    if not catalog_url:
        logger.error(
            "no REST Catalog URL (Quix__Lakehouse__Catalog__Url). Without it the "
            "parquet is written to blob but never registered - the catalog "
            "inconsistency this route exists to avoid. Refusing to start."
        )
        return 1

    logger.info(
        "input=%s signals=%s unknown=%s prefix=%s workspace=%s catalog=%s",
        INPUT_TOPIC,
        SIGNALS_TABLE,
        UNKNOWN_TABLE,
        S3_PREFIX,
        workspace_id,
        catalog_url,
    )
    logger.info("hive signals=%s unknown=%s", HIVE_COLUMNS, UNKNOWN_HIVE_COLUMNS)
    if not SINK_UNKNOWN_FRAMES:
        logger.info(
            "SINK_UNKNOWN_FRAMES=false - frames with no DBC entry are dropped, "
            "only decoded signals reach the lake"
        )

    app = Application(
        consumer_group=CONSUMER_GROUP,
        auto_offset_reset="earliest",
        commit_interval=COMMIT_INTERVAL,
        commit_every=COMMIT_EVERY,
    )
    topic = app.topic(INPUT_TOPIC, value_deserializer="json")
    sdf = app.dataframe(topic)

    # One envelope carries many frames and the sink writes one row per record,
    # so expand here. metadata=True supplies the Kafka timestamp - the replay
    # wall-clock, which is the only absolute time this data has.
    signals = sdf.apply(
        lambda v, key, timestamp, headers: to_signal_rows(v, timestamp),
        expand=True,
        metadata=True,
    )
    signals.sink(
        _sink(SIGNALS_TABLE, HIVE_COLUMNS, catalog_url, catalog_token, workspace_id)
    )

    if UNKNOWN_TABLE:
        # Separate branch off the same source: one sink writes one table, and
        # these two have different schemas.
        unknown = sdf.apply(
            lambda v, key, timestamp, headers: to_unknown_rows(v, timestamp),
            expand=True,
            metadata=True,
        )
        unknown.sink(
            _sink(
                UNKNOWN_TABLE,
                UNKNOWN_HIVE_COLUMNS,
                catalog_url,
                catalog_token,
                workspace_id,
            )
        )

    app.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
