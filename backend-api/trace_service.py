"""MF4 ingest: raw object to blob, one metadata message to Kafka (spec 4.2, 4.3).

The file bytes never enter Kafka. An MF4 is megabytes; the idiomatic pairing is a
raw object in blob plus a small metadata message on a topic, which is also what
keeps the trace reusable across runs without re-uploading it.

The trace key is content-addressed, so re-uploading identical bytes is idempotent
and cannot duplicate lake rows - the property that matters most here, because
uploads arrive from several places at different times. It is also what makes the
publish step recoverable: see ``publish_state`` below.

**Two writes and a publish, and what happens when the publish fails.** Steps 4-6
of spec 4.2 commit a blob object, a blob metadata document and a Mongo registry
row, and only then produce the extraction request. A broker outage at step 6 used
to surface as a bare 500 while all three writes had already committed, so the
caller could not tell whether the upload had landed and the only way to find out
was to upload again. The registry row therefore carries an explicit

    publish_state = pending | published | failed

and a failed publish answers ``503 event_bus_unavailable`` naming the trace key
and exactly what was persisted. Re-uploading the identical file reconciles: the
content-addressed key finds the existing row and re-publishes rather than
duplicating anything. ``ingest_status`` is deliberately *not* used to carry this -
its value set is fixed by spec 0.6 and consumed downstream, and overloading it
would make an un-published trace look like a failed extraction.

Evaluation is not triggered by this path. Ever (D8).
"""

import hashlib
import logging

import artifact_store
import error_envelope
import ids
import mongo_schema
import paths
import topics
from settings import EXTRACTOR_VERSION
from validation import Problem, UploadRejected

logger = logging.getLogger(__name__)

MDF_MAGIC = b"MDF     "
RAW_CAN_MARKERS = (b"CAN_DataFrame", b"CAN_ErrorFrame", b"CAN_RemoteFrame")

PUBLISH_PENDING = "pending"
PUBLISH_DONE = "published"
PUBLISH_FAILED = "failed"


class TraceConflictError(Exception):
    """A trace key collision with different content (spec 4.3)."""


class TraceNotPublishedError(Exception):
    """The trace is stored and registered; the extraction request was not published.

    Carries what committed and what did not, because the whole point is that the
    caller can tell the difference. ``error_handlers`` renders it as a 503.
    """

    def __init__(self, trace_key: str, created: bool, document: dict, reason: str) -> None:
        self.trace_key = trace_key
        self.created = created
        self.blob_path = document.get("blob_path")
        self.meta_path = document.get("meta_path")
        self.reason = reason
        super().__init__(reason)

    def as_dict(self) -> dict:
        return error_envelope.envelope(
            503,
            (
                f"trace {self.trace_key} is stored and registered, but the extraction "
                f"request could not be published: {self.reason}"
            ),
            error="event_bus_unavailable",
            trace_key=self.trace_key,
            created=self.created,
            published=False,
            persisted={
                "blob_object": self.blob_path,
                "blob_meta": self.meta_path,
                "mongo_traces_row": True,
                "publish_state": PUBLISH_FAILED,
                "lake_rows": False,
            },
            hint=(
                "nothing is lost and nothing is duplicated by retrying: the trace key is "
                "content-addressed, so re-uploading the identical file finds this row and "
                "re-publishes the extraction request. Un-published traces are listable with "
                "GET /traces?publish_state=failed."
            ),
        )


def sniff_mf4(path: str) -> dict:
    """Reject non-MDF4 and raw-CAN **before** storing anything.

    The raw-CAN test is a byte scan for the qualified channel names the
    bus-logging writer emits (``CAN_DataFrame.ID`` and friends), which keeps
    ``asammdf`` out of the API image. It is a cheap pre-filter, not the
    authoritative check: the extractor re-tests with ``asammdf`` and looks at
    ``FLAG_CG_BUS_EVENT`` on the channel groups, and rejects with
    ``ingest_status = "unsupported_raw_can"`` if this scan let one through.
    """
    with open(path, "rb") as handle:
        head = handle.read(64)
        if head[:8] != MDF_MAGIC:
            raise UploadRejected(
                stage="media_type",
                problems=[
                    Problem(
                        code="not_mdf4",
                        message=(
                            "file does not start with the MDF identification block; "
                            "this endpoint accepts ASAM MDF4 only"
                        ),
                    )
                ],
            )
        version_text = head[8:16].decode("ascii", errors="replace").strip()
        if not version_text.startswith("4"):
            raise UploadRejected(
                stage="media_type",
                problems=[
                    Problem(
                        code="unsupported_mdf_version",
                        message=f"MDF version {version_text!r} is not MDF4",
                    )
                ],
            )
        handle.seek(0)
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            for marker in RAW_CAN_MARKERS:
                if marker in chunk:
                    raise UploadRejected(
                        stage="media_type",
                        problems=[
                            Problem(
                                code="unsupported_raw_can",
                                message=(
                                    f"the file carries {marker.decode()} channels, i.e. raw CAN "
                                    "frames. This system ingests decoded-signal MF4 only: "
                                    "pass_criteria name channels such as VehAccel_mps2, so raw "
                                    "frames would need a per-device DBC registry, a decode stage "
                                    "and a name-mapping layer. Extension point declared in "
                                    "spec 0.6 (dbc_id on device_versions + a decode stage in the "
                                    "extractor); not implemented."
                                ),
                            )
                        ],
                    )
    return {"mdf_version": version_text, "is_raw_can": False}


