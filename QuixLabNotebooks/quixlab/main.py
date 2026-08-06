import quixlab as ql

canvas = ql.Canvas(title="My Notebook")


@canvas.dataset(position=(140, 310), size=(560, 420), code_height=200, viz={'type': 'table'})
def can_signals_sample():
    return ql.sql("""
        SELECT ts_ms, segment, seq, t_rel, channel_name, frame_id, frame_hex,
               frame_index, sender_node, frame_name, signal, value
        FROM can_signals
        WHERE platform = 'FORD_F_150_LIGHTNING_MK1'
          AND device = '0b2c0bec9a28eb0f'
          AND route = '00000001--82c7a5f419'
        ORDER BY t_rel
        LIMIT 50000
    """)


if __name__ == "__main__":
    canvas.serve()
