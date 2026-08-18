"""Test runs: scope expansion, the frozen plan, attachments, readiness, finalisation.

The frozen plan is the load-bearing idea. ``scope.planned_tc_ids`` is written at
creation, before any trace exists, and becomes immutable at submit. It is the
denominator of every outcome metric, and it is the only reason ``not_run`` can be
counted honestly: without a plan recorded ahead of the data, a case that was
never executed is indistinguishable from a case that was never intended.

Evaluation is never performed on arrival (D8). Ingest sinks vectors; a separate
manual or readiness-driven trigger publishes ``evaluation-requests``.
"""

import logging

import artifact_store
import baseline_service
import canonical
import ids
import metrics as metrics_module
import mongo_schema
import paths
from api_models import EvaluationSubmission, TestRunCreate
from settings import EVALUATOR_VERSION, GROUP_TABLES

logger = logging.getLogger(__name__)

DRAFT = "draft"
SUBMITTED = "submitted"
EVALUATING = "evaluating"
EVALUATED = "evaluated"
REPORTED = "reported"


class RunNotFoundError(KeyError):
    pass


class RunStateError(RuntimeError):
    """An operation that the run's current state forbids."""


def expand_scope(scope, bundle: dict) -> tuple[list[str], str]:
    """Resolve a scope selector to a concrete, sorted list of test-case ids.

    ``by_requirement`` expands to the union of covering cases in the baseline.
    Requirements in scope with no covering case are named in the note: they count
    against coverage (spec 6.1) and hiding that would make the metric flatter
    than the truth.
    """
    baseline = bundle["baseline"]
    requirements = bundle["requirements"]
    req_links = baseline.get("req_links") or {}

    if scope.kind == "by_test_case":
        unknown = [tc_id for tc_id in scope.tc_ids if tc_id not in bundle["test_cases"]]
        if unknown:
            raise RunStateError(
                f"test cases {unknown} do not exist in baseline {baseline['baseline_id']}"
            )
        return sorted(set(scope.tc_ids)), "explicit test-case selection"

    selected_reqs: set[str] = set()
    for chapter in scope.chapters:
        selected_reqs.update(
            req_id
            for req_id, requirement in requirements.items()
            if requirement.get("chapter") == chapter
        )
    unknown_reqs = [req_id for req_id in scope.req_ids if req_id not in requirements]
    if unknown_reqs:
        raise RunStateError(
            f"requirements {unknown_reqs} do not exist in baseline {baseline['baseline_id']}"
        )
    selected_reqs.update(scope.req_ids)

    planned: set[str] = set()
    uncovered: list[str] = []
    for req_id in sorted(selected_reqs):
        covering = req_links.get(req_id) or []
        if covering:
            planned.update(covering)
        else:
            uncovered.append(req_id)

    note = (
        f"{len(selected_reqs)} requirement(s) in scope expanded to {len(planned)} test case(s)"
    )
    if uncovered:
        note += f"; no covering test case for {uncovered}"
    return sorted(planned), note


def create_run(db, body: TestRunCreate) -> dict:
    """Create a draft run with its plan already persisted."""
    bundle = baseline_service.load_bundle(body.baseline_id)
    planned, note = expand_scope(body.scope, bundle)

    device_version = db[mongo_schema.DEVICE_VERSIONS].find_one(
        {
            "device_id": body.device_id,
            "sw_version": body.device_sw_version,
            "hw_version": body.device_hw_version,
        }
    )
    if device_version is None:
        raise RunStateError(
            f"device version {body.device_id}/{body.device_sw_version}/"
            f"{body.device_hw_version} is not registered"
        )

    if body.config_id is not None:
        parameter_set = db[mongo_schema.PARAMETER_SETS].find_one(
            {"config_id": body.config_id, "config_version": body.config_version}
        )
        if parameter_set is None:
            raise RunStateError(
                f"parameter set {body.config_id}@v{body.config_version} is not registered"
            )

    existing_today = [
        doc["test_run_id"]
        for doc in db[mongo_schema.TEST_RUNS].find({}, {"test_run_id": 1, "_id": 0})
    ]
    test_run_id = ids.next_test_run_id(existing_today)

    document = {
        "test_run_id": test_run_id,
        "latest_run_version": 1,
        "baseline_id": body.baseline_id,
        "device_id": body.device_id,
        "device_sw_version": body.device_sw_version,
        "device_hw_version": body.device_hw_version,
        "config_id": body.config_id,
        "config_version": body.config_version,
        "scope": {
            "selector": body.scope.model_dump(),
            "planned_tc_ids": planned,
            "expansion_note": note,
            "frozen": False,
        },
        "status": DRAFT,
        "auto_evaluate": body.auto_evaluate,
        "allow_provenance_mismatch": body.allow_provenance_mismatch,
        "version_descriptor": version_descriptor(bundle["baseline"], body),
        "label": body.label,
        "created_by": body.created_by,
        "created_utc": ids.utc_now_iso(),
        "submitted_utc": None,
        "report_ref": None,
        "lessons_learned": "",
    }
    db[mongo_schema.TEST_RUNS].insert_one(dict(document))
    logger.info("Created run %s with %d planned cases", test_run_id, len(planned))
    return document


