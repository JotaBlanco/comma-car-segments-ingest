"""The implemented test cases, one function each.

Each function mirrors a cell of ``quixlab/notebooks/acc_performance_tests.py`` and every
bound below is quoted from that test case's ``pass_criteria`` (or, where labelled, from
``preconditions.gates``). Nothing is hardcoded to a known-good answer: the verdicts are
computed from the signal series and can come out either way. ACC-SYS-TC-014 fails because
the vehicle really did exceed its deceleration limit, not because a demo needs a red row.

    cell / function   tc_id             impl_id           requirement_id
    ----------------  ----------------  ----------------  ----------------
    acc_sys_ti_011    ACC-SYS-TC-011    ACC-SYS-TI-011    ACC-SYS-PRF-001
    acc_sys_ti_014    ACC-SYS-TC-014    ACC-SYS-TI-014    ACC-SYS-PRF-020
    acc_sys_ti_016    ACC-SYS-TC-016    ACC-SYS-TI-016    ACC-SYS-PRF-041

A test case with no entry here is not evaluated and stays NOT_RUN in the run summary. That
is deliberate: inventing a verdict for a test case nobody implemented is the one thing a
verification tool must never do.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from .charts import (
    ChartBound,
    CriterionChart,
    breach_spans,
    chart_from,
    derived_points,
    measured_marker,
    series_of,
    signal_points,
)
from .criteria import (
    CriterionOutcome,
    Frame,
    binding_criterion,
    evaluate,
    full_range,
    overall_verdict,
    signal_threshold,
    state_mask,
    time_range,
)
from .signals import LakePartition


def fmt(value: float | None, decimals: int = 3) -> str:
    """Fixed-decimal rendering. Trailing zeros are kept - 180.000 is not 180."""
    return "n/a" if value is None else f"{value:.{decimals}f}"


def bound_text(value: float) -> str:
    """A bound as the spec writes it: 100.5, 22.3333, -3.5, 180.0."""
    return f"{value}"


@dataclass(frozen=True)
class CaseOutcome:
    """Everything one evaluated test case produced."""

    tc_id: str
    verdict: str
    criteria: list[CriterionOutcome]
    gates: list[CriterionOutcome]
    charts: list[CriterionChart]
    reason: str
    notes: list[str] = field(default_factory=list)
    derived: dict[str, float | str] = field(default_factory=dict)

    @property
    def binding(self) -> CriterionOutcome | None:
        return binding_criterion(self.criteria) if self.criteria else None


@dataclass(frozen=True)
class CaseEvaluator:
    """A test case that this backend can actually execute."""

    tc_id: str
    impl_id: str
    requirement_id: str
    entrypoint: str
    title: str
    verification_tag: str
    window: str
    scope: str
    signals: tuple[str, ...]
    partition: LakePartition
    run: Callable[[Frame], CaseOutcome]


def _unevaluable(tc_id: str, missing: list[str]) -> CaseOutcome:
    """``on_missing_signal: error`` - say so, loudly, instead of skipping the criterion."""
    return CaseOutcome(
        tc_id=tc_id,
        verdict="INCONCLUSIVE",
        criteria=[],
        gates=[],
        charts=[],
        reason=(
            "Required signals are absent or all-NULL in the measurement, so no criterion "
            f"could be evaluated: {', '.join(missing)}."
        ),
        notes=["on_missing_signal is 'error' on this test case: a missing signal is reported, never skipped."],
    )


# =============================================================================
#  ACC-SYS-TC-011 | ACC-SYS-TI-011 | ACC-SYS-PRF-001
#  "Time gap not less than 0,8 s in steady-state following control"
#
#  pass_criteria C1 (VehSpd_Kph max <= 100,5 km/h) and C2 (Trgt_Dist_m min >= 22,3333 m),
#  plus preconditions.gates C1 and C2. The two criteria are only meaningful together: the
#  spec's criterion vocabulary has no signal arithmetic, so tau >= 0,8 s is decomposed into
#  a speed ceiling and a clearance floor, and 22,3333 m is 0,8 s at 100,5 km/h. The implied
#  time gap is reported (exit_criteria, step 5) but is NOT the verdict.
# =============================================================================

TC011_SIGNALS = ("ACC_Status", "ACC_TimeGapSet_s", "Trgt_Dist_m", "Trgt_Valid_Flg", "VehSpd_Kph")


def acc_sys_ti_011(frame: Frame) -> CaseOutcome:
    missing = frame.missing(TC011_SIGNALS)
    if missing:
        return _unevaluable("ACC-SYS-TC-011", missing)

    # Window shared by both pass criteria: ACC_Status == 3 (Active-Follow), the first 2,0 s
    # of the segment discarded (settle_s, this spec's operational reading of "steady-state
    # conditions"), segment must then span >= 5,0 s.
    steady = state_mask(frame, allowed=[3], settle_s=2.0, min_duration_s=5.0)
    window_label = "steady-state Active-Follow (ACC_Status = 3, 2,0 s settle, >= 5,0 s span)"

    gates = [
        # preconditions.gates C1 - the 0,8 s setting really was the one selected.
        evaluate(
            frame, "gate:C1", "ACC_TimeGapSet_s", "s", "eq", 0.8, 0.001, "none", 100,
            state_mask(frame, allowed=[3], settle_s=0.5),
            description="selected time-gap setting resolves to 0,8 s",
            window_label="Active-Follow, 0,5 s settle",
        ),
        # preconditions.gates C2 - a valid primary target at every sample.
        evaluate(
            frame, "gate:C2", "Trgt_Valid_Flg", "1", "eq", 1, None, "min", 100, steady,
            description="valid primary target tracked throughout the window",
            window_label=window_label,
        ),
    ]
    criteria = [
        evaluate(
            frame, "C1", "VehSpd_Kph", "km/h", "le", 100.5, 0.01, "max", 1000, steady,
            description="ego speed ceiling the clearance floor is derived at",
            window_label=window_label,
        ),
        evaluate(
            frame, "C2", "Trgt_Dist_m", "m", "ge", 22.3333, 0.05, "min", 250, steady,
            description="minimum clearance = 0,8 s at the 100,5 km/h ceiling",
            window_label=window_label,
        ),
    ]

    speed, clearance = criteria[0], criteria[1]
    tau = (
        clearance.measured / (speed.measured / 3.6)
        if speed.measured and clearance.measured is not None
        else None
    )

    charts = [
        chart_from(
            "tc011-speed", speed,
            title="Ego speed against the 100,5 km/h ceiling",
            caption=(
                f"C1 - maximum VehSpd_Kph over the {window_label} must be "
                f"<= {bound_text(speed.bound)} km/h."
            ),
            y_label="VehSpd_Kph (km/h)",
            series=[series_of("VehSpd_Kph", "VehSpd_Kph", signal_points(frame, "VehSpd_Kph", steady), "km/h")],
            bounds=[ChartBound(label="ceiling 100,5 km/h", value=speed.bound)],
            spans=breach_spans(signal_points(frame, "VehSpd_Kph", steady), speed.effective_bound, "le", "above the ceiling"),
            markers=measured_marker(frame, speed, "max"),
        ),
        chart_from(
            "tc011-clearance", clearance,
            title="Clearance to the primary target against the 22,3333 m floor",
            caption=(
                f"C2 - minimum Trgt_Dist_m over the same window must be "
                f">= {bound_text(clearance.bound)} m, which is 0,8 s at the 100,5 km/h ceiling."
            ),
            y_label="Trgt_Dist_m (m)",
            series=[series_of("Trgt_Dist_m", "Trgt_Dist_m", signal_points(frame, "Trgt_Dist_m", steady), "m")],
            bounds=[ChartBound(label="floor 22,3333 m", value=clearance.bound)],
            spans=breach_spans(signal_points(frame, "Trgt_Dist_m", steady), clearance.effective_bound, "ge", "below the floor"),
            markers=measured_marker(frame, clearance, "min"),
        ),
    ]

    reason = (
        f"max VehSpd_Kph {fmt(speed.measured)} <= {bound_text(speed.bound)} km/h ; "
        f"min Trgt_Dist_m {fmt(clearance.measured)} >= {bound_text(clearance.bound)} m, "
        f"over {speed.n_samples} steady-state Active-Follow samples. "
        f"Implied minimum time gap {fmt(tau, 4)} s."
    )
    return CaseOutcome(
        tc_id="ACC-SYS-TC-011",
        verdict=overall_verdict(criteria, gates),
        criteria=criteria,
        gates=gates,
        charts=charts,
        reason=reason,
        notes=[
            "implied_min_time_gap_s is reported for the record per exit_criteria step 5. The "
            "verdict is C1 AND C2, not this quotient: 0,8 s is not a pass_criteria bound.",
            "ISO 15622:2018 cl. 6.2.3.1 sets the 0,8 s minimum the two bounds are derived from.",
        ],
        derived={
            "implied_min_time_gap_s": round(tau, 4) if tau is not None else "n/a",
            "formula": "min(Trgt_Dist_m) / (max(VehSpd_Kph) / 3.6)",
        },
    )


# =============================================================================
#  ACC-SYS-TC-014 | ACC-SYS-TI-014 | ACC-SYS-PRF-020
#  "Automatic deceleration limited to a 2 s moving average of 3,5 m/s2"
#
#  pass_criteria C1 (2 s trailing moving average of the ACHIEVED acceleration
#  VehAccel_mps2 >= -3,5 m/s2 at every sample), C2 (companion: the post-limiter request
#  BrkReq_mps2 min >= -3,5, which localises where any overshoot lives) and C3 (non-vacuity
#  guard: VehAccel_mps2 min <= -3,0), plus preconditions.gates C1 and C2.
# =============================================================================

TC014_SIGNALS = ("ACC_Status", "BrkReq_mps2", "DrvBrkPedal_Pct", "VehAccel_mps2")


def acc_sys_ti_014(frame: Frame) -> CaseOutcome:
    missing = frame.missing(TC014_SIGNALS)
    if missing:
        return _unevaluable("ACC-SYS-TC-014", missing)

    # C1/C3 window is all_of[state_mask(ACC_Status in {2,3}, settle 0,5 s, min_duration
    # 2,0 s), signal_threshold(DrvBrkPedal_Pct le 0,0)]. Both parts are load-bearing:
    # without them the driver's own braking is charged to the ACC. C2's window is the state
    # mask alone.
    state = state_mask(frame, allowed=[2, 3], settle_s=0.5, min_duration_s=2.0)
    gated = signal_threshold(frame, state, "DrvBrkPedal_Pct", "le", 0.0)
    window_label = "ACC-active (status 2 or 3, 0,5 s settle) with the driver brake released"

    gates = [
        # preconditions.gates C1 - driver never touched the brake, whole run.
        evaluate(
            frame, "gate:C1", "DrvBrkPedal_Pct", "%", "le", 0.0, 0.01, "abs_max", 1,
            full_range(frame),
            description="driver brake pedal released for the entire run",
            window_label="whole run",
        ),
        # preconditions.gates C2 - a contiguous ACC-active segment of >= 20 s.
        evaluate(
            frame, "gate:C2", "ACC_Status", "1", "ge", 2, None, "none", 200,
            state_mask(frame, allowed=[2, 3], settle_s=0.5, min_duration_s=20.0),
            description="contiguous Active-Cruise/Follow segment of >= 20 s",
            window_label="ACC-active, >= 20 s contiguous",
        ),
    ]
    criteria = [
        evaluate(
            frame, "C1", "VehAccel_mps2", "m/s^2", "ge", -3.5, 0.05, "moving_average", 200,
            gated, window_s=2.0,
            description="2 s trailing mean of the ACHIEVED deceleration",
            window_label=window_label,
        ),
        evaluate(
            frame, "C2", "BrkReq_mps2", "m/s^2", "ge", -3.5, 0.0, "min", 200, state,
            description="post-limiter deceleration REQUEST, localises the overshoot",
            window_label="ACC-active (status 2 or 3, 0,5 s settle)",
        ),
        evaluate(
            frame, "C3", "VehAccel_mps2", "m/s^2", "le", -3.0, 0.0, "min", 200, gated,
            description="non-vacuity guard: the run really did brake hard",
            window_label=window_label,
        ),
    ]

    averaged, request, floor = criteria[0], criteria[1], criteria[2]
    mean_points = derived_points(frame, averaged.derived_series)
    raw_points = signal_points(frame, "VehAccel_mps2", gated)
    overshoot = None if averaged.measured is None else abs(averaged.measured - averaged.bound)

    charts = [
        chart_from(
            "tc014-decel", averaged,
            title="Achieved deceleration: 2 s trailing mean against the 3,5 m/s2 limit",
            caption=(
                "C1 - the 2 s trailing mean of VehAccel_mps2 must stay "
                f">= {bound_text(averaged.bound)} m/s2 at every sample of the window. The raw "
                "signal is drawn behind it; the shaded stretch is where the mean is outside "
                "the limit."
            ),
            y_label="VehAccel_mps2 (m/s2)",
            series=[
                series_of(
                    "VehAccel_mps2", "VehAccel_mps2 (raw)", raw_points, "m/s^2",
                    kind="signal", role="context",
                ),
                series_of(
                    "VehAccel_2s_mean", "2 s trailing mean", mean_points, "m/s^2",
                    kind="derived", role="primary",
                ),
            ],
            bounds=[
                ChartBound(label="limit -3,5 m/s2", value=averaged.bound),
                ChartBound(label="with tolerance -3,55", value=averaged.effective_bound, kind="tolerance"),
            ],
            spans=breach_spans(mean_points, averaged.bound, "ge", "mean below -3,5 m/s2"),
            markers=measured_marker(frame, averaged, "worst 2 s mean"),
        ),
        chart_from(
            "tc014-request", request,
            title="Deceleration request after the limiter",
            caption=(
                "C2 - BrkReq_mps2 is the command the limiter emitted. It sits exactly on "
                f"{bound_text(request.bound)} m/s2, so the limiter did its job: the overshoot "
                "in C1 is in the achieved acceleration, not in the request."
            ),
            y_label="BrkReq_mps2 (m/s2)",
            series=[series_of("BrkReq_mps2", "BrkReq_mps2", signal_points(frame, "BrkReq_mps2", state), "m/s^2")],
            bounds=[ChartBound(label="limit -3,5 m/s2", value=request.bound)],
            spans=breach_spans(signal_points(frame, "BrkReq_mps2", state), request.effective_bound, "ge", "below the limit"),
            markers=measured_marker(frame, request, "min"),
        ),
    ]

    reason = (
        f"min 2 s trailing mean VehAccel_mps2 = {fmt(averaged.measured, 4)} m/s2 "
        f"vs bound {bound_text(averaged.bound)} ({fmt(overshoot)} over), "
        f"over {averaged.n_samples} averaged samples. "
        f"The post-limiter request BrkReq_mps2 held at {fmt(request.measured)} m/s2, so the "
        "overshoot is in the achieved deceleration, not in the command."
    )
    return CaseOutcome(
        tc_id="ACC-SYS-TC-014",
        verdict=overall_verdict(criteria, gates),
        criteria=criteria,
        gates=gates,
        charts=charts,
        reason=reason,
        notes=[
            "C1 reads the achieved acceleration, which includes road load and is never clipped "
            "by the limiter chain; C2 reads the command after the limiter. Reading C1 from "
            "AccelReq_mps2 (positive-only) or from BrkReq_mps2 (exact at -3,500) would return a "
            "false PASS - that is what C2 exists to make visible.",
            "instantaneous_min_accel_mps2 is a diagnostic: it shows how much of the averaged "
            "figure is a plateau rather than a spike.",
        ],
        derived={
            "instantaneous_min_accel_mps2": round(floor.measured, 4) if floor.measured is not None else "n/a",
            "gated_segments": len(gated),
            "gated_span_s": round(
                sum(frame.t_s[stop - 1] - frame.t_s[start] for start, stop in gated), 3
            ),
        },
    )


# =============================================================================
#  ACC-SYS-TC-016 | ACC-SYS-TI-016 | ACC-SYS-PRF-041
#  "Set speed constrained to not more than 180 km/h"
#
#  pass_criteria C1 (ACC_SetSpd_Kph max <= 180,0 km/h over the whole run) and C2 (every
#  sample from t = 6 s to t = 60 s equals 180,0 km/h - the driver's 190 km/h request at
#  t = 5 s was clamped, not accepted), plus preconditions.gates C1. The 190 km/h request is
#  a scenario input published on no bus, so C2 asserts its consequence instead.
# =============================================================================

TC016_SIGNALS = ("ACC_SetSpd_Kph", "ACC_Status", "VehSpd_Kph")


def acc_sys_ti_016(frame: Frame) -> CaseOutcome:
    missing = frame.missing(TC016_SIGNALS)
    if missing:
        return _unevaluable("ACC-SYS-TC-016", missing)

    whole = full_range(frame)
    clamped = time_range(frame, 6.0, 60.0)

    gates = [
        # preconditions.gates C1 - Active-Cruise held for a contiguous >= 20 s.
        evaluate(
            frame, "gate:C1", "ACC_Status", "1", "eq", 2, None, "none", 200,
            state_mask(frame, allowed=[2], min_duration_s=20.0),
            description="Active-Cruise held for a contiguous 20 s or more",
            window_label="Active-Cruise, >= 20 s contiguous",
        ),
    ]
    criteria = [
        # C1's window is `full`, so the pre-SET samples where ACC_SetSpd_Kph reads 0 are
        # INCLUDED, exactly as the spec writes it. That cannot change a maximum.
        evaluate(
            frame, "C1", "ACC_SetSpd_Kph", "km/h", "le", 180.0, 0.01, "max", 100, whole,
            description="set speed never exceeds 180 km/h anywhere in the run",
            window_label="whole run",
        ),
        evaluate(
            frame, "C2", "ACC_SetSpd_Kph", "km/h", "eq", 180.0, 0.01, "none", 500, clamped,
            description="every sample from t = 6 s is exactly 180 km/h (clamped)",
            window_label="t = 6,0 s to 60,0 s",
        ),
    ]

    ceiling, clamp = criteria[0], criteria[1]
    set_points = signal_points(frame, "ACC_SetSpd_Kph", whole)
    speed_points = signal_points(frame, "VehSpd_Kph", whole)
    top_speed = max((value for _, value in speed_points), default=None)

    charts = [
        chart_from(
            "tc016-setspeed", ceiling,
            title="Set speed against the 180 km/h ceiling",
            caption=(
                f"C1 - maximum ACC_SetSpd_Kph over the whole run must be "
                f"<= {bound_text(ceiling.bound)} km/h. The step out of 0 is the SET event: it "
                "lands on 180 and never moves again, which is what C2 asserts sample by "
                "sample from t = 6 s. The vehicle speed is drawn for context; no criterion "
                "reads it."
            ),
            y_label="km/h",
            series=[
                series_of("ACC_SetSpd_Kph", "ACC_SetSpd_Kph", set_points, "km/h"),
                series_of("VehSpd_Kph", "VehSpd_Kph", speed_points, "km/h", role="context"),
            ],
            bounds=[ChartBound(label="ceiling 180 km/h", value=ceiling.bound)],
            spans=breach_spans(set_points, ceiling.effective_bound, "le", "above the ceiling"),
            markers=measured_marker(frame, ceiling, "max"),
        ),
    ]

    reason = (
        f"max ACC_SetSpd_Kph {fmt(ceiling.measured)} <= {bound_text(ceiling.bound)} km/h "
        f"over {ceiling.n_samples} samples of the whole run; every one of the "
        f"{clamp.n_samples} samples from t = 6 s to t = 60 s reads "
        f"{fmt(clamp.measured)} km/h, so the 190 km/h request was clamped, not accepted."
    )
    return CaseOutcome(
        tc_id="ACC-SYS-TC-016",
        verdict=overall_verdict(criteria, gates),
        criteria=criteria,
        gates=gates,
        charts=charts,
        reason=reason,
        notes=[
            "max_vehicle_speed_kph is context only - VehSpd_Kph is in the spec's required_signals "
            "but no criterion reads it.",
            "The 180 km/h ceiling is a project decision (controller.speed.v_set_max_kph); "
            "ISO 15622:2018 cl. 4 defines v_set_max but sets no numeric value, so a PASS here is "
            "conformance to the project ceiling and to nothing in the standard.",
        ],
        derived={"max_vehicle_speed_kph": round(top_speed, 3) if top_speed is not None else "n/a"},
    )


EVALUATORS: dict[str, CaseEvaluator] = {
    "ACC-SYS-TC-011": CaseEvaluator(
        tc_id="ACC-SYS-TC-011",
        impl_id="ACC-SYS-TI-011",
        requirement_id="ACC-SYS-PRF-001",
        entrypoint="acc_sys_ti_011:run",
        title="Minimum selectable time gap",
        verification_tag="VERIFIED-PRIMARY",
        window="steady-state Active-Follow, 2,0 s settle, >= 5,0 s span",
        scope="ACC_Status = 3 samples on the 100 Hz grid",
        signals=TC011_SIGNALS,
        partition=LakePartition(
            platform="SKODA_OCTAVIA", device="a0001", route="00011",
            segment="ACC-SYS-TC-011", scenario="follow_steady_timegap/tau08",
        ),
        run=acc_sys_ti_011,
    ),
    "ACC-SYS-TC-014": CaseEvaluator(
        tc_id="ACC-SYS-TC-014",
        impl_id="ACC-SYS-TI-014",
        requirement_id="ACC-SYS-PRF-020",
        entrypoint="acc_sys_ti_014:run",
        title="Automatic deceleration limit",
        verification_tag="UNVERIFIED-2018",
        window="2,0 s trailing moving average",
        scope="2 s windows fully inside the ACC-active, brake-released gate",
        signals=TC014_SIGNALS,
        partition=LakePartition(
            platform="SKODA_OCTAVIA", device="a0001", route="00014",
            segment="ACC-SYS-TC-014", scenario="lead_brake_ccrb_4mps2/v130",
        ),
        run=acc_sys_ti_014,
    ),
    "ACC-SYS-TC-016": CaseEvaluator(
        tc_id="ACC-SYS-TC-016",
        impl_id="ACC-SYS-TI-016",
        requirement_id="ACC-SYS-PRF-041",
        entrypoint="acc_sys_ti_016:run",
        title="Maximum selectable set speed",
        verification_tag="DERIVED",
        window="full run, plus t = 6,0-60,0 s for the clamp check",
        scope="every sample of the run",
        signals=TC016_SIGNALS,
        partition=LakePartition(
            platform="SKODA_OCTAVIA", device="a0001", route="00016",
            segment="ACC-SYS-TC-016", scenario="cruise_set_speed_max/base",
        ),
        run=acc_sys_ti_016,
    ),
}


def evaluator_for(tc_id: str) -> CaseEvaluator | None:
    return EVALUATORS.get(tc_id)
