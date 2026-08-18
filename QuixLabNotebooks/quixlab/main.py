import quixlab as ql

canvas = ql.Canvas(title="My Notebook", lake_tree_open=['can_signals_v13'])


@canvas.datastore(position=(1562, 258), size=(560, 420), code_height=200)
def datastore_1():
    return ql.datastore("datastore_1")


@canvas.dataset(position=(542, 147), size=(1608, 771), code_height=138, viz={'measure': {'columns': {'x': 't_abs_ms', 'y': 'value'}, 'range': {'from': 1786655965507.8, 'mode': 'absolute', 'to': 1786656027866.2}, 'signals': [{'color': '--qm-sig-1', 'dec': 3, 'id': 'platform=CADILLAC_XT4/device=6521353b73fc8ffd/route=00000001--c77ab9841a/channel_name=camera_ipma_hs_can3/sender_node=K124_ASCM/frame_name=ASCMActiveCruiseControlStatus/signal=ACCAlwaysOne', 'name': 'ACCAlwaysOne', 'unit': ''}], 'table': 'can_signals_v13', 'windows': [{'axes': ['platform=CADILLAC_XT4/device=6521353b73fc8ffd/route=00000001--c77ab9841a/channel_name=camera_ipma_hs_can3/sender_node=K124_ASCM/frame_name=ASCMActiveCruiseControlStatus/signal=ACCAlwaysOne'], 'cursor': {'scope': 'shared'}, 'height': 173, 'hidden': [], 'id': 'w1_1', 'range': {'from': 1786656002175.5613, 'to': 1786656002386.3992}, 'signals': ['platform=CADILLAC_XT4/device=6521353b73fc8ffd/route=00000001--c77ab9841a/channel_name=camera_ipma_hs_can3/sender_node=K124_ASCM/frame_name=ASCMActiveCruiseControlStatus/signal=ACCAlwaysOne'], 'yMode': 'auto'}, {'axes': [], 'cursor': {'scope': 'shared'}, 'height': 179, 'hidden': [], 'id': 'w2_2', 'signals': [], 'yMode': 'auto'}]}, 'type': 'line', 'x': '', 'y': ''})
def can_signals_v13():
    return ql.sql("""SELECT *
    FROM can_signals_v13
    LIMIT 100""")


@canvas.dataset(position=(207, -629), size=(1565, 813), code_height=200, viz={'datasetMode': 'sql', 'type': 'line', 'x': 't_rel_ms', 'y': ['value']})
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


if __name__ == "__main__":
    canvas.serve()
