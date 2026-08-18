"""Per-test-case evaluation: preconditions, criteria, verdict, reason code.

Order of decisions, which is normative because it determines the reason code a
reader sees:

1. **Provenance.** The trace's embedded ``config_hash12`` is compared with the
   run's pinned parameter set. A mismatch is ``inconclusive /
   provenance_mismatch`` unless the run carries the explicit human override
   ``allow_provenance_mismatch``, which is recorded and printed in the report
   header.
2. **Preconditions.** ``preconditions.gates`` are evaluated first. An unmet gate
   yields ``inconclusive / precondition_gate_unmet`` - never ``fail``. Evidence
   that was not admissible is not evidence of a defect.
3. **Criteria.** Each is reduced and judged, then combined with
   ``pass_criteria_logic`` (``all`` / ``any``).

Multiple traces per case: each trace is evaluated independently and the case takes
the **worst** verdict across them (``error`` > ``fail`` > ``inconclusive`` >
``pass``). The spec fixes ``min_traces`` but does not state the combination rule;
worst-case is the only choice consistent with "no fudge factors", because a
requirement that holds in one trace and fails in another has failed.

``SIM_REF_100Hz`` signals (catalogue ``role: reference``) are refused here as well
as at baseline creation: a real vehicle log has no ground truth, so no verdict may
depend on one.
"""

import logging

import numpy as np

import alignment
import lake_client
import reduce_ops
import rules
import windows

logger = logging.getLogger(__name__)

VERDICT_SEVERITY = {"pass": 0, "inconclusive": 1, "fail": 2, "error": 3}
PREVIEW_MAX_POINTS = 2000


class SignalUnavailable(Exception):
    """A criterion references a signal the trace or the catalogue cannot supply."""

    def __init__(self, signal: str, message: str) -> None:
        self.signal = signal
        super().__init__(message)


def _criterion_signals(criterion: dict) -> list[str]:
    """Every signal one criterion touches, primary first."""
    found = [criterion["signal"]]
    found.extend(windows.signals_referenced(criterion.get("window") or {}))
    found.extend(reduce_ops.signals_referenced(criterion.get("reduce") or {}))
    return list(dict.fromkeys(found))


def case_signals(test_case: dict) -> list[str]:
    found: list[str] = []
    for criterion in test_case.get("pass_criteria") or []:
        found.extend(_criterion_signals(criterion))
    for gate in (test_case.get("preconditions") or {}).get("gates") or []:
        found.extend(_criterion_signals(gate))
    return list(dict.fromkeys(found))


def _catalogue_entry(catalog: dict, signal: str) -> dict:
    entry = catalog.get(signal)
    if entry is None:
        raise SignalUnavailable(
            signal, f"{signal!r} is not in the pinned signal catalogue"
        )
    if entry.get("role") == "reference":
        raise SignalUnavailable(
            signal,
            f"{signal!r} has catalogue role 'reference' (group {entry.get('channel_group')}); "
            "a verdict may never depend on simulator ground truth",
        )
    return entry


def load_groups(
    test_case: dict,
    catalog: dict,
    trace: dict,
    group_tables: dict,
) -> tuple[dict, list[str], list[str], list[str]]:
    """One lake query per needed channel group. Returns groups, queries, missing, errors."""
    wanted: dict[str, set[str]] = {}
    missing: list[str] = []
    errors: list[str] = []
    for signal in case_signals(test_case):
        try:
            entry = _catalogue_entry(catalog, signal)
        except SignalUnavailable as exc:
            errors.append(str(exc))
            continue
        wanted.setdefault(entry["channel_group"], set()).add(signal)

    loaded: dict[str, dict] = {}
    queries: list[str] = []
    for group, signals in sorted(wanted.items()):
        table = group_tables.get(group)
        if table is None:
            errors.append(f"channel group {group!r} has no lake table")
            continue
        data, sql = lake_client.load_group(
            table=table,
            columns=sorted(signals),
            device_id=trace["device_id"],
            scenario=trace.get("scenario"),
            trace_key=trace["trace_key"],
        )
        queries.append(sql)
        loaded[group] = data
        if data["row_count"] == 0:
            missing.extend(sorted(signals))
        else:
            missing.extend(sorted(signals - set(data["signals"])))
    return loaded, queries, sorted(set(missing)), errors


