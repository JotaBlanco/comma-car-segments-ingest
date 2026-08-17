import quixlab as ql

canvas = ql.Canvas(title="My Notebook", lake_tree_open=['can_signals_v13'])


@canvas.datastore(position=(1562, 258), size=(560, 420), code_height=200)
def datastore_1():
    return ql.datastore("datastore_1")


@canvas.dataset(position=(791, 296), size=(752, 647), code_height=0, viz={'type': 'line', 'x': '', 'y': ''})
def can_signals_v13():
    return ql.sql("""SELECT *
    FROM can_signals_v13
    LIMIT 100""")


@canvas.dataset(position=(601, 189), size=(1366, 649), code_height=147, viz={'measure': {'columns': {'x': 't_abs_ms', 'y': 'value'}, 'range': {'from': 1786655427975.969, 'mode': 'absolute', 'to': 1786656546284.0554}, 'signals': [{'color': '--qm-sig-1', 'dec': 3, 'id': 'platform=CADILLAC_XT4/device=6521353b73fc8ffd/route=00000001--c77ab9841a/channel_name=powertrain_hs_can1/sender_node=EPB/frame_name=EPBStatus/signal=EPBClosed', 'name': 'EPBClosed', 'unit': ''}, {'color': '--qm-sig-2', 'dec': 3, 'id': 'platform=CADILLAC_XT4/device=6521353b73fc8ffd/route=00000001--c77ab9841a/channel_name=powertrain_hs_can1/sender_node=K124_ASCM/frame_name=ASCMSteeringButton/signal=ACCAlwaysOne', 'name': 'ACCAlwaysOne', 'unit': ''}, {'color': '--qm-sig-3', 'dec': 3, 'id': 'platform=CADILLAC_XT4/device=6521353b73fc8ffd/route=00000001--c77ab9841a/channel_name=powertrain_hs_can1/sender_node=K124_ASCM/frame_name=ASCMSteeringButton/signal=ACCButtons', 'name': 'ACCButtons', 'unit': ''}], 'table': 'can_signals_v13', 'windows': [{'axes': ['platform=CADILLAC_XT4/device=6521353b73fc8ffd/route=00000001--c77ab9841a/channel_name=powertrain_hs_can1/sender_node=EPB/frame_name=EPBStatus/signal=EPBClosed'], 'cursor': {'scope': 'own'}, 'height': 183, 'hidden': [], 'id': 'w1_1', 'range': {'from': 1786655965487, 'to': 1786656027887}, 'signals': ['platform=CADILLAC_XT4/device=6521353b73fc8ffd/route=00000001--c77ab9841a/channel_name=powertrain_hs_can1/sender_node=EPB/frame_name=EPBStatus/signal=EPBClosed'], 'yMode': 'auto'}]}})
def can_signals_v13_2():
    return ql.sql("""SELECT *
    FROM can_signals_v13
    WHERE platform = 'AUDI_A3_MK3'
    LIMIT 100""")


if __name__ == "__main__":
    canvas.serve()
