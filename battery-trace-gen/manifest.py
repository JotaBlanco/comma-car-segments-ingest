"""The expected-verdict manifest, measured from the generator's own signal history.

Every ``measured`` number below comes out of the latched, quantised bus history — the
same values the lake will hold — so no achieved figure is ever written by hand. The
verdict itself is declared by the scenario: a requirement named by one of that
scenario's ``defects.breaks`` is expected to FAIL, everything else to PASS.
"""

from __future__ import annotations

import csv
import datetime as dt
import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

import meta
from bus.dbc import DCM_TARGET_KEY, DCM_TYPE, BatteryDbc
from controller import params as controller_params
from controller.params import ControllerParams
from controller.state_machine import CHARGING, SLEEP
from runner import TraceRun
from scenario import Identity

SCHEMA = "battery-trace-manifest/1"
TOOL_ROOT = Path(__file__).resolve().parent
REPO_ROOT = TOOL_ROOT.parent
REQUIREMENTS_PATH = TOOL_ROOT / "data" / "battery-dc-requirements.json"
SPECS_PATH = TOOL_ROOT / "specs" / "battery-dc-test-specs.json"
PARAMETERS_PATH = TOOL_ROOT / "data" / "battery-dc-parameters.json"


@dataclass(frozen=True)
class CheckContext:
    run: TraceRun
    dt_s: float
    nominal: ControllerParams
    q_max_as: float


Check = Callable[[CheckContext], dict[str, float]]


def _charge_current_limit(ctx: CheckContext) -> dict[str, float]:
    history = ctx.run.history
    charging = history["BMS_State"] == CHARGING
    i_dc = history["BMS_I_Dc"][charging]
    return {
        "min_i_dc_a": float(i_dc.min()),
        "limit_a": -ctx.nominal.i_chr_max_a,
        "margin_a": float(i_dc.min()) + ctx.nominal.i_chr_max_a,
    }


def _derating_law(ctx: CheckContext) -> dict[str, float]:
    history = ctx.run.history
    params = ctx.nominal
    expected = np.clip(
        (params.t_batt_max_c - history["BMS_T_Derate_Ref"])
        / params.t_batt_safety_threshold_c,
        0.0,
        1.0,
    )
    charging = history["BMS_State"] == CHARGING
    excess = -history["BMS_I_Dc"][charging] - history["BMS_I_Chg_Lim"][charging]
    return {
        "max_law_error": float(np.abs(history["BMS_Derating_Fct"] - expected).max()),
        "max_limit_excess_a": float(excess.max()),
        "min_derating_fct": float(history["BMS_Derating_Fct"].min()),
    }


def _temperature_ceiling(ctx: CheckContext) -> dict[str, float]:
    t_batt = ctx.run.history["BMS_T_Batt"]
    above = t_batt > ctx.nominal.t_batt_max_c
    return {
        "max_degc": float(t_batt.max()),
        "limit_degc": ctx.nominal.t_batt_max_c,
        "dwell_above_limit_s": float(above.sum()) * ctx.dt_s,
    }


def _coulomb_counting(ctx: CheckContext) -> dict[str, float]:
    history = ctx.run.history
    soc = history["BMS_Soc_Tech"]
    integrated = (
        float(np.trapezoid(history["BMS_I_Dc"], dx=ctx.dt_s)) / ctx.q_max_as * 100.0
    )
    measured = float(soc[0] - soc[-1])
    return {
        "soc_drop_pct": measured,
        "integrated_drop_pct": integrated,
        "error_pct": abs(measured - integrated),
    }


def _terminal_voltage_window(ctx: CheckContext) -> dict[str, float]:
    u_dc = ctx.run.history["BMS_U_Dc"]
    return {
        "min_v": float(u_dc.min()),
        "max_v": float(u_dc.max()),
        "lower_limit_v": ctx.nominal.udc_min_v,
        "upper_limit_v": ctx.nominal.udc_max_v,
    }


