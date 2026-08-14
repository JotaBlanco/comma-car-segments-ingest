import quixlab as ql

canvas = ql.Canvas(title="My Notebook")


@canvas.datastore(position=(1562, 258), size=(560, 420), code_height=200)
def datastore_1():
    return ql.datastore("datastore_1")


if __name__ == "__main__":
    canvas.serve()
