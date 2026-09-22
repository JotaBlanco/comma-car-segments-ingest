"""Latch the bus signals once per plant tick, then encode frames on demand.

The latch holds the physical value of every ``BATTERY_DC_V1`` signal, quantised through
the DBC's own scale and offset so the recorded history is exactly what the lake will
carry. Frames are encoded from the latch, so a 100 Hz frame between two plant ticks
repeats the held value — zero-order hold, which is what a real ECU transmits between
its own sampling instants.
"""

from __future__ import annotations

import numpy as np
from cantools.database.can import Message

from controller.bms import ControllerOutput
from plant.adapter import BusState
from scenario import Stimulus

from .crc import MuxCounter, RollingCounters, frame_crc
from .dbc import CELLS_PER_FRAME, CELL_COUNT, CELL_FRAME, CELL_MUX_SIGNAL, BatteryDbc

MUX_GROUPS = CELL_COUNT // CELLS_PER_FRAME
E2E_SUFFIXES = ("_BZ", "_CRC")


class Encoder:
    """Signal latch plus frame encoding for one trace."""

    def __init__(self, dbc: BatteryDbc) -> None:
        self._scaling = {
            signal.name: (float(signal.scale), float(signal.offset))
            for message in dbc.messages
            for signal in message.signals
        }
        self._cell_names = [
            [
                f"Ucell_{group * CELLS_PER_FRAME + index + 1:03d}"
                for index in range(CELLS_PER_FRAME)
            ]
            for group in range(MUX_GROUPS)
        ]
        self._counters = RollingCounters()
        self._mux = MuxCounter(MUX_GROUPS)
        self._values: dict[str, float] = {}
        self._cells = np.zeros(CELL_COUNT)

    def _quantise(self, name: str, value: float) -> float:
        scale, offset = self._scaling[name]
        return round((value - offset) / scale) * scale + offset

    def latch(
        self, state: BusState, stimulus: Stimulus, output: ControllerOutput
    ) -> dict[str, float]:
        """Store one tick of every signal and return the quantised sample."""
        cells = output.cells
        raw = {
            "BMS_U_Dc": state.u_dc_v,
            "BMS_I_Dc": state.i_dc_a,
            "BMS_State": output.state,
            "BMS_Soc_Tech": state.soc_tech_pct,
            "BMS_Soc_Cust": output.soc_cust_pct,
            "BMS_U_Ocv_Est": output.ocv_est_v,
            "BMS_T_Batt": state.t_batt_c,
            "BMS_T_Derate_Ref": output.t_derate_ref_c,
            "BMS_Derating_Fct": output.derating,
            "BMS_I_Chg_Lim": output.i_chg_lim_a,
            "BMS_U_Cell_Min": cells.u_min_v,
            "BMS_U_Cell_Max": cells.u_max_v,
            "BMS_U_Cell_Min_Idx": cells.min_index,
            "BMS_U_Cell_Max_Idx": cells.max_index,
            "BMS_Balancing_Act": cells.balancing,
            "BMS_U_Cell_Delta": cells.u_delta_v,
            "OBC_I_Out": output.obc_i_out_a,
            "OBC_U_Out": output.obc_u_out_v,
            "OBC_I_Avail": output.obc_i_avail_a,
            "OBC_Active": output.obc_active,
            "OBC_Fault": output.obc_fault,
            "VCU_Veh_State": stimulus.veh_state,
            "VCU_Kl15": stimulus.kl15,
            "VCU_Charge_Plug": stimulus.charge_plug,
            "VCU_Accel_Pedal_Pct": output.accel_pct,
            "VCU_Brake_Pedal_Pct": output.brake_pct,
            "VCU_T_Ambient": stimulus.ambient_c,
            "BTMS_Heater_State": output.heater_state,
            "BTMS_Heater_Req": output.heater_req,
            "BTMS_P_Heater": output.heater_power_w,
            "BTMS_Chiller_State": output.chiller_state,
            "BTMS_P_Chiller": output.chiller_power_w,
            "BTMS_T_Coolant": output.coolant_c,
        }
        self._values = {
            name: self._quantise(name, value) for name, value in raw.items()
        }
        self._cells = cells.voltages
        return self._values

    def encode(self, message: Message) -> bytes:
        """One transmission: latched values, the frame's BZ counter and its CRC."""
        if message.name == CELL_FRAME:
            group = self._mux.take()
            data: dict[str, float] = {CELL_MUX_SIGNAL: group}
            for index, name in enumerate(self._cell_names[group]):
                data[name] = float(self._cells[group * CELLS_PER_FRAME + index])
        else:
            data = {
                signal.name: self._values[signal.name]
                for signal in message.signals
                if not signal.name.endswith(E2E_SUFFIXES)
            }
            data[f"{message.name}_BZ"] = self._counters.take(message.frame_id)
        data[f"{message.name}_CRC"] = 0

        payload = bytearray(message.encode(data, scaling=True, padding=False))
        payload[7] = frame_crc(message.frame_id, bytes(payload))
        return bytes(payload)
