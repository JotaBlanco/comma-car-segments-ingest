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


@canvas.dataset(position=(737, 182), size=(1029, 641), code_height=147, viz={'measure': {'columns': {'x': None, 'y': 'value'}, 'range': {'from': 1786514292032.1484, 'mode': 'absolute', 'to': 1786514304603.979}, 'signals': [{'color': '--qm-sig-1', 'dec': 3, 'id': 'platform=CHEVROLET_EQUINOX/device=128c63b1aa9f97fe/route=00000002--f5deb822d7/channel_name=camera_ipma_hs_can3/sender_node=EPB/frame_name=SPEED_RELATED/signal=BrakePedalPos', 'name': 'BrakePedalPos', 'unit': ''}], 'table': 'can_signals_v13', 'windows': [{'axes': ['AUDI_Q3_MK2/AUDI_A3_MK3/AUDI_A3_MK3/AUDI_A3_MK3/AUDI_A3_MK3/AUDI_A3_MK3/AUDI_A3_MK3/value', 'platform=CADILLAC_XT4/device=6521353b73fc8ffd/route=00000001--c77ab9841a/channel_name=camera_ipma_hs_can3/sender_node=K124_ASCM/frame_name=ASCMActiveCruiseControlStatus/signal=ACCAlwaysOne/value', 'platform=CHEVROLET_EQUINOX/device=128c63b1aa9f97fe/route=00000002--f5deb822d7/channel_name=camera_ipma_hs_can3/sender_node=EPB/frame_name=SPEED_RELATED/signal=EngineTPS', 'platform=CHEVROLET_EQUINOX/device=128c63b1aa9f97fe/route=00000002--f5deb822d7/channel_name=camera_ipma_hs_can3/sender_node=EPB/frame_name=SPEED_RELATED/signal=EngineRPM', 'platform=CHEVROLET_EQUINOX/device=128c63b1aa9f97fe/route=00000002--f5deb822d7/channel_name=camera_ipma_hs_can3/sender_node=EPB/frame_name=SPEED_RELATED/signal=BrakePedalPos'], 'cursor': {'scope': 'shared'}, 'height': 176, 'hidden': [], 'id': 'w1_1', 'signals': ['platform=CHEVROLET_EQUINOX/device=128c63b1aa9f97fe/route=00000002--f5deb822d7/channel_name=camera_ipma_hs_can3/sender_node=EPB/frame_name=SPEED_RELATED/signal=BrakePedalPos'], 'yMode': 'shared'}, {'axes': [], 'cursor': {'scope': 'shared'}, 'height': 176, 'hidden': [], 'id': 'w2_2', 'signals': [], 'yMode': 'auto'}]}})
def can_signals_v13_2():
    return ql.sql("""SELECT *
    FROM can_signals_v13
    WHERE platform = 'AUDI_A3_MK3'
    LIMIT 100""")


if __name__ == "__main__":
    canvas.serve()
