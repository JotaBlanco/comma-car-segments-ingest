import quixlab as ql

canvas = ql.Canvas(title="My Notebook")


@canvas.dataset(position=(792, 295), size=(560, 420), code_height=200)
def can_signals():
    return ql.sql("""SELECT *
    FROM can_signals_v13
    LIMIT 100""")


if __name__ == "__main__":
    canvas.serve()
