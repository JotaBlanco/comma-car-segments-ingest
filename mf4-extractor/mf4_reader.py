"""Reading a decoded-signal MF4 with ``asammdf``: metadata, groups, raw-CAN rejection.

This system ingests **decoded-signal MF4 only** (the plant spec's format: four
channel groups, named channels, rasters 100/50/10 Hz). Raw-CAN MF4 is detected and
rejected, because ``pass_criteria`` name channels such as ``VehAccel_mps2``, so raw
frames would need a per-device DBC registry, a decode stage and a name-mapping
layer - a subsystem, not a branch.

The extension point is declared so adding raw CAN later changes no table:
``device_versions.dbc_id`` already exists, a ``decode`` stage would sit between
``open_mdf`` and ``rows.extract``, and the emitted row schema would be unchanged.
Both formats then converge on the same four tables.
"""

import logging
from xml.etree import ElementTree

logger = logging.getLogger(__name__)

# asammdf v4 channel-group flag: the group carries bus events, i.e. raw frames.
FLAG_CG_BUS_EVENT = 0x02
RAW_CAN_CHANNEL_PREFIXES = ("CAN_DataFrame", "CAN_ErrorFrame", "CAN_RemoteFrame")

# Channel groups the plant emits, with their nominal raster.
KNOWN_GROUPS = {
    "PT_CAN_100Hz": 100.0,
    "RADAR_OBJ_50Hz": 50.0,
    "ACC_HMI_10Hz": 10.0,
    "SIM_REF_100Hz": 100.0,
}

# Fields lifted out of the HD comment's common_properties (plant spec 6.5).
METADATA_KEYS = (
    "run_id", "scenario_name", "variant_id", "config_sha256", "config_hash12",
    "generated_utc", "tool_name", "tool_version", "spec_ref", "seed", "duration_s",
    "dt_sim_s", "dt_ctrl_s", "system_type", "git_commit",
)
INT_KEYS = ("seed",)
FLOAT_KEYS = ("duration_s", "dt_sim_s", "dt_ctrl_s")


class RawCanRejected(Exception):
    """The file carries raw CAN frames; ``ingest_status = unsupported_raw_can``."""


class UnreadableMf4(Exception):
    """asammdf could not open the object, or it is not MDF4."""


def open_mdf(fileobj):
    """Open an MDF from a file-like object, or raise ``UnreadableMf4``."""
    try:
        from asammdf import MDF
    except ImportError as exc:  # pragma: no cover - dependency missing
        raise UnreadableMf4(f"asammdf is not installed: {exc}") from exc
    try:
        return MDF(fileobj)
    except Exception as exc:  # asammdf raises a wide family; re-raised as UnreadableMf4
        raise UnreadableMf4(f"asammdf could not open the object: {exc}") from exc


def assert_not_raw_can(mdf) -> None:
    """Authoritative raw-CAN check: the group flag first, channel names second.

    The API's upload-time byte scan is a cheap pre-filter; this is the check that
    decides, because ``FLAG_CG_BUS_EVENT`` is what the bus-logging writer actually
    sets and a channel name can be renamed.
    """
    for index, group in enumerate(mdf.groups):
        flags = int(getattr(group.channel_group, "flags", 0) or 0)
        if flags & FLAG_CG_BUS_EVENT:
            raise RawCanRejected(
                f"channel group {index} has FLAG_CG_BUS_EVENT set, i.e. it carries raw CAN "
                "frames. Decoded-signal MF4 only: decoding needs a per-device DBC registry, a "
                "decode stage and a name-mapping layer (extension point declared in spec 0.6, "
                "device_versions.dbc_id)."
            )
        for channel in group.channels:
            name = str(getattr(channel, "name", ""))
            if name.startswith(RAW_CAN_CHANNEL_PREFIXES):
                raise RawCanRejected(
                    f"channel {name!r} in group {index} is a raw CAN frame field; "
                    "decoded-signal MF4 only (spec 0.6)."
                )


def parse_common_properties(comment: str | None) -> dict:
    """Lift ``HDcomment/common_properties`` into a flat dict of typed values.

    Absent or unparseable metadata is not fatal: the trace is still storable and
    the missing fields simply stay ``None``, which the lake columns permit. A hard
    failure here would make an otherwise usable trace unusable.
    """
    values: dict = dict.fromkeys(METADATA_KEYS)
    if not comment:
        return values
    text = comment.strip()
    if not text.startswith("<"):
        return values
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError as exc:
        logger.warning("HD comment is not parseable XML: %s", exc)
        return values

    for element in root.iter():
        local = element.tag.rsplit("}", 1)[-1]
        if local != "e":
            continue
        name = element.get("name")
        if name in values:
            values[name] = (element.text or "").strip() or None

    for key in INT_KEYS:
        values[key] = _as_int(values.get(key))
    for key in FLOAT_KEYS:
        values[key] = _as_float(values.get(key))
    return values


def _as_int(value):
    try:
        return None if value is None else int(float(value))
    except (TypeError, ValueError):
        return None


def _as_float(value):
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def header_epoch_ms(mdf) -> int | None:
    """HD ``start_time`` in epoch milliseconds, or ``None`` when unusable.

    In the plant's byte-identical mode the header start time is a fixed epoch, so
    this value is wall-clock-tainted. That is why ``epoch_source`` is recorded and
    why **every verdict uses ``t_s``**, never ``ts_ms``.
    """
    start_time = getattr(getattr(mdf, "header", None), "start_time", None)
    if start_time is None:
        return None
    try:
        return int(start_time.timestamp() * 1000)
    except (AttributeError, OSError, OverflowError, ValueError):
        return None


def group_index(mdf) -> dict[str, int]:
    """Channel-group name -> group index, for the groups this system knows."""
    found: dict[str, int] = {}
    for index, group in enumerate(mdf.groups):
        name = str(getattr(group.channel_group, "acq_name", "") or "").strip()
        if not name:
            name = str(getattr(group.channel_group, "comment", "") or "").strip()
        if name in KNOWN_GROUPS and name not in found:
            found[name] = index
    return found


TIME_CHANNEL_NAMES = frozenset({"time", "timestamps", "t"})
# MDF4 channel_type 2 and 3 are master (time) channels.
MASTER_CHANNEL_TYPES = frozenset({2, 3})


def channel_names(mdf, index: int) -> list[str]:
    """Signal channel names of one group, time channels excluded."""
    names = []
    for channel in mdf.groups[index].channels:
        if int(getattr(channel, "channel_type", 0) or 0) in MASTER_CHANNEL_TYPES:
            continue
        name = str(getattr(channel, "name", "") or "")
        if not name or name in TIME_CHANNEL_NAMES:
            continue
        names.append(name)
    return names


def attachment_names(mdf) -> list[str]:
    names = []
    for attachment in getattr(mdf, "attachments", []) or []:
        name = getattr(attachment, "file_name", None) or getattr(attachment, "comment", None)
        if name:
            names.append(str(name))
    return names


def mdf_version(mdf) -> str:
    return str(getattr(mdf, "version", "") or "")
