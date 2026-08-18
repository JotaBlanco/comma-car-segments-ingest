"""test-vectors-sink - four vector topics into four Iceberg tables.

One ``Application``, four dataframe -> sink pairs. Table writes go through the
built-in ``QuixTSDataLakeSink`` **with ``catalog_url`` set**, which is what makes
the write sanctioned: it registers the table through the REST catalog instead of
bypassing it. Writing parquet to blob without the catalog is what corrupts
Iceberg, and that - not the sink - is the thing to avoid.

Fixed layout, identical on all four tables:

* ``hive_columns = ["device_id", "scenario"]`` - both low cardinality (a handful
  of devices, 16 scenarios). ``trace_key`` is deliberately **not** a partition
  column: it is per-trace, i.e. exactly the high-cardinality case that must not
  partition. Evaluator queries still push down because the registry supplies
  ``device_id`` and ``scenario`` alongside ``trace_key``.
* ``timestamp_column = "ts_ms"`` (int64 epoch ms).

**Changing ``hive_columns`` later is a migration, not a tweak.** The sink validates
the partition set against catalog metadata and the on-disk Hive paths at
``setup()`` and raises; a layout change means a new table name and a re-sink.

Fallback with no code change: if the pinned QuixStreams version refuses four
dataframes in one ``Application``, deploy the existing ``lakehouse-sink``
application four times with different ``input`` / ``TABLE_NAME`` /
``HIVE_COLUMNS`` variables. Same image, same constructor arguments.
"""

from dotenv import load_dotenv

load_dotenv()

import logging  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402

from quixstreams import Application  # noqa: E402
from quixstreams.sinks.core.quix_ts_datalake_sink import QuixTSDataLakeSink  # noqa: E402

logging.basicConfig(
    level=os.getenv("LOGLEVEL", "INFO"),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# The prefix catalog discovery scans. Raw MF4 objects live outside it, under
# test-manager/traces/, so discovery never walks a file that has no schema.
TIMESERIES_PREFIX = "data-lake/time-series"
TABLE_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$")

HIVE_COLUMNS = ["device_id", "scenario"]
TIMESTAMP_COLUMN = "ts_ms"

# (topic env var, default topic, table name)
STREAMS = (
    ("input_pt_can", "test-vectors-pt-can-100hz", "acc_pt_can_100hz"),
    ("input_radar_obj", "test-vectors-radar-obj-50hz", "acc_radar_obj_50hz"),
    ("input_hmi", "test-vectors-hmi-10hz", "acc_hmi_10hz"),
    ("input_sim_ref", "test-vectors-sim-ref-100hz", "acc_sim_ref_100hz"),
)


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def _positive_int(env_var: str, default: str) -> int:
    raw = os.getenv(env_var, default)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{env_var} must be a positive integer, got {raw!r}") from None
    if value <= 0:
        raise ValueError(f"{env_var} must be a positive integer, got {value}")
    return value


def _validate_table_name(table_name: str) -> str:
    """Fail at boot rather than at the first catalog PUT."""
    if not TABLE_NAME_PATTERN.match(table_name):
        raise ValueError(
            f"Invalid table name {table_name!r}. Table names must start with a letter or digit "
            "and may only contain letters, digits, dots (.), hyphens (-) and underscores (_)."
        )
    return table_name


def build_sink(table_name: str, workspace_id: str) -> QuixTSDataLakeSink:
    """Constructor copied whole from the sanctioned sample.

    ``on_client_connect_success`` / ``on_client_connect_failure`` are not
    decoration: the portal's "Test connection & deploy" flow depends on them.
    Blob credentials are never passed - quixportal reads
    ``Quix__BlobStorage__Connection__Json`` and extracts the bucket itself.
    """
    return QuixTSDataLakeSink(
        s3_prefix=TIMESERIES_PREFIX,
        table_name=_validate_table_name(table_name),
        workspace_id=workspace_id,
        hive_columns=HIVE_COLUMNS,
        timestamp_column=TIMESTAMP_COLUMN,
        catalog_url=os.getenv("Quix__Lakehouse__Catalog__Url") or os.getenv("CATALOG_URL"),
        catalog_auth_token=os.getenv("Quix__Lakehouse__Catalog__AuthToken"),
        auto_discover=os.getenv("AUTO_DISCOVER", "true").lower() == "true",
        namespace=os.getenv("CATALOG_NAMESPACE", "default"),
        auto_create_bucket=True,
        max_workers=_positive_int("MAX_WRITE_WORKERS", "10"),
        on_client_connect_success=lambda: logger.info("CONNECTED!"),
        on_client_connect_failure=lambda exc: logger.error("ERROR! %s", exc),
    )


def build_application() -> Application:
    return Application(
        broker_address=os.getenv("KAFKA_BOOTSTRAP_SERVERS") or None,
        consumer_group=_env("CONSUMER_GROUP", "test-vectors-sink"),
        # The existing lakehouse-sink defaults to "latest" in code, which silently
        # skips everything already on the topic. For this system that is a bug.
        auto_offset_reset=_env("AUTO_OFFSET_RESET", "earliest"),
        commit_interval=_positive_int("COMMIT_INTERVAL", "30"),
        # These messages are already expanded rows, so a large batch is safe here
        # (unlike on the extractor, which expands one message into thousands).
        commit_every=_positive_int("BATCH_SIZE", "1000"),
    )


def build_pipeline(app: Application) -> None:
    workspace_id = os.getenv("Quix__Workspace__Id", "")
    for env_var, default_topic, table_name in STREAMS:
        topic_name = _env(env_var, default_topic)
        sdf = app.dataframe(topic=app.topic(topic_name, value_deserializer="json"))
        sdf.sink(build_sink(table_name, workspace_id))
        storage_path = f"{workspace_id}/{TIMESERIES_PREFIX}" if workspace_id else TIMESERIES_PREFIX
        logger.info(
            "%s -> %s/%s partitioned by %s, timestamp %s",
            topic_name, storage_path, table_name, HIVE_COLUMNS, TIMESTAMP_COLUMN,
        )


if __name__ == "__main__":
    application = build_application()
    build_pipeline(application)
    logger.info("Starting test-vectors-sink with %d table(s)", len(STREAMS))
    application.run()
