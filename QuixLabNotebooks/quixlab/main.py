import quixlab as ql

canvas = ql.Canvas(title="My Notebook")


@canvas.dataset(position=(600, 256), size=(560, 420), code_height=147, viz={'datasetMode': 'ai'})
def can_signals():
    return ql.sql("""SELECT *
    FROM can_signals_v13
    LIMIT 100""")


@canvas.datastore(position=(1562, 258), size=(560, 420), code_height=200)
def datastore_1():
    return ql.datastore("datastore_1")


if __name__ == "__main__":
    canvas.serve()