def version_descriptor(baseline: dict, body: TestRunCreate) -> str:
    """The single string that names every version a run is pinned to."""
    config = (
        f"{body.config_id}@v{body.config_version}" if body.config_id else "config:none"
    )
    return (
        f"{baseline['baseline_id']}"
        f" [req {baseline['requirements_version']}"
        f" / ts {baseline['test_specs_version']}"
        f" / ti {baseline['test_impl_version']}"
        f" / sc {baseline['signal_catalog_version']}]"
        f" {body.device_id} sw{body.device_sw_version}/hw{body.device_hw_version} {config}"
    )


def get_run(db, test_run_id: str) -> dict:
    document = db[mongo_schema.TEST_RUNS].find_one({"test_run_id": test_run_id})
    if document is None:
        raise RunNotFoundError(f"test run {test_run_id} does not exist")
    return document


def submit_run(db, test_run_id: str) -> dict:
    """Freeze the plan. After this, adding cases requires a new run."""
    run = get_run(db, test_run_id)
    if run["status"] != DRAFT:
        raise RunStateError(f"run {test_run_id} is {run['status']}, only a draft can be submitted")
    if not run["scope"]["planned_tc_ids"]:
        raise RunStateError(f"run {test_run_id} has an empty plan; nothing to submit")

    db[mongo_schema.TEST_RUNS].update_one(
        {"test_run_id": test_run_id},
        {
            "$set": {
                "status": SUBMITTED,
                "submitted_utc": ids.utc_now_iso(),
                "scope.frozen": True,
            }
        },
    )
    return get_run(db, test_run_id)


def attach(db, test_run_id: str, tc_ids: list[str], trace_keys: list[str],
           attached_by: str) -> dict:
    """Attach traces to cases, many-to-many, with the page-4 pre-flight check."""
    run = get_run(db, test_run_id)
    run_version = int(run["latest_run_version"])
    bundle = baseline_service.load_bundle(run["baseline_id"])

    planned = set(run["scope"]["planned_tc_ids"])
    not_planned = [tc_id for tc_id in tc_ids if tc_id not in planned]
    if not_planned:
        raise RunStateError(
            f"cases {not_planned} are not in the frozen plan of {test_run_id}; "
            "a different scope needs a new run"
        )

    traces = {
        doc["trace_key"]: doc
        for doc in db[mongo_schema.TRACES].find({"trace_key": {"$in": list(trace_keys)}})
    }
    missing = sorted(set(trace_keys) - set(traces))
    if missing:
        raise RunStateError(f"traces {missing} are not registered")

    preflight = []
    now = ids.utc_now_iso()
    for tc_id in tc_ids:
        test_case = bundle["test_cases"].get(tc_id)
        if test_case is None:
            raise RunStateError(f"{tc_id} is not in baseline {run['baseline_id']}")
        required = set((test_case.get("data_requirements") or {}).get("required_signals") or [])
        for trace_key in trace_keys:
            available = set(traces[trace_key].get("signals") or [])
            shortfall = sorted(required - available)
            db[mongo_schema.RUN_TRACE_LINKS].update_one(
                {
                    "test_run_id": test_run_id,
                    "run_version": run_version,
                    "tc_id": tc_id,
                    "trace_key": trace_key,
                },
                {"$set": {"attached_utc": now, "attached_by": attached_by}},
                upsert=True,
            )
            preflight.append(
                {
                    "tc_id": tc_id,
                    "trace_key": trace_key,
                    "missing_signals": shortfall,
                    "pre_classification": (
                        "not_run / required_signal_absent" if shortfall else "evaluable"
                    ),
                }
            )
    return {
        "test_run_id": test_run_id,
        "run_version": run_version,
        "links": len(tc_ids) * len(trace_keys),
        "preflight": preflight,
    }


