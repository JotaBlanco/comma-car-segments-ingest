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

canvas = ql.Canvas(title="ACC Performance Test Cases")

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


@canvas.dataset()
def signals_tc011():
    return fetch("ACC-SYS-TC-011", TC011_SIGNALS)


@canvas.cell()
def acc_sys_ti_011(signals_tc011):
    wide = to_wide(signals_tc011)
    absent = missing_signals(wide, TC011_SIGNALS)
    if absent:
        return unevaluable("ACC-SYS-TC-011", ["C1", "C2"], absent)

    # Window shared by both pass criteria: ACC_Status == 3 (Active-Follow), the
    # first 2,0 s of the segment discarded (settle_s, this spec's operational
    # reading of "steady-state conditions"), segment must then span >= 5,0 s.
    steady = state_mask(wide, allowed=[3], settle_s=2.0, min_duration_s=5.0)

    gates = [
        # preconditions.gates C1 -- the 0,8 s setting really was the one selected.
        evaluate("gate:C1", "ACC_TimeGapSet_s", "s", "eq", 0.8, 0.001, "none", 100,
                 state_mask(wide, allowed=[3], settle_s=0.5),
                 description="selected time-gap setting resolves to 0,8 s"),
        # preconditions.gates C2 -- a valid primary target at every sample.
        evaluate("gate:C2", "Trgt_Valid_Flg", "1", "eq", 1, None, "min", 100, steady,
                 description="valid primary target tracked throughout the window"),
    ]

    criteria = [
        evaluate("C1", "VehSpd_Kph", "km/h", "le", 100.5, 0.01, "max", 1000, steady,
                 description="ego speed ceiling the clearance floor is derived at"),
        evaluate("C2", "Trgt_Dist_m", "m", "ge", 22.3333, 0.05, "min", 250, steady,
                 description="minimum clearance = 0,8 s at the 100,5 km/h ceiling"),
    ]

    speed_max, dist_min = criteria[0]["measured"], criteria[1]["measured"]
    tau = dist_min / (speed_max / 3.6) if speed_max else float("nan")
    return assemble(
        "ACC-SYS-TC-011", criteria, gates,
        derived=dict(implied_min_time_gap_s=round(tau, 4),
                     formula="min(Trgt_Dist_m) / (max(VehSpd_Kph) / 3.6)",
                     iso_reference="ISO 15622:2018 cl. 6.2.3.1 -- 0,8 s"),
        notes=("implied_min_time_gap_s is reported for the record per "
               "exit_criteria / step 5. The verdict is C1 AND C2, not this "
               "quotient: 0,8 s is not a pass_criteria bound."),
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


@canvas.dataset()
def signals_tc014():
    return fetch("ACC-SYS-TC-014", TC014_SIGNALS)


def tc014_windows(wide):
    """C1/C3 window is all_of[state_mask(ACC_Status in {2,3}, settle 0,5 s,
    min_duration 2,0 s), signal_threshold(DrvBrkPedal_Pct le 0,0)]. Both parts
    are load-bearing: without them the driver's own braking is charged to the
    ACC. C2's window is the state mask alone.
    """
    state = state_mask(wide, allowed=[2, 3], settle_s=0.5, min_duration_s=2.0)
    gated = signal_threshold(state, "DrvBrkPedal_Pct", "le", 0.0)
    return state, gated


@canvas.cell()
def acc_sys_ti_014(signals_tc014):
    wide = to_wide(signals_tc014)
    absent = missing_signals(wide, TC014_SIGNALS)
    if absent:
        return unevaluable("ACC-SYS-TC-014", ["C1", "C2", "C3"], absent)

    state, gated = tc014_windows(wide)

    gates = [
        # preconditions.gates C1 -- driver never touched the brake, whole run.
        evaluate("gate:C1", "DrvBrkPedal_Pct", "%", "le", 0.0, 0.01, "abs_max", 1,
                 [wide],
                 description="driver brake pedal released for the entire run"),
        # preconditions.gates C2 -- a contiguous ACC-active segment of >= 20 s.
        evaluate("gate:C2", "ACC_Status", "1", "ge", 2, None, "none", 200,
                 state_mask(wide, allowed=[2, 3], settle_s=0.5, min_duration_s=20.0),
                 description="contiguous Active-Cruise/Follow segment of >= 20 s"),
    ]

    criteria = [
        evaluate("C1", "VehAccel_mps2", "m/s^2", "ge", -3.5, 0.05, "moving_average",
                 200, gated, window_s=2.0,
                 description="2 s trailing mean of the ACHIEVED deceleration"),
        evaluate("C2", "BrkReq_mps2", "m/s^2", "ge", -3.5, 0.0, "min", 200, state,
                 description="post-limiter deceleration REQUEST, localises the overshoot"),
        evaluate("C3", "VehAccel_mps2", "m/s^2", "le", -3.0, 0.0, "min", 200, gated,
                 description="non-vacuity guard: the run really did brake hard"),
    ]

    instantaneous = (round(float(pd.concat([s["VehAccel_mps2"] for s in gated]).min()), 4)
                     if gated else None)
    return assemble(
        "ACC-SYS-TC-014", criteria, gates,
        derived=dict(
            instantaneous_min_accel_mps2=instantaneous,
            gated_segments=len(gated),
            gated_span_s=round(sum(s["t_s"].iloc[-1] - s["t_s"].iloc[0]
                                   for s in gated), 3),
        ),
        notes=("C1 reads the achieved acceleration, which includes road load and is "
               "never clipped by the limiter chain; C2 reads the command after the "
               "limiter. Reading C1 from AccelReq_mps2 (positive-only) or from "
               "BrkReq_mps2 (exact at -3,500) would return a false PASS -- that is "
               "what C2 exists to make visible. instantaneous_min_accel_mps2 is a "
               "diagnostic: it shows how much of the averaged figure is a plateau "
               "rather than a spike."),
    )


@canvas.cell(viz={"type": "line", "x": "t_s", "y": "decel_2s_trailing_avg_mps2"})
def acc_sys_ti_014_trace(signals_tc014):
    """The C1 measurand plotted against its bound (tc_id ACC-SYS-TC-014,
    impl_id ACC-SYS-TI-014, pass_criteria C1).

    The charted series is the 2 s trailing average. The frame also carries
    raw_accel_mps2, the nominal bound (-3,5), the tolerance-relaxed effective
    bound (-3,55) and the signed margin, so a reviewer can retarget the chart's y
    or read the numbers straight off the table view. margin_mps2 < 0 marks a
    violating sample -- that is the whole finding, visible without having to
    trust the verdict cell.
    """
    wide = to_wide(signals_tc014)
    _, gated = tc014_windows(wide)
    averaged = pd.concat([trailing_mean(seg, "VehAccel_mps2", 2.0) for seg in gated])
    frame = pd.DataFrame({
        "t_s": wide.loc[averaged.index, "t_s"].to_numpy(),
        "decel_2s_trailing_avg_mps2": averaged.to_numpy(),
        "raw_accel_mps2": wide.loc[averaged.index, "VehAccel_mps2"].to_numpy(),
    })
    frame["bound_mps2"] = -3.5                    # pass_criteria C1 rule.value
    frame["effective_bound_mps2"] = -3.55         # bound relaxed by tolerance.abs
    frame["margin_mps2"] = (frame["decel_2s_trailing_avg_mps2"]
                            - frame["effective_bound_mps2"])
    return frame


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


@canvas.dataset()
def signals_tc016():
    return fetch("ACC-SYS-TC-016", TC016_SIGNALS)


@canvas.cell()
def acc_sys_ti_016(signals_tc016):
    wide = to_wide(signals_tc016)
    absent = missing_signals(wide, TC016_SIGNALS)
    if absent:
        return unevaluable("ACC-SYS-TC-016", ["C1", "C2"], absent)

    gates = [
        # preconditions.gates C1 -- Active-Cruise held for a contiguous >= 20 s.
        evaluate("gate:C1", "ACC_Status", "1", "eq", 2, None, "none", 200,
                 state_mask(wide, allowed=[2], min_duration_s=20.0),
                 description="Active-Cruise held for a contiguous 20 s or more"),
    ]

    criteria = [
        evaluate("C1", "ACC_SetSpd_Kph", "km/h", "le", 180.0, 0.01, "max", 100,
                 [wide],
                 description="set speed never exceeds 180 km/h anywhere in the run"),
        evaluate("C2", "ACC_SetSpd_Kph", "km/h", "eq", 180.0, 0.01, "none", 500,
                 time_range(wide, 6.0, 60.0),
                 description="every sample from t = 6 s is exactly 180 km/h (clamped)"),
    ]

    return assemble(
        "ACC-SYS-TC-016", criteria, gates,
        derived=dict(max_vehicle_speed_kph=round(float(wide["VehSpd_Kph"].max()), 3)),
        notes=("max_vehicle_speed_kph is context only -- VehSpd_Kph is in the spec's "
               "required_signals but no criterion reads it. The 180 km/h ceiling is a "
               "project decision (controller.speed.v_set_max_kph); ISO 15622:2018 "
               "cl. 4 defines v_set_max but sets no numeric value, so a PASS here is "
               "conformance to the project ceiling and to nothing in the standard."),
    )


# =============================================================================
#  Roll-up -- one row per criterion, traceable tc_id -> impl_id -> requirement.
# =============================================================================

@canvas.cell()
def verdict_summary(acc_sys_ti_011, acc_sys_ti_014, acc_sys_ti_016):
    rows = []
    for result in (acc_sys_ti_011, acc_sys_ti_014, acc_sys_ti_016):
        for criterion in result["criteria"]:
            rows.append(dict(
                tc_id=result["tc_id"],
                impl_id=result["impl_id"],
                requirement_id=result["requirement_id"],
                criterion_id=criterion["criterion_id"],
                signal=criterion["signal"],
                rule=criterion["rule"],
                measured=round(criterion["measured"], 4),
                bound=criterion["bound"],
                unit=criterion["unit"],
                margin=round(criterion["margin"], 4),
                n_samples=criterion["n_samples"],
                criterion_verdict=criterion["verdict"],
                test_case_verdict=result["verdict"],
            ))
    return pd.DataFrame(rows)


if __name__ == "__main__":
    canvas.serve()
