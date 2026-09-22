"""What each of the ten test implementations measures, and what makes it pass.

One entry per test case. `measure` is the body of the generated module's
`_measure`, and it is the SAME reduction `manifest.py` runs over the generator's
own signal history — so the achieved numbers a run produces in the lake and the
expected numbers `out/manifest.csv` records are comparable key for key.

`passes` is the boolean over those evidence keys. Its thresholds are the
requirement's own parameters wherever one exists; the rest are the tolerances
the test spec states (`pass_criteria[].tolerance.abs`) or the resolution of the
signal being reduced. Every number a module enforces is in its `limits`, so the
uploaded `.py` carries its own limits and needs no catalogue to read them.

`signals[0]` is the grid: the module aligns every other signal onto its raster.
"""

from __future__ import annotations

from dataclasses import dataclass, field

#: `BMS_State` encoding, from `controller/state_machine.py`.
BMS_STATE = {"SLEEP": 1, "CHARGING": 3, "DISCHARGING": 4}

#: Pack capacity, from `plant/parameters.json` (`Q_MAX_AH` = 100 Ah), in ampere
#: seconds. The coulomb-counting test integrates the current against it.
Q_MAX_AS = 100.0 * 3600.0


@dataclass(frozen=True)
class Case:
    """One generated implementation: what it reads, measures and decides."""

    signals: tuple[str, ...]
    limits: dict[str, float]
    measure: str
    passes: str
    rule: str
    states: tuple[str, ...] = field(default=())


