"""
MF4 DataLake Sink - Main Entry Point

Variant of quix-datalake-timeseries-sink for the MF4 pipeline.
mf4-decoder produces per-channel batched Kafka messages with the shape:

    {
        "file_name":     "sample.mf4",            # scalar
        "upload_id":     "sample-7a9622106da0",   # scalar, unique per file
        "platform":      "HYUNDAI_IONIQ",         # scalar, from the MF4 header
        "device":        "44b354b55dffb795",      # scalar, from the MF4 header
        "route":         "0000000e--053ec37492",  # scalar, from the MF4 header
        "segment":       "20",                    # scalar, from the MF4 header
        "dcm_config_id": "d8295d4af7b43ce...",    # scalar, from the MF4 header
        "signal":        "ACCMode",               # scalar, the signal name
        "unit":          "V",                     # scalar
        "channel_name":  "powertrain_hs_can1",    # scalar, the CAN bus name
        "frame_name":    "SCC12",                 # scalar, from the embedded DBC
        "sender_node":   "SCC",                   # scalar, from the embedded DBC
        "ts_ms":         [t0, t1, ..., tN],       # array
        "value":         [v0, v1, ..., vN],       # array, float | None
        "value_text":    [s0, s1, ..., sN],       # array, str | None
    }

``value`` and ``value_text`` are a per-channel split, not a per-sample one: a
numeric channel fills ``value`` with floats and ``value_text`` with nulls, a
string/bytes channel (including CAN signals resolved through a DBC ``VAL_``
value table, which decode to ``'D'``, ``'P'``, ``'R'``, ...) does the reverse.
Both keys are always present. Before the split every sample shared one
``value`` column, so a single parquet file holding both kinds made PyArrow
infer ``double`` from the leading rows and then raise on the first string.

``signal`` is the *signal* name (``ACCMode``) and ``channel_name`` is the *CAN
bus* name (``powertrain_hs_can1``). They are not variants of each other. The
pair now matches the reference ``can_signals_v13`` table exactly, where
``channel_name`` is likewise the bus and ``signal`` the signal. This column was
called ``channel`` up to and including the ``mf4_signals_v2`` table; messages
still on ``mf4-to-msg`` from that decoder carry the old key, so
``_expand_columnar`` reads ``signal`` first and falls back to ``channel``.

``upload_id`` is the pipeline-wide unique key minted by mf4-to-blob
(``metadata.make_upload_id``: ``<safe_filename_stem>-<sha256(filename+time)[:12]>``).
It is repeated onto every expanded row so the Iceberg table carries a
queryable per-upload key that can later be joined to Test Manager records.

The provenance scalars (``platform``, ``device``, ``route``, ``segment``,
``dcm_config_id``) come from the ``<common_properties>`` block of the MF4's own
HD comment; ``channel_name`` / ``frame_name`` / ``sender_node`` come from the
DBC embedded in the same file. Every one of them is the literal string
``"unknown"`` when unavailable - **never null**. Two independent failure modes
make that mandatory: PyArrow infers a null-typed column from an all-``None``
batch and fails the parquet write, and the sink groups *physical* partitions
with pandas' ``groupby``, which without the sink's NULL-bucket fallback would
make rows with a null partition value vanish silently. The same applies to the
``~``-prefixed *virtual* partitions, for a third reason: the catalog marks a
file ``virtual_indexed`` as a whole, so a null value in a virtual column is
dropped from the index while the file still counts as indexed - the row then
becomes unreachable through a ``WHERE <virtual col> = ...``. The ``.get(...) or
UNKNOWN`` reads below repeat the guarantee for messages produced by an older
decoder that ``AUTO_OFFSET_RESET=earliest`` replays.

The Kafka message key is the signal name (matches the in-payload
``signal`` scalar). Multi-group signals emit qualified keys
(``"<name>#g<group_idx>"``) on second-and-later occurrences. This means
messages for one file are spread across partitions by signal; the sink
does not depend on per-file ordering since each Iceberg row is independent.
**This sink never reads that key.** Every column, ``signal`` included, comes
from the payload - see the NOTE above ``sdf.sink`` for why.

For a CAN bus-logging MF4 the decoder resolves the raw frames against the DBC
embedded in the file and emits the decoded signal names (``ACC_ObjDist``,
``CR_Yrs_Yr``, ...); raw ``CAN_DataFrame.*`` frame fields are dropped upstream
and never reach this sink. Ordinary MF4s still emit their own channel names
unchanged. Either way the payload contract above is identical, so this sink
stays a thin writer and does no decoding.

This sink fans each batched message back out to N per-row dicts via
sdf.apply(..., expand=True) so QuixTSDataLakeSink writes one Iceberg row per
sample, identical to a non-batched producer.

ONE TOPIC, TWO KINDS
--------------------
``mf4-to-msg`` carries two shapes since the Test Manager integration, told apart
by ``kind``: ``"samples"`` (the per-channel batches above) and the one terminal
``"file_complete"`` marker per file, which holds that file's signal inventory and
no samples at all. tm-connector finalizes on the marker; this sink SKIPS it.
Expanding it would read ``value["ts_ms"]`` on a message that has none.

A message with NO ``kind`` is a batch an older decoder wrote, and
``AUTO_OFFSET_RESET=earliest`` replays those. They are samples, so they are
expanded — the filter refuses the marker specifically, rather than demanding a
field the backlog cannot carry.

PARTITIONED BY THE TRACEABILITY CHAIN
-------------------------------------
    HIVE_COLUMNS = platform,work_order,run_id,
                   ~channel_name,~sender_node,~frame_name,~signal

``work_order`` is ``unassigned`` when nobody claimed the file — an absent claim
is a fact, not a fault. ``run_id`` has no such default: a batch that names no
run is DROPPED, with a warning, because ``run_id=unknown/`` would merge every
unplaceable file in the estate into one partition that reads like a real run.

**There is no ``test_definition`` level, and no such column.** One trace fulfils
a SET of test definitions, and a row sits in exactly one directory, so the level
could only be honest by triplicating rows or by reading ``unassigned`` for every
shared run. The registry is the system of record for run -> definitions, and
every row here carries ``run_id``, which joins to it.

``device``, ``route``, ``segment`` and ``dcm_config_id`` are still on every row
and still queryable; they are no longer directory levels. ``run_id`` is minted
from ``platform`` and ``route`` when nothing else names it
(``mf4-decoder/identity.py``), so a route-level directory under it would only
repeat what the level above already says.

``platform`` prefers what the FILE says. The MF4's own header names the vehicle,
which is a better answer than any plan; the ``WorkOrder`` configuration the Test
Manager files in Dynamic Configuration (``api/api/config_push.py``, ``$.project``)
is consulted only when the header named none. That keeps the pushed configuration
load-bearing without letting a planning value overwrite a measured one.

Changing HIVE_COLUMNS needs a NEW ``TABLE_NAME`` (the sink validates an existing
table's partition spec at setup() and refuses a mismatch) and a new
``CONSUMER_GROUP``, so ``earliest`` replays into the new table.
"""
import logging
import os
import re

