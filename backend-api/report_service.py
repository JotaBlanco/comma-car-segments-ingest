"""Report generation: ``report.json`` + ``report.html`` + ``plots/*.svg``.

Reproducible from stored data alone (spec 7.3). The generator reads only:

* Mongo ``results`` / ``run_metrics`` - or, if Mongo were lost, the frozen
  ``evaluations/<run>/v<n>/results.json`` archive in blob;
* the baseline artifacts resolved through the run's ``baseline_id``;
* the ``traces`` registry entries and the parameter set as stored.

It reads no live state, no wall clock except ``generated_utc``, and no
environment-dependent default. The decimated series previews are stored inside
the result documents by the evaluator, so a report can be regenerated years later
without the lake still being queryable - while the exact queries used are printed
so the full data remains addressable.

Generation runs in-process rather than in a separate ``report-generator``
deployment: it needs the blob seam and the baseline resolver, both of which exist
exactly once, in this service. See ``dev-planning/test-manager-backend-architecture.md``.
"""

import logging
import os

import artifact_store
import baseline_service
import blob_storage
import canonical
import ids
import metrics as metrics_module
import mongo_schema
import paths
import report_html
import schema_registry
import svg_plot
from artifact_store import ArtifactFile
from settings import GROUP_TABLES, REPORT_GENERATOR_VERSION
from validation import Problem, UploadRejected

logger = logging.getLogger(__name__)

RESIDUAL_RISKS_BLOB = "test-manager/residual-risks.json"


def _frontend_base() -> str:
    return os.environ.get("TM_FRONTEND_BASE_URL", "").strip()


def load_results(db, test_run_id: str, run_version: int) -> list[dict]:
    """Mongo first, the frozen blob archive as the recovery path."""
    documents = list(
        db[mongo_schema.RESULTS].find(
            {"test_run_id": test_run_id, "run_version": run_version}
        )
    )
    if documents:
        return sorted(mongo_schema.serialize_all(documents), key=lambda doc: doc["tc_id"])
    archive = canonical.loads(
        blob_storage.read_bytes(
            paths.evaluation_archive(test_run_id, run_version)
        )
    )
    return sorted(archive.get("results") or [], key=lambda doc: doc["tc_id"])


def inputs_digest(
    run: dict,
    baseline: dict,
    parameter_set: dict | None,
    traces: list[dict],
    results: list[dict],
    evaluator_version: str,
) -> str:
    """SHA-256 over the canonical JSON of every input that can change a verdict."""
    payload = {
        "baseline_id": baseline["baseline_id"],
        "requirements_version": baseline["requirements_version"],
        "test_specs_version": baseline["test_specs_version"],
        "test_impl_version": baseline["test_impl_version"],
        "signal_catalog_version": baseline["signal_catalog_version"],
        "set_hashes": baseline.get("set_hashes") or {},
        "device": [run["device_id"], run["device_sw_version"], run["device_hw_version"]],
        "config": [
            run.get("config_id"),
            run.get("config_version"),
            (parameter_set or {}).get("canonical_sha256"),
        ],
        "planned_tc_ids": sorted(run["scope"]["planned_tc_ids"]),
        "trace_triples": sorted(
            [tc_id, trace_key, content_sha256]
            for tc_id, trace_key, content_sha256 in _trace_triples(traces, results)
        ),
        "result_pairs": sorted(
            [result["tc_id"], result.get("result_sha256")] for result in results
        ),
        "evaluator_version": evaluator_version,
        "report_generator_version": REPORT_GENERATOR_VERSION,
    }
    return canonical.canonical_sha256(payload)


def _trace_triples(traces: list[dict], results: list[dict]):
    by_key = {trace["trace_key"]: trace for trace in traces}
    for result in results:
        for trace_key in result.get("trace_keys") or []:
            trace = by_key.get(trace_key) or {}
            yield result["tc_id"], trace_key, trace.get("content_sha256")