CASES: dict[str, Case] = {
    "BAT-SYS-TC-001": Case(
        signals=("BMS_I_Dc", "BMS_State"),
        limits={"I_current_Chr_Max": 300.0, "i_tolerance_a": 0.05},
        states=("CHARGING",),
        rule=(
            "The most negative BMS_I_Dc inside the Charging residency is at or "
            "above -I_current_Chr_Max, within the signal's quantisation step."
        ),
        measure="""\
    charging = history["BMS_State"] == CHARGING
    i_dc = history["BMS_I_Dc"][charging]
    minimum = float(i_dc.min())
    return {
        "min_i_dc_a": minimum,
        "limit_a": -LIMITS["I_current_Chr_Max"],
        "margin_a": minimum + LIMITS["I_current_Chr_Max"],
    }""",
        passes='evidence["min_i_dc_a"] >= evidence["limit_a"] - LIMITS["i_tolerance_a"]',
    ),
    "BAT-SYS-TC-002": Case(
        signals=(
            "BMS_Derating_Fct",
            "BMS_T_Derate_Ref",
            "BMS_State",
            "BMS_I_Dc",
            "BMS_I_Chg_Lim",
        ),
        limits={
            "T_batt_max": 60.0,
            "T_batt_safety_threshold": 5.0,
            "law_error_tolerance": 0.02,
            "limit_excess_tolerance_a": 0.5,
        },
        states=("CHARGING",),
        rule=(
            "BMS_Derating_Fct follows the clamped derating law off "
            "BMS_T_Derate_Ref, and the charge current never exceeds the limit "
            "the factor produces."
        ),
        measure="""\
    expected = np.clip(
        (LIMITS["T_batt_max"] - history["BMS_T_Derate_Ref"])
        / LIMITS["T_batt_safety_threshold"],
        0.0,
        1.0,
    )
    charging = history["BMS_State"] == CHARGING
    excess = -history["BMS_I_Dc"][charging] - history["BMS_I_Chg_Lim"][charging]
    return {
        "max_law_error": float(np.abs(history["BMS_Derating_Fct"] - expected).max()),
        "max_limit_excess_a": float(excess.max()),
        "min_derating_fct": float(history["BMS_Derating_Fct"].min()),
    }""",
        passes=(
            'evidence["max_law_error"] <= LIMITS["law_error_tolerance"]\n'
            '        and evidence["max_limit_excess_a"] <= LIMITS["limit_excess_tolerance_a"]'
        ),
    ),
    "BAT-SYS-TC-003": Case(
        signals=("BMS_T_Batt",),
        limits={"T_batt_max": 60.0, "t_tolerance_k": 0.1},
        rule="BMS_T_Batt stays at or below T_batt_max at every sample of the run.",
        measure="""\
    t_batt = history["BMS_T_Batt"]
    above = t_batt > LIMITS["T_batt_max"]
    return {
        "max_degc": float(t_batt.max()),
        "limit_degc": LIMITS["T_batt_max"],
        "dwell_above_limit_s": float(above.sum()) * dt_s,
    }""",
        passes='evidence["max_degc"] <= evidence["limit_degc"] + LIMITS["t_tolerance_k"]',
    ),
    "BAT-SYS-TC-004": Case(
        signals=("BMS_Soc_Tech", "BMS_I_Dc"),
        limits={"q_max_as": Q_MAX_AS, "soc_error_tolerance_pct": 0.2},
        rule=(
            "The drop in BMS_Soc_Tech over the sweep equals the integral of "
            "BMS_I_Dc over the pack capacity, within 0,2 %."
        ),
        measure="""\
    soc = history["BMS_Soc_Tech"]
    integrated = (
        float(np.trapezoid(history["BMS_I_Dc"], dx=dt_s)) / LIMITS["q_max_as"] * 100.0
    )
    measured = float(soc[0] - soc[-1])
    return {
        "soc_drop_pct": measured,
        "integrated_drop_pct": integrated,
        "error_pct": abs(measured - integrated),
    }""",
        passes='evidence["error_pct"] <= LIMITS["soc_error_tolerance_pct"]',
    ),
    "BAT-SYS-TC-005": Case(
        signals=("BMS_U_Dc",),
        limits={"Udc_min": 720.0, "Udc_Max": 840.0, "u_tolerance_v": 0.5},
        rule="BMS_U_Dc stays inside Udc_min .. Udc_Max at every sample of the run.",
        measure="""\
    u_dc = history["BMS_U_Dc"]
    return {
        "min_v": float(u_dc.min()),
        "max_v": float(u_dc.max()),
        "lower_limit_v": LIMITS["Udc_min"],
        "upper_limit_v": LIMITS["Udc_Max"],
    }""",
        passes=(
            'evidence["min_v"] >= evidence["lower_limit_v"] - LIMITS["u_tolerance_v"]\n'
            '        and evidence["max_v"] <= evidence["upper_limit_v"] + LIMITS["u_tolerance_v"]'
        ),
    ),
    "BAT-SYS-TC-006": Case(
        signals=("BMS_Soc_Cust", "BMS_Soc_Tech"),
        limits={
            "SOC_tech_at_cust_0pct": 25.0,
            "SOC_tech_at_cust_100pct": 90.0,
            "soc_map_tolerance_pct": 0.5,
        },
        rule=(
            "BMS_Soc_Cust is the clamped linear map of BMS_Soc_Tech over the "
            "customer window, within 0,5 %."
        ),
        measure="""\
    expected = np.clip(
        (history["BMS_Soc_Tech"] - LIMITS["SOC_tech_at_cust_0pct"])
        / (LIMITS["SOC_tech_at_cust_100pct"] - LIMITS["SOC_tech_at_cust_0pct"])
        * 100.0,
        0.0,
        100.0,
    )
    error = np.abs(history["BMS_Soc_Cust"] - expected)
    peak = int(error.argmax())
    return {
        "max_abs_error_pct": float(error[peak]),
        "at_soc_tech_pct": float(history["BMS_Soc_Tech"][peak]),
        "at_t_s": float(times[peak]),
    }""",
        passes='evidence["max_abs_error_pct"] <= LIMITS["soc_map_tolerance_pct"]',
    ),
    "BAT-SYS-TC-007": Case(
        signals=("BMS_U_Cell_Delta", "BMS_Balancing_Act"),
        limits={"delta_ratio_max": 0.5, "delta_increase_tolerance_v": 0.0001},
        rule=(
            "BMS_U_Cell_Delta never rises while balancing is active, and it ends "
            "at half its starting value or less."
        ),
        measure="""\
    active = history["BMS_Balancing_Act"] == 1
    delta = history["BMS_U_Cell_Delta"][active]
    return {
        "delta_start_v": float(delta[0]),
        "delta_end_v": float(delta[-1]),
        "end_over_start": float(delta[-1] / delta[0]),
        "max_increase_v": float(np.diff(delta).max()),
        "balancing_s": float(active.sum()) * dt_s,
    }""",
        passes=(
            'evidence["end_over_start"] <= LIMITS["delta_ratio_max"]\n'
            '        and evidence["max_increase_v"] <= LIMITS["delta_increase_tolerance_v"]'
        ),
    ),
    "BAT-SYS-TC-008": Case(
        signals=("BMS_U_Dc", "BMS_U_Ocv_Est", "BMS_State"),
        limits={"t_transient_Voltage_sec": 600.0, "ocv_tolerance_v": 2.0},
        states=("SLEEP",),
        rule=(
            "|BMS_U_Dc - BMS_U_Ocv_Est| is within 2,0 V at "
            "t_transient_Voltage_sec after the run enters Sleep."
        ),
        measure="""\
    error = np.abs(history["BMS_U_Dc"] - history["BMS_U_Ocv_Est"])
    entry = int(np.argmax(history["BMS_State"] == SLEEP))
    budget = int(round(LIMITS["t_transient_Voltage_sec"] / dt_s))
    return {
        "t_sleep_entry_s": float(times[entry]),
        "budget_s": LIMITS["t_transient_Voltage_sec"],
        "error_v_at_entry": float(error[entry]),
        "error_v_at_budget": float(error[entry + budget]),
        "error_v_at_end": float(error[-1]),
    }""",
        passes='evidence["error_v_at_budget"] <= LIMITS["ocv_tolerance_v"]',
    ),
    "BAT-SYS-TC-009": Case(
        signals=("BTMS_Heater_State", "BTMS_P_Heater"),
        limits={
            "P_heater_middle": 500.0,
            "P_heater_max": 2000.0,
            "p_tolerance_w": 1.0,
            "dwell_minimum_s": 1.0,
        },
        rule=(
            "BTMS_P_Heater is 0 / P_heater_middle / P_heater_max to within 1 W "
            "per BTMS_Heater_State, and each of the three states is occupied "
            "for at least 1 s."
        ),
        measure="""\
    state = history["BTMS_Heater_State"]
    expected = np.select(
        [state == 0, state == 1, state == 2],
        [0.0, LIMITS["P_heater_middle"], LIMITS["P_heater_max"]],
    )
    return {
        "max_power_error_w": float(np.abs(history["BTMS_P_Heater"] - expected).max()),
        "dwell_state_0_s": float((state == 0).sum()) * dt_s,
        "dwell_state_1_s": float((state == 1).sum()) * dt_s,
        "dwell_state_2_s": float((state == 2).sum()) * dt_s,
    }""",
        passes=(
            'evidence["max_power_error_w"] <= LIMITS["p_tolerance_w"]\n'
            "        and min(\n"
            '            evidence["dwell_state_0_s"],\n'
            '            evidence["dwell_state_1_s"],\n'
            '            evidence["dwell_state_2_s"],\n'
            '        ) >= LIMITS["dwell_minimum_s"]'
        ),
    ),
    "BAT-SYS-TC-010": Case(
        signals=("BMS_T_Batt", "BTMS_Heater_State"),
        limits={"T_batt_min": 5.0, "violation_tolerance_s": 0.05},
        rule=(
            "BTMS_Heater_State is 2 at every sample where BMS_T_Batt is below "
            "T_batt_min."
        ),
        measure="""\
    below = history["BMS_T_Batt"] < LIMITS["T_batt_min"]
    violation = below & (history["BTMS_Heater_State"] != 2)
    return {
        "min_degc": float(history["BMS_T_Batt"].min()),
        "limit_degc": LIMITS["T_batt_min"],
        "time_below_min_s": float(below.sum()) * dt_s,
        "violation_s": float(violation.sum()) * dt_s,
    }""",
        passes='evidence["violation_s"] <= LIMITS["violation_tolerance_s"]',
    ),
}
