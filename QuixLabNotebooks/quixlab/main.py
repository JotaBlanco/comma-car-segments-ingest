import quixlab as ql

canvas = ql.Canvas(title="My Notebook", lake_tree_open=['can_signals_v13', 'can_signals_v13/platform=CHEVROLET_VOLT', 'can_signals_v13/platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9', 'can_signals_v13/platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b', 'can_signals_v13/platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1', 'can_signals_v13/platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K73_TCIC', 'can_signals_v13/platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K73_TCIC/frame_name=TCICOnStarGPSPosition'])


@canvas.datastore(position=(1562, 258), size=(560, 420), code_height=200)
def datastore_1():
    return ql.datastore("datastore_1")


@canvas.dataset(position=(936, -518), size=(1608, 771), code_height=138, viz={'measure': {'columns': {'x': 't_abs_ms', 'y': 'value'}, 'range': {'from': 1786655965507.8, 'mode': 'absolute', 'to': 1786656027866.2}, 'signals': [{'color': '--qm-sig-1', 'dec': 3, 'id': 'platform=CADILLAC_XT4/device=6521353b73fc8ffd/route=00000001--c77ab9841a/channel_name=camera_ipma_hs_can3/sender_node=K124_ASCM/frame_name=ASCMActiveCruiseControlStatus/signal=ACCAlwaysOne', 'name': 'ACCAlwaysOne', 'unit': ''}], 'table': 'can_signals_v13', 'windows': [{'axes': ['platform=CADILLAC_XT4/device=6521353b73fc8ffd/route=00000001--c77ab9841a/channel_name=camera_ipma_hs_can3/sender_node=K124_ASCM/frame_name=ASCMActiveCruiseControlStatus/signal=ACCAlwaysOne'], 'cursor': {'scope': 'shared'}, 'height': 173, 'hidden': [], 'id': 'w1_1', 'range': {'from': 1786656002175.5613, 'to': 1786656002386.3992}, 'signals': ['platform=CADILLAC_XT4/device=6521353b73fc8ffd/route=00000001--c77ab9841a/channel_name=camera_ipma_hs_can3/sender_node=K124_ASCM/frame_name=ASCMActiveCruiseControlStatus/signal=ACCAlwaysOne'], 'yMode': 'auto'}, {'axes': [], 'cursor': {'scope': 'shared'}, 'height': 179, 'hidden': [], 'id': 'w2_2', 'signals': [], 'yMode': 'auto'}]}, 'type': 'line', 'x': '', 'y': ''})
def can_signals_v13():
    return ql.sql("""SELECT *
    FROM can_signals_v13
    LIMIT 100""")


