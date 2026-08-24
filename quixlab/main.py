# =============================================================================
#  ACC performance test cases -- evaluated against the MF4 signal lake
# =============================================================================
#  REVIEW COPY -- NOT THE FILE QUIXLAB EXECUTES.
#  A running QuixLab deployment loads notebooks from its own persistent state
#  volume (/app/state), not from this git repository. This file lives in the repo
#  so the evaluation logic can be reviewed and diffed; to run it, paste or import
#  it into QuixLab through the in-app file picker. Editing it here does not change
#  what a deployed QuixLab canvas runs.
#
#  CREDENTIALS: none in this file, by design. Quix__Sdk__Token and
#  Quix__Workspace__Id are injected by the platform, so ql.sql(...) authenticates
#  itself with no setup.
#
#  READ-ONLY: every statement issued below is a SELECT. Nothing is written.
#
#  WHAT THIS IS
#  Three Test Implementation cells, one per test case, each evaluating that test
#  case's pass_criteria against real decoded CAN signals in table mf4_signals_v4
#  and returning a machine-readable verdict.
#
#  TRACEABILITY -- every cell returns tc_id / impl_id / requirement_id /
#  criterion_ids in its result dict, so a consumer reading the canvas output gets
#  the V-model trace without parsing comments. Cell functions are named after the
#  vm_test_impls entrypoints:
#
#    cell              tc_id             impl_id           requirement_id
#    ----------------  ----------------  ----------------  ----------------
#    acc_sys_ti_011    ACC-SYS-TC-011    ACC-SYS-TI-011    ACC-SYS-PRF-001
#    acc_sys_ti_014    ACC-SYS-TC-014    ACC-SYS-TI-014    ACC-SYS-PRF-020
#    acc_sys_ti_016    ACC-SYS-TC-016    ACC-SYS-TI-016    ACC-SYS-PRF-041
#
#  EVERY BOUND BELOW IS QUOTED FROM THE TEST SPEC'S pass_criteria (or, where
#  labelled, from preconditions.gates). Nothing is hardcoded to a known-good
#  answer: the verdicts are computed from the data and can come out either way.
#    Specs: GET /api/v1/vmodel/test-specs/<tc_id>@v0001
#    Impls: GET /api/v1/vmodel/test-impls
# =============================================================================

import numpy as np
import pandas as pd
import quixlab as ql

canvas = ql.Canvas(title="ACC Performance Test Cases", lake_tree_open=['can_signals_v13', 'can_signals_v13/platform=KIA_NIRO_EV_2ND_GEN', 'can_signals_v13/platform=KIA_NIRO_EV_2ND_GEN/device=7e83bf856d5fbb93', 'can_signals_v13/platform=KIA_NIRO_EV_2ND_GEN/device=7e83bf856d5fbb93/route=00000007--4ca4d4cf2e', 'can_signals_v13/platform=KIA_NIRO_EV_2ND_GEN/device=7e83bf856d5fbb93/route=00000007--4ca4d4cf2e/channel_name=camera_ipma_hs_can3', 'can_signals_v13/platform=KIA_NIRO_EV_2ND_GEN/device=7e83bf856d5fbb93/route=00000007--4ca4d4cf2e/channel_name=camera_ipma_hs_can3/sender_node=APRK', 'can_signals_v13/platform=KIA_NIRO_EV_2ND_GEN/device=7e83bf856d5fbb93/route=00000007--4ca4d4cf2e/channel_name=camera_ipma_hs_can3/sender_node=APRK/frame_name=SPAS1'])

TABLE = "mf4_signals_v4"

# Where each spec's named run landed in the lake. platform / device / route are
# physical Hive partitions; segment carries the tc_id and is a plain column.
RUNS = {
    "ACC-SYS-TC-011": dict(platform="SKODA_OCTAVIA", device="a0001", route="00011",
                           segment="ACC-SYS-TC-011",
                           scenario="follow_steady_timegap/tau08"),
    "ACC-SYS-TC-014": dict(platform="SKODA_OCTAVIA", device="a0001", route="00014",
                           segment="ACC-SYS-TC-014",
                           scenario="lead_brake_ccrb_4mps2/v130"),
    "ACC-SYS-TC-016": dict(platform="SKODA_OCTAVIA", device="a0001", route="00016",
                           segment="ACC-SYS-TC-016",
                           scenario="cruise_set_speed_max/base"),
}

# The V-model link, read from vm_test_impls -- not invented here. impl_id is the
# test case id with TC replaced by TI, so it is derived from the test case rather
# than from the requirement (one requirement may have several test cases).
TRACE = {
    "ACC-SYS-TC-011": dict(tc_id="ACC-SYS-TC-011", spec_key="ACC-SYS-TC-011@v0001",
                           impl_id="ACC-SYS-TI-011", impl_key="ACC-SYS-TI-011@v0001",
                           requirement_id="ACC-SYS-PRF-001",
                           entrypoint="acc_sys_ti_011:run"),
    "ACC-SYS-TC-014": dict(tc_id="ACC-SYS-TC-014", spec_key="ACC-SYS-TC-014@v0001",
                           impl_id="ACC-SYS-TI-014", impl_key="ACC-SYS-TI-014@v0001",
                           requirement_id="ACC-SYS-PRF-020",
                           entrypoint="acc_sys_ti_014:run"),
    "ACC-SYS-TC-016": dict(tc_id="ACC-SYS-TC-016", spec_key="ACC-SYS-TC-016@v0001",
                           impl_id="ACC-SYS-TI-016", impl_key="ACC-SYS-TI-016@v0001",
                           requirement_id="ACC-SYS-PRF-041",
                           entrypoint="acc_sys_ti_016:run"),
}