def attachments(db, test_run_id: str, run_version: int | None = None) -> dict:
    run = get_run(db, test_run_id)
    version = run_version or int(run["latest_run_version"])
    links = list(
        db[mongo_schema.RUN_TRACE_LINKS].find(
            {"test_run_id": test_run_id, "run_version": version}
        )
    )
    by_case: dict[str, list[str]] = {}
    for link in links:
        by_case.setdefault(link["tc_id"], []).append(link["trace_key"])
    return {
        "test_run_id": test_run_id,
        "run_version": version,
        "by_test_case": {tc_id: sorted(keys) for tc_id, keys in sorted(by_case.items())},
        "links": mongo_schema.serialize_all(links),
    }


def readiness(db, test_run_id: str, run_version: int | None = None) -> dict:
    """Per-trace ``stored -> vectorised -> linked`` and whether the run may evaluate."""
    run = get_run(db, test_run_id)
    version = run_version or int(run["latest_run_version"])
    bundle = baseline_service.load_bundle(run["baseline_id"])
    links = attachments(db, test_run_id, version)["by_test_case"]

    trace_keys = sorted({key for keys in links.values() for key in keys})
    traces = {
        doc["trace_key"]: doc
        for doc in db[mongo_schema.TRACES].find({"trace_key": {"$in": trace_keys}})
    }

    trace_rows = []
    for trace_key in trace_keys:
        trace = traces.get(trace_key, {})
        trace_rows.append(
            {
                "trace_key": trace_key,
                "stored": bool(trace.get("blob_path")),
                "vectorised": trace.get("ingest_status") == "vectorised",
                "ingest_status": trace.get("ingest_status"),
                "linked": True,
                "lake_rows": trace.get("lake_rows") or {},
                "signals": sorted(trace.get("signals") or []),
            }
        )

    per_case = []
    ready = True
    for tc_id in run["scope"]["planned_tc_ids"]:
        test_case = bundle["test_cases"].get(tc_id) or {}
        requirements = test_case.get("data_requirements") or {}
        needed = int(requirements.get("min_traces") or 0)
        trace_required = bool(requirements.get("trace_required"))
        attached = links.get(tc_id) or []
        vectorised = [
            key for key in attached if (traces.get(key) or {}).get("ingest_status") == "vectorised"
        ]
        case_ready = (not trace_required) or len(vectorised) >= max(needed, 1)
        ready = ready and case_ready
        per_case.append(
            {
                "tc_id": tc_id,
                "trace_required": trace_required,
                "min_traces": needed,
                "attached": sorted(attached),
                "vectorised": sorted(vectorised),
                "ready": case_ready,
            }
        )

    return {
        "test_run_id": test_run_id,
        "run_version": version,
        "status": run["status"],
        "auto_evaluate": bool(run.get("auto_evaluate")),
        "ready": ready,
        "traces": trace_rows,
        "per_test_case": per_case,
        "tables": sorted(GROUP_TABLES.values()),
    }


def request_evaluation(db, bus, test_run_id: str, trigger: str, requested_by: str,
                       new_run_version: bool = False) -> dict:
    """Publish an ``evaluation-requests`` message. Never evaluates inline."""
    run = get_run(db, test_run_id)
    if run["status"] == DRAFT:
        raise RunStateError(f"run {test_run_id} must be submitted before it can be evaluated")

    version = int(run["latest_run_version"])
    if new_run_version:
        version += 1
        db[mongo_schema.TEST_RUNS].update_one(
            {"test_run_id": test_run_id}, {"$set": {"latest_run_version": version}}
        )
        # A new evaluation revision starts from the same attachment set.
        for link in db[mongo_schema.RUN_TRACE_LINKS].find(
            {"test_run_id": test_run_id, "run_version": version - 1}
        ):
            db[mongo_schema.RUN_TRACE_LINKS].update_one(
                {
                    "test_run_id": test_run_id,
                    "run_version": version,
                    "tc_id": link["tc_id"],
                    "trace_key": link["trace_key"],
                },
                {"$set": {"attached_utc": link.get("attached_utc"),
                          "attached_by": link.get("attached_by")}},
                upsert=True,
            )

    db[mongo_schema.TEST_RUNS].update_one(
        {"test_run_id": test_run_id}, {"$set": {"status": EVALUATING}}
    )
    message = {
        "test_run_id": test_run_id,
        "run_version": version,
        "trigger": trigger,
        "requested_by": requested_by,
    }
    bus.publish("evaluation_requests", test_run_id, message)
    return message


