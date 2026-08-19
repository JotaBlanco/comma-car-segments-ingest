"""
MF4 DataLake Sink - Main Entry Point

Variant of quix-datalake-timeseries-sink for the MF4 pipeline.
mf4-decoder produces per-channel batched Kafka messages with the shape:

    {
        "file_name":  "sample.mf4",            # scalar
        "upload_id":  "sample-7a9622106da0",   # scalar, unique per file
        "channel":    "VOLTAGE",               # scalar
        "unit":       "V",                     # scalar
        "ts_ms":      [t0, t1, ..., tN],       # array
        "value":      [v0, v1, ..., vN],       # array, float | None
        "value_text": [s0, s1, ..., sN],       # array, str | None
    }

``value`` and ``value_text`` are a per-channel split, not a per-sample one: a
numeric channel fills ``value`` with floats and ``value_text`` with nulls, a
string/bytes channel (including CAN signals resolved through a DBC ``VAL_``
value table, which decode to ``'D'``, ``'P'``, ``'R'``, ...) does the reverse.
Both keys are always present. Before the split every sample shared one
``value`` column, so a single parquet file holding both kinds made PyArrow
infer ``double`` from the leading rows and then raise on the first string -
which is exactly what happens now that the table partitions on ``upload_id``
(one file per upload) instead of on ``channel`` (one file per signal).

``upload_id`` is the pipeline-wide unique key minted by mf4-to-blob
(``metadata.make_upload_id``: ``<safe_filename_stem>-<sha256(filename+time)[:12]>``).
It is repeated onto every expanded row so the Iceberg table carries a
queryable per-upload key that can later be joined to Test Manager records.

The Kafka message key is the channel name (matches the in-payload
``channel`` scalar). Multi-group channels emit qualified keys
(``"<name>#g<group_idx>"``) on second-and-later occurrences. This means
messages for one file are spread across partitions by channel; the sink
does not depend on per-file ordering since each Iceberg row is independent.

``channel`` is a signal name. For a CAN bus-logging MF4 the decoder resolves
the raw frames against the DBC embedded in the file and emits the decoded
signal names (``ACC_ObjDist``, ``CR_Yrs_Yr``, ...); raw ``CAN_DataFrame.*``
frame fields are dropped upstream and never reach this sink. Ordinary MF4s
still emit their own channel names unchanged. Either way the payload contract
below is identical, so this sink stays a thin writer and does no decoding.

This sink fans each batched message back out to N per-row dicts via
sdf.apply(..., expand=True) so QuixTSDataLakeSink writes one Iceberg row per
sample, identical to a non-batched producer.
"""
import inspect
import logging
import math
import os
import re

from quixstreams import Application
from quixstreams.sinks.core.quix_ts_datalake_sink import QuixTSDataLakeSink