def _customer_soc_map(ctx: CheckContext) -> dict[str, float]:
    history = ctx.run.history
    params = ctx.nominal
    expected = np.clip(
        (history["BMS_Soc_Tech"] - params.soc_tech_at_cust_0pct)
        / (params.soc_tech_at_cust_100pct - params.soc_tech_at_cust_0pct)
        * 100.0,
        0.0,
        100.0,
    )
    error = np.abs(history["BMS_Soc_Cust"] - expected)
    peak = int(error.argmax())
    return {
        "max_abs_error_pct": float(error[peak]),
        "at_soc_tech_pct": float(history["BMS_Soc_Tech"][peak]),
        "at_t_s": float(ctx.run.times[peak]),
    }


def _cell_balancing(ctx: CheckContext) -> dict[str, float]:
    history = ctx.run.history
    active = history["BMS_Balancing_Act"] == 1
    delta = history["BMS_U_Cell_Delta"][active]
    return {
        "delta_start_v": float(delta[0]),
        "delta_end_v": float(delta[-1]),
        "end_over_start": float(delta[-1] / delta[0]),
        "max_increase_v": float(np.diff(delta).max()),
        "balancing_s": float(active.sum()) * ctx.dt_s,
    }


def _ocv_relaxation(ctx: CheckContext) -> dict[str, float]:
    history = ctx.run.history
    error = np.abs(history["BMS_U_Dc"] - history["BMS_U_Ocv_Est"])
    entry = int(np.argmax(history["BMS_State"] == SLEEP))
    budget = int(round(ctx.nominal.t_transient_voltage_s / ctx.dt_s))
    return {
        "t_sleep_entry_s": float(ctx.run.times[entry]),
        "budget_s": ctx.nominal.t_transient_voltage_s,
        "error_v_at_entry": float(error[entry]),
        "error_v_at_budget": float(error[entry + budget]),
        "error_v_at_end": float(error[-1]),
    }


def _heater_power_mapping(ctx: CheckContext) -> dict[str, float]:
    history = ctx.run.history
    params = ctx.nominal
    state = history["BTMS_Heater_State"]
    expected = np.select(
        [state == 0, state == 1, state == 2],
        [0.0, params.p_heater_middle_w, params.p_heater_max_w],
    )
    return {
        "max_power_error_w": float(np.abs(history["BTMS_P_Heater"] - expected).max()),
        "dwell_state_0_s": float((state == 0).sum()) * ctx.dt_s,
        "dwell_state_1_s": float((state == 1).sum()) * ctx.dt_s,
        "dwell_state_2_s": float((state == 2).sum()) * ctx.dt_s,
    }


def _heater_below_minimum(ctx: CheckContext) -> dict[str, float]:
    history = ctx.run.history
    below = history["BMS_T_Batt"] < ctx.nominal.t_batt_min_c
    violation = below & (history["BTMS_Heater_State"] != 2)
    return {
        "min_degc": float(history["BMS_T_Batt"].min()),
        "limit_degc": ctx.nominal.t_batt_min_c,
        "time_below_min_s": float(below.sum()) * ctx.dt_s,
        "violation_s": float(violation.sum()) * ctx.dt_s,
    }


CHECKS: dict[str, Check] = {
    "charge_current_limit": _charge_current_limit,
    "derating_law": _derating_law,
    "temperature_ceiling": _temperature_ceiling,
    "coulomb_counting": _coulomb_counting,
    "terminal_voltage_window": _terminal_voltage_window,
    "customer_soc_map": _customer_soc_map,
    "cell_balancing": _cell_balancing,
    "ocv_relaxation": _ocv_relaxation,
    "heater_power_mapping": _heater_power_mapping,
    "heater_below_minimum": _heater_below_minimum,
}


def test_case_ids() -> dict[str, str]:
    """``{requirement id: test case id}``, inverted from the specs' ``covers_req_ids``.

    The derived direction (board BP5 / defect D1): a requirement never authors
    ``verified_by``, so this inverts the authored link the same way the Test
    Manager does at read time.
    """
    document = json.loads(SPECS_PATH.read_text(encoding="utf-8"))
    return {
        req_id: item["tc_id"]
        for item in document["items"]
        for req_id in item.get("covers_req_ids") or []
    }