def _residual_risks(db, baseline: dict, requirements: dict) -> list[dict]:
    """Uncovered requirements plus any declared by-design gaps.

    The plant spec's ``NOT CHECKABLE by design`` topics are meant to be
    reproduced verbatim so a reader cannot mistake them for gaps to be closed by
    more testing. That spec does not live in this repo, so the quotes are read
    from an operator-maintained blob document; when it is absent the report says
    so rather than silently omitting the section.
    """
    risks: list[dict] = []
    for finding in (baseline.get("integrity") or {}).get("findings") or []:
        if finding.get("code") == "uncovered_requirement":
            entity = finding.get("entity_id") or ""
            requirement = requirements.get(entity) or {}
            risks.append(
                {
                    "kind": "uncovered_requirement",
                    "entity_id": entity,
                    "message": (
                        f"{entity} ({requirement.get('title', '')}) is covered by no test case "
                        f"in {baseline['baseline_id']}"
                    ),
                    "source": f"baseline {baseline['baseline_id']} integrity finding",
                }
            )
    for record in db[mongo_schema.REQ_COVERAGE].find(
        {"baseline_id": baseline["baseline_id"], "trace_coverable": False}
    ):
        risks.append(
            {
                "kind": "not_trace_coverable",
                "entity_id": record["req_id"],
                "message": (
                    f"{record['req_id']} has verification_method "
                    f"{record.get('verification_method')!r}; it is excluded from the testable "
                    "coverage denominator and can only be closed by a manual verdict"
                ),
                "source": "spec 2.4 method compatibility matrix",
            }
        )
    try:
        declared = canonical.loads(blob_storage.read_bytes(RESIDUAL_RISKS_BLOB))
    except (OSError, ValueError, blob_storage.BlobUnavailableError):
        declared = None
    if declared is not None:
        for entry in declared.get("items") or []:
            risks.append(
                {
                    "kind": "by_design_gap",
                    "entity_id": entry.get("topic", ""),
                    "message": entry.get("quote", ""),
                    "source": entry.get("source", RESIDUAL_RISKS_BLOB),
                }
            )
    else:
        risks.append(
            {
                "kind": "by_design_gap",
                "entity_id": "",
                "message": (
                    "No by-design gap declaration was found at "
                    f"{RESIDUAL_RISKS_BLOB}; the plant spec's 'NOT CHECKABLE by design' topics "
                    "are therefore not reproduced in this revision."
                ),
                "source": RESIDUAL_RISKS_BLOB,
            }
        )
    return risks


def _plots_and_previews(results: list[dict]) -> tuple[dict[str, str], list[dict], list[str]]:
    plots: dict[str, str] = {}
    previews: list[dict] = []
    names: list[str] = []
    for result in results:
        for criterion in result.get("criteria") or []:
            preview = criterion.get("series_preview") or {}
            t_values = list(preview.get("t_s") or [])
            y_values = list(preview.get("values") or [])
            filename = f"{result['tc_id']}-{criterion.get('criterion_id')}-{criterion.get('signal')}.svg"
            plots[filename] = svg_plot.criterion_plot(
                title=(
                    f"{result['tc_id']} {criterion.get('criterion_id')} "
                    f"{criterion.get('signal')} ({criterion.get('reduce_op')})"
                ),
                signal=str(criterion.get("signal")),
                unit=str(criterion.get("unit") or ""),
                t_values=t_values,
                y_values=y_values,
                bound=_as_float(criterion.get("bound")),
                bound2=_as_float(criterion.get("bound2")),
                tolerance_abs=_as_float((criterion.get("tolerance") or {}).get("abs")),
                window_spans=[
                    (float(start), float(end))
                    for start, end in (criterion.get("window_spans") or [])
                ],
            )
            names.append(filename)
            previews.append(
                {
                    "tc_id": result["tc_id"],
                    "criterion_id": criterion.get("criterion_id"),
                    "signal": criterion.get("signal"),
                    "point_count": len(t_values),
                    "decimation_factor": preview.get("decimation_factor", 1),
                    "t_s_first": t_values[0] if t_values else None,
                    "t_s_last": t_values[-1] if t_values else None,
                    "plot": filename,
                    "series": {"t_s": t_values, "values": y_values},
                }
            )
    return plots, previews, sorted(names)


