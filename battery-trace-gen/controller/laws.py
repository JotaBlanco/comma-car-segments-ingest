"""The control laws, in battery sign: current and power positive = out of the pack.

Every limit arrives as an argument. Nothing here reads a document or holds state; the
two states the controller carries — the filtered derating temperature and the cell
spread — live in :mod:`controller.bms` and :mod:`controller.cells`.
"""

from __future__ import annotations

from .params import ControllerParams


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def ocv_estimate(soc_tech_pct: float, udc_min_v: float, udc_max_v: float) -> float:
    """L1 — linear OCV estimate across the SAF-001 window."""
    return udc_min_v + (udc_max_v - udc_min_v) * soc_tech_pct / 100.0


def filter_temperature(
    t_ref_c: float, t_batt_c: float, dt_s: float, tau_s: float
) -> float:
    """L2 — first-order lag modelling the averaging window the derating path uses."""
    return t_ref_c + (t_batt_c - t_ref_c) * dt_s / tau_s


def derating(t_ref_c: float, t_batt_max_c: float, band_k: float) -> float:
    """L2 — 1,0 at or below ``t_batt_max - band``, 0,0 at or above ``t_batt_max``."""
    return clamp((t_batt_max_c - t_ref_c) / band_k, 0.0, 1.0)


def charge_limit(i_chr_max_a: float, derating_factor: float) -> float:
    """L3 — permitted charge-current magnitude; the current is its negative."""
    return i_chr_max_a * derating_factor


def discharge_limit(
    u_dc_v: float, udc_min_v: float, r_int_est_ohm: float, i_dis_max_a: float
) -> float:
    """L4 — resistance-based limit, approaching the lower rail asymptotically."""
    return clamp((u_dc_v - udc_min_v) / r_int_est_ohm, 0.0, i_dis_max_a)


def current_target(
    *, i_demand_a: float, i_chg_lim_a: float, obc_i_avail_a: float, i_dis_lim_a: float
) -> float:
    """L3/L4 — the demand's sign selects the branch; each clamps to its own limit."""
    if i_demand_a < 0.0:
        return -min(i_chg_lim_a, obc_i_avail_a, -i_demand_a)
    if i_demand_a > 0.0:
        return min(i_demand_a, i_dis_lim_a)
    return 0.0


def power_request(i_target_a: float, u_dc_v: float) -> float:
    """L5 — R0 = 0 in every scenario, so I = P / U_dc holds exactly."""
    return i_target_a * u_dc_v


def customer_soc(soc_tech_pct: float, at_0pct: float, at_100pct: float) -> float:
    """L6 — the clamped linear customer map."""
    return clamp((soc_tech_pct - at_0pct) / (at_100pct - at_0pct) * 100.0, 0.0, 100.0)


def heater_state(previous: int, t_batt_c: float, params: ControllerParams) -> int:
    """L7 — latching two-level hysteresis. ``previous`` is last tick's state."""
    if t_batt_c < params.heat2_on_c:
        return 2
    if previous == 2 and t_batt_c < params.t_batt_min_c + params.heat_hyst_2_k:
        return 2
    if t_batt_c < params.t_batt_min_c + params.heat_hyst_1_k:
        return 1
    return 0


def heater_power(state: int, params: ControllerParams) -> float:
    return {0: 0.0, 1: params.p_heater_middle_w, 2: params.p_heater_max_w}[state]


def pedals(
    i_dc_a: float, charge_plug: int, params: ControllerParams
) -> tuple[float, float]:
    """L9 — gas tracks discharge, brake tracks regen, both zero while plugged in."""
    if charge_plug:
        return 0.0, 0.0
    accel = 100.0 * max(i_dc_a, 0.0) / params.i_dis_max_a
    brake = 100.0 * max(-i_dc_a, 0.0) / params.i_chg_max_a
    return accel, brake
