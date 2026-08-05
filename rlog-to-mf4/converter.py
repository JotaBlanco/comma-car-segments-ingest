"""Convert an openpilot rlog.zst into a raw CAN-FD bus-logging MF4.

The output is undecoded: frames are stored exactly as they came off the bus and
the DBC travels with the file, both as an embedded attachment and as a DCM
reference in the MDF4 header. Consumers apply the database on demand, the same
way CANoe/CANape open a raw recording next to a DBC.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import io
import logging
import os
import xml.sax.saxutils as sx

import capnp
import numpy as np
import zstandard
from asammdf import MDF, Signal
from asammdf.blocks import v4_constants as v4c
from asammdf.blocks.v4_blocks import SourceInformation

logger = logging.getLogger(__name__)

HERE = os.path.dirname(os.path.abspath(__file__))
CEREAL_DIR = os.path.join(HERE, "cereal")

MAX_PAYLOAD = 64  # CAN-FD

BUS_NAMES = {
    0: "powertrain_hs_can1",
    1: "radar_object_hs_can2",
    2: "camera_ipma_hs_can3",
}

_FRAME_DTYPE = np.dtype(
    [
        ("BusChannel", "u1"),
        ("ID", "u4"),
        ("IDE", "u1"),
        ("DLC", "u1"),
        ("DataLength", "u1"),
        ("DataBytes", f"({MAX_PAYLOAD},)u1"),
        ("EDL", "u1"),
        ("BRS", "u1"),
        ("Dir", "u1"),
    ]
)

_log_capnp = None


def _schema():
    """Load the pinned cereal schema once.

    The schemas are vendored under cereal/ deliberately. Fetching them at
    runtime is not viable: commaai/cereal no longer exists and log.capnp has
    moved inside the openpilot repo more than once.
    """
    global _log_capnp
    if _log_capnp is None:
        capnp.remove_import_hook()
        _log_capnp = capnp.load(
            os.path.join(CEREAL_DIR, "log.capnp"), imports=[CEREAL_DIR]
        )
    return _log_capnp


def read_can_frames(rlog_bytes: bytes):
    """Yield (timestamp_s, bus, address, payload) for physical RX frames.

    openpilot's TX echoes (src >= 128) are dropped - they are the panda
    forwarding traffic between bus 0 and bus 2, not ECU output.

    Every frame in one rlog envelope shares that envelope's logMonoTime; there
    is no per-frame timestamp in the source. Frame order within an envelope is
    the order boardd read them out of the panda buffer and is preserved here.
    """
    log = _schema()
    frames = []
    for evt in log.Event.read_multiple_bytes(
        rlog_bytes, traversal_limit_in_words=2**40
    ):
        if evt.which() != "can":
            continue
        t = evt.logMonoTime / 1e9
        for c in evt.can:
            if c.src < 128:
                frames.append((t, c.src, c.address, bytes(c.dat)))
    return frames


def _header_xml(props: dict, text: str) -> str:
    entries = "\n".join(
        f'    <e name="{sx.escape(str(k))}">{sx.escape(str(v))}</e>'
        for k, v in props.items()
    )
    return (
        "<HDcomment>\n"
        f"  <TX>{sx.escape(text)}</TX>\n"
        "  <common_properties>\n"
        f"{entries}\n"
        "  </common_properties>\n"
        "</HDcomment>"
    )


def build_mf4(
    frames,
    *,
    dbc_bytes: bytes,
    dbc_name: str,
    dbc_version: str,
    dcm_type: str,
    dcm_target_key: str,
    platform: str,
    device: str,
    route: str,
    segment: str,
) -> tuple[bytes, dict]:
    """Build the MF4 in memory. Returns (file_bytes, stats)."""
    if not frames:
        raise ValueError("no CAN frames in segment")

    n = len(frames)
    t0 = frames[0][0]
    samples = np.zeros(n, dtype=_FRAME_DTYPE)
    ts = np.empty(n, dtype=np.float64)

    for i, (t, src, addr, data) in enumerate(frames):
        ts[i] = t - t0
        samples["BusChannel"][i] = src + 1  # MDF bus channels are 1-based
        samples["ID"][i] = addr
        samples["IDE"][i] = 1 if addr > 0x7FF else 0
        samples["DLC"][i] = len(data)
        samples["DataLength"][i] = len(data)
        samples["DataBytes"][i, : len(data)] = np.frombuffer(data, dtype=np.uint8)
        samples["EDL"][i] = 1 if len(data) > 8 else 0

    mdf = MDF(version="4.10")
    mdf.append(
        [Signal(samples=samples, timestamps=ts, name="CAN_DataFrame")],
        acq_name="CAN",
        comment="raw CAN-FD frames, undecoded",
    )

    # Mark the group as an ASAM bus-event group. Without BOTH the flag and a CAN
    # acq_source, viewers treat this as an ordinary structured channel and offer
    # no DBC decoding - silently, with no error.
    cg = mdf.groups[0].channel_group
    cg.flags |= v4c.FLAG_CG_BUS_EVENT
    cg.acq_source = SourceInformation(
        source_type=v4c.SOURCE_BUS, bus_type=v4c.BUS_TYPE_CAN
    )
    cg.acq_source.name = "CAN"
    cg.acq_source.path = "CAN"
    # Structure members must carry their qualified name ("CAN_DataFrame.ID");
    # asammdf appends them bare and its bus-logging reader will not find them.
    for ch in mdf.groups[0].channels:
        ch.source = cg.acq_source
        if ch.name not in ("time", "CAN_DataFrame"):
            ch.name = f"CAN_DataFrame.{ch.name}"

    dbc_sha = hashlib.sha256(dbc_bytes).hexdigest()
    config_id = hashlib.sha1(f"{dcm_type}-{dcm_target_key}".encode()).hexdigest()
    buses = sorted({int(b) - 1 for b in np.unique(samples["BusChannel"])})
    fd_frames = int((samples["DataLength"] > 8).sum())
    duration = float(ts[-1])

    props = {
        "dbc.name": dbc_name,
        "dbc.sha256": dbc_sha,
        "dbc.version": dbc_version,
        "dbc.source": "opendbc (MIT)",
        "dcm.type": dcm_type,
        "dcm.target_key": dcm_target_key,
        "dcm.config_id": config_id,
        "platform": platform,
        "source.dataset": "commaai/commaCarSegments",
        "source.device": device,
        "source.route": route,
        "source.segment": segment,
        "source.format": "rlog.zst (openpilot cereal)",
        "capture.envelope_rate_hz": "100",
        "capture.time_base": (
            "relative to first frame; logMonoTime carries no wall clock"
        ),
        "capture.tx_echo_excluded": "true (openpilot src>=128 dropped)",
        "frames.total": str(n),
        "frames.canfd": str(fd_frames),
        "duration.seconds": f"{duration:.3f}",
        "bus.channels": ", ".join(
            f"{b + 1}={BUS_NAMES.get(b, f'bus{b}')}" for b in buses
        ),
    }
    mdf.header.comment = _header_xml(
        props,
        f"Raw CAN-FD recording, {platform}, {device}/{route}/{segment}. "
        f"Decode with {dbc_name} (sha256 {dbc_sha[:12]}...), embedded as an "
        f"attachment and resolvable from DCM as type='{dcm_type}' "
        f"target_key='{dcm_target_key}'.",
    )
    # The source has no wall-clock time at all. Epoch is an explicit "unknown"
    # sentinel so nothing mistakes the conversion date for a recording date.
    mdf.header.start_time = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)

    mdf.attach(
        dbc_bytes,
        file_name=dbc_name,
        comment=(
            f"opendbc Ford database (MIT). sha256={dbc_sha}. "
            f"DCM: type={dcm_type} target_key={dcm_target_key}"
        ),
        mime="application/x-dbc",
        embedded=True,
        compression=True,
    )

    buf = io.BytesIO()
    mdf.save(buf, overwrite=True, compression=2)
    data = buf.getvalue()

    return data, {
        "frames": n,
        "canfd_frames": fd_frames,
        "duration_s": round(duration, 3),
        "buses": buses,
        "dbc_sha256": dbc_sha,
        "dcm_config_id": config_id,
        "size_bytes": len(data),
    }


def decompress_rlog(raw: bytes) -> bytes:
    return zstandard.ZstdDecompressor().decompressobj().decompress(raw)
