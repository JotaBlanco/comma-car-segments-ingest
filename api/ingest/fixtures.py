"""The demo measurement byte mint.

This module mints one small, real MF4 object in memory. `blob_seed.py` writes
those bytes at each registered file's `storage_ref`, so the download button
serves a real measurement file on a developer machine.

**The landing drop left on 19 Aug 2026.** The module used to write the demo
drop into the prefix the watcher polled (`write_all`, `write_fixture`, `main`).
The watcher moved to the ingestion pipeline, and the pipeline's own generator
owns the live cast now (`plans/design/INGEST-SPLIT.md`). What stays is the byte
mint and the small store writer that `blob_seed.py` calls.

**A script, never a committed binary.** `.gitignore` excludes `*.mf4`, `*.mdf`
and `landing_zone/`. A committed binary is a fact nobody can reproduce. A
script mints the same fixture again on any machine, so the script is the
artefact.

`FIXTURES` holds three fixtures. `blob_seed.py` uses the first one, and the
store tests need a second and a third object.
"""

from __future__ import annotations

import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import cache
from pathlib import Path
from typing import Any

from ingest.store import BlobStore, FileSource, LocalStore

# The start time rebases on every import, so a minted run lands inside the
# Home "runs today" window. A pinned date held the run outside that count, and
# it also stretched the run over four days. Whole seconds only: asammdf
# round-trips them, and a test compares the parsed value.
START_TIME = datetime.now(UTC).replace(microsecond=0)

# Small on purpose. A demo drop must register while the audience watches.
SAMPLE_COUNT = 1000
DURATION_SECONDS = 10.0


@dataclass(frozen=True)
class Fixture:
    """One demo measurement file and the manifest that verifies it."""

    key: str
    run_id: str
    rig: str
    channels: tuple[tuple[str, str], ...]


FIXTURES: tuple[Fixture, ...] = (
    Fixture(
        key="rig-04/bat_cyc_TAS-88214_0941.mf4",
        run_id="TAS-88214",
        rig="RIG-04",
        # **Never name the seed's hero signal here.** The seed writes lake rows
        # for `HV_Batt_Cell_Temp_Max` on this run, and a second writer would
        # add 1000 real samples to the same `run_id,signal` partition. The
        # statistics query then averages a measurement with a synthetic set:
        # measured on 18 Aug 2026, the API served mean 32.2196 and the seed's
        # max, where the file alone gives 32.2031 and its own max. File detail
        # served the seed numbers at the same time, so two screens stated two
        # numbers for one run. One partition takes one writer.
        channels=(("HV_Batt_Cell_Temp_Min", "°C"), ("Coolant_Inlet_Temp", "°C")),
    ),
    Fixture(
        key="rig-04/bat_cyc_TAS-88215_1130.mf4",
        run_id="TAS-88215",
        rig="RIG-04",
        channels=(("HV_Batt_Cell_Temp_Max", "°C"), ("HV_Batt_Current", "A")),
    ),
    Fixture(
        key="rig-07/thermal_TAS-88216_1402.mf4",
        run_id="TAS-88216",
        rig="RIG-07",
        channels=(("Coolant_Inlet_Temp", "°C"), ("Ambient_Temp", "°C")),
    ),
)

def _samples(index: int) -> Any:
    """Build one deterministic channel. The same run mints the same numbers."""
    import numpy as np

    time = np.linspace(0.0, DURATION_SECONDS, SAMPLE_COUNT)
    return 18.2 + 12.0 * index + 29.7 * np.sin(time / (3.0 + index)) ** 2


@cache
def mf4_bytes(fixture: Fixture) -> bytes:
    """Write one real small MF4 with asammdf and return its bytes.

    asammdf saves to a path, so the function uses a temporary directory and
    returns the bytes. Nothing stays on disk.

    **The result is cached, so one process mints one byte image per fixture.**
    asammdf writes three bytes that change on every save, measured on
    2026-08-17, so two mints of the same fixture are two different files with
    two different checksums. `blob_seed.py` fills many keys in one run, and the
    cache holds every key on one byte image.
    """
    import numpy as np
    from asammdf import MDF, Signal

    time = np.linspace(0.0, DURATION_SECONDS, SAMPLE_COUNT)
    signals = [
        Signal(_samples(index), time, name=name, unit=unit)
        for index, (name, unit) in enumerate(fixture.channels)
    ]
    mdf = MDF()
    mdf.append(signals)
    mdf.header.start_time = START_TIME
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "fixture.mf4"
        mdf.save(path, overwrite=True)
        mdf.close()
        return path.read_bytes()


def put_object(store: FileSource, key: str, data: bytes) -> None:
    """Write one object into either store.

    `FileSource` states a read interface only, because the two API blob legs
    need no more. The seed job needs a write, and it stays here.
    """
    if isinstance(store, LocalStore):
        path = store._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return
    if isinstance(store, BlobStore):
        store._fs.pipe(key, data)
        return
    raise TypeError(f"the fixture writer does not know {type(store).__name__}")


__all__ = [
    "FIXTURES",
    "START_TIME",
    "Fixture",
    "mf4_bytes",
    "put_object",
]
