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
"""
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

# Signals already warned about in the current flush window. Coercion is a
# per-signal property (a signal is either systematically mis-typed or it is
# not), so one line per signal per flush says everything a rate-limited
# every-Nth-row line said, at a tiny fraction of the volume: the previous
# "every 1000 rows" rule reached 31k+ lines on a single file. The set is
# cleared by _FlushScopedWarningSink.write() so a signal that stays broken
# still reports once per flush rather than once per process lifetime.
_coerce_warned_signals: set[str] = set()

# Value used for any provenance/enrichment scalar an older message lacks. Must
# match the decoder's provenance.UNKNOWN: these columns are Hive partition keys
# and must never be null. See the module docstring.
UNKNOWN = "unknown"


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

    Scalars (file_name, upload_id, the provenance block, signal, unit and the
    DBC-derived block) are repeated; arrays (ts_ms, value, value_text) are
    indexed.

    Every yielded row carries *both* ``value`` and ``value_text``, one of them
    ``None``. A row that omitted a key would make the column set vary between
    rows of the same parquet file, which is the same class of unstable-schema
    bug as the mixed-type ``value`` column this split fixes.

    Everything except ``ts_ms``/``value``/``unit``/``file_name`` is read
    defensively with ``.get()``: messages produced by an older decoder are
    already on the topic and ``AUTO_OFFSET_RESET=earliest`` replays them. They
    carry no provenance keys at all, so those default to ``"unknown"`` and the
    rows write cleanly - and, critically, still land in a real Hive partition
    instead of being dropped by ``groupby``. ``value_text`` defaults to an
    all-null column for the same reason; an array of the wrong length is
    discarded rather than raising, because a malformed message must not stall
    the checkpoint.

    The signal name is read as ``signal`` first and ``channel`` second. The
    column was renamed for the ``mf4_signals_v3`` table (so the ``~signal``
    virtual partition and the reference ``can_signals_v13`` schema line up),
    but every message the previous decoder already wrote to ``mf4-to-msg``
    still spells it ``channel`` - and those are exactly the messages
    ``earliest`` is replaying, so dropping the fallback would drop the backlog.
    """
    global _coerced_rows

    n = len(value["ts_ms"])
    file_name = value["file_name"]
    upload_id = value.get("upload_id") or UNKNOWN
    platform = value.get("platform") or UNKNOWN
    device = value.get("device") or UNKNOWN
    route = value.get("route") or UNKNOWN
    segment = value.get("segment") or UNKNOWN
    dcm_config_id = value.get("dcm_config_id") or UNKNOWN
    # "signal" (current) then "channel" (pre-v3 decoder); never null - it is a
    # virtual partition key and feeds the catalog's per-file value index.
    signal = value.get("signal") or value.get("channel") or UNKNOWN
    unit = value["unit"]
    channel_name = value.get("channel_name") or UNKNOWN
    frame_name = value.get("frame_name") or UNKNOWN
    sender_node = value.get("sender_node") or UNKNOWN
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
            if signal not in _coerce_warned_signals:
                _coerce_warned_signals.add(signal)
                logger.warning(
                    "Coercing non-numeric 'value' samples to null on signal=%s "
                    "(first this flush; example %r -> value_text=%r); "
                    "%d row(s) coerced since start",
                    signal,
                    raw,
                    coerced_text,
                    _coerced_rows,
                )

        yield {
            "file_name":     file_name,
            "upload_id":     upload_id,
            "platform":      platform,
            "device":        device,
            "route":         route,
            "segment":       segment,
            "dcm_config_id": dcm_config_id,
            "signal":        signal,
            "unit":          unit,
            "channel_name":  channel_name,
            "frame_name":    frame_name,
            "sender_node":   sender_node,
            "ts_ms":         ts_arr[i],
            "value":         num,
            "value_text":    None if text is None else str(text),
        }


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

if __name__ == "__main__":
    app.run()