def hash_file(path: str) -> tuple[str, int]:
    """Content hash and size, computed in one pass over a staged file."""
    digest = hashlib.sha256()
    size = 0
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def ingest_trace(
    db,
    bus,
    staged_path: str,
    filename: str,
    device_id: str,
    sw_version: str,
    hw_version: str,
    uploaded_by: str,
    test_run_id: str | None = None,
    tc_ids: list[str] | None = None,
) -> dict:
    """The full spec-4.2 sequence, in order, with idempotent re-upload."""
    sniffed = sniff_mf4(staged_path)
    content_sha256, size_bytes = hash_file(staged_path)
    trace_key = ids.mint_trace_key(device_id, content_sha256)

    existing = db[mongo_schema.TRACES].find_one({"trace_key": trace_key})
    if existing is not None:
        if existing.get("content_sha256") != content_sha256:
            raise TraceConflictError(
                f"trace_key {trace_key} already exists with a different content hash "
                f"({existing.get('content_sha256')} != {content_sha256})"
            )
        if test_run_id and tc_ids:
            _link(db, test_run_id, tc_ids, trace_key, uploaded_by)
        if existing.get("publish_state") != PUBLISH_DONE:
            # Reconciliation, and the reason the retry story works: the previous
            # upload's writes committed but its extraction request never reached
            # the broker. Re-publishing is safe because the extractor keys its
            # State on trace_key and drops a request it has already handled, so a
            # duplicate request is a no-op rather than duplicated lake rows.
            # Rows without publish_state are pre-reconciliation records and are
            # treated as un-published for the same reason.
            logger.info("Re-upload of %s reconciles an un-published trace", trace_key)
            _publish_ingest_request(db, bus, existing, created=False)
        else:
            logger.info("Idempotent re-upload of %s", trace_key)
        return {
            "trace_key": trace_key,
            "created": False,
            "published": True,
            "trace": mongo_schema.serialize(existing),
        }

    device_version = db[mongo_schema.DEVICE_VERSIONS].find_one(
        {"device_id": device_id, "sw_version": sw_version, "hw_version": hw_version}
    )
    if device_version is None:
        raise UploadRejected(
            stage="cross_field",
            problems=[
                Problem(
                    code="unknown_device_version",
                    message=(
                        f"device version {device_id}/{sw_version}/{hw_version} is not "
                        f"registered, and trace upload requires it: device_versions is the "
                        f"registry of record for the (device_id, sw_version, hw_version) "
                        f"triple that every verdict's provenance is quoted against, so a "
                        f"trace cannot be admitted for a triple nobody declared. Register "
                        f'it first: POST /devices {{"device_id": "{device_id}", ...}} (skip '
                        f"if the device already exists), then POST /devices/{device_id}"
                        f'/versions {{"sw_version": "{sw_version}", "hw_version": '
                        f'"{hw_version}"}}, then re-upload this file.'
                    ),
                    entity_id=device_id,
                )
            ],
        )

    uploaded_utc = ids.utc_now_iso()
    blob_path = artifact_store.write_trace_object(device_id, trace_key, staged_path)

    meta = {
        "schema_version": "1.0.0",
        "trace_key": trace_key,
        "device_id": device_id,
        "sw_version": sw_version,
        "hw_version": hw_version,
        "blob_path": blob_path,
        "content_sha256": content_sha256,
        "size_bytes": size_bytes,
        "uploaded_utc": uploaded_utc,
        "uploaded_by": uploaded_by or "unknown",
        "mdf_version": sniffed["mdf_version"],
        "is_raw_can": False,
        # The extractor resolves the real epoch from the HD start_time and
        # overwrites both fields; the upload time is the declared fallback.
        "trace_epoch_ms": 0,
        "epoch_source": "upload_time",
        "mf4": {},
        "attachments": [],
        "groups": [],
        "signals": [],
        "extraction": None,
        "ingest_status": "stored",
        "ingest_log": [f"{uploaded_utc} stored by {uploaded_by or 'unknown'} as {filename}"],
    }
    artifact_store.write_trace_meta(device_id, trace_key, meta)

    document = dict(meta)
    document["meta_path"] = paths.trace_meta(device_id, trace_key)
    document["lake_rows"] = {}
    # Written before the publish is attempted, so a broker failure leaves a row
    # that says so instead of an invisible object in blob.
    document["publish_state"] = PUBLISH_PENDING
    document["publish_attempts"] = 0
    document["publish_error"] = None
    db[mongo_schema.TRACES].insert_one(dict(document))

    _publish_ingest_request(db, bus, document, created=True)

    if test_run_id and tc_ids:
        _link(db, test_run_id, tc_ids, trace_key, uploaded_by)

    logger.info("Stored %s (%d bytes) and requested extraction", trace_key, size_bytes)
    return {
        "trace_key": trace_key,
        "created": True,
        "published": True,
        "trace": mongo_schema.serialize(document),
    }


