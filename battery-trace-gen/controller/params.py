"""The numbers the BMS controls to.

Eleven of them are the DCM battery parameter set, read at run time from
``data/battery-dc-parameters.json`` — the same document the requirement text is
templated against, so a limit cannot drift between the requirement and the system
under test. The rest are controller calibrations with no counterpart in the
requirements; they live in ``scenarios/_controller_base.json``. Either group can be
shadowed per scenario through ``controller_param_overrides``, which is how three of the
four declared defects are injected.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

TOOL_ROOT = Path(__file__).resolve().parents[1]
PARAMETERS_PATH = TOOL_ROOT / "data" / "battery-dc-parameters.json"
CALIBRATION_PATH = TOOL_ROOT / "scenarios" / "_controller_base.json"


def load_values(overrides: dict[str, float] | None = None) -> dict[str, float]:
    """DCM parameters, then controller calibrations, then the scenario's overrides."""
    document = json.loads(PARAMETERS_PATH.read_text(encoding="utf-8"))
    values: dict[str, float] = {
        item["name"]: float(item["value"]) for item in document["items"]
    }

    calibration = json.loads(CALIBRATION_PATH.read_text(encoding="utf-8"))
    # HEAT2_ON is declared as null in the base document: its default is T_batt_min, and
    # naming the number twice would let the two drift.
    if calibration.get("HEAT2_ON") is None:
        calibration["HEAT2_ON"] = values["T_batt_min"]
    values.update({name: float(value) for name, value in calibration.items()})

    values.update({name: float(value) for name, value in (overrides or {}).items()})
    return values


@dataclass(frozen=True)
class ControllerParams:
    """One scenario's control limits, in battery sign (positive = discharge)."""

    i_chr_max_a: float
    t_transient_voltage_s: float
    udc_min_v: float
    udc_max_v: float
    t_batt_max_c: float
    t_batt_safety_threshold_c: float
    p_heater_middle_w: float
    p_heater_max_w: float
    t_batt_min_c: float
    soc_tech_at_cust_0pct: float
    soc_tech_at_cust_100pct: float
    t_filt_tau_s: float
    r_int_est_ohm: float
    i_dis_max_a: float
    i_chg_max_a: float
    heat2_on_c: float
    heat_hyst_1_k: float
    heat_hyst_2_k: float
    tau_bal_s: float
    n_cells: int
    bal_on_delta_v: float
    bal_off_delta_v: float
    cell_spread_v: float

    @classmethod
    def from_values(cls, values: dict[str, float]) -> ControllerParams:
        return cls(
            i_chr_max_a=values["I_current_Chr_Max"],
            t_transient_voltage_s=values["t_transient_Voltage_sec"],
            udc_min_v=values["Udc_min"],
            udc_max_v=values["Udc_Max"],
            t_batt_max_c=values["T_batt_max"],
            t_batt_safety_threshold_c=values["T_batt_safety_threshold"],
            p_heater_middle_w=values["P_heater_middle"],
            p_heater_max_w=values["P_heater_max"],
            t_batt_min_c=values["T_batt_min"],
            soc_tech_at_cust_0pct=values["SOC_tech_at_cust_0pct"],
            soc_tech_at_cust_100pct=values["SOC_tech_at_cust_100pct"],
            t_filt_tau_s=values["T_FILT_TAU"],
            r_int_est_ohm=values["R_INT_EST"],
            i_dis_max_a=values["I_DIS_MAX"],
            i_chg_max_a=values["I_CHG_MAX"],
            heat2_on_c=values["HEAT2_ON"],
            heat_hyst_1_k=values["HEAT_HYST_1"],
            heat_hyst_2_k=values["HEAT_HYST_2"],
            tau_bal_s=values["TAU_BAL"],
            n_cells=int(values["N_CELLS"]),
            bal_on_delta_v=values["BAL_ON_DELTA"],
            bal_off_delta_v=values["BAL_OFF_DELTA"],
            cell_spread_v=values["CELL_SPREAD"],
        )


def load(overrides: dict[str, float] | None = None) -> ControllerParams:
    return ControllerParams.from_values(load_values(overrides))