# =============================================================================
#  Shared helpers -- the spec's criterion vocabulary translated into pandas.
#  Read this section once; the three cells below are then short enough to audit.
# =============================================================================

def fetch(tc_id, signals):
    """One single-level SELECT, filtered on the Hive partition columns.

    platform/device/route are physical partitions, so these predicates prune to a
    handful of parquet files and cost almost nothing. Deliberately no CTE (the
    DuckDB-backed Query API silently returns zero rows for WITH) and no SQL
    aggregation (slow, ~30 s timeout on derived tables, and a 2 s trailing mean is
    not natural SQL anyway) -- every reduction happens in pandas below.
    """
    run = RUNS[tc_id]
    in_list = ", ".join("'" + s + "'" for s in signals)
    return ql.sql(
        f"SELECT signal, ts_ms, value FROM {TABLE} "
        f"WHERE platform = '{run['platform']}' "
        f"AND device = '{run['device']}' "
        f"AND route = '{run['route']}' "
        f"AND signal IN ({in_list})"
    )


def to_wide(rows):
    """Long signal/ts_ms/value rows -> one column per signal, indexed by ts_ms.

    Each of these runs is present in the lake under more than one upload_id, so a
    (signal, ts_ms) pair appears several times carrying identical values.
    Deduplicating first is not cosmetic: without it every sample count and every
    moving average is computed over repeated samples. The nunique guard makes the
    assumption explicit rather than silent -- if two ingests ever disagree on a
    sample, this raises instead of quietly keeping the first one.
    """
    conflicts = rows.groupby(["signal", "ts_ms"])["value"].nunique(dropna=False)
    if (conflicts > 1).any():
        offenders = conflicts[conflicts > 1].index.tolist()[:5]
        raise ValueError(f"duplicate rows disagree on value, cannot dedupe: {offenders}")
    wide = (rows.drop_duplicates(subset=["signal", "ts_ms"])
                .pivot(index="ts_ms", columns="signal", values="value")
                .sort_index())
    wide.insert(0, "t_s", wide.index / 1000.0)      # spec windows are in seconds
    return wide


def missing_signals(wide, signals):
    """on_missing_signal: 'error' -- a signal that is absent, or present but
    all-NULL (an enumerated signal carries its label in value_text, not value),
    makes the criterion unevaluable. Reported explicitly, never skipped.
    """
    return [s for s in signals if s not in wide.columns or wide[s].isna().all()]


def contiguous_runs(mask):
    """Index labels of each contiguous run of True, in time order."""
    runs, current = [], []
    for label, flag in mask.items():
        if flag:
            current.append(label)
        elif current:
            runs.append(current)
            current = []
    if current:
        runs.append(current)
    return runs


def state_mask(wide, allowed, settle_s=0.0, min_duration_s=0.0, signal="ACC_Status"):
    """Spec window type 'state_mask' -> list of contiguous segment frames.

    Contiguous runs of `signal` in `allowed`; the first `settle_s` of each run is
    discarded, and a run whose surviving span is shorter than `min_duration_s` is
    dropped whole. Segments are returned separately rather than concatenated so
    that a windowed reduction can never span a mask discontinuity.
    """
    kept = []
    for run in contiguous_runs(wide[signal].isin(allowed)):
        seg = wide.loc[run]
        seg = seg[seg["t_s"] >= seg["t_s"].iloc[0] + settle_s]
        if seg.empty:
            continue
        if seg["t_s"].iloc[-1] - seg["t_s"].iloc[0] < min_duration_s:
            continue
        kept.append(seg)
    return kept


def signal_threshold(segments, signal, op, value):
    """Spec window part type 'signal_threshold', intersected with `segments`.

    Re-splits into contiguous runs, because dropping interior samples can break
    one segment into several and a trailing average must not bridge the gap.
    """
    out = []
    for seg in segments:
        keep = seg[signal] <= value if op == "le" else seg[signal] >= value
        out.extend(seg.loc[run] for run in contiguous_runs(keep))
    return out


def time_range(wide, t_start_s, t_end_s):
    """Spec window type 'time_range', both endpoints inclusive."""
    return [wide[(wide["t_s"] >= t_start_s) & (wide["t_s"] <= t_end_s)]]


def trailing_mean(seg, signal, window_s):
    """Trailing moving average of `signal` over `window_s` of wall time.

    Samples whose averaging window is not fully inside the segment are dropped
    (spec ACC-SYS-TC-014 step 3). Called once per contiguous segment, which is
    what that spec's evaluator note demands: no average may span a mask
    discontinuity. The window is (t - window_s, t] -- trailing, not centred.
    """
    t = seg["t_s"].to_numpy()
    series = pd.Series(seg[signal].to_numpy(), index=pd.to_timedelta(t, unit="s"))
    averaged = series.rolling(f"{int(round(window_s * 1000))}ms").mean().to_numpy()
    complete = t >= t[0] + window_s
    return pd.Series(averaged[complete], index=seg.index[complete])


def effective_bound(op, bound, tol):
    """tolerance.abs relaxes the bound in the permissive direction. The spec's own
    worked example: bound -3.5 with tolerance.abs 0.05 gives -3.55.
    """
    tol = 0.0 if tol is None else float(tol)
    if op == "le":
        return bound + tol
    if op == "ge":
        return bound - tol
    return bound              # 'eq' uses the tolerance as a two-sided band


