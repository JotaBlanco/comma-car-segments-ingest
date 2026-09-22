"""``BMS_State`` — seven states, all conditions on bus-side quantities.

Balancing is not a state here: it is the orthogonal flag ``BMS_Balancing_Act`` asserted
inside a Sleep residency, so the requirement's system-state ``Balancing`` maps onto
``BMS_State == 1 AND BMS_Balancing_Act == 1``. A distinct top-level state would end the
Sleep residency mid-relaxation and make PRF-002's entry edge ambiguous.
"""

from __future__ import annotations

from dataclasses import dataclass

OFF = 0
SLEEP = 1
STANDBY = 2
CHARGING = 3
DISCHARGING = 4
HEATING = 5
FAULT = 6


@dataclass(frozen=True)
class StateInputs:
    charge_plug: int
    obc_active: int
    veh_state: int
    kl15: int
    p_req_bus_w: float
    heater_req: int


def next_state(inputs: StateInputs) -> int:
    """The state the BMS reports now. Fault is unreachable in these four traces."""
    if inputs.charge_plug == 1 and inputs.obc_active == 1:
        return CHARGING
    if inputs.veh_state == 3 and inputs.p_req_bus_w > 0.0:
        return DISCHARGING
    if inputs.heater_req > 0:
        return HEATING
    if inputs.kl15 == 0 and inputs.charge_plug == 0:
        return SLEEP
    return STANDBY
