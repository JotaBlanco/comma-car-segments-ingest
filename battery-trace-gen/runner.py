"""One trace: plant tick -> controller -> latch -> frames.

Per-tick order, dt = 0,1 s, t = k*dt:

1. plant step (the real ``run_simulation`` body) -> payload
2. ``adapter.from_plant`` -> BusState
3. the scenario's stimulus at t
4. ``BmsController.update`` -> ControllerOutput
5. latch every DBC signal, quantised through the DBC's own scale and offset
6. emit the frames due in the ten 10 ms bus slots that make up this tick
7. ``adapter.to_plant`` -> the setpoints the plant applies on tick k+1

Step 7 is the declared 100 ms actuation delay; it is not compensated anywhere.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from bus.dbc import BatteryDbc
from bus.encoder import Encoder
from bus.mf4 import FrameLog
from bus.scheduler import SLOT_S, SLOTS_PER_TICK, Scheduler
from controller import params as controller_params
from controller.bms import BmsController
from controller.params import ControllerParams
from plant import adapter
from plant import loader as plant_loader
from scenario import Identity, Scenario, SetpointSchedule


@dataclass(frozen=True)
class TraceRun:
    scenario: Scenario
    log: FrameLog
    times: np.ndarray
    history: dict[str, np.ndarray]
    controller: ControllerParams
    plant: dict[str, float]


def run(scenario: Scenario, identity: Identity, dbc: BatteryDbc) -> TraceRun:
    handle = plant_loader.load(scenario.plant_params, scenario.plant_module_overrides)
    dt_s = handle.dt_s
    ticks = int(round(scenario.duration_s / dt_s))

    scheduler = Scheduler(dbc.messages)
    log = FrameLog(scheduler.frame_count(ticks * SLOTS_PER_TICK), identity.bus_channel)
    encoder = Encoder(dbc)

    params = controller_params.load(scenario.controller_overrides)
    controller = BmsController(
        params,
        cell_seed=identity.cell_seed,
        dt_s=dt_s,
        t_batt_init_c=scenario.plant_initial_state["t_batt_c"],
    )
    schedule = SetpointSchedule(
        scenario.setpoints,
        chiller_powers={
            0: 0.0,
            1: handle.effective_params["CHILLER_POWER_LOW"],
            2: handle.effective_params["CHILLER_POWER_HIGH"],
        },
        coolant_c=handle.effective_params["COOLANT_TEMP"],
    )
    samples: list[dict[str, float]] = []

    def on_tick(tick: int, payload: dict[str, Any]) -> dict[str, float]:
        t_s = tick * dt_s
        state = adapter.from_plant(payload, t_s)
        stimulus = schedule.at(t_s)
        output = controller.update(state, stimulus)
        samples.append(encoder.latch(state, stimulus, output))

        base = tick * SLOTS_PER_TICK
        for offset in range(SLOTS_PER_TICK):
            slot = base + offset
            slot_t_s = slot * SLOT_S
            for message in scheduler.due(slot):
                log.append(slot_t_s, message.frame_id, encoder.encode(message))

        return adapter.to_plant(
            p_req_bus_w=output.p_req_bus_w,
            ambient_c=stimulus.ambient_c,
            heater_setting=output.heater_req,
            chiller_setting=stimulus.chiller_setting,
        )

    first = schedule.at(0.0)
    plant_loader.drive(
        handle,
        ticks=ticks,
        initial_cmd=adapter.to_plant(
            p_req_bus_w=0.0,
            ambient_c=first.ambient_c,
            heater_setting=0,
            chiller_setting=first.chiller_setting,
        ),
        soc_pct=scenario.plant_initial_state["soc_pct"],
        t_batt_c=scenario.plant_initial_state["t_batt_c"],
        on_tick=on_tick,
    )

    return TraceRun(
        scenario=scenario,
        log=log,
        times=np.arange(len(samples), dtype=np.float64) * dt_s,
        history={
            name: np.array([sample[name] for sample in samples]) for name in samples[0]
        },
        controller=params,
        plant=handle.effective_params,
    )
