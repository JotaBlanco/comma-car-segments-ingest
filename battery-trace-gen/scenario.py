"""Scenarios as data: identity, plant baseline, setpoints, defects, expectations.

Nothing about a trace is a Python literal. ``scenarios/_identity.json`` and
``scenarios/_plant_base.json`` are shared by every scenario; each ``T*.json`` carries
its own arc. The documents have stable shapes so a service can serve them unchanged
later without a transform.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCENARIO_DIR = Path(__file__).resolve().parent / "scenarios"
IDENTITY_PATH = SCENARIO_DIR / "_identity.json"
PLANT_BASE_PATH = SCENARIO_DIR / "_plant_base.json"


@dataclass(frozen=True)
class Identity:
    platform: str
    device: str
    bus_name: str
    bus_channel: int
    cell_seed: int
    route_template: str
    #: The `test.*` header keys every trace shares — the work order it fulfils,
    #: the rig, the cell, the operator and the bench software. A scenario's own
    #: `test` block adds its run key and the definitions it claims.
    test: dict[str, str]


@dataclass(frozen=True)
class Setpoint:
    t_s: float
    charge_plug: int
    kl15: int
    veh_state: int
    ambient_c: float
    chiller_setting: int
    obc_i_avail_a: float
    i_demand_a: float


@dataclass(frozen=True)
class Stimulus:
    """The scenario's commands at one instant, in battery sign."""

    t_s: float
    charge_plug: int
    kl15: int
    veh_state: int
    ambient_c: float
    chiller_setting: int
    chiller_power_w: float
    coolant_c: float
    obc_i_avail_a: float
    i_demand_a: float


@dataclass(frozen=True)
class Defect:
    target: str
    parameter: str
    nominal: float
    value: float
    breaks: str
    mechanism: str


@dataclass(frozen=True)
class Expectation:
    req_id: str
    measurand: str
    signal: str
    limit: str
    check: str


@dataclass(frozen=True)
class Scenario:
    trace_id: str
    title: str
    route: str
    start_time_utc: str
    duration_s: float
    #: What this trace claims about the Test Manager chain: `run_key`, the
    #: `definitions` it fulfils, and its own `description`.
    test: dict[str, Any]
    path: Path
    source_sha256: str
    plant_initial_state: dict[str, float]
    plant_params: dict[str, float]
    plant_module_overrides: dict[str, Any]
    controller_overrides: dict[str, float]
    defects: list[Defect]
    setpoints: list[Setpoint]
    expectations: list[Expectation]

    @property
    def output_name(self) -> str:
        return f"{self.path.stem}.mf4"


class SetpointSchedule:
    """The stimulus in force at time t. Entries apply from their ``t_s`` to the next."""

    def __init__(
        self,
        setpoints: list[Setpoint],
        *,
        chiller_powers: dict[int, float],
        coolant_c: float,
    ) -> None:
        self._setpoints = setpoints
        self._chiller_powers = chiller_powers
        self._coolant_c = coolant_c
        self._index = 0

    def at(self, t_s: float) -> Stimulus:
        while (
            self._index + 1 < len(self._setpoints)
            and self._setpoints[self._index + 1].t_s <= t_s
        ):
            self._index += 1
        current = self._setpoints[self._index]
        return Stimulus(
            t_s=t_s,
            charge_plug=current.charge_plug,
            kl15=current.kl15,
            veh_state=current.veh_state,
            ambient_c=current.ambient_c,
            chiller_setting=current.chiller_setting,
            chiller_power_w=self._chiller_powers[current.chiller_setting],
            coolant_c=self._coolant_c,
            obc_i_avail_a=current.obc_i_avail_a,
            i_demand_a=current.i_demand_a,
        )


def load_identity() -> Identity:
    document = json.loads(IDENTITY_PATH.read_text(encoding="utf-8"))
    return Identity(**document)


def load_scenario(path: Path) -> Scenario:
    base = json.loads(PLANT_BASE_PATH.read_text(encoding="utf-8"))
    raw = path.read_bytes()
    document = json.loads(raw.decode("utf-8"))

    plant_params = dict(base["plant_param_overrides"])
    plant_params.update(document.get("plant_param_overrides", {}))

    module_overrides = dict(base["plant_module_overrides"])
    module_overrides.update(document.get("plant_module_overrides", {}))

    return Scenario(
        trace_id=document["trace_id"],
        title=document["title"],
        route=document["route"],
        start_time_utc=document["start_time_utc"],
        duration_s=float(document["duration_s"]),
        test=document["test"],
        path=path,
        source_sha256=hashlib.sha256(raw).hexdigest(),
        plant_initial_state=document["plant_initial_state"],
        plant_params=plant_params,
        plant_module_overrides=module_overrides,
        controller_overrides=document.get("controller_param_overrides", {}),
        defects=[Defect(**entry) for entry in document.get("defects", [])],
        setpoints=[Setpoint(**entry) for entry in document["setpoints"]],
        expectations=[Expectation(**entry) for entry in document["evaluates"]],
    )


def load_all() -> list[Scenario]:
    paths = sorted(p for p in SCENARIO_DIR.glob("T*.json"))
    return [load_scenario(path) for path in paths]
