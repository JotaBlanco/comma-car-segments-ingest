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
from quixstreams import Application

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mf4-decoder")

# Tuning knobs ---------------------------------------------------------------
# FRAME_CHUNK is only used by the legacy object-dtype (string/bytes) fallback
# path. The numeric fast path is fully vectorized and slices directly by
# BATCH_RECORDS, so FRAME_CHUNK has no effect on numeric channels.
FRAME_CHUNK = int(os.getenv("FRAME_CHUNK", "1000"))      # MDF read chunk; unrelated to batching
BATCH_RECORDS = int(os.getenv("BATCH_RECORDS", "100"))   # Records per Kafka message (cluster size)
FLUSH_EVERY = int(os.getenv("FLUSH_EVERY", "1000"))      # librdkafka flush every N batches (was: N samples)

# CAN bus-logging decode -----------------------------------------------------
# "embedded" (default): decode CAN bus-logging files with the DBC that the MF4
# carries as an attachment. "none": do not decode. External DBC fetching is
# deliberately not implemented; the knob exists so it can be added later
# without changing today's behaviour.
DBC_SOURCE = os.getenv("DBC_SOURCE", "embedded").strip().lower()

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



app = Application(consumer_group="mf4-decoder-v3", auto_offset_reset="earliest")
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


def _produce_batch(file_name, upload_id, channel, unit, ts_buf, val_buf):
    """Serialize a per-channel scalar+array payload as one Kafka message and produce it.

    The Kafka key is the emitted ``channel`` name (matches the ``channel``
    field in the payload). For multi-group channels this is the qualified
    form (``"<name>#g<group_idx>"``) on second-and-later occurrences so each
    distinct stream gets its own key.

    ``upload_id`` is the pipeline-wide unique key minted by mf4-to-blob and
    carried on the ``id`` field of the ``mf4_metadata`` message. It is
    repeated on every batch so the sink can write it onto every lake row.
    """
    payload = {
        "file_name": file_name,
        "upload_id": upload_id,
        "channel":   channel,
        "unit":      unit,
        "ts_ms":     ts_buf,
        "value":     val_buf,
    }
    try:
        msg = output_topic.serialize(key=channel, value=payload)
        producer.produce(
            topic=output_topic.name,
            key=msg.key,
            value=msg.value,
        )
    except Exception as e:
        logger.error(
            "Produce failed for batch (%s/%s, %d records): %s",
            file_name, channel, len(ts_buf), e,
        )


def _emit_channel(
    filename, upload_id, emit_channel, unit, timestamps, samples,
    start_ms, total_msgs, total_samples,
):
    """Emit one channel's samples as BATCH_RECORDS-sized Kafka messages.

    Numeric (int/float) channels go through a fully vectorized fast path:
    timestamp conversion, NaN/Inf scrubbing and scalar coercion happen in
    numpy, then a single ``tolist()`` materializes JSON-ready Python lists.
    The per-element ``_safe_value`` loop is only used for the rare
    object/bytes dtype channels (string/bytes payloads) where vectorization
    doesn't apply.

    Returns updated (total_msgs, total_samples).
    """
    arr = np.asarray(samples)

    # Empty channel after dtype detection: nothing to emit. _channel_has_data
    # used to filter these upstream; with that check removed, drop here.
    if len(arr) == 0:
        return total_msgs, total_samples

    if np.issubdtype(arr.dtype, np.number):
        # Vectorized numeric fast path -----------------------------------
        ts_full = (start_ms + (np.asarray(timestamps, dtype=np.float64) * 1000.0)).astype(np.int64)

        if np.issubdtype(arr.dtype, np.floating):
            ok = np.isfinite(arr)
            if not ok.all():
                ts_full = ts_full[ok]
                arr = arr[ok]
            # All-NaN/Inf channel: nothing emittable left after the mask.
            if len(arr) == 0:
                return total_msgs, total_samples

        ts_list = ts_full.tolist()
        val_list = arr.tolist()
        n = len(val_list)

        for offset in range(0, n, BATCH_RECORDS):
            end = min(offset + BATCH_RECORDS, n)
            _produce_batch(
                filename, upload_id, emit_channel, unit,
                ts_list[offset:end], val_list[offset:end],
            )
            total_msgs += 1
            total_samples += end - offset
            if total_msgs % FLUSH_EVERY == 0:
                producer.flush()

        return total_msgs, total_samples

    # Object / bytes / string dtype slow path ---------------------------
    # Keep the existing per-element _safe_value loop here; bytes->hex
    # fallback and isinstance gymnastics still matter for these channels.
    n = len(samples)
    ts_buf = []
    val_buf = []

    for offset in range(0, n, FRAME_CHUNK):
        ts_chunk = timestamps[offset:offset + FRAME_CHUNK]
        smp_chunk = samples[offset:offset + FRAME_CHUNK]

        for t, v in zip(ts_chunk, smp_chunk):
            safe_v = _safe_value(v)
            if safe_v is None:
                continue

            ts_buf.append(start_ms + int(float(t) * 1000))
            val_buf.append(safe_v)
            total_samples += 1

            if len(ts_buf) >= BATCH_RECORDS:
                _produce_batch(filename, upload_id, emit_channel, unit, ts_buf, val_buf)
                ts_buf, val_buf = [], []
                total_msgs += 1
                if total_msgs % FLUSH_EVERY == 0:
                    producer.flush()

    if ts_buf:
        _produce_batch(filename, upload_id, emit_channel, unit, ts_buf, val_buf)
        total_msgs += 1

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