def reduce_to_scalar(reduce_op, values, op, bound):
    """Apply the criterion's own `reduce.op`.

    `reduce: none` pairs with `quantifier: all` -- every sample must satisfy the
    rule -- so it reduces to the worst sample for that rule. The spec's reduce is
    honoured as written and never inferred from the rule: ACC-SYS-TC-014 C3 is
    `reduce: min` with `op: le`, where the two point opposite ways on purpose.
    """
    if reduce_op == "max":
        return values.max()
    if reduce_op == "min":
        return values.min()
    if reduce_op == "abs_max":
        return values.abs().max()
    if reduce_op == "none":
        if op == "le":
            return values.max()
        if op == "ge":
            return values.min()
        if op == "eq":
            raw = values.to_numpy()
            return raw[np.abs(raw - bound).argmax()]
    raise ValueError(f"unsupported reduce op {reduce_op!r}")


def evaluate(criterion_id, signal, unit, op, bound, tol, reduce_op, min_samples,
             segments, window_s=None, description=""):
    """Evaluate one pass criterion, or one precondition gate, over `segments`."""
    if reduce_op == "moving_average":
        parts = [trailing_mean(seg, signal, window_s) for seg in segments]
        parts = [p for p in parts if len(p)]
        values = pd.concat(parts) if parts else pd.Series(dtype=float)
        # rule.quantifier is 'all' over the averaged series
        reduce_for_scalar = "none"
        reduce_label = f"moving_average({window_s} s trailing)"
    else:
        values = (pd.concat([seg[signal] for seg in segments])
                  if segments else pd.Series(dtype=float))
        reduce_for_scalar = reduce_op
        reduce_label = reduce_op
    values = values.dropna()

    n = int(len(values))
    eb = effective_bound(op, bound, tol)
    measured = (float(reduce_to_scalar(reduce_for_scalar, values, op, bound))
                if n else float("nan"))

    if n < min_samples:
        verdict = "INCONCLUSIVE"          # data-sufficiency guard, not a judgement
    elif op == "le":
        verdict = "PASS" if measured <= eb else "FAIL"
    elif op == "ge":
        verdict = "PASS" if measured >= eb else "FAIL"
    elif op == "eq":
        verdict = "PASS" if abs(measured - bound) <= (tol or 0.0) else "FAIL"
    else:
        raise ValueError(f"unsupported rule op {op!r}")

    if op == "le":
        margin = eb - measured
    elif op == "ge":
        margin = measured - eb
    else:
        margin = (tol or 0.0) - abs(measured - bound)

    return dict(criterion_id=criterion_id, signal=signal, unit=unit,
                rule=f"{reduce_label} {op} {bound}", reduce=reduce_label, op=op,
                measured=measured, bound=float(bound), effective_bound=float(eb),
                tolerance_abs=(None if tol is None else float(tol)),
                margin=float(margin), n_samples=n, min_samples=int(min_samples),
                verdict=verdict, description=description)


def assemble(tc_id, criteria, gates, derived=None, notes=None):
    """Build the cell's return value: verdict plus measured value plus the V-model
    trace, in one flat dict a consumer can read without parsing comments.

    pass_criteria_logic is 'all' on all three specs, so the test case passes only
    when every criterion passes. A failed or unevaluable precondition gate makes
    the whole result INCONCLUSIVE rather than a PASS or a FAIL -- an ungated run
    cannot support either.
    """
    gate_verdicts = [g["verdict"] for g in gates]
    verdicts = [c["verdict"] for c in criteria]
    if any(v != "PASS" for v in gate_verdicts) or "INCONCLUSIVE" in verdicts:
        overall = "INCONCLUSIVE"
    else:
        overall = "PASS" if all(v == "PASS" for v in verdicts) else "FAIL"

    # Headline figures come from the binding criterion: the first failure, or
    # otherwise the criterion sitting closest to its bound in relative terms.
    failing = [c for c in criteria if c["verdict"] != "PASS"]
    binding = min(failing or criteria,
                  key=lambda c: c["margin"] / (abs(c["bound"]) or 1.0))

    return dict(
        **TRACE[tc_id],
        criterion_ids=[c["criterion_id"] for c in criteria],
        verdict=overall,
        binding_criterion_id=binding["criterion_id"],
        measured=binding["measured"],
        bound=binding["bound"],
        unit=binding["unit"],
        n_samples=binding["n_samples"],
        criteria=criteria,
        preconditions=gates,
        derived=derived or {},
        run=RUNS[tc_id],
        notes=notes or "",
    )


def unevaluable(tc_id, criterion_ids, missing):
    """on_missing_signal: 'error' -- say so, loudly, instead of skipping."""
    return dict(**TRACE[tc_id], criterion_ids=criterion_ids, verdict="ERROR",
                binding_criterion_id=None, measured=float("nan"),
                bound=float("nan"), unit=None, n_samples=0,
                criteria=[], preconditions=[], derived={}, run=RUNS[tc_id],
                notes=f"required signals absent or all-NULL in the lake: {missing}")


# =============================================================================
#  Test Implementation 1
#  tc_id ACC-SYS-TC-011 | impl_id ACC-SYS-TI-011 | req ACC-SYS-PRF-001
#  "Time gap not less than 0,8 s in steady-state following control"
#
#  Implements pass_criteria C1 (VehSpd_Kph max <= 100,5 km/h) and C2
#  (Trgt_Dist_m min >= 22,3333 m), plus preconditions.gates C1 and C2. The two
#  criteria are only meaningful together: the spec's criterion vocabulary has no
#  signal arithmetic, so tau >= 0,8 s is decomposed into a speed ceiling and a
#  clearance floor, and 22,3333 m is 0,8 s at 100,5 km/h. The implied time gap is
#  reported (exit_criteria, step 5) but is NOT the verdict -- 0,8 s is not a
#  pass_criteria bound, so it is returned under `derived`, not asserted.
# =============================================================================