@canvas.dataset(position=(-111, -835), size=(1565, 813), code_height=200, viz={'datasetMode': 'sql', 'measure': {'columns': {'x': 't_abs_ms', 'y': 'value'}, 'range': {'from': 1786498705311.0735, 'mode': 'absolute', 'to': 1786498727206.3093}, 'signals': [{'color': '--qm-sig-1', 'dec': 3, 'id': 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K73_TCIC/frame_name=TCICOnStarGPSPosition/signal=GPSLatitude', 'name': 'GPSLatitude', 'unit': ''}, {'color': '--qm-sig-2', 'dec': 3, 'id': 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K73_TCIC/frame_name=TCICOnStarGPSPosition/signal=GPSLongitude', 'name': 'GPSLongitude', 'unit': ''}, {'color': '--qm-sig-3', 'dec': 3, 'id': 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K17_EBCM/frame_name=BECMBatteryVoltageCurrent/signal=HVBatteryCurrent', 'name': 'HVBatteryCurrent', 'unit': ''}, {'color': '--qm-sig-4', 'dec': 3, 'id': 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K17_EBCM/frame_name=BECMBatteryVoltageCurrent/signal=HVBatteryVoltage', 'name': 'HVBatteryVoltage', 'unit': ''}], 'table': 'can_signals_v13', 'windows': [{'axes': ['platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K73_TCIC/frame_name=TCICOnStarGPSPosition/signal=GPSLongitude', 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K73_TCIC/frame_name=TCICOnStarGPSPosition/signal=GPSLatitude'], 'cursor': {'scope': 'shared'}, 'height': 176, 'hidden': [], 'id': 'w1_1', 'signals': ['platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K73_TCIC/frame_name=TCICOnStarGPSPosition/signal=GPSLatitude', 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K73_TCIC/frame_name=TCICOnStarGPSPosition/signal=GPSLongitude'], 'yMode': 'shared'}, {'axes': [], 'cursor': {'scope': 'shared'}, 'height': 176, 'hidden': [], 'id': 'w2_2', 'signals': ['platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K73_TCIC/frame_name=TCICOnStarGPSPosition/signal=GPSLongitude', 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K17_EBCM/frame_name=BECMBatteryVoltageCurrent/signal=HVBatteryCurrent', 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K17_EBCM/frame_name=BECMBatteryVoltageCurrent/signal=HVBatteryVoltage'], 'yMode': 'shared'}]}, 'type': 'line', 'x': 't_rel_ms', 'y': ['value']})
def can_signals_v13_2():
    return ql.sql("""SELECT t_rel_ms, value
    FROM can_signals_v13
    WHERE platform = 'AUDI_A3_MK3'
      AND device = '200c952f826a6447'
      AND segment = 0
      AND frame_name = 'ESP_02'
      AND signal = 'COUNTER'
      AND t_rel_ms <= 60000
    ORDER BY t_rel_ms
    LIMIT 5000""")


@canvas.explore(position=(1170, -2303), size=(420, 260), code_height=0, viz={'measure': {'columns': {'x': 't_abs_ms', 'y': 'value'}, 'range': {'from': 1786498712432.5083, 'mode': 'absolute', 'to': 1786498742423.3577}, 'signals': [{'color': '--qm-sig-1', 'dec': 3, 'id': 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K43_PSCM/frame_name=PSCMSteeringAngle/signal=SteeringWheelAngle', 'name': 'SteeringWheelAngle', 'unit': ''}, {'color': '--qm-sig-2', 'dec': 3, 'id': 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K43_PSCM/frame_name=PSCMSteeringAngle/signal=SteeringWheelRate', 'name': 'SteeringWheelRate', 'unit': ''}, {'color': '--qm-sig-3', 'dec': 3, 'id': 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K20_ECM/frame_name=ECMEngineStatus/signal=EngineRPM', 'name': 'EngineRPM', 'unit': ''}, {'color': '--qm-sig-4', 'dec': 3, 'id': 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K20_ECM/frame_name=ECMEngineStatus/signal=EngineTPS', 'name': 'EngineTPS', 'unit': ''}], 'table': 'can_signals_v13', 'windows': [{'axes': ['platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K43_PSCM/frame_name=PSCMSteeringAngle/signal=SteeringWheelRate', 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K43_PSCM/frame_name=PSCMSteeringAngle/signal=SteeringWheelAngle'], 'cursor': {'scope': 'shared'}, 'height': 176, 'hidden': [], 'id': 'w1_1', 'signals': ['platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K43_PSCM/frame_name=PSCMSteeringAngle/signal=SteeringWheelAngle', 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K43_PSCM/frame_name=PSCMSteeringAngle/signal=SteeringWheelRate'], 'yMode': 'auto'}, {'axes': ['platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K20_ECM/frame_name=ECMEngineStatus/signal=EngineRPM', 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K20_ECM/frame_name=ECMEngineStatus/signal=EngineTPS'], 'cursor': {'scope': 'shared'}, 'height': 176, 'hidden': [], 'id': 'w2_2', 'signals': ['platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K20_ECM/frame_name=ECMEngineStatus/signal=EngineRPM', 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K20_ECM/frame_name=ECMEngineStatus/signal=EngineTPS'], 'yMode': 'auto'}]}})
def explore_1():
    pass


