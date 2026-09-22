"""The pure half of the sink: what one Kafka message becomes, and what it does not.

Split out of `main.py` so it can be read and TESTED without a broker: the module
body of `main.py` builds an Application and resolves the input topic's metadata,
which needs a live cluster. Every rule with a silent failure mode lives here —
the marker filter, the run-id drop, the claim defaults and the value/text split.
"""

import logging
import math

logger = logging.getLogger("mf4-datalake-sink.expand")

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

# What a claim column holds when nobody claimed the file. Distinct from UNKNOWN
# on purpose: "nobody assigned this file to a work order" is a different fact
# from "the file states no platform", and the two must not share a directory.
UNASSIGNED = "unassigned"

# The wire discriminator (mf4-decoder/main.py). Only the marker is refused; a
# message with no `kind` at all is a batch from the pre-integration decoder,
# which `earliest` replays and which must still be written.
KIND_FILE_COMPLETE = "file_complete"

# The configuration type the Test Manager files work orders under
# (api/api/config_push.py). Its `$.project` is the platform of the plan.
WORK_ORDER_CONFIG_TYPE = "WorkOrder"

# Where the joined platform lands before the expand reads it. A separate field,
# never `platform` itself: joining onto `platform` would overwrite what the MF4
# header measured with what a plan asserts.
F_WORK_ORDER_PLATFORM = "_work_order_platform"

# Batches dropped for naming no run, since the process started. Counted so one
# log line per drop cannot be mistaken for the whole story.
_dropped_no_run = 0


def is_sample_batch(value) -> bool:
    """True for a message this sink writes rows from.

    The terminal `file_complete` marker rides the same topic and carries an
    inventory instead of samples; it is tm-connector's message, not ours.
    Reading `value["ts_ms"]` on it would raise inside the expand and stall the
    checkpoint on a message that is perfectly valid.
    """
    if not isinstance(value, dict):
        return False
    return value.get("kind") != KIND_FILE_COMPLETE


def work_order_target_key(value, _key=None) -> str:
    """The `WorkOrder` target key for one batch: its work order id.

    Read through `.get`, never `value["work_order"]`: a batch that claims no
    work order yields a key no configuration matches, and an unmatched lookup
    fills the field's default instead of failing the whole checkpoint.
    """
    work_order = value.get("work_order") if isinstance(value, dict) else None
    return str(work_order or "")


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
    global _coerced_rows, _dropped_no_run

    # The traceability chain, resolved before anything else: a batch that names
    # no run has no partition to be placed in, and dropping it here costs one
    # dict read instead of expanding thousands of rows that cannot be written.
    #
    # It is DROPPED, not defaulted. `run_id=unknown/` would be a directory that
    # looks exactly like a real run and holds every unplaceable file in the
    # estate; a query for that run would answer with other files' samples. The
    # file itself is not lost — mf4-decoder's terminal marker still registers it,
    # and the registry quarantines it visibly, which is where an operator can
    # act on it.
    run_id = value.get("run_id")
    run_id = run_id.strip() if isinstance(run_id, str) else None
    if not run_id or run_id == UNKNOWN:
        _dropped_no_run += 1
        logger.warning(
            "%s: batch names no run (run_id=%r), so its rows have no partition "
            "and are dropped; %d dropped since start",
            value.get("file_name"), value.get("run_id"), _dropped_no_run,
        )
        return

    n = len(value["ts_ms"])
    file_name = value["file_name"]
    upload_id = value.get("upload_id") or UNKNOWN
    # The file's own answer wins; the work order's `project`, joined from
    # Dynamic Configuration, is the fallback for a file whose header named none.
    platform = value.get("platform") or UNKNOWN
    if platform == UNKNOWN:
        platform = value.get(F_WORK_ORDER_PLATFORM) or UNKNOWN
    work_order = value.get("work_order") or UNASSIGNED
    test_definition = value.get("test_definition") or UNASSIGNED
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
            "work_order":      work_order,
            "test_definition": test_definition,
            "run_id":          run_id,
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