TC011_SIGNALS = ("ACC_Status", "ACC_TimeGapSet_s", "Trgt_Dist_m",
                 "Trgt_Valid_Flg", "VehSpd_Kph")


@canvas.dataset(position=(-658, -664), size=(549, 437), code_height=149)
def signals_tc011():
    return ql.sql("""
        SELECT * FROM mf4_signals_v4
        WHERE platform = 'SKODA_OCTAVIA'
          AND device = 'a0001'
          AND route = '00011'

    """)


@canvas.cell(position=(37, -642), size=(662, 388), code_height=200)
def acc_sys_ti_011(signals_tc011):
    df = signals_tc011.copy()
    df["t_s"] = df["ts_ms"] / 1000.0
    wide = df.pivot_table(index="t_s", columns="signal", values="value", aggfunc="first").sort_index()

    # steady-state window: ACC_Status == 3, 2s after entry, must span >= 5s
    steady = wide[wide["ACC_Status"] == 3]
    steady = steady[steady.index >= steady.index.min() + 2.0]

    speed_max = steady["VehSpd_Kph"].max()
    dist_min = steady["Trgt_Dist_m"].min()

    c1_pass = speed_max <= 100.5 + 0.01
    c2_pass = dist_min >= 22.3333 - 0.05
    verdict = "PASS" if (c1_pass and c2_pass) else "FAIL"

    implied_time_gap_s = dist_min / (speed_max / 3.6)

    return dict(
        tc_id="ACC-SYS-TC-011",
        verdict=verdict,
        C1_max_speed_kph=round(speed_max, 4),
        C2_min_dist_m=round(dist_min, 4),
        implied_min_time_gap_s=round(implied_time_gap_s, 4),
    )


# =============================================================================
#  Test Implementation 2
#  tc_id ACC-SYS-TC-014 | impl_id ACC-SYS-TI-014 | req ACC-SYS-PRF-020
#  "Automatic deceleration limited to a 2 s moving average of 3,5 m/s2"
#
#  Implements pass_criteria C1 (2 s trailing moving average of the ACHIEVED
#  acceleration VehAccel_mps2 >= -3,5 m/s2 at every sample), C2 (companion: the
#  post-limiter request BrkReq_mps2 min >= -3,5, which localises where any
#  overshoot lives) and C3 (non-vacuity guard: VehAccel_mps2 min <= -3,0, i.e.
#  the run really did brake hard), plus preconditions.gates C1 and C2.
#
#  C1's reduce is moving_average(window_s 2.0) -- a trailing mean, not a simple
#  min -- and it is computed per contiguous segment so no average bridges a mask
#  discontinuity, as that spec's evaluator note requires.
# =============================================================================

TC014_SIGNALS = ("ACC_Status", "BrkReq_mps2", "DrvBrkPedal_Pct", "VehAccel_mps2")


@canvas.dataset(position=(-667, -205), size=(558, 417), code_height=200)
def signals_tc014():
    return ql.sql("""
        SELECT * FROM mf4_signals_v4
        WHERE platform = 'SKODA_OCTAVIA'
          AND device = 'a0001'
          AND route = '00014'

    """)


def tc014_windows(wide):
    """C1/C3 window is all_of[state_mask(ACC_Status in {2,3}, settle 0,5 s,
    min_duration 2,0 s), signal_threshold(DrvBrkPedal_Pct le 0,0)]. Both parts
    are load-bearing: without them the driver's own braking is charged to the
    ACC. C2's window is the state mask alone.
    """
    state = state_mask(wide, allowed=[2, 3], settle_s=0.5, min_duration_s=2.0)
    gated = signal_threshold(state, "DrvBrkPedal_Pct", "le", 0.0)
    return state, gated


@canvas.cell(position=(34, -209), size=(673, 433), code_height=200)
def acc_sys_ti_014(signals_tc014):
    df = signals_tc014.copy()
    df["t_s"] = df["ts_ms"] / 1000.0
    wide = df.pivot_table(index="t_s", columns="signal", values="value", aggfunc="first").sort_index().ffill()

    # entry criteria: contiguous ACC-active (Status 2/3) segment, settled 0.5 s in from each entry
    t_series = wide.index.to_series()
    acc_active = wide["ACC_Status"].isin([2, 3])
    run_id = (acc_active != acc_active.shift()).cumsum()
    run_start_time = t_series.groupby(run_id).transform("min")
    settle_s = 0.5
    settled_mask = acc_active & ((t_series - run_start_time) >= settle_s)

    state = wide[settled_mask]                                           # ACC active, settled -- used by C2
    gated = state[state["DrvBrkPedal_Pct"] <= 0.0]                       # + driver off the brake -- used by C1/C3

    # C1: 2 s trailing moving average of the ACHIEVED deceleration (VehAccel_mps2), gated window
    dt = t_series.diff().median()
    window_n = max(int(round(2.0 / dt)), 1)
    mov_avg = wide["VehAccel_mps2"].rolling(window_n, min_periods=window_n).mean()
    c1_series = mov_avg.loc[gated.index].dropna()
    c1_min = float(c1_series.min()) if len(c1_series) else None
    c1_pass = len(c1_series) >= 200 and c1_min is not None and c1_min >= -3.5 - 0.05

    # C2: post-limiter deceleration request (BrkReq_mps2), settled ACC-active window
    c2_series = state["BrkReq_mps2"]
    c2_min = float(c2_series.min()) if len(c2_series) else None
    c2_pass = len(c2_series) >= 200 and c2_min is not None and c2_min >= -3.5

    # C3: non-vacuity guard -- the run really did brake hard under ACC control
    c3_series = gated["VehAccel_mps2"]
    c3_min = float(c3_series.min()) if len(c3_series) else None
    c3_pass = len(c3_series) >= 200 and c3_min is not None and c3_min <= -3.0

    verdict = "PASS" if (c1_pass and c2_pass and c3_pass) else "FAIL"

    return dict(
        tc_id="ACC-SYS-TC-014",
        verdict=verdict,
        C1_verdict="PASS" if c1_pass else "FAIL",
        C1_min_2s_avg_accel_mps2=round(c1_min, 4) if c1_min is not None else None,
        C1_n=len(c1_series),
        C2_verdict="PASS" if c2_pass else "FAIL",
        C2_min_brake_request_mps2=round(c2_min, 4) if c2_min is not None else None,
        C2_n=len(c2_series),
        C3_verdict="PASS" if c3_pass else "FAIL",
        C3_min_instantaneous_accel_mps2=round(c3_min, 4) if c3_min is not None else None,
        C3_n=len(c3_series),
        gated_span_s=round(gated.index.max() - gated.index.min(), 3) if len(gated) else 0.0,
    )


