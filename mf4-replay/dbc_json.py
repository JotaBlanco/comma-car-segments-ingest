"""A CAN database as a JSON config document, and back again.

DCM stores JSON documents, so the DBC is held as structured JSON rather than an
opaque blob: it is inspectable in the UI, queryable with JSONPath, and usable
with QuixConfigurationService's json_field.

`to_json` serialises everything cantools needs to decode; `from_json` rebuilds a
real cantools Database, so bit extraction stays in cantools rather than being
reimplemented here.
"""

from __future__ import annotations

import logging
from collections import OrderedDict

import cantools
from cantools.database.can import Database, Message, Node, Signal
from cantools.database.conversion import BaseConversion

logger = logging.getLogger(__name__)

SCHEMA = "can-database/1"


def _signal_to_json(s: Signal) -> dict:
    return {
        "name": s.name,
        "start": s.start,
        "length": s.length,
        "byte_order": s.byte_order,
        "is_signed": bool(s.is_signed),
        "is_float": bool(s.is_float),
        "scale": s.scale,
        "offset": s.offset,
        "minimum": s.minimum,
        "maximum": s.maximum,
        "unit": s.unit,
        "receivers": list(s.receivers or []),
        "comment": s.comment,
        # enum value tables, as {int: text}; JSON keys must be strings
        "choices": (
            {str(int(k)): str(v) for k, v in s.choices.items()} if s.choices else None
        ),
        "is_multiplexer": bool(s.is_multiplexer),
        "multiplexer_ids": list(s.multiplexer_ids) if s.multiplexer_ids else None,
        "multiplexer_signal": s.multiplexer_signal,
    }


def _signal_from_json(d: dict) -> Signal:
    choices = None
    if d.get("choices"):
        # keys must be ints, and cantools wants insertion order preserved
        choices = OrderedDict((int(k), v) for k, v in d["choices"].items())
    # cantools 4.x keeps scale/offset/choices/is_float inside a conversion
    # object rather than as Signal kwargs; the factory picks the right subclass
    # (identity / linear / named-signal).
    conversion = BaseConversion.factory(
        scale=d.get("scale", 1),
        offset=d.get("offset", 0),
        choices=choices,
        is_float=d.get("is_float", False),
    )
    return Signal(
        name=d["name"],
        start=d["start"],
        length=d["length"],
        byte_order=d.get("byte_order", "little_endian"),
        is_signed=d.get("is_signed", False),
        conversion=conversion,
        minimum=d.get("minimum"),
        maximum=d.get("maximum"),
        unit=d.get("unit"),
        receivers=d.get("receivers") or [],
        comment=d.get("comment"),
        is_multiplexer=d.get("is_multiplexer", False),
        multiplexer_ids=d.get("multiplexer_ids"),
        multiplexer_signal=d.get("multiplexer_signal"),
    )


def to_json(db: Database, *, platform: str, source: dict) -> dict:
    """Serialise a cantools Database into a DCM-storable JSON document.

    Frames are keyed by decimal frame id as a string, so a decoder can look one
    up directly and JSONPath can address a single frame or signal.
    """
    frames: dict[str, dict] = {}
    for m in db.messages:
        key = str(m.frame_id)
        if key in frames:
            # Several diagnostic frames share an id in this database; keep the
            # first, matching cantools' own get_message_by_frame_id behaviour.
            continue
        frames[key] = {
            "id": m.frame_id,
            "id_hex": f"0x{m.frame_id:03X}",
            "name": m.name,
            "length": m.length,
            "is_extended_frame": bool(m.is_extended_frame),
            "senders": list(m.senders or []),
            "cycle_time": m.cycle_time,
            "comment": m.comment,
            "signals": [_signal_to_json(s) for s in sorted(m.signals, key=lambda x: x.start)],
        }

    return {
        "schema": SCHEMA,
        "platform": platform,
        "source": source,
        "counts": {
            "frames": len(frames),
            "signals": sum(len(f["signals"]) for f in frames.values()),
            "nodes": len(db.nodes),
        },
        "nodes": [{"name": n.name, "comment": n.comment} for n in db.nodes],
        "frames": frames,
    }


def from_json(doc: dict) -> Database:
    """Rebuild a cantools Database from the JSON document."""
    schema = doc.get("schema")
    if schema != SCHEMA:
        raise ValueError(f"unsupported can-database schema: {schema!r}")

    nodes = [Node(name=n["name"], comment=n.get("comment")) for n in doc.get("nodes", [])]
    messages = []
    for f in doc["frames"].values():
        messages.append(
            Message(
                frame_id=f["id"],
                name=f["name"],
                length=f["length"],
                signals=[_signal_from_json(s) for s in f["signals"]],
                senders=f.get("senders") or [],
                comment=f.get("comment"),
                cycle_time=f.get("cycle_time"),
                is_extended_frame=f.get("is_extended_frame", False),
                strict=False,
            )
        )
    db = Database(messages=messages, nodes=nodes, strict=False)
    logger.info(
        "rebuilt CAN database from JSON: %d frames, %d signals",
        len(db.messages),
        sum(len(m.signals) for m in db.messages),
    )
    return db


def load_dbc_file(path: str) -> Database:
    return cantools.database.load_file(path, strict=False)