def finalize_evaluation(db, bus, submission: EvaluationSubmission) -> dict:
    """Take the evaluator's per-case results and produce everything derived.

    Done here rather than in the evaluator so the metric formulas, the
    requirement-verdict precedence and the blob archive exist exactly once.
    """
    run = get_run(db, submission.test_run_id)
    bundle = baseline_service.load_bundle(run["baseline_id"])
    planned = list(run["scope"]["planned_tc_ids"])

    by_tc = {result["tc_id"]: result for result in submission.results}
    results: list[dict] = []
    for tc_id in planned:
        result = dict(
            by_tc.get(tc_id)
            or {
                "tc_id": tc_id,
                "verdict": "not_run",
                "reason_code": "no_evidence_attached",
                "criteria": [],
                "trace_keys": [],
            }
        )
        result["test_run_id"] = submission.test_run_id
        result["run_version"] = submission.run_version
        result["req_ids"] = sorted(
            (bundle["test_cases"].get(tc_id) or {}).get("covers_req_ids") or []
        )
        result["evaluated_utc"] = result.get("evaluated_utc") or ids.utc_now_iso()
        result["evaluator_version"] = submission.evaluator_version or EVALUATOR_VERSION
        result["result_sha256"] = canonical.canonical_sha256(
            {key: value for key, value in result.items() if key != "result_sha256"}
        )
        results.append(result)

    metric_block = metrics_module.compute(
        bundle["baseline"], bundle["requirements"], bundle["test_cases"], planned, results
    )
    verdicts = metrics_module.requirement_verdicts(
        bundle["requirements"], bundle["baseline"].get("req_links") or {}, planned, results
    )

    archive_path = artifact_store.write_evaluation_archive(
        submission.test_run_id, submission.run_version, results
    )

    for result in results:
        bus.publish("test_results", submission.test_run_id, result)
    summary = {
        "test_run_id": submission.test_run_id,
        "run_version": submission.run_version,
        **metric_block,
        "requirement_verdicts": verdicts,
        "queries": list(submission.queries),
        "warnings": list(submission.warnings),
        "evaluated_utc": ids.utc_now_iso(),
        "archive_path": archive_path,
    }
    bus.publish("run_summaries", submission.test_run_id, summary)

    db[mongo_schema.TEST_RUNS].update_one(
        {"test_run_id": submission.test_run_id},
        {"$set": {"status": EVALUATED, "latest_run_version": submission.run_version}},
    )
    logger.info(
        "Finalised %s v%d: %d planned, %d passed, sum_check=%s",
        submission.test_run_id, submission.run_version, len(planned),
        metric_block["tc_passed"], metric_block["sum_check_ok"],
    )
    return {
        "test_run_id": submission.test_run_id,
        "run_version": submission.run_version,
        "metrics": metric_block,
        "requirement_verdicts": verdicts,
        "result_count": len(results),
        "archive_path": archive_path,
        "evaluation_archive": paths.evaluation_archive(
            submission.test_run_id, submission.run_version
        ),
    }


def record_manual_verdict(db, bus, test_run_id: str, verdict) -> dict:
    """A manual verdict for an Inspection/Demonstration case.

    Recorded as ``evidence.kind = "manual"`` with author and timestamp, and
    marked ``manual`` everywhere it appears, so a human decision is never
    mistaken for a measured one.
    """
    run = get_run(db, test_run_id)
    version = verdict.run_version or int(run["latest_run_version"])
    if verdict.tc_id not in run["scope"]["planned_tc_ids"]:
        raise RunStateError(f"{verdict.tc_id} is not in the frozen plan of {test_run_id}")

    document = {
        "test_run_id": test_run_id,
        "run_version": version,
        "tc_id": verdict.tc_id,
        "verdict": verdict.verdict,
        "reason_code": None,
        "criteria": [],
        "trace_keys": [],
        "evidence": {
            "kind": "manual",
            "author": verdict.author,
            "note": verdict.note,
            "evidence_ref": verdict.evidence_ref,
            "recorded_utc": ids.utc_now_iso(),
        },
        "manual": True,
        "evaluated_utc": ids.utc_now_iso(),
        "evaluator_version": "manual",
    }
    document["result_sha256"] = canonical.canonical_sha256(document)
    bus.publish("test_results", test_run_id, document)
    return document