# Configure logging
logging.basicConfig(
    level=os.getenv("LOGLEVEL", "INFO"),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Constant for time-series data lake path structure
TIMESERIES_PREFIX = "data-lake/time-series"

# Iceberg/Hive table names: leading alphanumeric, then alphanumerics, dots,
# hyphens and underscores. Validated at boot so a typo fails the deployment
# immediately instead of at the first catalog PUT, minutes into a run.
_TABLE_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$")


def _positive_int(env_var: str, default: str) -> int:
    """Read an env var as a positive int, raising at boot if it is not one.

    The alternative - int(os.getenv(...)) inline - turns a mistyped variable
    into a confusing traceback deep inside the Application constructor, or
    worse into a silently degenerate batch size.
    """
    raw = os.getenv(env_var, default)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{env_var} must be a positive integer, got '{raw}'") from None
    if value <= 0:
        raise ValueError(f"{env_var} must be a positive integer, got {value}")
    return value


# Running count of rows whose ``value`` was not a float and had to be coerced
# to null. Counted and logged rather than raised: the sink writes in batches, so
# one poison sample would fail the whole parquet write, the checkpoint would not
# commit, and the service would retry the same offsets forever. Clearing that
# state needs a topic purge or a redeploy, which is not an acceptable failure
# mode for a data-shape problem in a single row.
_coerced_rows = 0

# Log the first coercion, then one line per this many, so a systematically
# mis-typed channel is visible without flooding the log at 1000 rows/batch.
_COERCE_LOG_EVERY = 1000


def _coerce_value(raw):
    """Coerce one raw sample to ``(float | None, str | None)``.

    The decoder already routes numeric channels to ``value`` and text channels
    to ``value_text``, so this is a backstop for everything else that can reach
    the sink: messages from an older decoder, hand-written messages, or a dtype
    the decoder mis-routed. Anything that will not become a finite float is
    returned as ``(None, str(raw))`` - the value survives as text instead of
    raising ``ArrowInvalid`` inside the parquet writer.

    Numeric strings are accepted as numbers: a replayed older message can carry
    ``"1.5"`` where a float belongs, and that is a number, not a label.
    """
    if raw is None:
        return None, None
    # bool is a subclass of int; check it first so True lands as 1.0 rather
    # than being handled by some later branch.
    if isinstance(raw, bool):
        return float(raw), None
    if not isinstance(raw, (int, float, str)):
        return None, str(raw)
    try:
        as_float = float(raw)
    except (TypeError, ValueError):
        return None, str(raw)
    # NaN / Inf have no parquet double representation that survives a round
    # trip through pd.isna(), so they are nulls, not text.
    return (as_float, None) if math.isfinite(as_float) else (None, None)


def _expand_columnar(value):
    """Expand a per-channel batched message into N per-row dicts.

    Scalars (file_name, upload_id, channel, unit) are repeated; arrays
    (ts_ms, value, value_text) are indexed.

    Every yielded row carries *both* ``value`` and ``value_text``, one of them
    ``None``. A row that omitted a key would make the column set vary between
    rows of the same parquet file, which is the same class of unstable-schema
    bug as the mixed-type ``value`` column this split fixes.

    ``upload_id`` and ``value_text`` are read defensively with ``.get()``:
    messages produced by an older decoder are already on the topic and
    ``AUTO_OFFSET_RESET=earliest`` replays them. They have no ``value_text``
    key at all, so it defaults to an all-null column and those rows write
    cleanly without a topic purge. A ``value_text`` array of the wrong length
    is discarded for the same reason - a malformed message must not raise.
    """
    global _coerced_rows

    n = len(value["ts_ms"])
    file_name = value["file_name"]
    upload_id = value.get("upload_id")
    channel = value["channel"]
    unit = value["unit"]
    ts_arr = value["ts_ms"]
    val_arr = value["value"]

    text_arr = value.get("value_text")
    if not isinstance(text_arr, list) or len(text_arr) != n:
        text_arr = None

    for i in range(n):
        raw = val_arr[i]
        num, coerced_text = _coerce_value(raw)
        text = text_arr[i] if text_arr is not None else None

        if coerced_text is not None:
            _coerced_rows += 1
            # Do not overwrite a real value_text; the coerced string is only a
            # fallback for rows that have nowhere else to put the value.
            if text is None:
                text = coerced_text
            if _coerced_rows == 1 or _coerced_rows % _COERCE_LOG_EVERY == 0:
                logger.warning(
                    "Coerced %d non-numeric 'value' sample(s) to null so far; "
                    "latest channel=%s value=%r -> value_text=%r",
                    _coerced_rows,
                    channel,
                    raw,
                    coerced_text,
                )

        yield {
            "file_name":  file_name,
            "upload_id":  upload_id,
            "channel":    channel,
            "unit":       unit,
            "ts_ms":      ts_arr[i],
            "value":      num,
            "value_text": None if text is None else str(text),
        }


def parse_hive_columns(columns_str: str) -> list:
    if not columns_str or columns_str.strip() == "":
        return []
    return [col.strip() for col in columns_str.split(",") if col.strip()]


# Initialize Quix Streams Application. `broker_address` is read from
# KAFKA_BOOTSTRAP_SERVERS for local-dev convenience; in Quix Cloud it stays None
# and the Application picks up Quix__Broker__* from the platform.
app = Application(
    broker_address=os.getenv("KAFKA_BOOTSTRAP_SERVERS"),
    consumer_group=os.getenv("CONSUMER_GROUP", "mdf_file_test_lake_v1"),
    auto_offset_reset=os.getenv("AUTO_OFFSET_RESET", "latest"),
    commit_interval=_positive_int("COMMIT_INTERVAL", "30"),
    commit_every=_positive_int("BATCH_SIZE", "30"),
)

# Parse configuration
hive_columns = parse_hive_columns(os.getenv("HIVE_COLUMNS", ""))
auto_discover = os.getenv("AUTO_DISCOVER", "true").lower() == "true"
table_name = os.getenv("TABLE_NAME") or os.environ["input"]
if not _TABLE_NAME_PATTERN.match(table_name):
    raise ValueError(
        f"Invalid table name '{table_name}'. Table names must start with a letter "
        f"or digit and may only contain letters, digits, dots (.), hyphens (-), "
        f"and underscores (_)."
    )

# Workspace ID (automatically injected by Quix platform)
workspace_id = os.getenv("Quix__Workspace__Id", "")

# Optional row ordering inside each written Parquet file. `sort_column` was
# added to QuixTSDataLakeSink after the branch this app pins, so it is forwarded
# only when the installed QuixStreams actually accepts it - pinning forward or
# back can then never break the boot.
sort_column = os.getenv("SORT_COLUMN", "").strip()
sink_kwargs = {}
if sort_column:
    try:
        supported = "sort_column" in inspect.signature(
            QuixTSDataLakeSink.__init__
        ).parameters
    except (TypeError, ValueError):
        supported = False
    if supported:
        sink_kwargs["sort_column"] = sort_column
    else:
        logger.warning(
            "SORT_COLUMN=%s ignored: the installed QuixStreams QuixTSDataLakeSink "
            "does not accept a 'sort_column' argument.",
            sort_column,
        )

# Initialize QuixLakeSink.
# Blob storage credentials come from Quix__BlobStorage__Connection__Json, which
# quixportal reads automatically; the bucket name is extracted from it. The
# Lakehouse Catalog URL is injected by the platform under the Quix naming
# convention (Quix__Lakehouse__Catalog__Url) when a Catalog deployment exists in
# the workspace, with CATALOG_URL kept as a legacy fallback. The auth token is
# injected *only* under the Quix name - it routes through the secrets-bag path
# the platform uses for the Catalog's own credentials - so it has no fallback.
blob_sink = QuixTSDataLakeSink(
    s3_prefix=TIMESERIES_PREFIX,
    table_name=table_name,
    workspace_id=workspace_id,
    hive_columns=hive_columns,
    timestamp_column=os.getenv("TIMESTAMP_COLUMN", "ts_ms"),
    catalog_url=os.getenv("Quix__Lakehouse__Catalog__Url")
    or os.getenv("CATALOG_URL"),
    catalog_auth_token=os.getenv("Quix__Lakehouse__Catalog__AuthToken"),
    auto_discover=auto_discover,
    namespace=os.getenv("CATALOG_NAMESPACE", "default"),
    auto_create_bucket=True,
    max_workers=_positive_int("MAX_WRITE_WORKERS", "10"),
    on_client_connect_success=lambda: print("CONNECTED!"),
    on_client_connect_failure=lambda e: print(f"ERROR! {e}"),
    **sink_kwargs,
)

# Create streaming dataframe
sdf = app.dataframe(topic=app.topic(os.environ["input"], key_deserializer="str"))

# Expand batched payload: one Kafka message (per-channel scalar+array) -> N records.
sdf = sdf.apply(_expand_columnar, expand=True)

# Per-record channel from message key (defensive duplicate; producer also
# embeds channel as a scalar in each batched message).
sdf["channel"] = sdf.apply(lambda value, key, *_: key, metadata=True)

# Attach sink
sdf.sink(blob_sink)

storage_path = f"{workspace_id}/{TIMESERIES_PREFIX}" if workspace_id else TIMESERIES_PREFIX
logger.info("Starting MF4 DataLake Sink")
logger.info(f"  Input topic: {os.environ['input']}")
logger.info(f"  Storage path: {storage_path}/{table_name}")
logger.info(f"  Partitioning: {hive_columns if hive_columns else 'none'}")

if __name__ == "__main__":
    app.run()