from quixstreams import Application
from quixstreams.dataframe.joins.lookups import (
    QuixConfigurationService,
    QuixConfigurationServiceJSONField,
)
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


# The rules one message is written by. `expand.py` holds them so they can be
# tested without a broker; this module holds the wiring that needs one.
from expand import (  # noqa: E402  (after the logging setup above, on purpose)
    F_WORK_ORDER_PLATFORM,
    UNKNOWN,
    WORK_ORDER_CONFIG_TYPE,
    _coerce_warned_signals,
    _expand_columnar,
    is_sample_batch,
    work_order_target_key,
)

# Marks a *virtual* partition: a column that appears in the partition tree and
# is filterable, but is NOT written as a physical `key=value/` directory and
# does not split files.
#
# Supported by the QuixStreams commit this app pins
# (c888997ab65303a5565cef84da687eb3d6f98790) and NOT by anything older - the
# previous `quixlakesink-fix-v3` branch copied hive_columns verbatim into
# `df.groupby()` and into the f"{col}={val}" path segment, so a "~" entry there
# produced a literal `~signal=...` directory that no reader in the stack maps
# back to anything. If this pin is ever moved, re-read
# quixstreams/sinks/core/quix_ts_datalake_sink.py and confirm `__init__` still
# splits `hive_columns` on this prefix before relying on it.
VIRTUAL_PARTITION_PREFIX = "~"