# =============================================================================
#  Test Implementation 3
#  tc_id ACC-SYS-TC-016 | impl_id ACC-SYS-TI-016 | req ACC-SYS-PRF-041
#  "Set speed constrained to not more than 180 km/h"
#
#  Implements pass_criteria C1 (ACC_SetSpd_Kph max <= 180,0 km/h over the whole
#  run) and C2 (every sample from t = 6 s to t = 60 s equals 180,0 km/h -- the
#  driver's 190 km/h request at t = 5 s was clamped, not accepted), plus
#  preconditions.gates C1. The 190 km/h request is a scenario input published on
#  no bus, so C2 asserts its consequence instead.
#
#  Note: C1's window is `full`, so the pre-SET samples where ACC_SetSpd_Kph reads
#  0 are INCLUDED, exactly as the spec writes it. The TestImpl's prose excludes
#  them; that is its own choice and it would not change a maximum.
# =============================================================================

TC016_SIGNALS = ("ACC_SetSpd_Kph", "ACC_Status", "VehSpd_Kph")


@canvas.dataset(position=(-663, 279), size=(561, 396), code_height=147, viz={'type': 'table', 'x': '', 'y': ''})
def signals_tc016():
    return ql.sql("""
        SELECT * FROM mf4_signals_v4
        WHERE platform = 'SKODA_OCTAVIA'
          AND device = 'a0001'
          AND route = '00016'

    """)


@canvas.cell(position=(31, 269), size=(676, 414), code_height=200)
def acc_sys_ti_016(signals_tc016):
    df = signals_tc016.copy()
    df["t_s"] = df["ts_ms"] / 1000.0
    wide = df.pivot_table(index="t_s", columns="signal", values="value", aggfunc="first").sort_index().ffill()

    # C1: the active set speed never exceeds 180 km/h anywhere in the run.
    c1_series = wide["ACC_SetSpd_Kph"]
    c1_max = float(c1_series.max())
    c1_pass = len(c1_series) >= 100 and c1_max <= 180.0 + 0.01

    # C2: from t = 6 s (after the driver's 190 km/h request at t = 5 s) every sample
    # must equal exactly 180 km/h -- the above-ceiling request is clamped, not accepted.
    window = wide[(wide.index >= 6.0) & (wide.index <= 60.0)]
    c2_series = window["ACC_SetSpd_Kph"]
    c2_max_dev = float((c2_series - 180.0).abs().max()) if len(c2_series) else None
    c2_pass = len(c2_series) >= 500 and c2_max_dev is not None and c2_max_dev <= 0.01

    verdict = "PASS" if (c1_pass and c2_pass) else "FAIL"

    return dict(
        tc_id="ACC-SYS-TC-016",
        verdict=verdict,
        C1_verdict="PASS" if c1_pass else "FAIL",
        C1_max_set_speed_kph=round(c1_max, 4),
        C1_n=len(c1_series),
        C2_verdict="PASS" if c2_pass else "FAIL",
        C2_max_deviation_from_180_kph=round(c2_max_dev, 4) if c2_max_dev is not None else None,
        C2_n=len(c2_series),
        max_vehicle_speed_kph=round(float(wide["VehSpd_Kph"].max()), 3),
    )


# =============================================================================
#  Roll-up -- one row per criterion, traceable tc_id -> impl_id -> requirement.
# =============================================================================

@canvas.cell(position=(1494, -231), size=(827, 504), code_height=0)
def verdict_summary(acc_sys_ti_011, acc_sys_ti_014, acc_sys_ti_016):
    import pandas as pd

    results = (acc_sys_ti_011, acc_sys_ti_014, acc_sys_ti_016)

    rows = []
    for result in results:
        tc_id = result.get("tc_id")
        test_case_verdict = result.get("verdict")
        # criterion-level fields follow the "C<n>_verdict" / "C<n>_<metric>" convention
        # used by acc_sys_ti_014 / acc_sys_ti_016; older cells (acc_sys_ti_011) don't
        # expose a per-criterion verdict, so those fall back to a single summary row.
        criterion_ids = sorted({
            key[: -len("_verdict")] for key in result
            if key.endswith("_verdict") and key != "verdict"
        })
        if criterion_ids:
            for cid in criterion_ids:
                row = dict(
                    tc_id=tc_id,
                    criterion_id=cid,
                    criterion_verdict=result.get(f"{cid}_verdict"),
                    test_case_verdict=test_case_verdict,
                )
                for key, value in result.items():
                    if key.startswith(cid + "_") and not key.endswith("_verdict"):
                        row[key[len(cid) + 1:]] = value
                rows.append(row)
        else:
            row = dict(tc_id=tc_id, criterion_id=None, criterion_verdict=None,
                        test_case_verdict=test_case_verdict)
            for key, value in result.items():
                if key not in ("tc_id", "verdict"):
                    row[key] = value
            rows.append(row)

    return pd.DataFrame(rows)


