"""mongo-writer - stream output into the queryable MongoDB mirror.

Nothing consumed stream output into Mongo before this service existed. It uses the
built-in ``MongoDBSink`` (``quixstreams.sinks.community.mongodb``) with a **custom
``document_matcher`` for every collection**, never the default: the default matcher
puts the Kafka key into ``_id``, and since the key here is a run id or a trace key
that would collapse every result of a run into one document.

Five streams, five collections:

| topic | collection | identity |
|---|---|---|
| ``test-results`` | ``results`` | ``(test_run_id, run_version, tc_id)`` |
| ``run-summaries`` | ``run_metrics`` | ``(test_run_id, run_version)`` |
| ``run-summaries`` | ``req_verdicts`` | ``(test_run_id, run_version, req_id)`` |
| ``trace-ingest-completed`` | ``traces`` | ``trace_key`` |
| ``config-events`` | ``parameter_sets`` | ``(config_id, config_version)`` |
| ``report-completed`` | ``test_runs`` | ``test_run_id`` |

Every document written here is **derived and rebuildable**: deleting the database
and replaying these topics (30 d retention) plus the blob evaluation archive
reconstructs it. Blob remains the record of truth for anything that appears in a
report.

Indexes are created by the Backend API (``backend-api/mongo_schema.py``), not here.
One owner for the index definitions means they cannot drift; the matchers above
reproduce the same identities, so an upsert is correct even before the index exists.
"""

from dotenv import load_dotenv

load_dotenv()

import logging  # noqa: E402
import os  # noqa: E402

from quixstreams import Application  # noqa: E402
from quixstreams.sinks.community.mongodb import MongoDBSink  # noqa: E402

import matchers  # noqa: E402
import selectors_map  # noqa: E402

logging.basicConfig(
    level=os.getenv("LOGLEVEL", "INFO"),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def _mongo_host_port() -> tuple[str, int]:
    """``MONGO_HOST`` is ``host:port`` in this project; the sink wants them apart."""
    raw = os.environ["MONGO_HOST"]
    if ":" in raw:
        host, _, port = raw.rpartition(":")
        return host, int(port)
    return raw, 27017


def build_sink(collection: str, document_matcher, value_selector) -> MongoDBSink:
    """One sink per collection.

    ``authSource=admin`` is passed through ``**kwargs`` to ``MongoClient``: the
    sink builds ``mongodb://user:pass@host`` without an auth database, and this
    deployment authenticates against ``admin`` like every other service here.
    """
    host, port = _mongo_host_port()
    return MongoDBSink(
        host=host,
        port=port,
        db=os.environ["MONGO_DB_NAME"],
        collection=collection,
        username=os.environ["MONGO_USER"],
        password=os.environ["MONGO_PASSWORD"],
        document_matcher=document_matcher,
        # "UpdateOne" so a later message only changes the fields it carries: the
        # traces document is written once by the API and then updated by the
        # extractor's completion event, and a replace would erase the upload
        # provenance.
        update_method="UpdateOne",
        upsert=True,
        value_selector=value_selector,
        authSource="admin",
    )


def expand_requirement_verdicts(value: dict) -> list[dict]:
    """The run summary carries the verdicts nested; they need their own documents."""
    verdicts = value.get("requirement_verdicts") or []
    return [
        {
            "test_run_id": value["test_run_id"],
            "run_version": value["run_version"],
            **verdict,
        }
        for verdict in verdicts
    ]


def requirement_verdict_matcher(record) -> dict:
    value = record.value
    return {
        "test_run_id": value["test_run_id"],
        "run_version": value["run_version"],
        "req_id": value["req_id"],
    }


def build_application() -> Application:
    return Application(
        broker_address=os.getenv("KAFKA_BOOTSTRAP_SERVERS") or None,
        consumer_group=_env("CONSUMER_GROUP", "mongo-writer"),
        # A fresh deployment must pick up the backlog; "latest" would silently
        # drop every result already produced.
        auto_offset_reset=_env("AUTO_OFFSET_RESET", "earliest"),
        commit_interval=float(_env("COMMIT_INTERVAL", "10")),
        commit_every=int(_env("BATCH_SIZE", "200")),
    )


def build_pipeline(app: Application) -> None:
    results = app.dataframe(
        topic=app.topic(_env("input_test_results", "test-results"), value_deserializer="json")
    )
    results.sink(build_sink("results", matchers.results, selectors_map.result))

    summaries = app.dataframe(
        topic=app.topic(_env("input_run_summaries", "run-summaries"), value_deserializer="json")
    )
    summaries.sink(build_sink("run_metrics", matchers.run_metrics, selectors_map.run_metrics))
    verdicts = summaries.apply(expand_requirement_verdicts, expand=True)
    verdicts.sink(build_sink("req_verdicts", requirement_verdict_matcher, None))

    completions = app.dataframe(
        topic=app.topic(
            _env("input_trace_completed", "trace-ingest-completed"), value_deserializer="json"
        )
    )
    completions.sink(build_sink("traces", matchers.traces, selectors_map.trace_status))

    configs = app.dataframe(
        topic=app.topic(_env("input_config_events", "config-events"), value_deserializer="json")
    )
    configs.sink(
        build_sink("parameter_sets", matchers.parameter_sets, selectors_map.parameter_set)
    )

    reports = app.dataframe(
        topic=app.topic(_env("input_report_completed", "report-completed"),
                        value_deserializer="json")
    )
    reports.sink(build_sink("test_runs", matchers.report_refs, selectors_map.report_ref))


if __name__ == "__main__":
    application = build_application()
    build_pipeline(application)
    logger.info("Starting mongo-writer against %s", os.environ.get("MONGO_HOST"))
    application.run()