def parse_hive_columns(columns_str: str) -> tuple[list[str], list[str]]:
    """Split HIVE_COLUMNS into (columns as the sink wants them, virtual names).

    ``"platform,device,route,~signal"`` ->
    ``(["platform", "device", "route", "~signal"], ["signal"])``.

    The first list is passed to the sink **verbatim, prefixes intact**: the sink
    owns the split (`self.hive_columns` physical / `self._virtual_columns`
    virtual / `self._partition_spec_order` full tree order) and needs the full
    ordered list to register the table's partition spec. Stripping or demoting
    here - which an earlier revision did, because the then-pinned build had no
    "~" support - would register a physical-only spec and silently lose the
    pruning index.

    The second list is the bare virtual names, returned only so the boot log can
    state which columns are virtual without re-parsing the string.
    """
    if not columns_str or columns_str.strip() == "":
        return [], []

    columns, virtual = [], []
    for raw in columns_str.split(","):
        col = raw.strip()
        if not col:
            continue
        if col.startswith(VIRTUAL_PARTITION_PREFIX):
            name = col[len(VIRTUAL_PARTITION_PREFIX):].strip()
            if not name:
                continue
            columns.append(f"{VIRTUAL_PARTITION_PREFIX}{name}")
            virtual.append(name)
        else:
            columns.append(col)

    return columns, virtual


# Initialize Quix Streams Application. `broker_address` is read from
# KAFKA_BOOTSTRAP_SERVERS for local-dev convenience; in Quix Cloud it stays None
# and the Application picks up Quix__Broker__* from the platform.
app = Application(
    broker_address=os.getenv("KAFKA_BOOTSTRAP_SERVERS"),
    consumer_group=os.getenv("CONSUMER_GROUP", "mdf_file_test_lake_v1"),
    auto_offset_reset=os.getenv("AUTO_OFFSET_RESET", "earliest"),
    commit_interval=_positive_int("COMMIT_INTERVAL", "30"),
    commit_every=_positive_int("BATCH_SIZE", "30"),
)

# Parse configuration. `hive_columns` keeps the "~" prefixes - the sink parses
# them itself and needs the full ordered list to register the partition spec.
hive_columns, virtual_hive_columns = parse_hive_columns(os.getenv("HIVE_COLUMNS", ""))
physical_hive_columns = [
    c for c in hive_columns if not c.startswith(VIRTUAL_PARTITION_PREFIX)
]
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

# Ordering column recorded on the table as `properties.sort_column`. Lakehouse
# compaction rewrites files ordered by it, which is what lets a time-range or
# ORDER BY query skip whole files instead of scanning the partition. The sink
# falls back to `timestamp_column` when this is None, so an empty value is a
# valid configuration rather than an error.
sort_column = os.getenv("SORT_COLUMN", "").strip() or None

# Initialize QuixLakeSink.
# Blob storage credentials come from Quix__BlobStorage__Connection__Json, which
# quixportal reads automatically; the bucket name is extracted from it. The
# Lakehouse Catalog URL is injected by the platform under the Quix naming
# convention (Quix__Lakehouse__Catalog__Url) when a Catalog deployment exists in
# the workspace, with CATALOG_URL kept as a legacy fallback. The auth token is
# injected *only* under the Quix name - it routes through the secrets-bag path
# the platform uses for the Catalog's own credentials - so it has no fallback.
class _FlushScopedWarningSink(QuixTSDataLakeSink):
    """QuixTSDataLakeSink that scopes the coercion warnings to one flush.

    ``_expand_columnar`` warns the first time it coerces a value on a given
    signal and then stays quiet for that signal. Without a reset that would
    be once per process lifetime, which hides a signal that starts
    misbehaving later; with a reset on every flush it is once per signal per
    written batch. ``BatchingSink.write`` is the flush boundary, so the reset
    lives here rather than on a timer.

    The reset is in a ``finally`` so a failed write - the case where the log is
    most worth reading - still re-arms the warnings for the retry.
    """

    def write(self, batch):
        try:
            return super().write(batch)
        finally:
            _coerce_warned_signals.clear()


