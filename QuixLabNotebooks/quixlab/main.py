import quixlab as ql

canvas = ql.Canvas(title="My Notebook", lake_tree_open=['can_signals_v13'])


@canvas.datastore(position=(1562, 258), size=(560, 420), code_height=200)
def datastore_1():
    return ql.datastore("datastore_1")


@canvas.dataset(position=(355, 201), size=(752, 647), code_height=138, viz={'type': 'line', 'x': '', 'y': ''})
def can_signals_v13():
    return ql.sql("""SELECT *
    FROM can_signals_v13
    LIMIT 100""")


@canvas.dataset(position=(128, -774), size=(1366, 649), code_height=147, viz={'measure': {'columns': {'x': 't_rel_ms', 'y': 'value'}, 'range': {'from': -1193.96, 'mode': 'absolute', 'to': 62451.96}, 'signals': [{'color': '--qm-sig-1', 'dec': 3, 'id': 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K73_TCIC/frame_name=TCICOnStarGPSPosition/signal=GPSLatitude', 'name': 'GPSLatitude', 'unit': ''}, {'color': '--qm-sig-2', 'dec': 3, 'id': 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K73_TCIC/frame_name=TCICOnStarGPSPosition/signal=GPSLongitude', 'name': 'GPSLongitude', 'unit': ''}], 'table': 'can_signals_v13', 'windows': [{'axes': [], 'cursor': {'scope': 'shared'}, 'height': 176, 'hidden': [], 'id': 'w1_1', 'signals': ['platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K73_TCIC/frame_name=TCICOnStarGPSPosition/signal=GPSLatitude', 'platform=CHEVROLET_VOLT/device=180ea5df0f0b4db9/route=00000000--7b23a7654b/channel_name=powertrain_hs_can1/sender_node=K73_TCIC/frame_name=TCICOnStarGPSPosition/signal=GPSLongitude'], 'yMode': 'auto'}]}})
def can_signals_v13_2():
    return ql.sql("""SELECT *
    FROM can_signals_v13
    WHERE platform = 'AUDI_A3_MK3'
    LIMIT 100""")


if __name__ == "__main__":
    canvas.serve()
