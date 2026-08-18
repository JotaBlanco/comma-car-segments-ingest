"""mf4-extractor - one MF4 object in, test-vector rows out.

Reads the metadata message produced by ``POST /uploads/traces`` (the file bytes
never enter Kafka), opens the object from blob, and emits one row dict per sample
per channel group to the four vector topics. A completion event follows with the
row counts, signal list, ``t_s`` span and ``epoch_source``.

Two things about the shape of this pipeline are deliberate:

* ``commit_every = 1``. One input message expands to roughly 6 400 output messages
  (about 1.3 MB); with a larger checkpoint the framework would hold several traces'
  expansions in memory at once, which is the standard OOM in expand-then-produce
  topologies.
* idempotency uses native QuixStreams ``State`` keyed by ``trace_key``, which is
  also the Kafka message key - so the store is in-context and no external
  deduplication store is needed. A redelivered message is skipped, not re-expanded.
"""

from dotenv import load_dotenv

load_dotenv()

import io  # noqa: E402
import json  # noqa: E402
import logging  # noqa: E402
import os  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

from quixstreams import Application  # noqa: E402

import blob_seam  # noqa: E402
import mf4_reader  # noqa: E402
import rows as rows_module  # noqa: E402

logging.basicConfig(
    level=os.getenv("LOGLEVEL", "INFO"),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

EXTRACTOR_VERSION = "tm-mf4-extractor/1.0.0"

GROUP_TOPIC_VARS = {
    "PT_CAN_100Hz": ("output_pt_can", "test-vectors-pt-can-100hz"),
    "RADAR_OBJ_50Hz": ("output_radar_obj", "test-vectors-radar-obj-50hz"),
    "ACC_HMI_10Hz": ("output_hmi", "test-vectors-hmi-10hz"),
    "SIM_REF_100Hz": ("output_sim_ref", "test-vectors-sim-ref-100hz"),
}
GROUP_TABLES = {
    "PT_CAN_100Hz": "acc_pt_can_100hz",
    "RADAR_OBJ_50Hz": "acc_radar_obj_50hz",
    "ACC_HMI_10Hz": "acc_hmi_10hz",
    "SIM_REF_100Hz": "acc_sim_ref_100hz",
}


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def needs_extraction(value: dict, state) -> bool:
    """State is keyed by ``trace_key`` because that is the message key."""
    if state.get("extracted"):
        logger.info("Skipping %s: already extracted", value.get("trace_key"))
        return False
    return True


def extract_payload(value: dict) -> dict:
    """Open the object, read the metadata, build the rows and the meta document."""
    trace_key = value["trace_key"]
    blob_path = value["blob_path"]
    meta_path = value.get("meta_path")
    started = _utc_now()

    try:
        raw = blob_seam.read_bytes(blob_path)
    except blob_seam.BlobUnavailableError as exc:
        logger.error("Cannot read %s: %s", blob_path, exc)
        return _failure(value, "failed", f"blob unavailable: {exc}", started, meta_path)

    try:
        mdf = mf4_reader.open_mdf(io.BytesIO(raw))
    except mf4_reader.UnreadableMf4 as exc:
        return _failure(value, "failed", str(exc), started, meta_path)

    try:
        mf4_reader.assert_not_raw_can(mdf)
    except mf4_reader.RawCanRejected as exc:
        return _failure(value, "unsupported_raw_can", str(exc), started, meta_path)

    properties = mf4_reader.parse_common_properties(
        getattr(getattr(mdf, "header", None), "comment", None)
    )
    header_epoch = mf4_reader.header_epoch_ms(mdf)
    if header_epoch and header_epoch > 0:
        trace_epoch_ms, epoch_source = header_epoch, "mf4_header"
    else:
        trace_epoch_ms, epoch_source = _upload_epoch_ms(value), "upload_time"

    context = {
        "trace_key": trace_key,
        "device_id": value.get("device_id"),
        "scenario": properties.get("scenario_name"),
        "variant_id": properties.get("variant_id"),
        "config_hash12": properties.get("config_hash12"),
        "mf4_run_id": properties.get("run_id"),
        "trace_epoch_ms": trace_epoch_ms,
        "ingest_utc": started,
        "extractor_version": EXTRACTOR_VERSION,
    }

    row_dicts, group_summaries, warnings = rows_module.extract_all(mdf, context)
    # Read everything off the MDF before closing it.
    version_text = mf4_reader.mdf_version(mdf)
    attachments = mf4_reader.attachment_names(mdf)
    try:
        mdf.close()
    except Exception as exc:  # noqa: BLE001 - closing must not fail the message
        warnings.append(f"closing the MDF raised {exc}")

    rows_per_table: dict[str, int] = {}
    for row in row_dicts:
        table = GROUP_TABLES[row["channel_group"]]
        rows_per_table[table] = rows_per_table.get(table, 0) + 1

    signals = sorted({name for summary in group_summaries for name in summary["signals"]})
    status = "vectorised" if row_dicts else "failed"
    if not row_dicts:
        warnings.append("no rows were produced; nothing will reach the lake")

    meta_update = {
        "mdf_version": version_text,
        "is_raw_can": False,
        "trace_epoch_ms": trace_epoch_ms,
        "epoch_source": epoch_source,
        "mf4": {
            **{key: properties.get(key) for key in mf4_reader.METADATA_KEYS},
            "channel_groups": [summary["name"] for summary in group_summaries],
        },
        "attachments": attachments,
        "groups": group_summaries,
        "signals": signals,
        "extraction": {
            "extractor_version": EXTRACTOR_VERSION,
            "extracted_utc": _utc_now(),
            "rows_per_table": rows_per_table,
            "warnings": warnings,
        },
        "ingest_status": status,
    }

    completion = {
        "trace_key": trace_key,
        "device_id": value.get("device_id"),
        "ingest_status": status,
        "lake_rows": rows_per_table,
        "signals": signals,
        "groups": group_summaries,
        "mf4": meta_update["mf4"],
        "attachments": meta_update["attachments"],
        "trace_epoch_ms": trace_epoch_ms,
        "epoch_source": epoch_source,
        "extraction": meta_update["extraction"],
        "t_s_span": [
            min((s["t_s_first"] for s in group_summaries if s["t_s_first"] is not None),
                default=None),
            max((s["t_s_last"] for s in group_summaries if s["t_s_last"] is not None),
                default=None),
        ],
    }
    return {
        "trace_key": trace_key,
        "meta_path": meta_path,
        "meta_update": meta_update,
        "completion": completion,
        "rows": row_dicts,
    }


def _upload_epoch_ms(value: dict) -> int:
    uploaded = value.get("uploaded_utc")
    if uploaded:
        try:
            parsed = datetime.fromisoformat(str(uploaded).replace("Z", "+00:00"))
            return int(parsed.timestamp() * 1000)
        except ValueError:
            logger.warning("uploaded_utc %r is not ISO-8601; using now()", uploaded)
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _failure(value: dict, status: str, message: str, started: str, meta_path) -> dict:
    """A rejected or unreadable trace still produces a completion event.

    Silence would leave the run's readiness panel waiting forever; an explicit
    ``failed`` / ``unsupported_raw_can`` status is what lets the case become
    ``not_run`` with a reason instead.
    """
    logger.error("Extraction of %s ended as %s: %s", value.get("trace_key"), status, message)
    return {
        "trace_key": value["trace_key"],
        "meta_path": meta_path,
        "meta_update": {
            "ingest_status": status,
            "is_raw_can": status == "unsupported_raw_can",
            "extraction": {
                "extractor_version": EXTRACTOR_VERSION,
                "extracted_utc": _utc_now(),
                "rows_per_table": {},
                "warnings": [message],
            },
        },
        "completion": {
            "trace_key": value["trace_key"],
            "device_id": value.get("device_id"),
            "ingest_status": status,
            "lake_rows": {},
            "signals": [],
            "groups": [],
            "message": message,
            "started_utc": started,
            "extraction": {
                "extractor_version": EXTRACTOR_VERSION,
                "extracted_utc": _utc_now(),
                "rows_per_table": {},
                "warnings": [message],
            },
        },
        "rows": [],
    }


def finalise(value: dict, state) -> dict:
    """Merge the extraction report into ``trace.meta.json``, then mark the state.

    The meta document beside the object is the blob record of truth for a trace;
    the Mongo ``traces`` entry is the queryable mirror, updated by ``mongo-writer``
    from the completion event.
    """
    meta_path = value.get("meta_path")
    if meta_path:
        try:
            current = json.loads(blob_seam.read_bytes(meta_path).decode("utf-8"))
        except (blob_seam.BlobUnavailableError, OSError, ValueError) as exc:
            logger.warning("Could not read %s: %s", meta_path, exc)
            current = {}
        merged = {**current, **value["meta_update"]}
        try:
            blob_seam.write_bytes(
                meta_path,
                (json.dumps(merged, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode(
                    "utf-8"
                ),
            )
        except (blob_seam.BlobUnavailableError, OSError) as exc:
            logger.warning("Could not update %s: %s", meta_path, exc)

    state.set("extracted", True)
    state.set("ingest_status", value["meta_update"].get("ingest_status"))
    return value["completion"]


def build_application() -> Application:
    return Application(
        broker_address=os.getenv("KAFKA_BOOTSTRAP_SERVERS") or None,
        consumer_group=_env("CONSUMER_GROUP", "mf4-extractor"),
        auto_offset_reset=_env("AUTO_OFFSET_RESET", "earliest"),
        commit_interval=float(_env("COMMIT_INTERVAL", "5")),
        # One trace's expansion per checkpoint. See the module docstring.
        commit_every=int(_env("COMMIT_EVERY", "1")),
        state_dir=_env("Quix__State__Dir", "state"),
    )


def build_pipeline(app: Application) -> None:
    requests_topic = app.topic(_env("input", "trace-ingest-requests"), value_deserializer="json")
    completed_topic = app.topic(
        _env("output_completed", "trace-ingest-completed"),
        value_serializer="json",
        key_serializer="string",
    )
    vector_topics = {
        group: app.topic(_env(var, default), value_serializer="json", key_serializer="string")
        for group, (var, default) in GROUP_TOPIC_VARS.items()
    }

    sdf = app.dataframe(topic=requests_topic)
    sdf = sdf.filter(needs_extraction, stateful=True)
    sdf = sdf.apply(extract_payload)

    # Row branches first, completion last: readiness should never see a trace
    # reported complete before its rows were produced.
    row_stream = sdf.apply(lambda value: value["rows"], expand=True)
    for group, topic in vector_topics.items():
        row_stream.filter(_group_filter(group)).to_topic(
            topic, key=lambda row: row["trace_key"]
        )

    completion = sdf.apply(finalise, stateful=True)
    completion.to_topic(completed_topic, key=lambda value: value["trace_key"])


def _group_filter(group: str):
    def matches(row: dict) -> bool:
        return row.get("channel_group") == group

    return matches


if __name__ == "__main__":
    application = build_application()
    build_pipeline(application)
    logger.info("Starting mf4-extractor %s", EXTRACTOR_VERSION)
    application.run()
