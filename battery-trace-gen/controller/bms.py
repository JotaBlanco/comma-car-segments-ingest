"""The BMS: one ``update`` per plant tick, producing everything the bus carries.

Two groups of signals are reported one tick late, because the command issued on tick k
only reaches the plant on tick k+1 and a report that disagreed with the current the
plant is actually passing would be indistinguishable from a control defect:

* the derating triple ``BMS_T_Derate_Ref`` / ``BMS_Derating_Fct`` / ``BMS_I_Chg_Lim`` —
  the limit in force on the current now on the bus;
* ``BTMS_Heater_State`` and ``BTMS_P_Heater`` — the heat the plant is injecting this
  tick, against ``BTMS_Heater_Req``, which is what the BMS is asking for now.
"""

from __future__ import annotations

from dataclasses import dataclass

from plant.adapter import BusState
from scenario import Stimulus

from . import laws
from .cells import CellModel, CellSample
from .params import ControllerParams
from .state_machine import StateInputs, next_state


@dataclass(frozen=True)
class ControllerOutput:
    """Everything the BMS, OBC, VCU and BTMS frames carry for one tick."""

    state: int
    i_target_a: float
    p_req_bus_w: float
    derating: float
    t_derate_ref_c: float
    i_chg_lim_a: float
    soc_cust_pct: float
    ocv_est_v: float
    heater_req: int
    heater_state: int
    heater_power_w: float
    chiller_state: int
    chiller_power_w: float
    coolant_c: float
    accel_pct: float
    brake_pct: float
    obc_active: int
    obc_i_out_a: float
    obc_u_out_v: float
    obc_i_avail_a: float
    obc_fault: int
    cells: CellSample


class BmsController:
    """Owns the filtered derating temperature, the heater latch and the cell spread."""

    def __init__(
        self,
        params: ControllerParams,
        *,
        cell_seed: int,
        dt_s: float,
        t_batt_init_c: float,
    ) -> None:
        self._p = params
        self._dt = dt_s
        self._cells = CellModel(cell_seed, params)
        self._t_ref = t_batt_init_c
        self._heater = 0
        derating = laws.derating(
            t_batt_init_c, params.t_batt_max_c, params.t_batt_safety_threshold_c
        )
        self._reported = (
            t_batt_init_c,
            derating,
            laws.charge_limit(params.i_chr_max_a, derating),
        )

    def update(self, state: BusState, stimulus: Stimulus) -> ControllerOutput:
        p = self._p

        self._t_ref = laws.filter_temperature(
            self._t_ref, state.t_batt_c, self._dt, p.t_filt_tau_s
        )
        derating = laws.derating(
            self._t_ref, p.t_batt_max_c, p.t_batt_safety_threshold_c
        )
        i_chg_lim = laws.charge_limit(p.i_chr_max_a, derating)
        reported_ref, reported_derating, reported_lim = self._reported
        self._reported = (self._t_ref, derating, i_chg_lim)

        i_dis_lim = laws.discharge_limit(
            state.u_dc_v, p.udc_min_v, p.r_int_est_ohm, p.i_dis_max_a
        )
        i_target = laws.current_target(
            i_demand_a=stimulus.i_demand_a,
            i_chg_lim_a=i_chg_lim,
            obc_i_avail_a=stimulus.obc_i_avail_a,
            i_dis_lim_a=i_dis_lim,
        )
        p_req_bus = laws.power_request(i_target, state.u_dc_v)

        applied_heater = self._heater
        self._heater = laws.heater_state(self._heater, state.t_batt_c, p)

        obc_active = 1 if stimulus.charge_plug else 0
        bms_state = next_state(
            StateInputs(
                charge_plug=stimulus.charge_plug,
                obc_active=obc_active,
                veh_state=stimulus.veh_state,
                kl15=stimulus.kl15,
                p_req_bus_w=p_req_bus,
                heater_req=self._heater,
            )
        )
        cells = self._cells.update(state.u_dc_v, bms_state, self._dt)
        accel_pct, brake_pct = laws.pedals(state.i_dc_a, stimulus.charge_plug, p)

        return ControllerOutput(
            state=bms_state,
            i_target_a=i_target,
            p_req_bus_w=p_req_bus,
            derating=reported_derating,
            t_derate_ref_c=reported_ref,
            i_chg_lim_a=reported_lim,
            soc_cust_pct=laws.customer_soc(
                state.soc_tech_pct,
                p.soc_tech_at_cust_0pct,
                p.soc_tech_at_cust_100pct,
            ),
            ocv_est_v=laws.ocv_estimate(state.soc_tech_pct, p.udc_min_v, p.udc_max_v),
            heater_req=self._heater,
            heater_state=applied_heater,
            heater_power_w=laws.heater_power(applied_heater, p),
            chiller_state=stimulus.chiller_setting,
            chiller_power_w=stimulus.chiller_power_w,
            coolant_c=(
                stimulus.coolant_c if stimulus.chiller_setting else state.t_batt_c
            ),
            accel_pct=accel_pct,
            brake_pct=brake_pct,
            obc_active=obc_active,
            obc_i_out_a=state.i_dc_a if obc_active else 0.0,
            obc_u_out_v=state.u_dc_v,
            obc_i_avail_a=stimulus.obc_i_avail_a,
            obc_fault=0,
            cells=cells,
        )
