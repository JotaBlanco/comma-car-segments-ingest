"""Provenance read out of an MF4 file's own metadata.

Two independent sources, both already present inside the file, so nothing has
to be threaded through Kafka from the uploader:

* the **HD comment** (``mdf.header.comment``) - an ``<HDcomment>`` XML block
  whose ``<common_properties>`` section carries ``<e name="KEY">VALUE</e>``
  entries written by ``rlog-to-mf4``'s ``build_mf4(...)``. This is where
  ``platform``, ``source.device``, ``source.route``, ``source.segment`` and
  ``dcm.config_id`` come from.
* the **embedded DBC** - the same attachment the decoder already writes to a
  temp file for ``MDF.extract_bus_logging``. Re-read through ``canmatrix`` it
  yields the CAN frame each signal belongs to and the ECU that transmits it,
  neither of which exists anywhere in the MF4 metadata.

Every value produced here is a **non-empty string**. Missing metadata becomes
the literal ``"unknown"``, never ``None``. That is not cosmetic: these columns
are Hive partition keys in ``mf4-datalake-sink``, and the pinned
``quixlakesink-fix-v3`` build groups by them with pandas' default
``dropna=True``, so a null partition value makes the whole row disappear from
the lake without an error. PyArrow additionally infers a null-typed column
from an all-``None`` batch and fails the parquet write - the same class of bug
that ``value_text`` hit.
"""

import logging
import re
import xml.etree.ElementTree as ET

import canmatrix.formats

logger = logging.getLogger("mf4-decoder.provenance")

# Sentinel written whenever a provenance field cannot be resolved. Must stay a
# non-empty string with no path-separator characters: it ends up in Hive
# partition directory names (``platform=unknown/...``).
UNKNOWN = "unknown"

# Emitted column name -> key inside <common_properties>. The indirection is the
# point: the lake column names are short and query-friendly (``device``), the
# MF4 keys are namespaced by their producer (``source.device``).
_PROVENANCE_KEYS = {
    "platform": "platform",
    "device": "source.device",
    "route": "source.route",
    "segment": "source.segment",
    "dcm_config_id": "dcm.config_id",
}

# Columns resolved from the embedded DBC rather than the header, defaulted
# together so callers never have to spell the fallback pair out.
UNKNOWN_FRAME = (UNKNOWN, UNKNOWN)


def _local_name(tag) -> str:
    """Element tag with any ``{namespace}`` prefix removed.

    The sample files write a bare ``<HDcomment>`` with no namespace, but the
    ASAM MDF schema allows one and other writers do declare it. Matching on the
    local name means a namespaced file parses identically instead of silently
    yielding zero properties.
    """
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1]


def parse_header_properties(mdf) -> dict[str, str]:
    """Every ``<common_properties>`` entry in the file's HD comment.

    Returns ``{}`` - never raises - when the comment is absent, empty, not
    XML at all (some writers put plain prose there), or carries no
    ``common_properties`` section. A file with no provenance is an ordinary
    browser upload, not an error, so this stays at INFO.

    Duplicate ``name`` attributes keep the **first** occurrence. The MDF spec
    does not forbid repeats and last-wins would make the result depend on
    element order for no benefit.

    Nested entries are picked up too: ``common_properties`` may wrap groups of
    ``<e>`` elements in a ``<tree>``, so the whole subtree is walked rather
    than only its direct children.
    """
    comment = getattr(getattr(mdf, "header", None), "comment", None)
    if not comment or not isinstance(comment, (str, bytes)):
        return {}

    try:
        root = ET.fromstring(comment)
    except ET.ParseError as exc:
        logger.info("MF4 header comment is not parseable XML (%s) - no provenance", exc)
        return {}

    properties: dict[str, str] = {}
    for element in root.iter():
        if _local_name(element.tag) != "common_properties":
            continue
        for entry in element.iter():
            if _local_name(entry.tag) != "e":
                continue
            name = (entry.get("name") or "").strip()
            if not name or name in properties:
                continue
            properties[name] = (entry.text or "").strip()

    if not properties:
        logger.info("MF4 header comment has no <common_properties> entries")
    return properties


def build_provenance(properties: dict[str, str]) -> dict[str, str]:
    """Map header properties onto the scalar columns every record carries.

    Any key that is missing or blank becomes ``UNKNOWN``. See the module
    docstring for why ``None`` is not an option here.
    """
    return {
        column: (properties.get(key) or "").strip() or UNKNOWN
        for column, key in _PROVENANCE_KEYS.items()
    }


