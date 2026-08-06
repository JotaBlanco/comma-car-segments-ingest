import quixlab as ql

canvas = ql.Canvas(title="My Notebook")


@canvas.dataset(position=(-608, 759), size=(560, 420), code_height=200, viz={'type': 'table'})
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


@canvas.dataset(position=(-610, 1237), size=(560, 420), code_height=200, viz={'type': 'table'})
def signal_catalog():
    return ql.sql("""
        SELECT channel_name, sender_node, frame_name, signal,
               count(*) AS n_messages,
               min(value) AS min_val,
               max(value) AS max_val,
               avg(value) AS avg_val,
               stddev(value) AS std_val
        FROM can_signals
        WHERE platform = 'FORD_F_150_LIGHTNING_MK1'
          AND device = '0b2c0bec9a28eb0f'
          AND route = '00000001--82c7a5f419'
        GROUP BY 1, 2, 3, 4
        ORDER BY n_messages DESC
        LIMIT 2000
    """)


@canvas.dataset(position=(-608, 1711), size=(560, 420), code_height=200, viz={'type': 'table'})
def frame_frequency():
    return ql.sql("""
        SELECT channel_name, sender_node, frame_name,
               count(*) AS n_rows,
               count(DISTINCT signal) AS n_signals,
               count(DISTINCT frame_index) AS n_frame_occurrences
        FROM can_signals
        WHERE platform = 'FORD_F_150_LIGHTNING_MK1'
          AND device = '0b2c0bec9a28eb0f'
          AND route = '00000001--82c7a5f419'
        GROUP BY 1, 2, 3
        ORDER BY n_rows DESC
        LIMIT 300
    """)


@canvas.cell(position=(140, 770), size=(560, 420), code_height=200, viz={'type': 'line', 'x': 't_rel', 'y': ['WhlFl_W_Meas', 'WhlFr_W_Meas', 'VehLat2_A_Actl', 'VehLong2_A_Actl', 'BattTrac_U_Actl']})
def key_signals_timeseries(can_signals_sample):
    signals_of_interest = [
        "WhlFl_W_Meas", "WhlFr_W_Meas",     # front wheel speeds
        "VehLat2_A_Actl", "VehLong2_A_Actl",  # lateral / longitudinal accel
        "BattTrac_U_Actl",                    # traction battery voltage
    ]
    df = can_signals_sample[can_signals_sample["signal"].isin(signals_of_interest)]
    wide = df.pivot_table(index="t_rel", columns="signal", values="value", aggfunc="mean").sort_index()
    wide = wide.interpolate(method="index", limit_direction="both")
    return wide.reset_index()


@canvas.file(position=(136, 1244), size=(560, 420), code_height=0, path='can_signals_eda_notes.md')
def can_signals_eda_notes():
    pass


@canvas.dataset(position=(1940, 310), size=(560, 420), code_height=200, viz={'type': 'bar', 'x': 'sender_node', 'y': ['n_messages']})
def sender_summary():
    return ql.sql("""
        SELECT sender_node,
               count(*) AS n_messages,
               count(DISTINCT frame_name) AS n_frames,
               count(DISTINCT signal) AS n_signals
        FROM can_signals
        WHERE platform = 'FORD_F_150_LIGHTNING_MK1'
          AND device = '0b2c0bec9a28eb0f'
          AND route = '00000001--82c7a5f419'
        GROUP BY 1
        ORDER BY n_messages DESC
        LIMIT 50
    """)


if __name__ == "__main__":
    canvas.serve()
