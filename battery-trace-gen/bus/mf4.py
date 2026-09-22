"""Write one trace as a raw CAN bus-logging MF4.

Wiring copied from ``origin/main:rlog-to-mf4/converter.py`` — the ``CAN_DataFrame``
structured signal, the ``FLAG_CG_BUS_EVENT`` / ``SOURCE_BUS`` channel group, the
qualified member names, the embedded DBC attachment and the ``<HDcomment>`` provenance
block. The frames here are classic CAN, so the CAN-FD-only members (``DataLength``,
``BRS``) are absent and ``DLC`` carries the length.

Every key ``mf4-decoder/provenance.py`` reads must be present or the lake row gets the
literal ``"unknown"`` in a Hive partition key.

The ``test.*`` block states the Test Manager chain the trace belongs to — the run key,
the work order and the rig it ran on — so the evidence file describes its own place in
the chain. Test definitions are not claimed here; they are assigned to the run in the
Test Manager. ``tm-connector/connector/identity.py`` reads the block.

asammdf stamps every ``##FH`` block it creates with wall-clock time, so ``start_time``
is pinned onto the file history and ``save()`` is told not to add a block of its own.
"""

from __future__ import annotations

import datetime as dt
import xml.sax.saxutils as sx
from pathlib import Path

import numpy as np
from asammdf import MDF, Signal
from asammdf.blocks import v4_constants as v4c
from asammdf.blocks.v4_blocks import SourceInformation

import meta

from .dbc import DBC_NAME, DCM_TARGET_KEY, DCM_TYPE, BatteryDbc

PAYLOAD_BYTES = 8

_FRAME_DTYPE = np.dtype(
    [
        ("BusChannel", "u1"),
        ("ID", "u4"),
        ("IDE", "u1"),
        ("DLC", "u1"),
        ("DataBytes", f"({PAYLOAD_BYTES},)u1"),
        ("EDL", "u1"),
        ("Dir", "u1"),
    ]
)


class FrameLog:
    """Fixed-capacity record of one trace's frames, in emission order."""

    def __init__(self, capacity: int, bus_channel: int) -> None:
        self.samples = np.zeros(capacity, dtype=_FRAME_DTYPE)
        self.timestamps = np.zeros(capacity, dtype=np.float64)
        self.samples["BusChannel"] = bus_channel
        self.samples["DLC"] = PAYLOAD_BYTES
        self._count = 0

    def append(self, t_s: float, frame_id: int, data: bytes) -> None:
        index = self._count
        self.timestamps[index] = t_s
        self.samples["ID"][index] = frame_id
        self.samples["DataBytes"][index] = np.frombuffer(data, dtype=np.uint8)
        self._count += 1

    @property
    def count(self) -> int:
        return self._count


def _header_xml(props: dict[str, str], text: str) -> str:
    entries = "\n".join(
        f'    <e name="{sx.escape(str(key))}">{sx.escape(str(value))}</e>'
        for key, value in props.items()
    )
    return (
        "<HDcomment>\n"
        f"  <TX>{sx.escape(text)}</TX>\n"
        "  <common_properties>\n"
        f"{entries}\n"
        "  </common_properties>\n"
        "</HDcomment>"
    )


def _test_props(test: dict, start: dt.datetime, duration_s: float) -> dict[str, str]:
    """The `test.*` block tm-connector reads off `<common_properties>`.

    `test.definitions` is written only for a scenario that declares definitions,
    and none does: a run's definitions are assigned from the Test Run page in
    the Test Manager. One that did declare them would state them as ONE
    comma-separated value, because the block is a name->value map
    (`tm-connector/connector/identity.py`, HEADER_LIST_FIELDS).

    The window is derived, never stated: the file's own start plus its duration.
    """
    keys = ("run_key", "work_order", "rig", "cell", "operator", "bench_sw", "description")
    props = {f"test.{key}": str(test[key]) for key in keys if test.get(key) is not None}
    if test.get("definitions"):
        props["test.definitions"] = ",".join(test["definitions"])
    props["test.started_at"] = start.isoformat().replace("+00:00", "Z")
    end = start + dt.timedelta(seconds=duration_s)
    props["test.ended_at"] = end.isoformat().replace("+00:00", "Z")
    return props


