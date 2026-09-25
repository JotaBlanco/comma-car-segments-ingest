import logging
import math
import os
import pathlib
import shutil
import tempfile
import time

import numpy as np
import pandas as pd
from asammdf import MDF
from quixportal.storage import get_filesystem
from quixstreams import Application, State
from quixstreams.dataframe.joins.lookups import QuixConfigurationService

import dcm_dbc
import identity
from decodability import DECODING_OFF, decode_failure
from idempotency import decode_identity, log_mode, mark_decoded, needs_decode
from inventory import FileInventory
from marker import build_marker
from provenance import (
    UNKNOWN,
    UNKNOWN_FRAME,
    build_group_bus_names,
    build_provenance,
    build_signal_frame_map,
    parse_bus_channels,
    parse_header_properties,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mf4-decoder")

# Tuning knobs ---------------------------------------------------------------
# FRAME_CHUNK is only used by the legacy object-dtype (string/bytes) fallback
# path. The numeric fast path is fully vectorized and slices directly by
# BATCH_RECORDS, so FRAME_CHUNK has no effect on numeric channels.
FRAME_CHUNK = int(os.getenv("FRAME_CHUNK", "1000"))      # MDF read chunk; unrelated to batching
BATCH_RECORDS = int(os.getenv("BATCH_RECORDS", "100"))   # Records per Kafka message (cluster size)
FLUSH_EVERY = int(os.getenv("FLUSH_EVERY", "1000"))      # librdkafka flush every N batches (was: N samples)

# Rung 3 of the run-key ladder. It MUST be the value tm-connector reads from its
# own TM_RUN_KEY_PATTERN: the two apps climb the same ladder over the same
# message and a different pattern here is a silent disagreement about which run
# a file belongs to. See identity.py.
TM_RUN_KEY_PATTERN = os.getenv("TM_RUN_KEY_PATTERN", identity.DEFAULT_RUN_KEY_PATTERN)

# The wire discriminator every message on the output topic carries. tm-connector
# accumulates "samples" and finalizes on KIND_FILE_COMPLETE (marker.py, which
# owns that spelling); the lake sink expands "samples" and skips the marker. A
# batch with no `kind` at all is one an older decoder wrote, and both readers
# still treat it as samples — which is what makes this rollout safe over a topic
# that already holds a backlog.
KIND_SAMPLES = "samples"

# CAN bus-logging decode -----------------------------------------------------
# "dcm" (default): decode with the database held in the Dynamic Configuration
# Manager, resolved by vehicle platform. "embedded": use the DBC the MF4 carries
# as an attachment. "none": do not decode.
#
# `dcm` is the default because the database is then external and versioned: one
# document per platform, editable in the Configurations UI, with every change a
# new version rather than a re-upload of every affected recording. An embedded
# DBC is frozen into the file at write time and cannot be corrected afterwards.
DBC_SOURCE = os.getenv("DBC_SOURCE", "dcm").strip().lower()

# Configuration type the databases are stored under in DCM. Fixed at
# pipeline-build time by QuixConfigurationService - only the target_key varies
# per message - so changing it here orphans every existing lookup.
DCM_TYPE = os.getenv("DCM_TYPE", "dbc")

# Platform used as the DCM target_key when the metadata message does not carry
# one. The platform is written in the MF4 header, which cannot be read until the
# file has been downloaded and opened - by which time the lookup has already
# run - so a deployment ingesting one platform names it here.
DBC_PLATFORM = os.getenv("DBC_PLATFORM", "").strip()

# Column the lookup writes the resolved document into, and the column it keys on.
F_DBC_DOC = "dcm_dbc_doc"
F_DCM_KEY = "dcm_target_key"

# MDF4 channel-group flag / bus-type values, copied from
# asammdf/blocks/v4_constants.py (FLAG_CG_BUS_EVENT, BUS_TYPE_CAN). Copied
# rather than imported: that module is asammdf-internal and has moved between
# major versions.
FLAG_CG_BUS_EVENT = 1 << 1
BUS_TYPE_CAN = 2

# Raw CAN frame channel written by MDF4 bus-logging recorders. Its presence in
# a channel group is what marks that group as frames, not signals. Members are
# exposed as "CAN_DataFrame.ID", "CAN_DataFrame.DataBytes", ...
CAN_FRAME_CHANNEL = "CAN_DataFrame"

_fs = None


def get_fs():
    global _fs
    if _fs is None:
        _fs = get_filesystem()
        logger.info("Blob filesystem initialised: %s", type(_fs).__name__)
    return _fs



# consumer_group is a hard-coded constant on purpose. The decode-once State
# store is backed by a changelog topic whose name embeds the group
# (changelog__<group>--<topic>--<store>), so rotating the group abandons the
# dedup state along with the offsets and the next run re-decodes every file
# in mf4_metadata - which is how mf4_signals_v4 collected 5 copies of every
# row. Keeping it out of app.yaml means the portal cannot rotate it.
#
# commit_every=1 checkpoints after each metadata message, i.e. after each
# file, so the decoded marker becomes durable as soon as that file batches
# are flushed rather than up to commit_interval later. That window is what
# an OOM kill mid-decode used to exploit.
app = Application(
    consumer_group="mf4-decoder-v3",
    auto_offset_reset="earliest",
    commit_every=1,
)
input_topic = app.topic(os.environ["input"], value_deserializer="json")
output_topic = app.topic(os.environ["output"], value_serializer="json")
producer = app.get_producer()


def _to_jsonable(v):
    if v is None:
        return None
    if isinstance(v, (bytes, bytearray, np.bytes_)):
        b = bytes(v)
        try:
            return b.decode("utf-8")
        except UnicodeDecodeError:
            return b.hex()
    if isinstance(v, np.ndarray):
        if v.size == 1:
            return _to_jsonable(v.item())
        return [_to_jsonable(x) for x in v.tolist()]
    if isinstance(v, pd.Timestamp):
        return v.isoformat()
    if hasattr(v, "item"):
        try:
            v = v.item()
        except (ValueError, AttributeError):
            return v
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    return v


# ✅ NEW: hard safety wrapper (prevents crashes)
def _safe_value(v):
    v = _to_jsonable(v)

    if v is None:
        return None

    # 🚨 ensure only scalar types go to DataLake
    if isinstance(v, (list, dict)):
        return str(v)

    return v


def _safe_text(v):
    """JSON-safe *string* form of one sample taken from a non-numeric channel.

    Text channels put every sample in ``value_text``, so the sample is
    stringified here instead of being left as whatever type ``_safe_value``
    happened to produce - that keeps the column a single Arrow type. Returns
    ``None`` for samples that carry nothing (None / NaN / undecodable), which
    the caller drops.
    """
    v = _safe_value(v)
    if v is None:
        return None
    if isinstance(v, str):
        return v
    return str(v)


def _is_numeric_dtype(dtype) -> bool:
    """True when a channel's samples belong in the float ``value`` column.

    Numeric-vs-text is decided once per channel from the numpy dtype, never
    per sample. Every sample of a numeric channel is emitted as a float in
    ``value`` with ``value_text=None``; every sample of a non-numeric channel
    is emitted as a string in ``value_text`` with ``value=None``. Mixing the
    two inside one column is what made PyArrow infer ``double`` from the
    leading rows and then fail on the first DBC ``VAL_`` table string.

    Booleans count as numeric (0.0 / 1.0). Complex, datetime, void/structured
    and object/bytes/str dtypes are all text.
    """
    return (
        np.issubdtype(dtype, np.integer)
        or np.issubdtype(dtype, np.floating)
        or dtype == np.bool_
    )


def _record_base(file_scalars, signal, unit, channel_name, frame_name, sender_node):
    """Every scalar one signal's batches repeat, as a single flat dict.

    ``file_scalars`` is the per-file half (``file_name``, ``upload_id`` and the
    header provenance); the rest is the per-signal identity. Insertion order
    here is the JSON wire order and therefore the sink's column order, so
    provenance stays first and the value arrays are appended last by
    ``_produce_batch``.

    ``signal`` is the signal name (``ACCMode``); ``channel_name`` is the CAN bus
    name (``powertrain_hs_can1``). They are not variants of each other - the
    pair matches the reference ``can_signals_v13`` table. This key was called
    ``channel`` before the ``mf4_signals_v3`` table; the sink still accepts that
    spelling so the ``mf4-to-msg`` backlog written by the old decoder replays.

    Every PARTITIONING value is a non-empty string by construction - see
    ``provenance.UNKNOWN``. None of those may be ``None``: they become Hive
    partition keys (physical or virtual) downstream, and a null partition value
    either drops the row or defeats the catalog's pruning index. The
    traceability claims partition nothing and are null when unclaimed
    (``identity.resolve_claims``, and ``run_id``, whose absence drops the batch
    at the sink rather than defaulting it).
    """
    base = dict(file_scalars)
    base["signal"] = signal
    base["unit"] = unit
    base["channel_name"] = channel_name
    base["frame_name"] = frame_name
    base["sender_node"] = sender_node
    return base


def _produce_batch(record_base, ts_buf, val_buf, text_buf):
    """Serialize a per-channel scalar+array payload as one Kafka message and produce it.

    ``record_base`` carries every scalar the batch repeats (see
    ``_record_base``). Threading it as one dict instead of a dozen positional
    arguments is deliberate: it makes the two emit paths - the vectorized
    numeric one and the object/bytes fallback - structurally incapable of
    drifting apart, because both hand the *same* object through. Adding a
    column to one path and forgetting the other is exactly how ``upload_id``
    could have been silently dropped for string channels.

    The Kafka key is the emitted ``signal`` name (matches the ``signal``
    field in the payload). For multi-group signals this is the qualified
    form (``"<name>#g<group_idx>"``) on second-and-later occurrences so each
    distinct stream gets its own key.

    ``value`` and ``value_text`` are *both* always present and always the same
    length as ``ts_ms``. One of the two is an all-``None`` list, chosen per
    channel by ``_is_numeric_dtype``. Omitting a key on some batches would
    give the sink an unstable schema, which is the bug this split exists to
    prevent - so callers pass an explicit ``[None] * len(ts_buf)`` rather than
    dropping the unused column.
    """
    payload = dict(record_base)
    payload["ts_ms"] = ts_buf
    payload["value"] = val_buf
    payload["value_text"] = text_buf

    signal = record_base["signal"]
    try:
        msg = output_topic.serialize(key=signal, value=payload)
        producer.produce(
            topic=output_topic.name,
            key=msg.key,
            value=msg.value,
        )
    except Exception as e:
        logger.error(
            "Produce failed for batch (%s/%s, %d records): %s",
            record_base.get("file_name"), signal, len(ts_buf), e,
        )


def _produce_marker(
    *,
    metadata,
    filename,
    upload_id,
    declared,
    header_properties,
    inv,
    decode_error=None,
    samples_suppressed=None,
):
    """Emit the ONE terminal `file_complete` message for a file.

    The payload is built by `marker.build_marker`, which is a pure function so
    the contract test can feed it to tm-connector's real readers and then to the
    registry's real models. This half is the produce call and nothing else.

    It is produced ONCE, after the last batch has been flushed, so a registry
    that reads it can rely on the rows already being on their way to the lake.
    A file that failed to decode gets one too, carrying `decode_error`: a decode
    failure is the PRODUCER's to state, and a file that never produced a marker
    is invisible to the registry rather than visibly broken.
    """
    time_start_ms, time_end_ms = inv.window
    payload = build_marker(
        metadata=metadata,
        filename=filename,
        upload_id=upload_id,
        declared=declared,
        header_properties=header_properties,
        inventory_rows=inv.rows(),
        time_start_ms=time_start_ms,
        time_end_ms=time_end_ms,
        unknown=UNKNOWN,
        decode_error=decode_error,
        samples_suppressed=samples_suppressed,
    )
    try:
        msg = output_topic.serialize(key=str(upload_id or filename), value=payload)
        producer.produce(topic=output_topic.name, key=msg.key, value=msg.value)
        producer.flush()
    except Exception as e:
        # A lost marker costs this file its registration, and nothing else: the
        # samples are already in the lake. Kafka redelivers the metadata message
        # if the offset was never committed, and the decode-once filter makes
        # that replay cheap.
        logger.error("Produce failed for the file_complete marker of %s: %s", filename, e)


def _emit_channel(
    record_base, timestamps, samples, start_ms, total_msgs, total_samples, inv=None,
):
    """Emit one channel's samples as BATCH_RECORDS-sized Kafka messages.

    Numeric (int/float) channels go through a fully vectorized fast path:
    timestamp conversion, NaN/Inf scrubbing and scalar coercion happen in
    numpy, then a single ``tolist()`` materializes JSON-ready Python lists.
    The per-element ``_safe_text`` loop is only used for the rare
    object/bytes dtype channels (string/bytes payloads) where vectorization
    doesn't apply.

    Which of the two value columns a channel fills is decided once, here, from
    the samples' dtype: the numeric fast path fills ``value`` (float) and nulls
    ``value_text``, the object/bytes path fills ``value_text`` (str) and nulls
    ``value``. Both paths emit both keys.

    ``record_base`` is passed through untouched by both paths, so every scalar
    column (``upload_id``, ``platform``, ``device``, ``route``, ``segment``,
    ``dcm_config_id``, ``channel_name``, ``frame_name``, ``sender_node``)
    reaches numeric and string channels alike.

    ``inv`` is the file's channel catalogue. Every channel reports itself to it
    exactly once, INCLUDING the two that leave without producing a batch: a
    channel that is in the file and missing from the catalogue is invisible in
    the one place an engineer looks it up. See inventory.py.

    Returns updated (total_msgs, total_samples).
    """
    signal = record_base["signal"]
    unit = record_base["unit"]
    arr = np.asarray(samples)

    # Empty channel after dtype detection: nothing to emit. _channel_has_data
    # used to filter these upstream; with that check removed, drop here.
    if len(arr) == 0:
        if inv is not None:
            inv.declare(signal, unit)
        return total_msgs, total_samples

    if _is_numeric_dtype(arr.dtype):
        # Vectorized numeric fast path -----------------------------------
        ts_full = (start_ms + (np.asarray(timestamps, dtype=np.float64) * 1000.0)).astype(np.int64)

        # Widen every numeric channel (int, bool, float32, ...) to float64 so
        # the whole `value` column is one Python type. A file mixing int and
        # float channels would otherwise hand PyArrow a mixed int/float list.
        arr = arr.astype(np.float64, copy=False)

        ok = np.isfinite(arr)
        if not ok.all():
            ts_full = ts_full[ok]
            arr = arr[ok]
        # All-NaN/Inf channel: nothing emittable left after the mask. It is
        # still a channel of this file, so it is catalogued without statistics
        # — there is no finite sample to compute one from.
        if len(arr) == 0:
            if inv is not None:
                inv.declare(signal, unit)
            return total_msgs, total_samples

        ts_list = ts_full.tolist()
        val_list = arr.tolist()
        n = len(val_list)

        # Measured over the WHOLE channel, before it is sliced into batches, so
        # the numbers describe the signal rather than its last batch.
        if inv is not None:
            inv.observe_numeric(signal, unit, ts_list, val_list)

        for offset in range(0, n, BATCH_RECORDS):
            end = min(offset + BATCH_RECORDS, n)
            _produce_batch(
                record_base,
                ts_list[offset:end], val_list[offset:end],
                [None] * (end - offset),
            )
            total_msgs += 1
            total_samples += end - offset
            if total_msgs % FLUSH_EVERY == 0:
                producer.flush()

        return total_msgs, total_samples

    # Object / bytes / string dtype slow path ---------------------------
    # Keep the existing per-element loop here; bytes->hex fallback and
    # isinstance gymnastics still matter for these channels. Everything this
    # path produces goes to `value_text`, including the DBC `VAL_` value-table
    # strings ('D', 'P', 'R', ...) that used to land in the numeric column.
    n = len(samples)
    ts_buf = []
    text_buf = []
    # The three numbers the catalogue needs from a path that never holds the
    # whole channel: how many samples survived, and the two ends of the window.
    text_count = 0
    text_first_ts = None
    text_last_ts = None

    for offset in range(0, n, FRAME_CHUNK):
        ts_chunk = timestamps[offset:offset + FRAME_CHUNK]
        smp_chunk = samples[offset:offset + FRAME_CHUNK]

        for t, v in zip(ts_chunk, smp_chunk):
            safe_v = _safe_text(v)
            if safe_v is None:
                continue

            ts_ms = start_ms + int(float(t) * 1000)
            ts_buf.append(ts_ms)
            text_buf.append(safe_v)
            total_samples += 1
            text_count += 1
            if text_first_ts is None:
                text_first_ts = ts_ms
            text_last_ts = ts_ms

            if len(ts_buf) >= BATCH_RECORDS:
                _produce_batch(
                    record_base, ts_buf, [None] * len(ts_buf), text_buf,
                )
                ts_buf, text_buf = [], []
                total_msgs += 1
                if total_msgs % FLUSH_EVERY == 0:
                    producer.flush()

    if ts_buf:
        _produce_batch(
            record_base, ts_buf, [None] * len(ts_buf), text_buf,
        )
        total_msgs += 1

    if inv is not None:
        if text_count:
            inv.observe_text(signal, unit, text_count, text_first_ts, text_last_ts)
        else:
            # Every sample was unreadable. The channel is in the file.
            inv.declare(signal, unit, dtype="str")

    return total_msgs, total_samples


def _is_can_bus_logging_group(group) -> bool:
    """True if this channel group holds raw CAN frames rather than signals.

    Two independent tests, either of which is sufficient:

    1. The MDF4 metadata test that asammdf itself applies in
       ``MDF4._extract_can_logging``: the channel group carries the
       ``CG_BUS_EVENT`` flag and its acquisition source is a CAN bus. Groups
       failing this test are the ones asammdf will refuse to decode.
    2. The channel-name test: the group exposes ``CAN_DataFrame`` or one of its
       ``CAN_DataFrame.<field>`` members.

    Test 2 is what actually decides whether emitting the group would put raw
    frame fields (``CAN_DataFrame.ID``, ``CAN_DataFrame.DataBytes``, ...) on the
    wire, and files in the wild do not always set the MDF4 flags correctly.
    ``channel_group.acq_name`` (typically ``"CAN"``) is logged for diagnostics
    but is never a trigger on its own: it is free text and nothing stops an
    ordinary measurement from using the same string.
    """
    channel_group = getattr(group, "channel_group", None)
    if channel_group is not None:
        flags = getattr(channel_group, "flags", 0) or 0
        acq_source = getattr(channel_group, "acq_source", None)
        bus_type = getattr(acq_source, "bus_type", None) if acq_source else None
        if flags & FLAG_CG_BUS_EVENT and bus_type in (None, BUS_TYPE_CAN):
            return True

    prefix = CAN_FRAME_CHANNEL + "."
    for channel in getattr(group, "channels", ()) or ():
        name = getattr(channel, "name", "") or ""
        if name == CAN_FRAME_CHANNEL or name.startswith(prefix):
            return True

    return False


def _find_can_bus_logging_groups(mdf) -> set[int]:
    """Physical indices of every channel group in ``mdf`` that holds raw CAN frames."""
    found: set[int] = set()
    for index, group in enumerate(mdf.groups):
        if _is_can_bus_logging_group(group):
            found.add(index)
            acq_name = getattr(getattr(group, "channel_group", None), "acq_name", "")
            logger.info("Channel group %d is CAN bus logging (acq_name=%r)", index, acq_name)
    return found


def _bus_group_totals(mdf, group_indices):
    """(raw channel count, frame count) across ``group_indices``, from metadata only."""
    channels = 0
    frames = 0
    for index in group_indices:
        group = mdf.groups[index]
        channels += len(getattr(group, "channels", ()) or ())
        frames += int(getattr(group.channel_group, "cycles_nr", 0) or 0)
    return channels, frames


def _find_dbc_attachments(mdf) -> list[int]:
    """Indices of the attachments that look like a CAN database.

    An attachment matches on either its mime type (``application/x-dbc``; any
    mime containing "dbc" is accepted because writers are inconsistent here) or
    a ``.dbc`` filename suffix. *All* matches are returned rather than the first
    one: a recording may embed one database per bus, and ``extract_bus_logging``
    takes a list.
    """
    matches = []
    for index, attachment in enumerate(getattr(mdf, "attachments", None) or ()):
        mime = str(getattr(attachment, "mime", "") or "").lower()
        file_name = str(getattr(attachment, "file_name", "") or "").lower()
        if file_name.endswith(".dbc") or "dbc" in mime:
            matches.append(index)
    return matches


def _extract_dbc_files(mdf, attachment_indices, target_dir):
    """Write the embedded CAN databases to real files under ``target_dir``.

    ``extract_bus_logging`` calls ``Path()`` on every database entry, so an
    in-memory buffer is rejected with ``TypeError`` - the database has to exist
    on disk. asammdf also dispatches its parser on the file suffix (see
    ``asammdf.blocks.utils.load_can_database``), hence the forced ``.dbc``
    extension. The index-based name is deliberate: the attachment's own file
    name is arbitrary text from the writer and is used only for logging.
    """
    paths = []
    for index in attachment_indices:
        try:
            data, source_name, _md5 = mdf.extract_attachment(index=index)
        except Exception:
            logger.exception("Could not extract attachment %d", index)
            continue

        # extract_attachment decodes text/* attachments to str, and returns an
        # empty bytes object when extraction failed internally.
        if isinstance(data, str):
            data = data.encode("utf-8")
        if not data:
            logger.warning("Attachment %d (%s) extracted empty - ignoring", index, source_name)
            continue

        dbc_path = target_dir / f"embedded_{index}.dbc"
        dbc_path.write_bytes(bytes(data))
        paths.append(dbc_path)
        logger.info(
            "Extracted embedded CAN database %s (%d bytes) -> %s",
            source_name, len(data), dbc_path,
        )

    return paths


def _decode_can_bus_logging(mdf, target_dir, dcm_doc=None, platform=UNKNOWN):
    """Decode raw CAN frames into named signals using the file's own DBC.

    Returns ``(decoded_mdf, dbc_paths, dbc_reason)``. ``decoded_mdf`` is one
    channel group per CAN message with one channel per signal, or ``None`` when
    no usable database is available.

    ``dbc_reason`` is ``None`` on success and one short sentence on every path
    that returns no database. It becomes the file's quarantine reason via
    ``decodability.decode_failure``, so it names the cause rather than the
    symptom, and it renders as a table cell - keep it under ~120 characters and
    free of stack traces.

    ``dbc_paths`` is returned alongside because the same on-disk databases are
    read a second time, by ``provenance.build_signal_frame_map``, to recover the
    frame and transmitting ECU of each signal. Those two facts live only in the
    DBC - the MF4 header has no trace of them - and re-extracting the
    attachment just to read them again would be wasted work.
    """
    if DBC_SOURCE == "none":
        logger.warning("DBC_SOURCE=none - CAN bus logging will not be decoded")
        return None, [], DECODING_OFF

    if DBC_SOURCE == "dcm":
        # The document arrived on the message from the DCM lookup. `fallback` and
        # the field default both yield None, so an absent configuration lands here
        # as None rather than as an exception - which is why this is a warning and
        # a return, not a raise.
        if not dcm_doc:
            logger.warning(
                "No DCM database resolved for this file - nothing can be decoded. "
                "Check that a '%s' configuration exists for its platform.",
                DCM_TYPE,
            )
            return None, [], f"no CAN database resolved for platform {platform}"
        try:
            dbc_path, dropped = dcm_dbc.materialise(dcm_doc, target_dir / "dcm.dbc")
        except Exception:
            logger.exception("Could not turn the DCM document into a loadable database")
            return None, [], (
                f"the DCM document for {platform} is not a loadable database"
            )
        database_files = {"CAN": [(str(dbc_path), 0)]}
        try:
            return mdf.extract_bus_logging(database_files=database_files), [dbc_path], None
        except Exception:
            logger.exception("extract_bus_logging failed with the DCM database")
            return None, [dbc_path], (
                f"extract_bus_logging failed with the {platform} database"
            )

    if DBC_SOURCE != "embedded":
        logger.warning("Unknown DBC_SOURCE=%r - treating it as 'embedded'", DBC_SOURCE)

    attachment_indices = _find_dbc_attachments(mdf)
    if not attachment_indices:
        logger.warning(
            "CAN bus-logging file has no embedded .dbc attachment "
            "(%d attachment(s) present) - no signals can be decoded",
            len(getattr(mdf, "attachments", None) or ()),
        )
        return None, [], "the file carries no embedded .dbc attachment"

    dbc_paths = _extract_dbc_files(mdf, attachment_indices, target_dir)
    if not dbc_paths:
        logger.warning("No embedded CAN database could be extracted - nothing to decode")
        return None, [], "no embedded CAN database could be extracted"

    # Bus channel 0 means "applies to any bus channel". The embedded database is
    # by definition the one that describes this file's buses, so there is no
    # per-channel mapping to guess at.
    database_files = {"CAN": [(str(path), 0) for path in dbc_paths]}
    try:
        return mdf.extract_bus_logging(database_files=database_files), dbc_paths, None
    except Exception:
        logger.exception(
            "extract_bus_logging failed with %d embedded database(s)", len(dbc_paths)
        )
        return None, dbc_paths, "extract_bus_logging failed with the embedded database(s)"


def _emit_signals(
    signals, file_scalars, start_ms, seen_names, total_msgs, total_samples,
    signal_frame_map=None, bus_names=None, inv=None,
):
    """Emit an iterable of asammdf ``Signal`` objects.

    Signal names repeat: across channel groups in ordinary MF4s, and across CAN
    message groups in a decoded bus-logging file where one signal name can
    appear in several messages. The first occurrence of a name keeps the bare
    name; later ones are qualified as ``"<name>#g<group_index>"`` so every
    stream gets a distinct Kafka key. ``seen_names`` is shared across every call
    made for one file, so decoded and raw streams cannot collide.

    ``file_scalars`` (``file_name``, ``upload_id`` and the header provenance) is
    merged with the per-signal identity into one ``record_base`` that
    ``_emit_channel`` puts on every batch of both the numeric and the
    object/bytes emit path. So is the ``value`` / ``value_text`` split:
    ``_emit_channel`` routes each signal to one of the two columns from its
    dtype, so signals decoded from a DBC ``VAL_`` value table (which come back
    as strings) never share a column with numeric signals.

    ``signal_frame_map`` and ``bus_names`` are supplied only for the decoded-CAN
    pass. The lookup is by the signal's **bare** name, never by the emitted
    signal name, because the latter may carry a ``#g<idx>`` disambiguation
    suffix that no DBC knows about. Ordinary (non bus-logging) channels pass
    neither and fall back to ``UNKNOWN`` for all three DBC-derived columns -
    they have no CAN frame, no transmitting ECU and no bus.

    Returns (total_msgs, total_samples, channels_emitted).
    """
    emitted = 0

    for sig in signals:
        name = sig.name
        occ = seen_names.get(name, 0)
        seen_names[name] = occ + 1

        group_idx = getattr(sig, "group_index", -1)
        if occ == 0:
            emit_signal = name
        elif group_idx is not None and group_idx >= 0:
            emit_signal = f"{name}#g{group_idx}"
        else:
            emit_signal = f"{name}#g{occ}"

        unit = getattr(sig, "unit", "") or ""
        if not isinstance(unit, str):
            unit = str(unit)

        samples = sig.samples
        if len(samples) == 0:
            # Read the unit first, then skip: a channel with no samples still
            # earns a catalogue row, and a row is worth more with its unit on
            # it. `_emit_channel` catalogues every other channel; this one never
            # reaches it.
            if inv is not None:
                inv.declare(emit_signal, unit)
            continue

        # Bare name, not emit_signal: a "#g<idx>"-qualified name is our own
        # invention and would never match a DBC entry.
        frame_name, sender_node = (
            signal_frame_map.get(name, UNKNOWN_FRAME)
            if signal_frame_map
            else UNKNOWN_FRAME
        )
        channel_name = bus_names.get(group_idx, UNKNOWN) if bus_names else UNKNOWN

        record_base = _record_base(
            file_scalars, emit_signal, unit, channel_name, frame_name, sender_node,
        )

        total_msgs, total_samples = _emit_channel(
            record_base, sig.timestamps, samples,
            start_ms, total_msgs, total_samples, inv=inv,
        )
        emitted += 1

    return total_msgs, total_samples, emitted


def process(metadata: dict, state: State):
    blob_path = metadata.get("blob_path")
    filename = metadata.get("filename")
    # Pipeline-wide unique key minted by mf4-to-blob (metadata.make_upload_id).
    # Carried on the "id" field of mf4_metadata and forwarded onto every
    # decoded batch so it survives all the way to the Iceberg table.
    upload_id = metadata.get("id")

    if not upload_id:
        logger.warning(
            "Metadata message has no 'id' - lake rows will have a null "
            "upload_id. Keys: %s",
            list(metadata.keys()),
        )

    if not blob_path or not filename:
        logger.warning(
            "Skipping message - missing blob_path or filename. Keys: %s",
            list(metadata.keys()),
        )
        return

    logger.info("Processing file: %s from blob path: %s", filename, blob_path)

    with tempfile.NamedTemporaryFile(suffix=".mf4", delete=False) as tmp:
        tmp_path = tmp.name

    # Initialised before the try so the finally can release them even if the
    # download raises.
    dbc_dir = None
    decoded = None

    # Initialised before the try for the same reason the two above are: the
    # failure path produces a `file_complete` marker, and it must be able to
    # report whatever the decode got as far as resolving. A download that raises
    # leaves all three at these values, which say "nothing was learned" rather
    # than raising a second time inside the error handler.
    declared = metadata.get("declared") if isinstance(metadata.get("declared"), dict) else {}
    header_properties = {}
    inv = FileInventory()

    try:
        # --- Phase: download --------------------------------------------
        t_phase = time.monotonic()
        fs = get_fs()
        fs.get(blob_path, tmp_path)

        downloaded_size = os.path.getsize(tmp_path)
        logger.info("Downloaded %s (%d bytes)", blob_path, downloaded_size)

        expected_size = metadata.get("size_bytes")
        if expected_size and downloaded_size != expected_size:
            raise ValueError(
                f"Download size mismatch: got {downloaded_size}, expected {expected_size}"
            )
        download_ms = int((time.monotonic() - t_phase) * 1000)

        # --- Phase: open MDF + read header ------------------------------
        t_phase = time.monotonic()
        mdf = MDF(tmp_path)
        start_ms = int(mdf.header.start_time.timestamp() * 1000)

        # Provenance comes out of the file's own HD comment: an MF4 written by
        # rlog-to-mf4 already states which platform / device / route / segment
        # it came from and which DBC revision (dcm.config_id) is authoritative
        # for decoding it. Files uploaded straight from a browser have none of
        # these keys and get the literal "unknown" for each - never None,
        # because these are Hive partition keys downstream.
        header_properties = parse_header_properties(mdf)
        provenance_fields = build_provenance(header_properties)
        # `platform` is the one provenance field the message may answer: under
        # the default DBC_SOURCE=dcm it is the target_key the CAN database was
        # resolved with (F_DCM_KEY, computed before the download), so the
        # partition has to name the platform the decode actually used.
        if declared_platform := str(metadata.get("platform") or "").strip():
            provenance_fields["platform"] = declared_platform
        bus_channels = parse_bus_channels(header_properties)

        # upload_id is defaulted the same way for the same reason. It stopped
        # being the sole Hive partition when the table moved to
        # platform/device/route, but an all-null column still makes PyArrow
        # infer a null type and fail the parquet write.
        # --- The Test Manager identity ----------------------------------
        # The run key is resolved HERE, once, and every message this file
        # produces carries the answer: the batches as the `run_id` partition
        # column, the terminal marker inside the `declared` bag tm-connector
        # reads on rung 1 of its own ladder. Resolving it twice is how the
        # registry and the lake come to disagree about which run a file is —
        # identity.py says what that costs.
        declared, run_id = identity.resolve_identity(
            metadata.get("declared"),
            header_properties,
            filename,
            TM_RUN_KEY_PATTERN,
            provenance_fields,
            UNKNOWN,
        )

        file_scalars = {
            "kind": KIND_SAMPLES,
            "file_name": filename,
            "upload_id": upload_id or UNKNOWN,
            **provenance_fields,
            # The lake's traceability columns. `run_id` is the one column whose
            # absence drops the row rather than defaulting it (the sink refuses
            # to place a batch that names no run), so it stays None when nothing
            # resolved one instead of becoming a sentinel that would merge every
            # unplaceable file into one partition.
            "run_id": run_id,
            # `work_order` stays: the lake sink joins its WorkOrder configuration
            # on it for the platform fallback. There is no `test_definition`
            # column — a run fulfils a SET of definitions, and a row can sit in
            # only one directory, so the registry answers run -> definitions.
            "work_order": identity.resolve_work_order(
                metadata, declared, header_properties
            ),
            # Plain columns, not partition keys: the car the recording came off
            # and the rig it ran on. They answer "which bench, which vehicle"
            # inside a lake query, which until now only the registry could
            # answer. Null when nothing claims them — see `resolve_claims`.
            **identity.resolve_claims(declared, header_properties),
        }

        logger.info(
            "Provenance for %s: platform=%s device=%s route=%s segment=%s "
            "dcm_config_id=%s bus_channels=%s",
            filename,
            provenance_fields["platform"],
            provenance_fields["device"],
            provenance_fields["route"],
            provenance_fields["segment"],
            provenance_fields["dcm_config_id"],
            bus_channels or "none",
        )
        mdf_open_ms = int((time.monotonic() - t_phase) * 1000)

        # --- Phase: CAN bus-logging detection + embedded-DBC decode -----
        # A bus-logging MF4 stores raw CAN frames, not signals: its channels
        # are CAN_DataFrame.ID / .DataBytes / .DLC and friends. Emitting those
        # would fill the signals table with frame plumbing, so instead the
        # frames are decoded with the DBC the file carries as an attachment.
        t_phase = time.monotonic()
        bus_groups = _find_can_bus_logging_groups(mdf)
        raw_bus_channels = 0
        raw_bus_frames = 0
        # Why no database was resolved, or None. Stays None for a file with no
        # bus-logging group, which asks for no database.
        dbc_reason = None
        # The name the DBC was looked up under: under DBC_SOURCE=dcm the lookup
        # wrote its target key onto the message, so it is the platform the
        # decode actually asked DCM for, not the one the header states.
        dbc_platform = str(metadata.get(F_DCM_KEY) or provenance_fields["platform"])
        # signal name -> (frame_name, sender_node), and decoded group index ->
        # bus name. Empty for ordinary MF4s, which have neither.
        signal_frame_map: dict[str, tuple[str, str]] = {}
        bus_names: dict[int, str] = {}

        if bus_groups:
            raw_bus_channels, raw_bus_frames = _bus_group_totals(mdf, bus_groups)
            logger.info(
                "%s is a CAN bus-logging file: %d group(s), "
                "%d raw frame channel(s), %d frames",
                filename, len(bus_groups), raw_bus_channels, raw_bus_frames,
            )
            dbc_dir = pathlib.Path(tempfile.mkdtemp(prefix="mf4-dbc-"))
            decoded, dbc_paths, dbc_reason = _decode_can_bus_logging(
                mdf, dbc_dir, dcm_doc=metadata.get(F_DBC_DOC), platform=dbc_platform
            )

            if decoded is not None:
                # Second read of the same on-disk DBCs: asammdf uses them to
                # decode samples, canmatrix to tell us which frame each signal
                # belongs to and which ECU transmits it.
                signal_frame_map = build_signal_frame_map(dbc_paths)
                bus_names = build_group_bus_names(decoded, bus_channels)

        dbc_ms = int((time.monotonic() - t_phase) * 1000)

        total_msgs = 0       # batches produced (was: samples produced)
        total_samples = 0    # total per-sample records emitted
        decoded_signals = 0  # named CAN signals emitted from the embedded DBC

        # --- Phase: decode + per-batch produces -------------------------
        t_phase = time.monotonic()
        # Walk physical-order with iter_channels: faster than per-name
        # mdf.get() because asammdf reads each group once via select().
        # Multi-group occurrences yield once per (group, channel); use the
        # first-seen-bare-name / "#g<idx>" suffix rule on subsequent ones.
        seen_names: dict[str, int] = {}

        # Decoded CAN signals first, so they take the bare (unqualified) names.
        if decoded is not None:
            # Decoded signals only. The raw CAN_DataFrame.* channels of the
            # bus-logging groups are never emitted - they are replaced by the
            # named signals below. Masters of the decoded groups are skipped
            # too: a decoded group's master is just the frame timestamp, which
            # already rides on every batch as ts_ms.
            total_msgs, total_samples, decoded_signals = _emit_signals(
                decoded.iter_channels(skip_master=True),
                file_scalars, start_ms, seen_names,
                total_msgs, total_samples,
                signal_frame_map=signal_frame_map,
                bus_names=bus_names,
                inv=inv,
            )
            logger.info(
                "Decoded %d CAN signal(s) across %d message group(s) "
                "from the embedded DBC",
                decoded_signals, len(decoded.groups),
            )

        if bus_groups and decoded_signals == 0:
            logger.warning(
                "Dropping %d raw CAN frame channel(s) / %d frame(s) from %s: "
                "no decodable signals. Raw CAN_DataFrame.* fields are never "
                "written to the signals table (decoded-signals-only policy).",
                raw_bus_channels, raw_bus_frames, filename,
            )

        # None unless CAN frames went in and no signal came out. Then it is the
        # reason, and the marker below states it instead of registering the file
        # as a clean decode of nothing.
        decode_error = decode_failure(
            bus_frames=raw_bus_frames,
            decoded_signals=decoded_signals,
            dbc_reason=dbc_reason,
            platform=dbc_platform,
        )

        # Ordinary (non bus-logging) channel groups keep the original
        # behaviour: every channel is emitted as-is.
        #
        # Note on asammdf 8.8.9: iter_channels(skip_master=False) is documented
        # but the parameter is silently ignored — masters are never yielded.
        # We emit masters via an explicit second loop below to preserve the
        # prior wire format (where the "t"/"time" master appeared as its own
        # Kafka stream).
        total_msgs, total_samples, _ = _emit_signals(
            (
                sig
                for sig in mdf.iter_channels(skip_master=True)
                if getattr(sig, "group_index", -1) not in bus_groups
            ),
            file_scalars, start_ms, seen_names,
            total_msgs, total_samples,
            inv=inv,
        )

        # Emit master channels per-group (iter_channels in this asammdf
        # version skips them unconditionally). Master is at channel index 0
        # of every virtual group; re-use the same name-disambiguation rule.
        # virtual_groups is keyed by virtual group index, so the bus-logging
        # physical indices are mapped over before they can be used as a filter.
        bus_virtual_groups = {
            mdf.virtual_groups_map.get(index, index) for index in bus_groups
        }

        for group_idx in mdf.virtual_groups:
            if group_idx in bus_virtual_groups:
                continue

            try:
                master_sig = mdf.get(group=group_idx, index=0)
            except Exception:
                continue

            name = master_sig.name
            occ = seen_names.get(name, 0)
            seen_names[name] = occ + 1
            emit_signal = name if occ == 0 else f"{name}#g{group_idx}"

            samples = master_sig.samples
            if len(samples) == 0:
                continue

            unit = getattr(master_sig, "unit", "") or ""
            if not isinstance(unit, str):
                unit = str(unit)

            # Masters belong to ordinary groups only (bus-logging groups are
            # skipped above), so they have no CAN bus, frame or sender.
            record_base = _record_base(
                file_scalars, emit_signal, unit, UNKNOWN, UNKNOWN, UNKNOWN,
            )

            total_msgs, total_samples = _emit_channel(
                record_base, master_sig.timestamps, samples,
                start_ms, total_msgs, total_samples, inv=inv,
            )
        decode_ms = int((time.monotonic() - t_phase) * 1000)

        # --- Phase: trailing kafka flush --------------------------------
        t_phase = time.monotonic()
        producer.flush()
        kafka_ms = int((time.monotonic() - t_phase) * 1000)

        elapsed_ms = download_ms + mdf_open_ms + dbc_ms + decode_ms + kafka_ms

        if total_msgs == 0:
            logger.warning("No valid channels found in %s", filename)
        else:
            logger.info(
                "Produced %d msgs (%d samples, %d decoded CAN signals) for %s "
                "download_ms=%d mdf_open_ms=%d dbc_ms=%d decode_ms=%d "
                "kafka_ms=%d elapsed_ms=%d",
                total_msgs,
                total_samples,
                decoded_signals,
                filename,
                download_ms,
                mdf_open_ms,
                dbc_ms,
                decode_ms,
                kafka_ms,
                elapsed_ms,
            )

        # The terminal marker, and it goes BEFORE the decode-once mark: a
        # delivery that is about to be filtered out must not be the one that
        # skipped the file's only registration. Producing it twice is harmless
        # — the registry identifies a file by (run, checksum) and answers the
        # second one as a replay — while never producing it is not.
        _produce_marker(
            metadata=metadata,
            filename=filename,
            upload_id=upload_id,
            declared=declared,
            header_properties=header_properties,
            inv=inv,
            decode_error=decode_error,
            samples_suppressed=(
                None if run_id is not None else
                "the file names no run, so its rows have no lake partition"
            ),
        )

        # The file is decoded, every batch is flushed and the marker is out, so
        # record the mark that turns a replay of this metadata message into a
        # no-op instead of a second copy in the lake. Deliberately the last
        # statement of the try: anything that raised above leaves the file
        # unmarked and therefore retryable, so the mark is never more durable
        # than the rows it vouches for.
        #
        # Producing nothing is a completed decode only when there was nothing to
        # decode; `decode_failure` is what tells that apart from frames nothing
        # could read. A file whose frames could not be decoded stays UNMARKED,
        # so the same bytes decode again once the database is back. It is marked
        # anyway once rows exist: those are in the lake and a re-decode would
        # append a second copy.
        if decode_error is None or total_samples > 0:
            mark_decoded(state, metadata, samples=total_samples)
        else:
            logger.warning(
                "NOT marking %s decoded: %s. Restore the database in DCM and "
                "upload the same file again - it will decode, and that decode "
                "closes this one too (the dedup key is the file's sha256).",
                filename, decode_error,
            )

    except Exception as error:
        logger.exception(
            "Failed to process file %s (blob_path=%s)", filename, blob_path
        )
        # A file that failed to decode still reaches the registry, carrying the
        # reason. Without this the file is simply absent from the Test Manager,
        # which reads exactly like a file nobody uploaded. The marker is built
        # from whatever survived the failure — the three names are bound before
        # the try for exactly this reason, so a download that raised still
        # reports the file rather than raising again in the handler.
        try:
            _produce_marker(
                metadata=metadata,
                filename=filename,
                upload_id=upload_id,
                declared=declared,
                header_properties=header_properties,
                inv=inv,
                decode_error=f"{type(error).__name__}: {error}",
            )
        except Exception:
            logger.exception("Could not report the decode failure of %s", filename)
    finally:
        if decoded is not None:
            try:
                decoded.close()
            except Exception:
                logger.warning("Could not close the decoded MDF", exc_info=True)
        if dbc_dir is not None:
            shutil.rmtree(dbc_dir, ignore_errors=True)
        pathlib.Path(tmp_path).unlink(missing_ok=True)


sdf = app.dataframe(input_topic)

# Re-key onto the file identity before the decode-once filter. QuixStreams
# scopes State by the message key and mf4-to-blob keys mf4_metadata by
# upload_id, so without this hop the store would answer the wrong question:
# "have I seen this upload?" instead of "have I decoded these bytes?". The
# same file uploaded twice would then occupy two stores and decode twice.
# idempotency.py documents the identity chain and why sha256 beats upload_id.
sdf = sdf.group_by(
    decode_identity,
    name="decode-identity",
    key_serializer="string",
    key_deserializer="string",
)

# Replayed metadata is dropped here, ahead of the blob download: a skip costs
# one state read instead of a full re-decode and a duplicate copy in the lake.
sdf = sdf.filter(needs_decode, stateful=True)

if DBC_SOURCE == "dcm":
    # Resolve the CAN database from DCM. The lookup runs after the decode-once
    # filter so a replayed file costs one state read rather than a config fetch.
    #
    # `fallback="default"` is not optional: the SDK default is "error", which
    # re-raises inside join() and takes the application down when content cannot
    # be fetched. A per-field `default=` does not cover that - it is consulted
    # only when the configuration is absent, never when the fetch itself throws.
    #
    # jsonpath="$" pulls the whole document, which is a full copy per message.
    # That is a real cost to watch, but one message here is one MF4 file, not one
    # signal sample, so it is paid once per file rather than per row.
    lookup = QuixConfigurationService(
        app.topic(os.environ["config"]),
        app_config=app.config,
        fallback="default",
    )
    # The key is a column rather than a callable so the resolved value is visible
    # in the message for debugging, and so the lookup contract stays a plain
    # column reference.
    sdf[F_DCM_KEY] = sdf.apply(
        lambda value: str(value.get("platform") or DBC_PLATFORM or UNKNOWN)
    )
    sdf = sdf.join_lookup(
        lookup,
        {F_DBC_DOC: lookup.json_field(jsonpath="$", type=DCM_TYPE, default=None)},
        on=F_DCM_KEY,
    )

sdf = sdf.update(process, stateful=True)

log_mode()
app.run()