blob_sink = _FlushScopedWarningSink(
    s3_prefix=TIMESERIES_PREFIX,
    table_name=table_name,
    workspace_id=workspace_id,
    hive_columns=hive_columns,
    timestamp_column=os.getenv("TIMESTAMP_COLUMN", "ts_ms"),
    sort_column=sort_column,
    catalog_url=os.getenv("Quix__Lakehouse__Catalog__Url")
    or os.getenv("CATALOG_URL"),
    catalog_auth_token=os.getenv("Quix__Lakehouse__Catalog__AuthToken"),
    auto_discover=auto_discover,
    namespace=os.getenv("CATALOG_NAMESPACE", "default"),
    auto_create_bucket=True,
    max_workers=_positive_int("MAX_WRITE_WORKERS", "10"),
    on_client_connect_success=lambda: logger.info("lakehouse client connected"),
    on_client_connect_failure=lambda e: logger.error("lakehouse client failed: %s", e),
)

# Create streaming dataframe
sdf = app.dataframe(topic=app.topic(os.environ["input"]))

# The terminal `file_complete` marker shares this topic and holds no samples.
# Filtered FIRST, ahead of the lookup and the expand, so neither ever sees it.
sdf = sdf.filter(is_sample_batch)

# The work order's platform, joined BEFORE the expand: one cache read per batch
# rather than one per row. It is the FALLBACK for `platform` - see
# `_expand_columnar` - so a work order nobody filed costs nothing.
#
# `fallback="default"` is not optional: the SDK default is "error", which
# re-raises inside join() and takes the sink down when content cannot be
# fetched. Leaving `config` unset turns the join off entirely, which is the
# right answer for a workspace with no Configuration Manager.
config_topic = os.getenv("config", "").strip()
if config_topic:
    work_order_lookup = QuixConfigurationService(
        app.topic(config_topic, value_deserializer="json"),
        app_config=app.config,
        fallback="default",
    )
    sdf = sdf.join_lookup(
        work_order_lookup,
        {
            F_WORK_ORDER_PLATFORM: QuixConfigurationServiceJSONField(
                type=WORK_ORDER_CONFIG_TYPE, jsonpath="$.project", default=UNKNOWN
            )
        },
        on=work_order_target_key,
    )

# Expand batched payload: one Kafka message (per-channel scalar+array) -> N records.
sdf = sdf.apply(_expand_columnar, expand=True)

# NOTE: `signal` is deliberately NOT re-derived from the Kafka message key here.
# A key addresses a message; it is not a row's identity, and coupling a table
# column to the producer's keying scheme breaks the column the day the producer
# re-keys. `_expand_columnar` reads it from the payload and guarantees non-null.

# Attach sink
sdf.sink(blob_sink)

storage_path = f"{workspace_id}/{TIMESERIES_PREFIX}" if workspace_id else TIMESERIES_PREFIX
logger.info("Starting MF4 DataLake Sink")
logger.info(f"  Input topic: {os.environ['input']}")
logger.info(f"  Storage path: {storage_path}/{table_name}")
logger.info(f"  Partition tree: {hive_columns if hive_columns else 'none'}")
logger.info(
    f"  Physical (key=value dirs): "
    f"{physical_hive_columns if physical_hive_columns else 'none'}"
)
logger.info(
    f"  Virtual (catalog-indexed, no dirs): "
    f"{virtual_hive_columns if virtual_hive_columns else 'none'}"
)
logger.info(f"  Sort column: {sort_column or 'none (falls back to timestamp_column)'}")
logger.info(
    "  Work order platform fallback: %s",
    f"joined from {config_topic}" if config_topic else "off (no `config` topic set)",
)

if __name__ == "__main__":
    app.run()
