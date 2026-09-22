"""L8 — the 200-cell array, its spread, and the balancing flag.

The pack model is a single node, so per-cell voltages are synthesised: one seeded offset
per cell, drawn once, scaled by a spread factor that decays only while balancing is
active. ``BMS_04``'s min/max/delta and the ``BMS_Cell_01`` mux frame are computed from
the same array, so the two frames cannot disagree.

Per-cell bleed current is around 100 mA and invisible at pack level, so balancing draws
no pack current — declared, not modelled.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .params import ControllerParams
from .state_machine import SLEEP


@dataclass(frozen=True)
class CellSample:
    voltages: np.ndarray
    u_min_v: float
    u_max_v: float
    u_delta_v: float
    min_index: int
    max_index: int
    balancing: int


class CellModel:
    """Owns the cell offsets, the spread factor s(t) and the balancing hysteresis."""

    def __init__(self, seed: int, params: ControllerParams) -> None:
        self._params = params
        self._offsets = np.random.default_rng(seed).uniform(
            -params.cell_spread_v, params.cell_spread_v, params.n_cells
        )
        self._scale = 1.0
        self._balancing = 0

    def update(self, u_dc_v: float, state: int, dt_s: float) -> CellSample:
        voltages = u_dc_v / self._params.n_cells + self._offsets * self._scale
        min_index = int(voltages.argmin())
        max_index = int(voltages.argmax())
        delta = float(voltages[max_index] - voltages[min_index])

        if state != SLEEP:
            self._balancing = 0
        elif self._balancing and delta < self._params.bal_off_delta_v:
            self._balancing = 0
        elif not self._balancing and delta > self._params.bal_on_delta_v:
            self._balancing = 1

        sample = CellSample(
            voltages=voltages,
            u_min_v=float(voltages[min_index]),
            u_max_v=float(voltages[max_index]),
            u_delta_v=delta,
            min_index=min_index + 1,
            max_index=max_index + 1,
            balancing=self._balancing,
        )

        if self._balancing:
            self._scale *= math.exp(-dt_s / self._params.tau_bal_s)

        return sample
