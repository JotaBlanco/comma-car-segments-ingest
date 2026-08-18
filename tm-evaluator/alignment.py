"""Cross-raster alignment, declared once (spec 4.6).

The alignment base is the channel group of the criterion's **primary signal**. Any
signal referenced from a coarser group is zero-order-hold forward-filled onto that
grid: at each base timestamp the coarse signal takes its most recent value. Samples
before the coarse signal's first sample are NaN, not the first value - a value that
did not exist yet must not be invented.

Every timing result carries ``uncertainty_s`` = half the coarsest contributing
raster period (5 ms for 100 Hz, 10 ms for 50 Hz, 50 ms for 10 Hz), and
``alignment = {method: "zoh", base_group, filled_groups[]}``. Uncertainty is
**reported, never subtracted from a bound** - a test manager that quietly widens a
limit by its own measurement error cannot fail.
"""

import numpy as np

RASTER_HZ = {
    "PT_CAN_100Hz": 100.0,
    "RADAR_OBJ_50Hz": 50.0,
    "ACC_HMI_10Hz": 10.0,
    "SIM_REF_100Hz": 100.0,
}


class AlignmentError(RuntimeError):
    """The base grid is empty, so nothing can be aligned onto it."""


def zoh(source_t: np.ndarray, source_y: np.ndarray, base_t: np.ndarray) -> np.ndarray:
    """Zero-order-hold forward-fill ``source_y`` onto ``base_t``."""
    if source_t.size == 0:
        return np.full(base_t.shape, np.nan)
    indices = np.searchsorted(source_t, base_t, side="right") - 1
    out = np.full(base_t.shape, np.nan)
    valid = indices >= 0
    out[valid] = source_y[indices[valid]]
    return out


def uncertainty_s(groups: list[str]) -> float:
    """Half the coarsest contributing raster period."""
    rasters = [RASTER_HZ[group] for group in groups if group in RASTER_HZ]
    if not rasters:
        return 0.0
    return round(0.5 / min(rasters), 6)


class AlignedFrame:
    """One base grid plus every signal the criterion needs, ZOH-aligned onto it."""

    def __init__(self, base_group: str, base_t: np.ndarray) -> None:
        if base_t.size == 0:
            raise AlignmentError(
                f"channel group {base_group} returned no samples; there is no base grid"
            )
        self.base_group = base_group
        self.t = base_t
        self.signals: dict[str, np.ndarray] = {}
        self.signal_group: dict[str, str] = {}
        self.filled_groups: list[str] = []
        self.missing: list[str] = []

    def add_native(self, name: str, values: np.ndarray) -> None:
        """A signal already on the base grid."""
        self.signals[name] = values
        self.signal_group[name] = self.base_group

    def add_from(self, name: str, group: str, source_t: np.ndarray,
                 source_y: np.ndarray) -> None:
        """A signal from another group, forward-filled onto the base grid."""
        self.signals[name] = zoh(source_t, source_y, self.t)
        self.signal_group[name] = group
        if group != self.base_group and group not in self.filled_groups:
            self.filled_groups.append(group)

    def mark_missing(self, name: str) -> None:
        if name not in self.missing:
            self.missing.append(name)

    def has(self, name: str) -> bool:
        return name in self.signals

    def get(self, name: str) -> np.ndarray:
        if name not in self.signals:
            raise KeyError(f"signal {name!r} was not loaded onto the {self.base_group} grid")
        return self.signals[name]

    def contributing_groups(self) -> list[str]:
        return [self.base_group, *self.filled_groups]

    def uncertainty_s(self) -> float:
        return uncertainty_s(self.contributing_groups())

    def as_dict(self) -> dict:
        return {
            "method": "zoh",
            "base_group": self.base_group,
            "filled_groups": sorted(self.filled_groups),
            "uncertainty_s": self.uncertainty_s(),
            "sample_count": int(self.t.size),
        }

    def sample_period_s(self) -> float:
        """Median sample spacing of the base grid, used by duration reductions."""
        if self.t.size < 2:
            return 0.0
        return float(np.median(np.diff(self.t)))
