"""Access to BATTERY_DC_V1, which lives only under ``dcm-seed-dbc/dbc/``.

There is no second copy: the sha256 stamped into every MF4 header and the bytes DCM
serialises have to be the same file.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import cantools
from cantools.database.can import Database, Message

REPO_ROOT = Path(__file__).resolve().parents[2]
DBC_NAME = "BATTERY_DC_V1"
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
        """The id DCM derives for this database, ``sha1("dbc-BATTERY_DC_V1")``."""
        return hashlib.sha1(f"{DCM_TYPE}-{DCM_TARGET_KEY}".encode()).hexdigest()

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