def _decode_can_bus_logging(mdf, target_dir):
    """Decode raw CAN frames into named signals using the file's own DBC.

    Returns the decoded ``MDF`` - one channel group per CAN message, one channel
    per signal - or ``None`` when no usable database is available. ``None`` is
    not an error: the caller drops the raw frame channels and logs the drop.
    """
    if DBC_SOURCE == "none":
        logger.warning("DBC_SOURCE=none - CAN bus logging will not be decoded")
        return None
    if DBC_SOURCE != "embedded":
        logger.warning("Unknown DBC_SOURCE=%r - treating it as 'embedded'", DBC_SOURCE)

    attachment_indices = _find_dbc_attachments(mdf)
    if not attachment_indices:
        logger.warning(
            "CAN bus-logging file has no embedded .dbc attachment "
            "(%d attachment(s) present) - no signals can be decoded",
            len(getattr(mdf, "attachments", None) or ()),
        )
        return None

    dbc_paths = _extract_dbc_files(mdf, attachment_indices, target_dir)
    if not dbc_paths:
        logger.warning("No embedded CAN database could be extracted - nothing to decode")
        return None

    # Bus channel 0 means "applies to any bus channel". The embedded database is
    # by definition the one that describes this file's buses, so there is no
    # per-channel mapping to guess at.
    database_files = {"CAN": [(str(path), 0) for path in dbc_paths]}
    try:
        return mdf.extract_bus_logging(database_files=database_files)
    except Exception:
        logger.exception(
            "extract_bus_logging failed with %d embedded database(s)", len(dbc_paths)
        )
        return None


def _emit_signals(
    signals, filename, upload_id, start_ms, seen_names, total_msgs, total_samples,
):
    """Emit an iterable of asammdf ``Signal`` objects.

    Signal names repeat: across channel groups in ordinary MF4s, and across CAN
    message groups in a decoded bus-logging file where one signal name can
    appear in several messages. The first occurrence of a name keeps the bare
    name; later ones are qualified as ``"<name>#g<group_index>"`` so every
    stream gets a distinct Kafka key. ``seen_names`` is shared across every call
    made for one file, so decoded and raw streams cannot collide.

    ``upload_id`` is passed straight through to ``_emit_channel``, which puts it
    on every batch of both the numeric and the object/bytes emit path.

    Returns (total_msgs, total_samples, channels_emitted).
    """
    emitted = 0

    for sig in signals:
        name = sig.name
        occ = seen_names.get(name, 0)
        seen_names[name] = occ + 1

        group_idx = getattr(sig, "group_index", -1)
        if occ == 0:
            emit_channel = name
        elif group_idx is not None and group_idx >= 0:
            emit_channel = f"{name}#g{group_idx}"
        else:
            emit_channel = f"{name}#g{occ}"

        samples = sig.samples
        if len(samples) == 0:
            continue

        unit = getattr(sig, "unit", "") or ""
        if not isinstance(unit, str):
            unit = str(unit)

        total_msgs, total_samples = _emit_channel(
            filename, upload_id, emit_channel, unit, sig.timestamps, samples,
            start_ms, total_msgs, total_samples,
        )
        emitted += 1

    return total_msgs, total_samples, emitted


def process(metadata: dict):
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

        if bus_groups:
            raw_bus_channels, raw_bus_frames = _bus_group_totals(mdf, bus_groups)
            logger.info(
                "%s is a CAN bus-logging file: %d group(s), "
                "%d raw frame channel(s), %d frames",
                filename, len(bus_groups), raw_bus_channels, raw_bus_frames,
            )
            dbc_dir = pathlib.Path(tempfile.mkdtemp(prefix="mf4-dbc-"))
            decoded = _decode_can_bus_logging(mdf, dbc_dir)

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
                filename, upload_id, start_ms, seen_names,
                total_msgs, total_samples,
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
            filename, upload_id, start_ms, seen_names,
            total_msgs, total_samples,
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
            emit_channel = name if occ == 0 else f"{name}#g{group_idx}"

            samples = master_sig.samples
            if len(samples) == 0:
                continue

            unit = getattr(master_sig, "unit", "") or ""
            if not isinstance(unit, str):
                unit = str(unit)

            total_msgs, total_samples = _emit_channel(
                filename, upload_id, emit_channel, unit, master_sig.timestamps, samples,
                start_ms, total_msgs, total_samples,
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

    except Exception:
        logger.exception(
            "Failed to process file %s (blob_path=%s)", filename, blob_path
        )
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
sdf = sdf.update(process)
app.run()
