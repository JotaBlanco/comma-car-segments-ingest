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


@canvas.explore(position=(1170, -2303), size=(1063, 678), code_height=0, viz={'exploreDisplay': 'plot', 'measure': {'columns': {'x': 't_abs_ms', 'y': 'value'}, 'range': {'from': 1786498712432.5083, 'mode': 'absolute', 'to': 1786498742423.3577}, 'signals': [{'color': '--qm-sig-1', 'dec': 3, 'id': 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K43_PSCM/frame_name=PSCMSteeringAngle/signal=SteeringWheelAngle', 'name': 'SteeringWheelAngle', 'unit': ''}, {'color': '--qm-sig-2', 'dec': 3, 'id': 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K43_PSCM/frame_name=PSCMSteeringAngle/signal=SteeringWheelRate', 'name': 'SteeringWheelRate', 'unit': ''}, {'color': '--qm-sig-3', 'dec': 3, 'id': 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K20_ECM/frame_name=ECMEngineStatus/signal=EngineRPM', 'name': 'EngineRPM', 'unit': ''}, {'color': '--qm-sig-4', 'dec': 3, 'id': 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K20_ECM/frame_name=ECMEngineStatus/signal=EngineTPS', 'name': 'EngineTPS', 'unit': ''}], 'table': 'can_signals_v13', 'windows': [{'axes': ['platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K43_PSCM/frame_name=PSCMSteeringAngle/signal=SteeringWheelRate', 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K43_PSCM/frame_name=PSCMSteeringAngle/signal=SteeringWheelAngle'], 'cursor': {'scope': 'shared'}, 'height': 176, 'hidden': [], 'id': 'w1_1', 'signals': ['platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K43_PSCM/frame_name=PSCMSteeringAngle/signal=SteeringWheelAngle', 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K43_PSCM/frame_name=PSCMSteeringAngle/signal=SteeringWheelRate'], 'yMode': 'auto'}, {'axes': ['platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K20_ECM/frame_name=ECMEngineStatus/signal=EngineRPM', 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K20_ECM/frame_name=ECMEngineStatus/signal=EngineTPS'], 'cursor': {'scope': 'shared'}, 'height': 176, 'hidden': [], 'id': 'w2_2', 'signals': ['platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K20_ECM/frame_name=ECMEngineStatus/signal=EngineRPM', 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K20_ECM/frame_name=ECMEngineStatus/signal=EngineTPS'], 'yMode': 'auto'}]}})
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
def can_signals_v13_4(selection):
    return ql.sql(f"""SELECT *
    FROM can_signals_v13
    WHERE platform = '{selection.platform}'
      AND device = '{selection.device}'
      AND route = '{selection.route}'
    ORDER BY t_abs_ms
    """)


@canvas.ai(position=(2033, -3891), size=(690, 666), code_height=200, viz={'chartOpts': {'yMax': '8000', 'yMin': '0'}, 'type': 'line', 'x': 'timestamp', 'y': ['EngineRPM']})
def ai_3(can_signals_v13_4):
    """Plot signal EngineRPM over time. Filter values where RPM is 0"""
    # ql-ai: generated from prompt 1568dec216fe88ca
    import pandas as pd

    df = can_signals_v13_4[can_signals_v13_4['signal'] == 'EngineRPM'].copy()
    df = df[df['value'] != 0]
    df['timestamp'] = pd.to_datetime(df['ts_ms'], unit='ms')
    df = df.sort_values('timestamp')[['timestamp', 'value']].rename(columns={'value': 'EngineRPM'})

    ql.viz(df, type='line', x='timestamp', y=['EngineRPM'])


@canvas.cell(position=(23, -3838), size=(682, 518), code_height=0)
def selection():

    platforms = ql.partition_values('can_signals_v13', 'platform')  # metadata only, no data scan
    platform = ql.ui.dropdown(
        options=platforms,
        label="Platform",
    )

    devices = ql.partition_values('can_signals_v13', 'device', where={"platform": platform.value}) 
    device = ql.ui.dropdown(
        options=devices,
        label="Device",
    )

    routes = ql.partition_values('can_signals_v13', 'route', where={"platform": platform.value, "device": device.value}) 
    route = ql.ui.dropdown(
        options=routes,
        label="Route",
    )

    return platform, device, route


if __name__ == "__main__":
    canvas.serve()