def _as_float(value):
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def generate(db, bus, test_run_id: str, run_version: int | None = None,
             requested_by: str = "", lessons_learned: str | None = None) -> dict:
    """Render and store one report revision. Never overwrites an earlier one."""
    run = db[mongo_schema.TEST_RUNS].find_one({"test_run_id": test_run_id})
    if run is None:
        raise KeyError(f"test run {test_run_id} does not exist")
    version = run_version or int(run["latest_run_version"])
    if lessons_learned is not None:
        db[mongo_schema.TEST_RUNS].update_one(
            {"test_run_id": test_run_id}, {"$set": {"lessons_learned": lessons_learned}}
        )
        run["lessons_learned"] = lessons_learned

    bundle = baseline_service.load_bundle(run["baseline_id"])
    baseline = bundle["baseline"]
    results = load_results(db, test_run_id, version)
    planned = list(run["scope"]["planned_tc_ids"])

    stored_metrics = db[mongo_schema.RUN_METRICS].find_one(
        {"test_run_id": test_run_id, "run_version": version}
    )
    if stored_metrics is not None:
        metric_block = mongo_schema.serialize(stored_metrics)
        verdicts = metric_block.pop("requirement_verdicts", None) or _verdicts_from_mongo(
            db, test_run_id, version
        )
        queries = metric_block.pop("queries", []) or []
    else:
        # Mongo lags the evaluation by one sink hop; recompute from the same
        # inputs rather than reporting a hole.
        metric_block = metrics_module.compute(
            baseline, bundle["requirements"], bundle["test_cases"], planned, results
        )
        verdicts = metrics_module.requirement_verdicts(
            bundle["requirements"], baseline.get("req_links") or {}, planned, results
        )
        queries = []

    trace_keys = sorted({key for result in results for key in result.get("trace_keys") or []})
    traces = list(db[mongo_schema.TRACES].find({"trace_key": {"$in": trace_keys}}))
    parameter_set = None
    if run.get("config_id"):
        parameter_set = db[mongo_schema.PARAMETER_SETS].find_one(
            {"config_id": run["config_id"], "config_version": run.get("config_version")}
        )

    plots, previews, plot_names = _plots_and_previews(results)
    evaluator_version = metric_block.get("evaluator_version") or "unknown"
    digest = inputs_digest(run, baseline, parameter_set, traces, results, evaluator_version)

    existing = artifact_store.list_report_revisions(test_run_id, version)
    previous_digest = None
    previous_body = None
    if existing:
        previous = canonical.loads(
            artifact_store.read_report_file(test_run_id, version, existing[-1], "report.json")
        )
        previous_digest = previous.get("inputs_digest")
        previous_body = {k: v for k, v in previous.items() if k != "generated_utc"}
    revision = ids.next_report_revision(existing)

    report = {
        "schema_version": "1.0.0",
        "test_run_id": test_run_id,
        "run_version": version,
        "revision": revision,
        "generated_utc": ids.utc_now_iso(),
        "report_generator_version": REPORT_GENERATOR_VERSION,
        "evaluator_version": evaluator_version,
        "inputs_digest": digest,
        "inputs_digest_prev": previous_digest,
        "reproducible": bool(previous_digest) and previous_digest == digest,
        "diff_summary": [],
        "header": {
            "device_id": run["device_id"],
            "sw_version": run["device_sw_version"],
            "hw_version": run["device_hw_version"],
            "baseline_id": baseline["baseline_id"],
            "config_id": run.get("config_id"),
            "config_version": run.get("config_version"),
            "config_hash12": (parameter_set or {}).get("config_hash12"),
            "version_descriptor": run.get("version_descriptor"),
            "provenance_override": bool(run.get("allow_provenance_mismatch")),
        },
        "baseline": {
            "baseline_id": baseline["baseline_id"],
            "requirements_version": baseline["requirements_version"],
            "test_specs_version": baseline["test_specs_version"],
            "test_impl_version": baseline["test_impl_version"],
            "signal_catalog_version": baseline["signal_catalog_version"],
            "set_hashes": baseline.get("set_hashes"),
        },
        "scope": {
            "selector": run["scope"].get("selector") or {},
            "planned_tc_ids": planned,
            "expansion_note": run["scope"].get("expansion_note"),
        },
        "metrics": metric_block,
        "results": [_report_result(result) for result in results],
        "requirement_verdicts": [_report_verdict(entry) for entry in verdicts],
        "deviations": [
            {
                "tc_id": result["tc_id"],
                "verdict": result.get("verdict"),
                "reason_code": result.get("reason_code"),
                "note": (result.get("evidence") or {}).get("note"),
            }
            for result in results
            if result.get("verdict") == "not_run"
        ],
        "blockers": [
            {
                "tc_id": result["tc_id"],
                "reason_code": result.get("reason_code"),
                "message": (result.get("evidence") or {}).get("message", ""),
            }
            for result in results
            if result.get("verdict") == "error"
        ],
        "residual_risks": _residual_risks(db, baseline, bundle["requirements"]),
        "deliverables": {
            "traces": [
                {
                    "trace_key": trace["trace_key"],
                    "blob_path": trace.get("blob_path"),
                    "content_sha256": trace.get("content_sha256"),
                    "mf4": trace.get("mf4") or {},
                }
                for trace in sorted(traces, key=lambda doc: doc["trace_key"])
            ],
            "lake_tables": sorted(GROUP_TABLES.values()),
            "queries": list(queries),
            "plots": plot_names,
        },
        "data_preview": previews,
        "parameter_set": mongo_schema.serialize(parameter_set),
        "lessons_learned": run.get("lessons_learned") or "",
    }

    if previous_body is not None:
        current_body = {k: v for k, v in report.items() if k != "generated_utc"}
        current_body["revision"] = previous_body.get("revision")
        current_body["inputs_digest_prev"] = previous_body.get("inputs_digest_prev")
        current_body["reproducible"] = previous_body.get("reproducible")
        if report["reproducible"] and canonical.canonical_bytes(
            current_body
        ) != canonical.canonical_bytes(previous_body):
            report["reproducible"] = False
            report["diff_summary"] = [
                (
                    "inputs_digest is unchanged but the rendered report body differs; "
                    "the generator is not deterministic for this run and this is a defect"
                )
            ]
        elif not report["reproducible"]:
            report["diff_summary"] = _diff_summary(previous_body, report)

    problems = [
        Problem(
            code="schema_violation",
            message=error.message,
            entity_id=f"{test_run_id}/v{version}/{revision}",
            pointer=schema_registry.pointer(error),
        )
        for error in schema_registry.iter_errors("report-1.0.0", report)
    ]
    if problems:
        raise UploadRejected(stage="report_schema", problems=problems)

    files = [ArtifactFile(f"plots/{name}", markup.encode("utf-8"))
             for name, markup in sorted(plots.items())]
    files.append(
        ArtifactFile(
            "report.html",
            report_html.render(report, plots, _frontend_base()).encode("utf-8"),
        )
    )
    files.append(ArtifactFile("report.json", canonical.stored_bytes(report)))
    folder = artifact_store.write_report(test_run_id, version, revision, files)

    report_ref = {
        "test_run_id": test_run_id,
        "run_version": version,
        "revision": revision,
        "folder": folder,
        "report_json": paths.report_file(test_run_id, version, revision, "report.json"),
        "report_html": paths.report_file(test_run_id, version, revision, "report.html"),
        "inputs_digest": digest,
        "reproducible": report["reproducible"],
        "generated_utc": report["generated_utc"],
        "requested_by": requested_by,
    }
    db[mongo_schema.TEST_RUNS].update_one(
        {"test_run_id": test_run_id},
        {"$set": {"report_ref": report_ref, "status": "reported"}},
    )
    bus.publish("report_completed", test_run_id, report_ref)
    logger.info("Wrote report %s v%d %s to %s", test_run_id, version, revision, folder)
    return report_ref


