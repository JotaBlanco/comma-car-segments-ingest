"""Build a `can-database/1` document from canmatrix, for the DBCs cantools rejects.

cantools parses 25 of the 43 bundled databases. The other 18 hit quirks it treats
as fatal:

  * `CM_ SG_ <id> "text"` with no signal name  (honda, acura)
  * a scale written `.25` rather than `0.25`   (chrysler)
  * a message name beginning with a digit, `BO_ 1275 2017_5`  (mazda)
  * an 11-bit frame id field holding a 29-bit id  (honda_crv_ex_2017_body)
  * signals canmatrix reads as None-length  (nissan)
  * a 64-bit-wide signal whose maximum is 2**64, one past the int64 ceiling BSON
    can store - DCM answers 500 rather than rejecting the field  (mazda)

canmatrix reads all of them. Round-tripping canmatrix -> DBC text -> cantools was
tried first and rejected: it loses `mazda_2017` entirely ("signal NEW_SIGNAL_4 does
not fit in message HVAC") and silently drops the extended-id frames from
`honda_crv_ex_2017_body_generated`, leaving 0 of 2. So the document is written
straight from canmatrix's objects instead.

The output schema is identical to `dbc_json.to_json`, field for field, so a
consumer cannot tell which parser produced a document and `dbc_json.from_json`
still rebuilds a real cantools Database from either.

Two mappings are not one-to-one and are deliberate:

`byte_order` - canmatrix carries `is_little_endian`; cantools wants the strings
`"little_endian"` / `"big_endian"`.

`start` - canmatrix's `start_bit` is already the LSB position for little-endian
signals, which is what cantools means by `start`. For big-endian signals canmatrix
exposes `get_startbit(bit_numbering=1)` to convert to the same convention, so that
is used rather than the raw attribute.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

SCHEMA = "can-database/1"


def _num(value):
    """Plain JSON number, or None.

    canmatrix returns Decimal for scale/offset/min/max. Decimal is not
    JSON-serialisable and `json.dumps(default=str)` would quietly turn 0.25 into
    the string "0.25", which then fails float maths in the decoder.
    """
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    # A whole number stays an int so the document matches the cantools output,
    # where scale=1 and offset=0 are ints - but only while it fits in a signed
    # 64-bit integer. A 64-bit-wide signal gets maximum = 2**64, which is one past
    # that ceiling; BSON has no integer type for it and DCM answers 500. Emitting
    # it as a double keeps the value and stores cleanly.
    if f.is_integer() and -(2**63) <= f < 2**63:
        return int(f)
    return f


def _signal_to_json(sig) -> dict:
    try:
        start = int(sig.get_startbit(bit_numbering=1)) if not sig.is_little_endian else int(sig.start_bit)
    except Exception:
        start = int(sig.start_bit)

    choices = None
    if getattr(sig, "values", None):
        choices = {}
        for k, v in sig.values.items():
            try:
                choices[str(int(k))] = str(v)
            except (TypeError, ValueError):
                continue
        choices = choices or None

    receivers = [str(r) for r in (getattr(sig, "receivers", None) or []) if r]
    unit = getattr(sig, "unit", None) or None

    return {
        "name": str(sig.name),
        "start": start,
        "length": int(sig.size),
        "byte_order": "little_endian" if sig.is_little_endian else "big_endian",
        "is_signed": bool(sig.is_signed),
        "is_float": bool(getattr(sig, "is_float", False)),
        "scale": _num(getattr(sig, "factor", 1)) or 1,
        "offset": _num(getattr(sig, "offset", 0)) or 0,
        "minimum": _num(getattr(sig, "min", None)),
        "maximum": _num(getattr(sig, "max", None)),
        "unit": unit,
        "receivers": receivers,
        "comment": getattr(sig, "comment", None) or None,
        "choices": choices,
        "is_multiplexer": bool(getattr(sig, "is_multiplexer", False)),
        "multiplexer_ids": None,
        "multiplexer_signal": None,
    }


def to_json(cm, *, platform: str, source: dict) -> dict:
    """Serialise a canmatrix CanMatrix into a `can-database/1` document."""
    frames: dict[str, dict] = {}
    for f in cm.frames:
        frame_id = int(f.arbitration_id.id)
        key = str(frame_id)
        if key in frames:
            # Same rule cantools' get_message_by_frame_id follows: several
            # diagnostic frames share an id in these databases, keep the first.
            continue

        signals = []
        for sig in f.signals:
            try:
                signals.append(_signal_to_json(sig))
            except Exception:
                logger.warning(
                    "skipping unreadable signal %r in frame %s", getattr(sig, "name", "?"), key
                )
        signals.sort(key=lambda s: s["start"])

        frames[key] = {
            "id": frame_id,
            "id_hex": f"0x{frame_id:03X}",
            "name": str(f.name),
            "length": int(f.size),
            "is_extended_frame": bool(f.arbitration_id.extended),
            "senders": [str(t) for t in (f.transmitters or []) if t],
            "cycle_time": int(f.cycle_time) if getattr(f, "cycle_time", None) else None,
            "comment": getattr(f, "comment", None) or None,
            "signals": signals,
        }

    nodes = [{"name": str(n.name), "comment": getattr(n, "comment", None) or None}
             for n in (cm.ecus or [])]

    return {
        "schema": SCHEMA,
        "platform": platform,
        "source": source,
        "counts": {
            "frames": len(frames),
            "signals": sum(len(f["signals"]) for f in frames.values()),
            "nodes": len(nodes),
        },
        "nodes": nodes,
        "frames": frames,
    }