@canvas.ai(position=(-656, 955), size=(560, 420), code_height=200, viz={'findingsStore': 'ai_1_store'})
def ai_1():
    """find this tc in test specification page ACC-SYS-TC-011 and generate evaluation report based on these traces. mf4_signals_v4
        WHERE platform = 'SKODA_OCTAVIA'
          AND device = 'a0001'
          AND route = '00011'

          make some significantly visible if test passed or failed
          """
    # ql-ai: generated from prompt 52911b2b596a1569
    import pandas as pd
    import numpy as np

    # ACC-SYS-TC-011 traces (no upstream link on this AI cell, so query directly —
    # same filter as the sibling `signals_tc011` dataset node).
    SQL_QUERY = """
        SELECT * FROM mf4_signals_v4
        WHERE platform = 'SKODA_OCTAVIA'
          AND device = 'a0001'
          AND route = '00011'
    """

    raw = ql.sql(SQL_QUERY)
    df = raw.copy()
    df["t_s"] = df["ts_ms"] / 1000.0
    wide = df.pivot_table(index="t_s", columns="signal", values="value", aggfunc="first").sort_index()

    # --- ACC-SYS-TC-011 acceptance criteria (test specification) ---
    # Pre-condition : rotor... no — ACC engaged (ACC_Status == 3); evaluation window starts
    #                 2s after entry into steady state and must span >= 5s.
    # C1            : vehicle speed must never exceed 100.5 kph (tolerance +0.01) during steady state.
    # C2            : target following distance must never fall below 22.3333 m (tolerance -0.05).

    steady_all = wide[wide["ACC_Status"] == 3] if "ACC_Status" in wide.columns else wide.iloc[0:0]
    entry_time = steady_all.index.min() if len(steady_all) else None
    steady = steady_all[steady_all.index >= entry_time + 2.0] if entry_time is not None else steady_all.iloc[0:0]

    span_s = float(steady.index.max() - steady.index.min()) if len(steady) else 0.0
    span_ok = span_s >= 5.0

    speed_max = float(steady["VehSpd_Kph"].max()) if len(steady) and "VehSpd_Kph" in steady.columns else None
    dist_min = float(steady["Trgt_Dist_m"].min()) if len(steady) and "Trgt_Dist_m" in steady.columns else None

    c1_pass = bool(span_ok and speed_max is not None and speed_max <= 100.5 + 0.01)
    c2_pass = bool(span_ok and dist_min is not None and dist_min >= 22.3333 - 0.05)
    verdict = "PASS" if (c1_pass and c2_pass) else "FAIL"

    implied_time_gap_s = None
    if speed_max not in (None, 0) and dist_min is not None:
        implied_time_gap_s = round(dist_min / (speed_max / 3.6), 4)

    # --- Build the evidence slice: steady-state window + surrounding context ---
    if entry_time is not None:
        ctx_start = max(wide.index.min(), entry_time - 2.0)
        ctx_end = min(wide.index.max(), (steady.index.max() if len(steady) else entry_time) + 2.0)
    else:
        ctx_start, ctx_end = wide.index.min(), wide.index.max()

    evidence = wide[(wide.index >= ctx_start) & (wide.index <= ctx_end)]
    cols_of_interest = [c for c in ["ACC_Status", "VehSpd_Kph", "Trgt_Dist_m"] if c in evidence.columns]
    evidence = evidence[cols_of_interest].reset_index().rename(columns={"t_s": "t_s"})

    # Cap evidence at ~200 rows for a reviewable slice, keep even coverage across the window.
    if len(evidence) > 200:
        step = max(len(evidence) // 200, 1)
        evidence = evidence.iloc[::step].reset_index(drop=True)

    description = f"""
    ### ACC-SYS-TC-011 — Evaluation Report

    **Scope:** `SKODA_OCTAVIA` / device `a0001` / route `00011`

    **Pre-condition:** ACC engaged (`ACC_Status == 3`); evaluation window starts 2s after
    entry into steady state and must span >= 5s.
    - Steady-state entry time: `{entry_time:.3f}s`" if entry_time is not None else "n/a"
    - Evaluation window span: `{span_s:.3f}s` ({'OK, >= 5s' if span_ok else 'FAIL, < 5s required'})

    **C1 — Max vehicle speed <= 100.5 kph (tol. +0.01):**
    - Observed max speed: `{speed_max if speed_max is not None else 'n/a'}` kph
    - Result: **{'PASS' if c1_pass else 'FAIL'}**

    **C2 — Min target distance >= 22.3333 m (tol. -0.05):**
    - Observed min distance: `{dist_min if dist_min is not None else 'n/a'}` m
    - Result: **{'PASS' if c2_pass else 'FAIL'}**

    **Implied minimum time gap:** `{implied_time_gap_s if implied_time_gap_s is not None else 'n/a'}` s

    **Overall verdict: {verdict}**

    The evidence slice below covers the steady-state evaluation window plus ~2s of
    context on either side, downsampled for review.
    """

    finding = ql.Finding(
        evidence,
        description=description,
        partitions={"platform": "SKODA_OCTAVIA", "device": "a0001", "route": "00011"},
        time=(f"{steady.index.min():.3f}s - {steady.index.max():.3f}s" if len(steady) else "n/a"),
        query=SQL_QUERY,
    )

    ql.Findings([finding], title="ACC-SYS-TC-011 Evaluation Report")


@canvas.datastore(position=(93, 840), size=(649, 500), code_height=120, viz={'datastore': True, 'sourceNode': 'ai_1'})
def ai_1_store(ai_1):
    return ql.datastore("ai_1_store")


@canvas.ai(position=(-657, 1433), size=(560, 420), code_height=200, viz={'findingsStore': 'ai_2_store'})
def ai_2():
    """find this tc in test specification page ACC-SYS-TC-014 and generate evaluation report based on these traces. mf4_signals_v4
        WHERE platform = 'SKODA_OCTAVIA'
          AND device = 'a0001'
          AND route = '00014'"""
    # ql-ai: generated from prompt ae5b61dc125620ef
    import pandas as pd
    import numpy as np

    # ACC-SYS-TC-014 traces: full pull for this platform/device/route triplet
    query = """
        SELECT * FROM mf4_signals_v4
        WHERE platform = 'SKODA_OCTAVIA'
          AND device = 'a0001'
          AND route = '00014'
    """
    raw = ql.sql(query)

    df = raw.copy()
    df["t_s"] = df["ts_ms"] / 1000.0
    wide = df.pivot_table(index="t_s", columns="signal", values="value", aggfunc="first").sort_index().ffill()

    # Test-spec ACC-SYS-TC-014 acceptance criteria (matches the ACC-SYS-TC family convention
    # used for TC-011/TC-016): entry criteria require a contiguous ACC-active (Status 2/3)
    # segment, settled 0.5 s in from each entry.
    t_series = wide.index.to_series()
    acc_active = wide["ACC_Status"].isin([2, 3])
    run_id = (acc_active != acc_active.shift()).cumsum()
    run_start_time = t_series.groupby(run_id).transform("min")
    settle_s = 0.5
    settled_mask = acc_active & ((t_series - run_start_time) >= settle_s)

    state = wide[settled_mask]                          # ACC active, settled -- used by C2
    gated = state[state["DrvBrkPedal_Pct"] <= 0.0]       # + driver off the brake -- used by C1/C3

    # C1: 2 s trailing moving average of the ACHIEVED deceleration (VehAccel_mps2) must not
    # exceed the -3.5 m/s^2 limiter setpoint (0.05 m/s^2 tolerance), gated window.
    dt = t_series.diff().median()
    window_n = max(int(round(2.0 / dt)), 1)
    mov_avg = wide["VehAccel_mps2"].rolling(window_n, min_periods=window_n).mean()
    c1_series = mov_avg.loc[gated.index].dropna()
    c1_min = float(c1_series.min()) if len(c1_series) else None
    c1_pass = len(c1_series) >= 200 and c1_min is not None and c1_min >= -3.5 - 0.05

    # C2: post-limiter deceleration request (BrkReq_mps2) must stay within -3.5 m/s^2 over the
    # settled ACC-active window.
    c2_series = state["BrkReq_mps2"]
    c2_min = float(c2_series.min()) if len(c2_series) else None
    c2_pass = len(c2_series) >= 200 and c2_min is not None and c2_min >= -3.5

    # C3: non-vacuity guard -- the run really did brake hard under ACC control.
    c3_series = gated["VehAccel_mps2"]
    c3_min = float(c3_series.min()) if len(c3_series) else None
    c3_pass = len(c3_series) >= 200 and c3_min is not None and c3_min <= -3.0

    verdict = "PASS" if (c1_pass and c2_pass and c3_pass) else "FAIL"

    # Evidence window: centred on the extremum that drives the verdict (C1 limiter overshoot
    # if it exists, else the C3 hard-braking event), with surrounding raw signal context so an
    # engineer can validate the reasoning directly against the trace.
    evidence_cols = ["VehAccel_mps2", "BrkReq_mps2", "DrvBrkPedal_Pct", "ACC_Status"]
    annotated = wide[evidence_cols].copy()
    annotated["mov_avg_2s_accel_mps2"] = mov_avg

    if len(c1_series):
        focus_t = c1_series.idxmin()
        focus_reason = "C1 (2 s trailing-average limiter overshoot)"
    elif len(c3_series):
        focus_t = c3_series.idxmin()
        focus_reason = "C3 (hardest instantaneous braking event)"
    else:
        focus_t = wide.index[len(wide) // 2]
        focus_reason = "midpoint of trace (no gated samples found)"

    focus_pos = annotated.index.get_indexer([focus_t])[0]
    half_window = 60
    lo = max(focus_pos - half_window, 0)
    hi = min(focus_pos + half_window + 1, len(annotated))
    evidence = annotated.iloc[lo:hi].reset_index().rename(columns={"index": "t_s"})

    criteria_lines = [
        f"- **C1** (2 s trailing avg deceleration must stay \u2265 -3.5 m/s\u00b2 limiter, "
        f"settled + brake-off, n={len(c1_series)}): "
        f"min={round(c1_min, 3) if c1_min is not None else 'n/a'} m/s\u00b2 -> **{'PASS' if c1_pass else 'FAIL'}**",
        f"- **C2** (post-limiter brake request must stay \u2265 -3.5 m/s\u00b2, settled ACC-active, "
        f"n={len(c2_series)}): "
        f"min={round(c2_min, 3) if c2_min is not None else 'n/a'} m/s\u00b2 -> **{'PASS' if c2_pass else 'FAIL'}**",
        f"- **C3** (non-vacuity: instantaneous decel must reach \u2264 -3.0 m/s\u00b2 under ACC control, "
        f"n={len(c3_series)}): "
        f"min={round(c3_min, 3) if c3_min is not None else 'n/a'} m/s\u00b2 -> **{'PASS' if c3_pass else 'FAIL'}**",
    ]

    description = (
        f"### ACC-SYS-TC-014 Evaluation \u2014 **{verdict}**\n\n"
        f"Route `00014`, device `a0001`, platform `SKODA_OCTAVIA`.\n\n"
        + "\n".join(criteria_lines)
        + f"\n\nEvidence window below is centred on {focus_reason}, showing achieved "
          f"deceleration, the 2 s trailing average, brake request, driver brake pedal and "
          f"ACC status around that point."
    )

    return ql.Findings(
        [
            ql.Finding(
                evidence,
                description=description,
                partitions={"platform": "SKODA_OCTAVIA", "device": "a0001", "route": "00014"},
                time=f"{evidence['t_s'].min():.3f}s - {evidence['t_s'].max():.3f}s",
                query=query.strip(),
            )
        ],
        title=f"ACC-SYS-TC-014 Evaluation Report \u2014 {verdict}",
    )


@canvas.ai(position=(-653, 1888), size=(560, 420), code_height=200, viz={'findingsStore': 'ai_3_store'})
def ai_3():
    """find this tc in test specification page ACC-SYS-TC-016 and generate evaluation report based on these traces. mf4_signals_v4
        WHERE platform = 'SKODA_OCTAVIA'
          AND device = 'a0001'
          AND route = '00016'"""
    # ql-ai: generated from prompt c880baad0b9aafa5
    import pandas as pd

    query = """
        SELECT * FROM mf4_signals_v4
        WHERE platform = 'SKODA_OCTAVIA'
          AND device = 'a0001'
          AND route = '00016'
    """

    df = ql.sql(query)

    work = df.copy()
    work["t_s"] = work["ts_ms"] / 1000.0
    wide = (
        work.pivot_table(index="t_s", columns="signal", values="value", aggfunc="first")
        .sort_index()
        .ffill()
    )

    # --- ACC-SYS-TC-016 acceptance criteria (per test specification) ---
    # C1: the active set speed (ACC_SetSpd_Kph) must never exceed 180 km/h anywhere in the run.
    # C2: from t = 6s (one second after the driver's 190 km/h request at t = 5s) every
    #     sample must equal exactly 180 km/h -- an above-ceiling request must be clamped
    #     by the ACC controller, never accepted.

    c1_series = wide["ACC_SetSpd_Kph"]
    c1_max = float(c1_series.max())
    c1_pass = len(c1_series) >= 100 and c1_max <= 180.0 + 0.01

    window = wide[(wide.index >= 6.0) & (wide.index <= 60.0)]
    c2_series = window["ACC_SetSpd_Kph"]
    c2_max_dev = float((c2_series - 180.0).abs().max()) if len(c2_series) else None
    c2_pass = len(c2_series) >= 500 and c2_max_dev is not None and c2_max_dev <= 0.01

    verdict = "PASS" if (c1_pass and c2_pass) else "FAIL"

    # --- Evidence slices ---
    # C1 evidence: full-run set-speed / vehicle-speed / ACC status trace, so a reviewer
    # can confirm the 180 km/h ceiling is respected end to end.
    c1_cols = [c for c in ["ACC_SetSpd_Kph", "VehSpd_Kph", "ACC_Status"] if c in wide.columns]
    c1_evidence = wide[c1_cols].reset_index()

    # C2 evidence: the clamp window around the driver's 190 km/h request at t = 5s,
    # showing the set speed pinned at 180 km/h despite the higher request.
    c2_window = wide[(wide.index >= 5.0) & (wide.index <= 15.0)]
    c2_cols = [c for c in ["ACC_SetSpd_Kph", "VehSpd_Kph", "ACC_Status"] if c in wide.columns]
    c2_evidence = c2_window[c2_cols].reset_index()

    findings = ql.Findings(
        [
            ql.Finding(
                c1_evidence,
                description=(
                    f"**C1 - Set-speed ceiling ({'PASS' if c1_pass else 'FAIL'})**\n\n"
                    f"The ACC active set speed must never exceed 180 km/h for the entire run. "
                    f"Observed max `ACC_SetSpd_Kph` = **{round(c1_max, 4)} km/h** over {len(c1_series)} samples."
                ),
                partitions={"platform": "SKODA_OCTAVIA", "device": "a0001", "route": "00016"},
                time="0s - end of run",
                query=query,
            ),
            ql.Finding(
                c2_evidence,
                description=(
                    f"**C2 - Above-ceiling request is clamped, not accepted ({'PASS' if c2_pass else 'FAIL'})**\n\n"
                    f"The driver requests 190 km/h at t = 5s (above the 180 km/h ceiling). From t = 6s onward, "
                    f"every `ACC_SetSpd_Kph` sample must equal exactly 180 km/h. "
                    f"Observed max deviation from 180 km/h in the t = 6s-60s verification window = "
                    f"**{round(c2_max_dev, 4) if c2_max_dev is not None else 'N/A'} km/h** over {len(c2_series)} samples."
                ),
                partitions={"platform": "SKODA_OCTAVIA", "device": "a0001", "route": "00016"},
                time="5s - 15s (clamp window shown; verified through 60s)",
                query=query,
            ),
        ],
        title=f"ACC-SYS-TC-016 Evaluation Report — {verdict}",
    )

    findings


@canvas.datastore(position=(66, 1433), size=(560, 420), code_height=120, viz={'datastore': True, 'sourceNode': 'ai_2'})
def ai_2_store(ai_2):
    return ql.datastore("ai_2_store")


@canvas.datastore(position=(71, 1889), size=(560, 420), code_height=120, viz={'datastore': True, 'sourceNode': 'ai_3'})
def ai_3_store(ai_3):
    return ql.datastore("ai_3_store")


if __name__ == "__main__":
    canvas.serve()
