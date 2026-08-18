"""tm-evaluator - the criteria engine plus the readiness trigger.

One ``Application``, two dataframes:

* ``evaluation-requests`` -> evaluate every planned case of the run and hand the
  per-case results back to the API, which owns the metric formulas, the
  requirement-verdict precedence, the blob archive and the outgoing
  ``test-results`` / ``run-summaries`` messages;
* ``trace-ingest-completed`` -> ``group_by("test_run_id")`` + ``State`` to fire a
  readiness-driven evaluation request at most once per run and ``run_version``.

Why two workers in one deployment rather than the two the spec's deployment matrix
names: both need the same ``backend_client`` and neither is CPU-bound (a whole run
is roughly 6 400 rows per trace), while every extra Quix application means another
copy of the shared modules, because each application is built from its own folder.

This service never evaluates on arrival. It evaluates when a request message tells
it to (D8).
"""

from dotenv import load_dotenv

load_dotenv()

import logging  # noqa: E402
import os  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

from quixstreams import Application  # noqa: E402

import backend_client  # noqa: E402
import evaluate_case  # noqa: E402
import lake_client  # noqa: E402
import readiness  # noqa: E402

logging.basicConfig(
    level=os.getenv("LOGLEVEL", "INFO"),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

EVALUATOR_VERSION = "tm-evaluator/1.0.0"


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def evaluate_run(value: dict) -> dict:
    """Evaluate one run: fetch its input by key, judge every planned case, submit."""
    test_run_id = value["test_run_id"]
    run_version = int(value.get("run_version") or 1)
    logger.info(
        "Evaluating %s v%d (trigger %s)", test_run_id, run_version, value.get("trigger")
    )

    warnings: list[str] = []
    reason = lake_client.unavailable_reason()
    if reason:
        warnings.append(reason)

    try:
        payload = backend_client.evaluation_input(test_run_id, run_version)
    except backend_client.BackendError as exc:
        logger.error("Cannot load evaluation input for %s: %s", test_run_id, exc)
        return {"test_run_id": test_run_id, "run_version": run_version, "error": str(exc)}

    catalog = payload.get("signal_catalog") or {}
    group_tables = payload.get("group_tables") or {}
    traces_by_case = payload.get("traces_by_case") or {}
    test_cases = payload.get("test_cases") or {}
    expected_hash = payload.get("expected_config_hash12")
    allow_mismatch = bool(payload.get("allow_provenance_mismatch"))

    results = []
    queries: list[str] = []
    for tc_id in payload.get("planned_tc_ids") or []:
        test_case = test_cases.get(tc_id)
        if test_case is None:
            # The plan was frozen against this baseline, so this cannot happen
            # unless the baseline was tampered with. Report it, do not guess.
            results.append(
                {
                    "tc_id": tc_id,
                    "verdict": "error",
                    "reason_code": "schema_violation",
                    "criteria": [],
                    "trace_keys": [],
                    "note": f"{tc_id} is not in baseline {payload.get('baseline_id')}",
                }
            )
            continue
        try:
            outcome = evaluate_case.evaluate(
                test_case=test_case,
                catalog=catalog,
                traces=traces_by_case.get(tc_id) or [],
                group_tables=group_tables,
                expected_config_hash12=expected_hash,
                allow_provenance_mismatch=allow_mismatch,
            )
        except Exception as exc:  # noqa: BLE001 - one bad case must not stop the run
            logger.exception("Evaluation of %s raised", tc_id)
            outcome = {
                "tc_id": tc_id,
                "verdict": "error",
                "reason_code": "evaluator_exception",
                "criteria": [],
                "trace_keys": [],
                "note": f"{type(exc).__name__}: {exc}",
            }
        queries.extend(outcome.pop("queries", []) or [])
        outcome["evaluated_utc"] = _utc_now()
        outcome["evaluator_version"] = EVALUATOR_VERSION
        results.append(outcome)

    submission = {
        "test_run_id": test_run_id,
        "run_version": run_version,
        "evaluator_version": EVALUATOR_VERSION,
        "results": results,
        "queries": sorted(set(queries)),
        "warnings": warnings,
    }
    try:
        summary = backend_client.submit_results(submission)
    except backend_client.BackendError as exc:
        logger.error("Could not submit results for %s: %s", test_run_id, exc)
        return {"test_run_id": test_run_id, "run_version": run_version, "error": str(exc)}

    metrics = summary.get("metrics") or {}
    logger.info(
        "%s v%d: %d planned, passed=%s failed=%s not_run=%s error=%s inconclusive=%s "
        "sum_check=%s coverage_testable=%s",
        test_run_id, run_version, len(results),
        metrics.get("tc_passed"), metrics.get("tc_failed"), metrics.get("tc_not_run"),
        metrics.get("tc_error"), metrics.get("tc_inconclusive"), metrics.get("sum_check_ok"),
        metrics.get("requirement_coverage_testable"),
    )
    return {
        "test_run_id": test_run_id,
        "run_version": run_version,
        "result_count": len(results),
        "metrics": metrics,
        "queries": submission["queries"],
        "warnings": warnings,
    }


def build_application() -> Application:
    return Application(
        broker_address=os.getenv("KAFKA_BOOTSTRAP_SERVERS") or None,
        consumer_group=_env("CONSUMER_GROUP", "tm-evaluator"),
        auto_offset_reset=_env("AUTO_OFFSET_RESET", "earliest"),
        commit_interval=float(_env("COMMIT_INTERVAL", "5")),
        commit_every=int(_env("COMMIT_EVERY", "1")),
        state_dir=_env("Quix__State__Dir", "state"),
    )


def build_pipeline(app: Application) -> None:
    requests_topic = app.topic(
        _env("input_evaluation_requests", "evaluation-requests"), value_deserializer="json"
    )
    completed_topic = app.topic(
        _env("input_trace_completed", "trace-ingest-completed"), value_deserializer="json"
    )

    evaluations = app.dataframe(topic=requests_topic)
    evaluations = evaluations.apply(evaluate_run)
    evaluations.print(metadata=False)

    completions = app.dataframe(topic=completed_topic)
    completions = completions.filter(lambda value: value.get("ingest_status") == "vectorised")
    completions = completions.apply(readiness.expand_completions, expand=True)
    completions = completions.group_by("test_run_id")
    completions = completions.apply(readiness.maybe_request, stateful=True)
    completions.print(metadata=False)


if __name__ == "__main__":
    application = build_application()
    build_pipeline(application)
    logger.info(
        "Starting %s (backend %s, lakehouse %s)",
        EVALUATOR_VERSION,
        backend_client.base_url(),
        "available" if lake_client.is_available() else lake_client.unavailable_reason(),
    )
    application.run()