def _expectations(run: TraceRun, tc_ids: dict[str, str]) -> list[dict[str, Any]]:
    nominal = controller_params.load()
    context = CheckContext(
        run=run,
        dt_s=float(run.times[1] - run.times[0]),
        nominal=nominal,
        q_max_as=run.plant["Q_MAX_AH"] * 3600.0,
    )
    rigged = {defect.breaks: defect for defect in run.scenario.defects}

    rows: list[dict[str, Any]] = []
    for expectation in run.scenario.expectations:
        defect = rigged.get(expectation.req_id)
        row: dict[str, Any] = {
            "req_id": expectation.req_id,
            "tc_id": tc_ids[expectation.req_id],
            "expected": "FAIL" if defect else "PASS",
            "measurand": expectation.measurand,
            "signal": expectation.signal,
            "limit": expectation.limit,
            "measured": CHECKS[expectation.check](context),
        }
        if defect:
            row["mechanism"] = defect.mechanism
            row["rigged"] = {
                "target": defect.target,
                "parameter": defect.parameter,
                "nominal": defect.nominal,
                "value": defect.value,
            }
        rows.append(row)
    return rows


def build(
    runs: list[TraceRun],
    *,
    identity: Identity,
    dbc: BatteryDbc,
    stats: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """The whole ``out/manifest.json`` document."""
    tc_ids = test_case_ids()
    return {
        "schema": SCHEMA,
        "generated_utc": dt.datetime.now(dt.UTC).isoformat(),
        "generator": {
            "name": meta.TOOL_NAME,
            "version": meta.TOOL_VERSION,
            "cell_seed": identity.cell_seed,
        },
        "plant_origin": {
            "repo": meta.PLANT_REPO,
            "ref": meta.PLANT_REF,
            "path": meta.PLANT_PATH,
            "patch": meta.PLANT_PATCH,
        },
        "sign_convention": meta.SIGN_CONVENTION,
        "requirements_source": REQUIREMENTS_PATH.relative_to(REPO_ROOT).as_posix(),
        "parameters_source": PARAMETERS_PATH.relative_to(REPO_ROOT).as_posix(),
        "dbc": {
            "path": dbc.path.relative_to(REPO_ROOT).as_posix(),
            "sha256": dbc.sha256,
            "dcm": {
                "type": DCM_TYPE,
                "target_key": DCM_TARGET_KEY,
                "config_id": dbc.config_id,
            },
            "counts": dbc.counts,
        },
        "platform": identity.platform,
        "device": identity.device,
        "traces": [
            {
                "trace_id": run.scenario.trace_id,
                "title": run.scenario.title,
                "file": run.scenario.output_name,
                # The run key the trace states in its own HD comment, and the
                # test cases its expectations cover. The trace claims no
                # definition; the run is assigned them in the Test Manager.
                "run_key": run.scenario.test["run_key"],
                "definitions": [
                    tc_ids[expectation.req_id]
                    for expectation in run.scenario.expectations
                ],
                "route": run.scenario.route,
                "segment": 0,
                "start_time_utc": run.scenario.start_time_utc,
                "duration_s": run.scenario.duration_s,
                "scenario_sha256": run.scenario.source_sha256,
                "plant_param_overrides": run.scenario.plant_params,
                "controller_param_overrides": run.scenario.controller_overrides,
                "expectations": _expectations(run, tc_ids),
                **stats[run.scenario.trace_id],
            }
            for run in runs
        ],
    }


def write(document: dict[str, Any], out_dir: Path) -> tuple[Path, Path]:
    """``manifest.json`` plus the flat ``manifest.csv`` the sanity print reads."""
    json_path = out_dir / "manifest.json"
    json_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")

    csv_path = out_dir / "manifest.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "trace_id",
                "tc_id",
                "req_id",
                "expected",
                "measurand",
                "signal",
                "limit",
                "measured",
                "mechanism",
            ]
        )
        for trace in document["traces"]:
            for row in trace["expectations"]:
                writer.writerow(
                    [
                        trace["trace_id"],
                        row["tc_id"],
                        row["req_id"],
                        row["expected"],
                        row["measurand"],
                        row["signal"],
                        row["limit"],
                        "; ".join(
                            f"{key}={value:g}" for key, value in row["measured"].items()
                        ),
                        row.get("mechanism", ""),
                    ]
                )
    return json_path, csv_path
