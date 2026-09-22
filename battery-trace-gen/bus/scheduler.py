"""Which frames are transmitted in which 10 ms bus slot.

The plant runs at SAMPLE_TIME = 0,1 s and the fastest frame is 100 Hz, so the bus grid
is ten times finer than the plant grid: signal values are latched once per plant tick
and held across the ten slots that follow. Frame ``f`` with cycle ``c_f`` ms is
transmitted at exactly ``t = n * c_f``; there is no jitter, so two runs of one scenario
produce byte-identical payloads.
"""

from __future__ import annotations

from dataclasses import dataclass

from cantools.database.can import Message

SLOT_MS = 10
SLOT_S = SLOT_MS / 1000.0
SLOTS_PER_TICK = 10


@dataclass(frozen=True)
class ScheduledFrame:
    message: Message
    stride: int


class Scheduler:
    """Frames due in a bus slot, ascending CAN id within the slot."""

    def __init__(self, messages: list[Message]) -> None:
        self._frames = [
            ScheduledFrame(message=m, stride=int(m.cycle_time) // SLOT_MS)
            for m in sorted(messages, key=lambda m: m.frame_id)
        ]

    @property
    def frames_per_second(self) -> float:
        return sum(1000.0 / (f.stride * SLOT_MS) for f in self._frames)

    def frame_count(self, slots: int) -> int:
        """How many frames ``slots`` bus slots emit in total."""
        return sum((slots + f.stride - 1) // f.stride for f in self._frames)

    def due(self, slot: int) -> list[Message]:
        return [f.message for f in self._frames if slot % f.stride == 0]
