import quixlab as ql

canvas = ql.Canvas(title="My Notebook")


@canvas.dataset(position=(-743, 688), size=(711, 568), code_height=200, viz={'type': 'table'})
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


@canvas.dataset(position=(17, 686), size=(687, 544), code_height=200, viz={'type': 'table'})
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


@canvas.dataset(position=(749, 687), size=(745, 581), code_height=200, viz={'type': 'table'})
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


@canvas.cell(position=(-720, 1978), size=(612, 552), code_height=167, viz={'type': 'line', 'x': 't_rel', 'y': ['WhlFl_W_Meas', 'WhlFr_W_Meas', 'VehLat2_A_Actl', 'VehLong2_A_Actl', 'BattTrac_U_Actl']})
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


@canvas.file(position=(-511, 1652), size=(619, 402), code_height=0, path='can_signals_eda_notes.md')
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


@canvas.cell(position=(-22, 1353), size=(789, 538), code_height=200)
def signal_taxonomy(signal_catalog):
    import re

    df = signal_catalog.copy()

    def classify_domain(row):
        text = f"{row['signal']} {row['frame_name']}".upper()
        if re.search(r'WHL|WHEEL', text) and re.search(r'W_MEAS|_W_|SPD', text):
            return 'Wheel Speed / ABS'
        if re.search(r'BRK|BRAKE', text):
            return 'Braking'
        if re.search(r'STR|STEER', text):
            return 'Steering'
        if re.search(r'YAW', text):
            return 'Vehicle Dynamics (Yaw)'
        if re.search(r'VEHLAT|VEHLONG|VEHVERT|ACCEL_DATA|\bA_ACTL\b', text):
            return 'Vehicle Dynamics (Accel/IMU)'
        if re.search(r'BATT|HEV|\bSOC\b|CHRG', text):
            return 'Battery / EV Powertrain'
        if re.search(r'\bENG\b|\bPT_|PWT|IGNSWTCH|GEAR|TORQ', text):
            return 'Engine / Powertrain'
        if re.search(r'RADAR|OBJECT|TRK\d|TARGET', text):
            return 'Radar / Object Detection'
        if re.search(r'LANE|LKA|IPMA|\bCAM\b|ADAS|ACC_', text):
            return 'Camera / ADAS'
        if re.search(r'DOOR|LOCK|LIGHT|HVAC|CLIMA|SEAT|WIPER', text):
            return 'Body / Comfort'
        if re.search(r'TIRE|TPMS', text):
            return 'Tire Pressure'
        if re.search(r'GPS|\bNAV\b', text):
            return 'Navigation'
        return 'Other / Unclassified'

    def classify_role(name):
        n = name.upper()
        if '_D_STAT' in n:
            return 'Discrete State'
        if '_QF' in n:
            return 'Quality Flag'
        if '_NO_CNT' in n or n.endswith('_CNT'):
            return 'Message Counter'
        if '_NO_CS' in n or n.endswith('_CS'):
            return 'Checksum'
        if '_ACTL' in n:
            return 'Actual / Measured Value'
        if '_MEAS' in n:
            return 'Measured Value'
        if '_EST' in n:
            return 'Estimated Value'
        if '_CMD' in n or '_REQ' in n:
            return 'Command / Request'
        if '_TRG' in n or 'TRGT' in n:
            return 'Target Value'
        return 'Other'

    df['domain'] = df.apply(classify_domain, axis=1)
    df['signal_role'] = df['signal'].apply(classify_role)
    return df


@canvas.cell(position=(882, 1347), size=(560, 420), code_height=200, viz={'type': 'bar', 'x': 'domain', 'y': 'n_signals'})
def domain_signal_counts(signal_taxonomy):
    counts = (signal_taxonomy.groupby('domain')['signal']
              .nunique().reset_index(name='n_signals')
              .sort_values('n_signals', ascending=False))
    return counts


@canvas.cell(position=(1482, 887), size=(560, 420), code_height=200)
def hierarchy_sunburst(signal_taxonomy):
    import plotly.express as px

    agg = (signal_taxonomy
           .groupby(['channel_name', 'sender_node', 'frame_name'])
           .agg(n_signals=('signal', 'nunique'), n_messages=('n_messages', 'sum'))
           .reset_index())

    fig = px.sunburst(
        agg,
        path=['channel_name', 'sender_node', 'frame_name'],
        values='n_signals',
        color='n_messages',
        color_continuous_scale='Viridis',
        title='CAN hierarchy: Bus -> ECU -> Frame (size=#signals, color=message volume)'
    )
    fig.update_layout(margin=dict(t=60, l=0, r=0, b=0))
    return fig


@canvas.cell(position=(1482, 1347), size=(560, 420), code_height=200, viz={'type': 'bar', 'x': 'domain', 'y': 'n_rows'})
def bus_traffic_by_domain(frame_frequency, signal_taxonomy):
    lookup = signal_taxonomy[['sender_node', 'frame_name', 'domain']].drop_duplicates()
    merged = frame_frequency.merge(lookup, on=['sender_node', 'frame_name'], how='left')
    by_domain = (merged.groupby('domain', as_index=False)['n_rows']
                 .sum().sort_values('n_rows', ascending=False))
    return by_domain


@canvas.cell(position=(882, 1807), size=(560, 420), code_height=200)
def representative_signals_by_domain(signal_taxonomy, can_signals_sample):
    top_per_domain = (signal_taxonomy.sort_values('n_messages', ascending=False)
                      .groupby('domain').first().reset_index())
    sig_names = top_per_domain['signal'].tolist()

    df = can_signals_sample[can_signals_sample['signal'].isin(sig_names)]
    wide = (df.pivot_table(index='t_rel', columns='signal', values='value', aggfunc='mean')
            .sort_index())
    wide = wide.interpolate(method='index', limit_direction='both').reset_index()

    import plotly.express as px
    value_cols = [c for c in wide.columns if c != 't_rel']
    fig = px.line(wide, x='t_rel', y=value_cols,
                  title='Highest-traffic signal per domain, over one drive segment')
    fig.update_layout(legend_title_text='Signal')
    return fig


@canvas.cell(position=(282, 1807), size=(560, 420), code_height=200, viz={'type': 'heatmap', 'x': 'domain', 'y': 'sender_node', 'z': 'n_signals'})
def node_domain_heatmap(signal_taxonomy):
    matrix = (signal_taxonomy.groupby(['sender_node', 'domain'])['signal']
              .nunique().reset_index(name='n_signals'))
    return matrix


@canvas.file(position=(1482, 1807), size=(560, 420), code_height=0, path='can_signal_domain_guide.md')
def can_signal_domain_guide():
    pass


if __name__ == "__main__":
    canvas.serve()
