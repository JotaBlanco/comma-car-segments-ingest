"""Read a bus-logging MF4 and decode its CAN frames with a DBC.

Frames are grouped back into the envelopes they arrived in. In the source rlogs
every frame in one ~10 ms envelope shares a single logMonoTime, so identical
timestamps identify an envelope. Order inside an envelope is row order, which is
the order the frames were read off the panda - it cannot be recovered from the
timestamps, so an explicit sequence number is carried instead.
"""

from __future__ import annotations

import io
import logging
import xml.etree.ElementTree as ET

import numpy as np
from asammdf import MDF

logger = logging.getLogger(__name__)


def read_header_properties(mdf: MDF) -> dict:
    """Pull the ASAM common_properties written by the converter."""
    props: dict[str, str] = {}
    comment = mdf.header.comment or ""
    if not comment.strip().startswith("<"):
        return props
    try:
        root = ET.fromstring(comment)
    except ET.ParseError as exc:
        logger.warning("could not parse MDF header comment: %s", exc)
        return props
    for e in root.iter("e"):
        name = e.get("name")
        if name:
            props[name] = (e.text or "").strip()
    return props


def load_frames(mf4_bytes: bytes):
    """Return (mdf, header_props, frame arrays) from MF4 bytes."""
    mdf = MDF(io.BytesIO(mf4_bytes))
    props = read_header_properties(mdf)

    ids = mdf.get("CAN_DataFrame.ID")
    bus = mdf.get("CAN_DataFrame.BusChannel").samples
    dlc = mdf.get("CAN_DataFrame.DataLength").samples
    data = mdf.get("CAN_DataFrame.DataBytes").samples

    return mdf, props, {
        "t": ids.timestamps,
        "id": ids.samples,
        "bus": bus,
        "dlc": dlc,
        "data": data,
    }


def envelopes(frames: dict, max_envelopes: int = 0):
    """Yield (seq, t_rel, slice) per envelope, in file order.

    Timestamps are non-decreasing across rows, so envelope boundaries are just
    the points where the value changes - no sorting required.
    """
    t = frames["t"]
    if len(t) == 0:
        return
    boundaries = np.flatnonzero(np.diff(t)) + 1
    starts = np.concatenate(([0], boundaries))
    ends = np.concatenate((boundaries, [len(t)]))
    for seq, (a, b) in enumerate(zip(starts, ends)):
        if max_envelopes and seq >= max_envelopes:
            return
        yield seq, float(t[a]), slice(int(a), int(b))


def decode_envelope(db, frames: dict, sl: slice) -> tuple[list, int, int]:
    """Decode one envelope. Returns (frame records, decoded_count, unknown_count).

    Frames whose id is absent from the DBC are kept with their raw payload
    rather than dropped: 195 observed ids in this dataset have no DBC entry, and
    silently discarding them would make the stream a lossy view of the bus.
    """
    out = []
    decoded = unknown = 0
    for i in range(sl.start, sl.stop):
        addr = int(frames["id"][i])
        n = int(frames["dlc"][i])
        payload = bytes(frames["data"][i][:n])
        rec = {
            "bus": int(frames["bus"][i]) - 1,  # back to openpilot src numbering
            "id": addr,
            "id_hex": f"0x{addr:03X}",
            "dlc": n,
        }
        try:
            msg = db.get_message_by_frame_id(addr)
        except KeyError:
            msg = None
        if msg is None:
            rec["name"] = None
            rec["raw"] = payload.hex()
            unknown += 1
        else:
            rec["name"] = msg.name
            rec["sender"] = msg.senders[0] if msg.senders else None
            try:
                values = msg.decode(payload, decode_choices=False, allow_truncated=True)
                rec["signals"] = {
                    k: (float(v) if isinstance(v, (int, float)) else str(v))
                    for k, v in values.items()
                }
                decoded += 1
            except Exception as exc:  # noqa: BLE001 - keep the frame, note the failure
                rec["raw"] = payload.hex()
                rec["decode_error"] = str(exc)[:120]
                unknown += 1
        out.append(rec)
    return out, decoded, unknown