def build_frame(criterion: dict, catalog: dict, loaded: dict) -> alignment.AlignedFrame:
    """Align every signal a criterion needs onto the primary signal's grid."""
    primary = criterion["signal"]
    base_group = _catalogue_entry(catalog, primary)["channel_group"]
    base = loaded.get(base_group)
    if base is None or base["row_count"] == 0:
        raise SignalUnavailable(
            primary, f"channel group {base_group} has no rows for this trace"
        )
    frame = alignment.AlignedFrame(base_group, base["t_s"])
    for signal in _criterion_signals(criterion):
        entry = _catalogue_entry(catalog, signal)
        group = entry["channel_group"]
        source = loaded.get(group)
        if source is None or signal not in source["signals"]:
            raise SignalUnavailable(
                signal, f"{signal!r} is absent from the {group} rows of this trace"
            )
        if group == base_group:
            frame.add_native(signal, source["signals"][signal])
        else:
            frame.add_from(signal, group, source["t_s"], source["signals"][signal])
    return frame


def _series_preview(criterion: dict, frame, reduction, mask) -> dict:
    """A decimated series stored in the result so the report needs no lake access.

    Reports have to be reproducible from stored data alone; keeping <= 2 000 points
    per criterion beside the verdict makes that true even years later, while the
    exact query stays printed so the full data remains addressable.
    """
    if reduction.kind == "series" and reduction.t is not None:
        t_values = np.asarray(reduction.t, dtype=float)
        y_values = np.asarray(reduction.values, dtype=float)
    else:
        t_values = frame.t[mask]
        y_values = frame.get(criterion["signal"])[mask]
    count = int(min(t_values.size, y_values.size))
    if count == 0:
        return {"t_s": [], "values": [], "decimation_factor": 1, "point_count": 0}
    factor = max(1, (count + PREVIEW_MAX_POINTS - 1) // PREVIEW_MAX_POINTS)
    t_slice = t_values[:count:factor]
    y_slice = y_values[:count:factor]
    return {
        "t_s": [round(float(value), 6) for value in t_slice],
        "values": [None if not np.isfinite(v) else round(float(v), 6) for v in y_slice],
        "decimation_factor": factor,
        "point_count": int(t_slice.size),
    }


def evaluate_criterion(criterion: dict, catalog: dict, loaded: dict, trace: dict) -> dict:
    """Reduce, judge, and attach everything the report needs to show the working."""
    on_missing = criterion.get("on_missing_signal") or "error"
    try:
        frame = build_frame(criterion, catalog, loaded)
    except SignalUnavailable as exc:
        return {
            "criterion_id": criterion.get("criterion_id"),
            "signal": criterion.get("signal"),
            "unit": criterion.get("unit"),
            "trace_key": trace["trace_key"],
            "verdict": {"error": "error", "not_run": "not_run", "skip": "skip"}[on_missing],
            "reason_code": "required_signal_absent",
            "actual": None,
            "note": str(exc),
            "on_missing_signal": on_missing,
        }

    try:
        mask = windows.resolve(criterion.get("window") or {}, frame)
        reduction = reduce_ops.apply(criterion.get("reduce") or {}, frame, criterion["signal"],
                                     mask)
        block = rules.evaluate(criterion, reduction)
    except (windows.WindowError, reduce_ops.ReduceError, rules.RuleError, KeyError) as exc:
        return {
            "criterion_id": criterion.get("criterion_id"),
            "signal": criterion.get("signal"),
            "unit": criterion.get("unit"),
            "trace_key": trace["trace_key"],
            "verdict": "error",
            "reason_code": "schema_violation",
            "actual": None,
            "note": f"{type(exc).__name__}: {exc}",
        }

    block["trace_key"] = trace["trace_key"]
    block["alignment"] = frame.as_dict()
    block["uncertainty_s"] = frame.uncertainty_s()
    block["window_spans"] = [[float(a), float(b)] for a, b in windows.spans(mask, frame.t)]
    block["window_sample_count"] = int(np.count_nonzero(mask))
    block["series_preview"] = _series_preview(criterion, frame, reduction, mask)
    return block


def _combine(verdicts: list[str], logic: str) -> str:
    """Combine criterion verdicts with ``pass_criteria_logic``.

    ``error`` and ``inconclusive`` dominate regardless of the logic: an evaluator
    that could not decide must not be reported as a product verdict.
    """
    if not verdicts:
        return "not_run"
    if "error" in verdicts:
        return "error"
    if "inconclusive" in verdicts:
        return "inconclusive"
    if logic == "any":
        return "pass" if "pass" in verdicts else "fail"
    return "pass" if all(verdict == "pass" for verdict in verdicts) else "fail"


def _reason_for(verdict: str, blocks: list[dict]) -> str | None:
    if verdict == "pass":
        return None
    for block in blocks:
        if block.get("verdict") == verdict and block.get("reason_code"):
            return block["reason_code"]
    return {"fail": "criterion_violated", "error": "evaluator_exception",
            "inconclusive": "window_never_satisfied", "not_run": "no_evidence_attached"}.get(
        verdict
    )


def evaluate_trace(
    test_case: dict,
    catalog: dict,
    trace: dict,
    group_tables: dict,
) -> dict:
    """Evaluate one case against one trace."""
    loaded, queries, missing, errors = load_groups(test_case, catalog, trace, group_tables)
    if errors:
        return {
            "trace_key": trace["trace_key"],
            "verdict": "error",
            "reason_code": "schema_violation",
            "criteria": [],
            "queries": queries,
            "note": "; ".join(errors),
        }

    gate_blocks = [
        evaluate_criterion(gate, catalog, loaded, trace)
        for gate in (test_case.get("preconditions") or {}).get("gates") or []
    ]
    unmet = [block for block in gate_blocks if block.get("verdict") != "pass"]
    if unmet:
        return {
            "trace_key": trace["trace_key"],
            "verdict": "inconclusive",
            "reason_code": "precondition_gate_unmet",
            "criteria": gate_blocks,
            "queries": queries,
            "missing_signals": missing,
            "note": (
                f"{len(unmet)} precondition gate(s) were not met; the trace is not admissible "
                "evidence for this case, which is inconclusive rather than a failure"
            ),
        }

    blocks = [
        evaluate_criterion(criterion, catalog, loaded, trace)
        for criterion in test_case.get("pass_criteria") or []
    ]
    # A "skip" on a missing signal removes the criterion from the combination
    # instead of deciding the case.
    considered = [block for block in blocks if block.get("verdict") != "skip"]
    verdict = _combine([block["verdict"] for block in considered],
                       test_case.get("pass_criteria_logic") or "all")
    return {
        "trace_key": trace["trace_key"],
        "verdict": verdict,
        "reason_code": _reason_for(verdict, considered),
        "criteria": blocks,
        "gates": gate_blocks,
        "queries": queries,
        "missing_signals": missing,
    }


def evaluate(
    test_case: dict,
    catalog: dict,
    traces: list[dict],
    group_tables: dict,
    expected_config_hash12: str | None,
    allow_provenance_mismatch: bool,
) -> dict:
    """Evaluate one case against every attached trace and combine, worst-case."""
    tc_id = test_case["tc_id"]
    requirements = test_case.get("data_requirements") or {}
    min_traces = int(requirements.get("min_traces") or 0)
    trace_required = bool(requirements.get("trace_required"))

    if trace_required and not traces:
        return _not_run(tc_id, "no_evidence_attached",
                        "no trace is attached to this case in this run")

    if not trace_required and not traces:
        # Deferred by explicit decision: this phase ships MF4-upload + evaluate
        # only, so a case that needs no trace has no runner to produce evidence.
        return _not_run(
            tc_id, "manual_verdict_pending",
            "the case declares trace_required: false; the unit-test runner is deferred out of "
            "this phase, so this verdict has to be entered manually",
        )

    usable: list[dict] = []
    per_trace: list[dict] = []
    queries: list[str] = []

    for trace in traces:
        if trace.get("ingest_status") != "vectorised":
            per_trace.append(
                {
                    "trace_key": trace["trace_key"],
                    "verdict": "not_run",
                    "reason_code": "trace_not_vectorised",
                    "criteria": [],
                    "note": f"ingest_status is {trace.get('ingest_status')!r}",
                }
            )
            continue
        actual_hash = trace.get("config_hash12")
        if expected_config_hash12 and actual_hash and actual_hash != expected_config_hash12:
            if allow_provenance_mismatch:
                logger.warning(
                    "%s: provenance override in effect for %s (%s != %s)",
                    tc_id, trace["trace_key"], actual_hash, expected_config_hash12,
                )
            else:
                per_trace.append(
                    {
                        "trace_key": trace["trace_key"],
                        "verdict": "inconclusive",
                        "reason_code": "provenance_mismatch",
                        "criteria": [],
                        "note": (
                            f"the trace embeds config_hash12 {actual_hash} but the run pins "
                            f"{expected_config_hash12}; set allow_provenance_mismatch on the run "
                            "to accept it explicitly"
                        ),
                    }
                )
                continue
        try:
            outcome = evaluate_trace(test_case, catalog, trace, group_tables)
        except (lake_client.LakeQueryError, lake_client.LakeUnavailableError) as exc:
            outcome = {
                "trace_key": trace["trace_key"],
                "verdict": "error",
                "reason_code": "lake_query_failed",
                "criteria": [],
                "note": str(exc),
            }
        queries.extend(outcome.pop("queries", []) or [])
        per_trace.append(outcome)
        if outcome["verdict"] in ("pass", "fail"):
            usable.append(outcome)

    if trace_required and min_traces and len(usable) < min_traces:
        verdict = "not_run" if not usable else "inconclusive"
        reason = "no_evidence_attached" if not usable else "insufficient_samples"
        return {
            "tc_id": tc_id,
            "verdict": verdict,
            "reason_code": reason,
            "criteria": [
                block for outcome in per_trace for block in outcome.get("criteria") or []
            ],
            "trace_keys": [outcome["trace_key"] for outcome in per_trace],
            "per_trace": [
                {key: value for key, value in outcome.items()
                 if key not in ("criteria", "gates")}
                for outcome in per_trace
            ],
            "queries": queries,
            "note": f"{len(usable)} evaluable trace(s), min_traces is {min_traces}",
        }

    worst = max(
        (outcome["verdict"] for outcome in per_trace),
        key=lambda verdict: VERDICT_SEVERITY.get(verdict, 1),
        default="not_run",
    )
    criteria = [block for outcome in per_trace for block in outcome.get("criteria") or []]
    # The per-trace summary keeps the verdict and the reason but drops its own copy
    # of the criteria: they are already flattened into "criteria" above, and each
    # one carries a decimated series preview. Duplicating those would double the
    # result document for no reader.
    per_trace_summary = [
        {key: value for key, value in outcome.items() if key not in ("criteria", "gates")}
        for outcome in per_trace
    ]
    alignment_blocks = [
        block["alignment"] for block in criteria if isinstance(block.get("alignment"), dict)
    ]
    uncertainties = [
        block.get("uncertainty_s") for block in criteria if block.get("uncertainty_s") is not None
    ]
    return {
        "tc_id": tc_id,
        "verdict": worst,
        "reason_code": _reason_for(worst, per_trace),
        "criteria": criteria,
        "trace_keys": [outcome["trace_key"] for outcome in per_trace],
        "per_trace": per_trace_summary,
        "queries": queries,
        "alignment": alignment_blocks[0] if alignment_blocks else None,
        "uncertainty": {
            "max_uncertainty_s": max(uncertainties) if uncertainties else None,
            "note": "half the coarsest contributing raster period; reported, never subtracted",
        },
        "evidence": {"kind": "trace", "trace_count": len(per_trace)},
    }


def _not_run(tc_id: str, reason_code: str, note: str) -> dict:
    return {
        "tc_id": tc_id,
        "verdict": "not_run",
        "reason_code": reason_code,
        "criteria": [],
        "trace_keys": [],
        "per_trace": [],
        "queries": [],
        "note": note,
        "evidence": {"kind": "none"},
    }
