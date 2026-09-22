"""End-to-end protection for BATTERY_DC_V1: CRC-8/SAE-J1850 and the BZ counter.

CRC-8/SAE-J1850: polynomial 0x1D, init 0xFF, no input or output reflection, final
XOR 0xFF. It is computed over ``[id >> 8, id & 0xFF] + data[0:7]``, so the two-byte
big-endian CAN id acts as the AUTOSAR-style Data ID and a frame's CRC is
frame-specific; byte 7 carries the CRC itself and is excluded.
"""

from __future__ import annotations

_POLYNOMIAL = 0x1D


def _build_table() -> tuple[int, ...]:
    table = []
    for value in range(256):
        crc = value
        for _ in range(8):
            crc = ((crc << 1) ^ _POLYNOMIAL) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
        table.append(crc)
    return tuple(table)


_TABLE = _build_table()


def crc8_j1850(payload: bytes) -> int:
    """CRC-8/SAE-J1850 over ``payload``."""
    crc = 0xFF
    for byte in payload:
        crc = _TABLE[crc ^ byte]
    return crc ^ 0xFF


def frame_crc(frame_id: int, data: bytes) -> int:
    """The ``<Frame>_CRC`` byte for one transmission of ``frame_id``."""
    return crc8_j1850(bytes((frame_id >> 8, frame_id & 0xFF)) + data[:7])


class RollingCounters:
    """Per-frame 4-bit ``<Frame>_BZ`` counters, 0 at t = 0, wrapping 15 -> 0."""

    def __init__(self) -> None:
        self._values: dict[int, int] = {}

    def take(self, frame_id: int) -> int:
        """Value to transmit now; the next call for this frame returns value + 1."""
        value = self._values.get(frame_id, 0)
        self._values[frame_id] = (value + 1) & 0x0F
        return value


class MuxCounter:
    """Multiplex index of ``BMS_Cell_01``: advances on every transmission, wraps."""

    def __init__(self, groups: int) -> None:
        self._groups = groups
        self._value = 0

    def take(self) -> int:
        value = self._value
        self._value = (value + 1) % self._groups
        return value