@canvas.dataset(position=(1127, -2998), size=(727, 555), code_height=200)
def can_signals_v13_3():
    return ql.sql("""SELECT *
    FROM can_signals_v13
    WHERE platform = 'CHEVROLET_VOLT'
      AND device = '180ea5df0f0b4db9'
      AND route = '00000000--7b23a7654b'
      AND channel_name = 'powertrain_hs_can1'
      AND sender_node = 'K73_TCIC'
      AND frame_name = 'TCICOnStarGPSPosition'
    ORDER BY t_abs_ms""")


@canvas.ai(position=(2053, -3051), size=(1262, 797), code_height=200)
def ai_2(can_signals_v13_3):
    """Can you plot GPS Lat and Long over time"""
    # ql-ai: generated from prompt 7d3453bde4dd5588
    import pandas as pd

    gps = can_signals_v13_3[can_signals_v13_3["signal"].isin(["GPSLatitude", "GPSLongitude"])].copy()
    gps["ts"] = pd.to_datetime(gps["ts_ms"], unit="ms")

    wide = (
        gps.pivot_table(index="ts", columns="signal", values="value", aggfunc="mean")
        .sort_index()
        .reset_index()
    )

    ql.viz(wide, type="line", x="ts", y=["GPSLatitude", "GPSLongitude"])


@canvas.dataset(position=(997, -3904), size=(864, 686), code_height=200)
def can_signals_v13_4():
    return ql.sql("""SELECT *
    FROM can_signals_v13
    WHERE platform = 'CHEVROLET_VOLT'
      AND device = '180ea5df0f0b4db9'
      AND route = '00000000--7b23a7654b'
    """)


@canvas.ai(position=(2033, -3891), size=(690, 666), code_height=200)
def ai_3(can_signals_v13_4):
    """Plot channel powertrain_hs_can1 over time."""


@canvas.ai(position=(200, -3843), size=(594, 501), code_height=200)
def selection():
    """Create a form with 3 dropdowns that cascade.

    1. Selected platform
    2. Selected device (filter list by selected platform)
    3. Selected route (filter list by both device and platform)

    Return them as bag for reference downstream. 

    ## Questions from the AI

    **Q:** Which QuixLake table (or upstream node) contains the platform, device, and route values for these dropdowns?
    **A:** can_signals_v13

    **Q:** What are the exact column names for platform, device, and route in that table?
    **A:** platform, device, and route
    """
    # ql-ai: generated from prompt 952b1ab0de6295d2
    def selection():
        # Pull the full platform / device / route partition combinations from the
        # catalog (fast metadata read, no data scan).
        info = ql.partition_info("can_signals_v13")

        # --- Platform dropdown -------------------------------------------------
        platforms = sorted(info["platform"].dropna().unique().tolist())
        platform_widget = ql.ui.dropdown(
            options=platforms,
            value=platforms[0] if platforms else None,
            label="Platform",
        )

        # --- Device dropdown (filtered by selected platform) --------------------
        devices_scope = info[info["platform"] == platform_widget.value]
        devices = sorted(devices_scope["device"].dropna().unique().tolist())
        device_widget = ql.ui.dropdown(
            options=devices,
            value=devices[0] if devices else None,
            label="Device",
        )

        # --- Route dropdown (filtered by selected platform + device) ------------
        routes_scope = devices_scope[devices_scope["device"] == device_widget.value]
        routes = sorted(routes_scope["route"].dropna().unique().tolist())
        route_widget = ql.ui.dropdown(
            options=routes,
            value=routes[0] if routes else None,
            label="Route",
        )

        # Return the three widgets together so downstream cells can reference
        # them by position: selection[0] = platform, selection[1] = device,
        # selection[2] = route (use .value on each for the selected string).
        return ql.ui.row([platform_widget, device_widget, route_widget])


if __name__ == "__main__":
    canvas.serve()