def _verdicts_from_mongo(db, test_run_id: str, run_version: int) -> list[dict]:
    documents = db[mongo_schema.REQ_VERDICTS].find(
        {"test_run_id": test_run_id, "run_version": run_version}
    )
    return sorted(mongo_schema.serialize_all(documents), key=lambda doc: doc["req_id"])


def _report_result(result: dict) -> dict:
    """Project a stored result onto the report schema's closed result shape."""
    return {
        "tc_id": result["tc_id"],
        "verdict": result.get("verdict", "not_run"),
        "reason_code": result.get("reason_code"),
        "req_ids": sorted(result.get("req_ids") or []),
        "trace_keys": sorted(result.get("trace_keys") or []),
        "criteria": result.get("criteria") or [],
        "alignment": result.get("alignment"),
        "uncertainty": result.get("uncertainty"),
        "evidence": result.get("evidence"),
        "result_sha256": result.get("result_sha256"),
    }


def _report_verdict(entry: dict) -> dict:
    return {
        "req_id": entry["req_id"],
        "verdict": entry["verdict"],
        "covering_tc_ids": sorted(entry.get("covering_tc_ids") or []),
        "passed_tc_ids": sorted(entry.get("passed_tc_ids") or []),
        "failed_tc_ids": sorted(entry.get("failed_tc_ids") or []),
        "not_run_tc_ids": sorted(entry.get("not_run_tc_ids") or []),
    }


def _diff_summary(previous: dict, current: dict) -> list[str]:
    """Which inputs changed since the last revision, in report-friendly prose."""
    notes = []
    if previous.get("scope", {}).get("planned_tc_ids") != current["scope"]["planned_tc_ids"]:
        notes.append("the planned test-case set changed")
    if previous.get("evaluator_version") != current["evaluator_version"]:
        notes.append(
            f"evaluator version changed from {previous.get('evaluator_version')} "
            f"to {current['evaluator_version']}"
        )
    previous_traces = {
        entry.get("trace_key") for entry in (previous.get("deliverables") or {}).get("traces") or []
    }
    current_traces = {
        entry.get("trace_key") for entry in current["deliverables"]["traces"]
    }
    if previous_traces != current_traces:
        notes.append(
            f"attached traces changed (added {sorted(current_traces - previous_traces)}, "
            f"removed {sorted(previous_traces - current_traces)})"
        )
    previous_results = {
        entry.get("tc_id"): entry.get("result_sha256")
        for entry in previous.get("results") or []
    }
    changed = sorted(
        entry["tc_id"]
        for entry in current["results"]
        if previous_results.get(entry["tc_id"]) != entry.get("result_sha256")
    )
    if changed:
        notes.append(f"re-evaluated cases {changed}")
    return notes or ["inputs digest differs; no field-level cause identified"]
