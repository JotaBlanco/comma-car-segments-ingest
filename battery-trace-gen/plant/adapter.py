"""Between the vendored plant and the bus.

``from_plant`` is a pure rename: after the polarity patch every quantity the plant
publishes is already in bus units and battery sign. ``to_plant`` carries the one place
in this tool where a sign is flipped — the plant's *input* setpoint
``requested_power_w`` keeps its documented powertrain sign because the patch did not
touch the input path.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class BusState:
    """One plant tick as the bus sees it. Battery sign: positive current = discharge."""

    t_s: float
    u_dc_v: float
    i_dc_a: float
    ocv_v: float
    soc_tech_pct: float
    t_batt_c: float


def from_plant(payload: dict[str, Any], t_s: float) -> BusState:
    return BusState(
        t_s=t_s,
        u_dc_v=float(payload["dc_voltage_v"]),
        i_dc_a=float(payload["dc_current_a"]),
        ocv_v=float(payload["ocv_v"]),
        soc_tech_pct=float(payload["soc_percent"]),
        t_batt_c=float(payload["temperature_c"]),
    )


def to_plant(
    *, p_req_bus_w: float, ambient_c: float, heater_setting: int, chiller_setting: int
) -> dict[str, float]:
    """Setpoints for the next tick. The negation below is the whole sign conversion."""
    return {
        "requested_power_w": -p_req_bus_w,
        "ambient_temp_c": ambient_c,
        "heater_setting": heater_setting,
        "chiller_setting": chiller_setting,
    }