def build_signal_frame_map(dbc_paths) -> dict[str, tuple[str, str]]:
    """``signal name -> (frame_name, sender_node)`` from the embedded CAN databases.

    Read with ``canmatrix``, not ``cantools``: opendbc's ``hyundai_kia_generic.dbc``
    uses a bare ``CM_ <id> "..."`` comment form that cantools' parser rejects
    outright (``textparser.ParseError`` at the first such line), while canmatrix
    reads the same file fine. canmatrix is already a hard dependency of asammdf
    and is pinned in ``requirements.txt``.

    ``canmatrix.formats.load`` returns ``{bus_name: CanMatrix}``; every matrix is
    merged into one flat map because the decoder looks signals up by name alone.
    A signal name may legitimately appear in several frames - the **first**
    occurrence wins and later ones are ignored rather than raising.

    A database that cannot be read is logged and skipped: frame/sender metadata
    is enrichment, and losing it must never cost us the decoded signals
    themselves.
    """
    mapping: dict[str, tuple[str, str]] = {}

    for path in dbc_paths:
        try:
            with open(path, "rb") as handle:
                matrices = canmatrix.formats.load(handle, "dbc")
        except Exception:
            logger.exception(
                "Could not read %s through canmatrix - frame/sender metadata "
                "will fall back to %r for its signals",
                path,
                UNKNOWN,
            )
            continue

        for matrix in (matrices or {}).values():
            for frame in getattr(matrix, "frames", None) or ():
                frame_name = str(getattr(frame, "name", "") or "").strip() or UNKNOWN

                # canmatrix exposes transmitters as a list; opendbc frames name
                # exactly one ECU, but the format allows several and allows none.
                transmitters = list(getattr(frame, "transmitters", None) or ())
                sender_node = UNKNOWN
                for transmitter in transmitters:
                    candidate = str(transmitter or "").strip()
                    if candidate:
                        sender_node = candidate
                        break

                for signal in getattr(frame, "signals", None) or ():
                    name = str(getattr(signal, "name", "") or "").strip()
                    if name and name not in mapping:
                        mapping[name] = (frame_name, sender_node)

    logger.info(
        "Built signal -> (frame, sender) map from %d embedded database(s): %d signal(s)",
        len(dbc_paths),
        len(mapping),
    )
    return mapping


# asammdf names every decoded bus-logging group
# ``"CAN<bus> message ID=0x<id> EXT=<bool>"``. The leading bus index is the
# only place the bus survives ``extract_bus_logging`` - the decoded Signal
# objects themselves carry no bus attribute - so it is recovered from the
# group's acquisition name.
_ACQ_BUS_RE = re.compile(r"^CAN(\d+)\b")


def parse_bus_channels(properties: dict[str, str]) -> dict[int, str]:
    """``{bus index: bus name}`` from the ``bus.channels`` header property.

    The property is written as ``"1=powertrain_hs_can1, 2=radar_object_hs_can2,
    3=camera_ipma_hs_can3"``. Malformed fragments (no ``=``, a non-numeric
    index, an empty name) are skipped rather than raising; a file with no
    ``bus.channels`` simply yields ``{}`` and every signal falls back to
    ``UNKNOWN``.
    """
    raw = (properties.get("bus.channels") or "").strip()
    channels: dict[int, str] = {}
    if not raw:
        return channels

    for part in raw.split(","):
        index, separator, name = part.partition("=")
        index = index.strip()
        name = name.strip()
        if not separator or not name or not index.isdigit():
            continue
        channels.setdefault(int(index), name)

    return channels


def build_group_bus_names(decoded, bus_channels: dict[int, str]) -> dict[int, str]:
    """``{decoded group index: bus name}`` for a decoded bus-logging MDF.

    Joins the bus index parsed out of each decoded group's ``acq_name`` to the
    human bus names declared in the header. Groups whose ``acq_name`` does not
    match the expected shape, or whose bus index the header does not describe,
    are simply absent from the result - callers default them to ``UNKNOWN``
    rather than inventing a name.
    """
    names: dict[int, str] = {}
    if not bus_channels:
        return names

    for index, group in enumerate(getattr(decoded, "groups", None) or ()):
        channel_group = getattr(group, "channel_group", None)
        acq_name = str(getattr(channel_group, "acq_name", "") or "").strip()
        match = _ACQ_BUS_RE.match(acq_name)
        if not match:
            continue
        name = bus_channels.get(int(match.group(1)))
        if name:
            names[index] = name

    return names
