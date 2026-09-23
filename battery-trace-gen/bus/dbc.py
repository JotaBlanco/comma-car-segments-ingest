"""Access to the battery CAN database, which lives only under ``dcm-seed-dbc/dbc/``.

There is no second copy: the sha256 stamped into every MF4 header and the bytes DCM
serialises have to be the same file.

Its basename is the PLATFORM, not the database's own name: ``dcm-seed-dbc`` keys each
DCM document by basename, and that key is what the decoder resolves a DBC by. The
database calls itself BATTERY_DC_V1 in its ``VERSION`` line and keeps doing so.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import cantools
from cantools.database.can import Database, Message

REPO_ROOT = Path(__file__).resolve().parents[2]
DBC_NAME = "Porsche_Taycan"
DBC_PATH = REPO_ROOT / "dcm-seed-dbc" / "dbc" / f"{DBC_NAME}.dbc"
DCM_TYPE = "dbc"
DCM_TARGET_KEY = DBC_NAME

CELL_FRAME = "BMS_Cell_01"
CELL_MUX_SIGNAL = "BMS_Cell_Mux"
CELL_COUNT = 200
CELLS_PER_FRAME = 4


@dataclass(frozen=True)
class BatteryDbc:
    """The loaded database plus the identity the MF4 header and DCM both key on."""

    database: Database
    path: Path
    raw: bytes

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.raw).hexdigest()

    @property
    def config_id(self) -> str:
        """The id DCM derives for this database, ``sha1("dbc-Porsche_Taycan")``."""
        return hashlib.sha1(f"{DCM_TYPE}-{DCM_TARGET_KEY}".encode()).hexdigest()

    @property
    def version(self) -> str:
        """The database's own ``VERSION`` line, which is not the platform key."""
        return self.database.version or ""

    @property
    def counts(self) -> dict[str, int]:
        return {
            "frames": len(self.database.messages),
            "signals": sum(len(m.signals) for m in self.database.messages),
            "nodes": len(self.database.nodes),
        }

    @property
    def messages(self) -> list[Message]:
        """Every frame in ascending CAN id, the order frames are emitted in."""
        return sorted(self.database.messages, key=lambda m: m.frame_id)


def load() -> BatteryDbc:
    return BatteryDbc(
        database=cantools.database.load_file(str(DBC_PATH), strict=False),
        path=DBC_PATH,
        raw=DBC_PATH.read_bytes(),
    )
