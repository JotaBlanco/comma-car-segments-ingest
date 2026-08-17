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


@canvas.dataset(position=(763, 129), size=(1029, 641), code_height=147, viz={'measure': {'columns': {'x': None, 'y': None}, 'range': {'from': 1786514281851, 'mode': 'absolute', 'to': 1786514401851}, 'signals': [{'color': '--qm-sig-1', 'dec': 2, 'id': 'AUDI_Q3_MK2/AUDI_A3_MK3/AUDI_A3_MK3/AUDI_A3_MK3/AUDI_A3_MK3/AUDI_A3_MK3/AUDI_A3_MK3/value', 'name': 'value', 'unit': ''}], 'table': 'can_signals_v13', 'windows': [{'axes': ['AUDI_Q3_MK2/AUDI_A3_MK3/AUDI_A3_MK3/AUDI_A3_MK3/AUDI_A3_MK3/AUDI_A3_MK3/AUDI_A3_MK3/value'], 'cursor': {'scope': 'shared'}, 'height': 176, 'hidden': [], 'id': 'w1_1', 'signals': ['AUDI_Q3_MK2/AUDI_A3_MK3/AUDI_A3_MK3/AUDI_A3_MK3/AUDI_A3_MK3/AUDI_A3_MK3/AUDI_A3_MK3/value'], 'yMode': 'auto'}]}})
def can_signals_v13_2():
    return ql.sql("""SELECT *
    FROM can_signals_v13
    WHERE platform = 'AUDI_A3_MK3'
    LIMIT 100""")


if __name__ == "__main__":
    canvas.serve()