def write(
    path: Path,
    log: FrameLog,
    *,
    dbc: BatteryDbc,
    platform: str,
    device: str,
    route: str,
    segment: str,
    bus_channels: str,
    start_time_utc: str,
    scenario_id: str,
    cell_seed: int,
    test: dict,
) -> dict[str, object]:
    """Build and save the MF4. Returns the stats the manifest records."""
    samples = log.samples[: log.count]
    timestamps = log.timestamps[: log.count]

    mdf = MDF(version="4.10")
    mdf.append(
        [Signal(samples=samples, timestamps=timestamps, name="CAN_DataFrame")],
        acq_name="CAN",
        comment="raw classic CAN frames, undecoded",
    )

    group = mdf.groups[0].channel_group
    group.flags |= v4c.FLAG_CG_BUS_EVENT
    group.acq_source = SourceInformation(
        source_type=v4c.SOURCE_BUS, bus_type=v4c.BUS_TYPE_CAN
    )
    group.acq_source.name = "CAN"
    group.acq_source.path = "CAN"
    for channel in mdf.groups[0].channels:
        channel.source = group.acq_source
        if channel.name not in ("time", "CAN_DataFrame"):
            channel.name = f"CAN_DataFrame.{channel.name}"

    duration = float(timestamps[-1])
    start_time = dt.datetime.fromisoformat(start_time_utc.replace("Z", "+00:00"))
    props = {
        "platform": platform,
        "source.device": device,
        "source.route": route,
        "source.segment": segment,
        "source.format": "synthetic (battery-trace-gen)",
        "dcm.type": DCM_TYPE,
        "dcm.target_key": DCM_TARGET_KEY,
        "dcm.config_id": dbc.config_id,
        "dbc.name": DBC_NAME,
        "dbc.sha256": dbc.sha256,
        "dbc.version": f"{DBC_NAME} 1.0",
        "dbc.source": "hand-authored (comma-car-segments-ingest)",
        "bus.channels": bus_channels,
        "frames.total": str(log.count),
        "duration.seconds": f"{duration:.3f}",
        "gen.tool": meta.TOOL_NAME,
        "gen.version": meta.TOOL_VERSION,
        "gen.scenario": scenario_id,
        "gen.seed": str(cell_seed),
        "gen.plant_origin": f"{meta.PLANT_REPO}@{meta.PLANT_REF}:{meta.PLANT_PATH}",
        "gen.plant_patch": meta.PLANT_PATCH,
        "gen.sign_convention": meta.SIGN_CONVENTION,
        "gen.dbc_sha256": dbc.sha256,
        **_test_props(test, start_time, duration),
    }
    mdf.header.comment = _header_xml(
        props,
        f"Synthetic battery CAN recording, {platform}, {device}/{route}/{segment}, "
        f"scenario {scenario_id}. Decode with {DBC_NAME} "
        f"(sha256 {dbc.sha256[:12]}...), embedded as an attachment and resolvable "
        f"from DCM as type='{DCM_TYPE}' target_key='{DCM_TARGET_KEY}'. "
        f"Test Manager run {test.get('run_key')}, work order "
        f"{test.get('work_order')}, rig {test.get('rig')}.",
    )
    mdf.header.start_time = start_time

    mdf.attach(
        dbc.raw,
        file_name=f"{DBC_NAME}.dbc",
        comment=(
            f"{DBC_NAME} database. sha256={dbc.sha256}. "
            f"DCM: type={DCM_TYPE} target_key={DCM_TARGET_KEY}"
        ),
        mime="application/x-dbc",
        embedded=True,
        compression=True,
    )

    for history in mdf.file_history:
        history.time_stamp = start_time

    path.parent.mkdir(parents=True, exist_ok=True)
    mdf.save(path, overwrite=True, compression=2, add_history_block=False)

    return {
        "frames": log.count,
        "duration_s": round(duration, 3),
        "size_bytes": path.stat().st_size,
    }