def _ingest_request(document: dict) -> dict:
    """The one metadata message of spec 4.2 step 6, built from the registry row.

    Built from named keys rather than by copying the document, so a field added to
    the registry row can never leak onto the topic by accident.
    """
    device_id = document["device_id"]
    trace_key = document["trace_key"]
    return {
        "trace_key": trace_key,
        "device_id": device_id,
        "sw_version": document.get("sw_version", ""),
        "hw_version": document.get("hw_version", ""),
        "blob_path": document.get("blob_path") or paths.trace_object(device_id, trace_key),
        "meta_path": document.get("meta_path") or paths.trace_meta(device_id, trace_key),
        "content_sha256": document["content_sha256"],
        "size_bytes": document["size_bytes"],
        "uploaded_utc": document["uploaded_utc"],
        "expected_extractor_version": EXTRACTOR_VERSION,
    }


def _publish_ingest_request(db, bus, document: dict, created: bool) -> None:
    """Publish the extraction request and record the outcome on the registry row.

    Raises :class:`TraceNotPublishedError` on failure, having first marked the row
    ``publish_state = "failed"`` with the reason. ``document`` is updated in place
    so the caller's response body cannot claim a state the database contradicts.
    """
    trace_key = document["trace_key"]
    attempted_utc = ids.utc_now_iso()
    try:
        bus.publish("trace_ingest_requests", trace_key, _ingest_request(document))
    except topics.EventBusUnavailableError as exc:
        document["publish_state"] = PUBLISH_FAILED
        document["publish_error"] = str(exc)
        db[mongo_schema.TRACES].update_one(
            {"trace_key": trace_key},
            {
                "$set": {
                    "publish_state": PUBLISH_FAILED,
                    "publish_error": str(exc),
                    "publish_attempted_utc": attempted_utc,
                },
                "$inc": {"publish_attempts": 1},
            },
        )
        logger.error("Trace %s is stored but not published: %s", trace_key, exc)
        raise TraceNotPublishedError(trace_key, created, document, str(exc)) from exc

    document["publish_state"] = PUBLISH_DONE
    document["publish_error"] = None
    db[mongo_schema.TRACES].update_one(
        {"trace_key": trace_key},
        {
            "$set": {
                "publish_state": PUBLISH_DONE,
                "publish_error": None,
                "published_utc": attempted_utc,
            },
            "$inc": {"publish_attempts": 1},
        },
    )


def _link(db, test_run_id: str, tc_ids: list[str], trace_key: str, attached_by: str) -> None:
    """Attachment at upload time is optional; ingest does not require a run."""
    run = db[mongo_schema.TEST_RUNS].find_one({"test_run_id": test_run_id})
    if run is None:
        raise UploadRejected(
            stage="cross_field",
            problems=[
                Problem(
                    code="unknown_test_run",
                    message=f"test run {test_run_id} does not exist",
                    entity_id=test_run_id,
                )
            ],
        )
    run_version = int(run["latest_run_version"])
    now = ids.utc_now_iso()
    for tc_id in tc_ids:
        db[mongo_schema.RUN_TRACE_LINKS].update_one(
            {
                "test_run_id": test_run_id,
                "run_version": run_version,
                "tc_id": tc_id,
                "trace_key": trace_key,
            },
            {"$set": {"attached_utc": now, "attached_by": attached_by or "unknown"}},
            upsert=True,
        )


def trace_neighbourhood(db, trace_key: str) -> dict:
    """The pre-resolved trace view of spec 2.6 - one call, no client-side join."""
    trace = db[mongo_schema.TRACES].find_one({"trace_key": trace_key})
    if trace is None:
        raise KeyError(f"trace {trace_key} is not registered")
    links = list(db[mongo_schema.RUN_TRACE_LINKS].find({"trace_key": trace_key}))
    device_version = db[mongo_schema.DEVICE_VERSIONS].find_one(
        {
            "device_id": trace.get("device_id"),
            "sw_version": trace.get("sw_version"),
            "hw_version": trace.get("hw_version"),
        }
    )
    return {
        "trace": mongo_schema.serialize(trace),
        "device_version": mongo_schema.serialize(device_version),
        "used_in_runs": sorted({link["test_run_id"] for link in links}),
        "tc_links": mongo_schema.serialize_all(links),
        "lake_rows": trace.get("lake_rows") or {},
    }
