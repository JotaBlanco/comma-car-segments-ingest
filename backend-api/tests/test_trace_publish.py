"""A bus failure after the trace writes have committed must be honest.

Round-1 finding: ``bus.publish`` failing at step 6 of spec 4.2 - after the blob
object, the blob metadata and the Mongo row had all committed - surfaced as an
opaque 500 with no body, so the caller could not tell whether the upload had
landed. The only way to find out was to upload the same bytes again and read
``created: false``.

These are unit tests over the publish step and its bookkeeping; they need neither
a broker nor a database. The end-to-end upload path (blob + Mongo + multipart) is
Tester's harness, not this file's job.
"""

import pytest

import topics
import trace_service


class _Collection:
    """Just enough of a pymongo collection for the publish bookkeeping."""

    def __init__(self) -> None:
        self.updates: list[tuple[dict, dict]] = []

    def update_one(self, query, update, upsert=False):
        self.updates.append((query, update))


class _Db(dict):
    def __missing__(self, name):
        collection = _Collection()
        self[name] = collection
        return collection


class _RefusingBus:
    def publish(self, topic_key, key, value):
        raise topics.EventBusUnavailableError(
            'cannot reach the event bus to publish to "trace-ingest-requests": '
            'Either "broker_address" or "quix_sdk_token" must be provided'
        )


class _AcceptingBus:
    def __init__(self) -> None:
        self.published: list[tuple[str, str, dict]] = []

    def publish(self, topic_key, key, value):
        self.published.append((topic_key, key, value))
        return value


def _document() -> dict:
    return {
        "trace_key": "TRC-plant-sim-01-8317fce18d5e",
        "device_id": "plant-sim-01",
        "sw_version": "1.0",
        "hw_version": "1.0",
        "blob_path": "test-manager/traces/plant-sim-01/TRC-plant-sim-01-8317fce18d5e/trace.mf4",
        "meta_path": (
            "test-manager/traces/plant-sim-01/TRC-plant-sim-01-8317fce18d5e/trace.meta.json"
        ),
        "content_sha256": "8317fce18d5e" + "0" * 52,
        "size_bytes": 4096,
        "uploaded_utc": "2026-08-18T10:00:00Z",
        "publish_state": trace_service.PUBLISH_PENDING,
        "publish_attempts": 0,
        "publish_error": None,
    }


def test_the_request_message_carries_only_the_named_fields():
    document = _document()
    document["ingest_log"] = ["should not reach the topic"]
    message = trace_service._ingest_request(document)
    assert set(message) == {
        "trace_key",
        "device_id",
        "sw_version",
        "hw_version",
        "blob_path",
        "meta_path",
        "content_sha256",
        "size_bytes",
        "uploaded_utc",
        "expected_extractor_version",
    }
    assert "trace.mf4" in message["blob_path"]


def test_a_successful_publish_marks_the_row_published():
    db, document, bus = _Db(), _document(), _AcceptingBus()
    trace_service._publish_ingest_request(db, bus, document, created=True)
    assert document["publish_state"] == trace_service.PUBLISH_DONE
    assert bus.published[0][1] == document["trace_key"]
    query, update = db[trace_service.mongo_schema.TRACES].updates[0]
    assert query == {"trace_key": document["trace_key"]}
    assert update["$set"]["publish_state"] == trace_service.PUBLISH_DONE
    assert update["$inc"] == {"publish_attempts": 1}


def test_a_failed_publish_is_recorded_and_raised_not_swallowed():
    db, document = _Db(), _document()
    with pytest.raises(trace_service.TraceNotPublishedError) as raised:
        trace_service._publish_ingest_request(db, _RefusingBus(), document, created=True)

    assert document["publish_state"] == trace_service.PUBLISH_FAILED
    _, update = db[trace_service.mongo_schema.TRACES].updates[0]
    assert update["$set"]["publish_state"] == trace_service.PUBLISH_FAILED
    assert update["$set"]["publish_error"]
    assert update["$set"]["publish_attempted_utc"]

    body = raised.value.as_dict()
    assert body["error"] == "event_bus_unavailable"
    assert body["trace_key"] == document["trace_key"]
    assert body["created"] is True
    assert body["published"] is False
    assert body["persisted"]["blob_object"] == document["blob_path"]
    assert body["persisted"]["blob_meta"] == document["meta_path"]
    assert body["persisted"]["mongo_traces_row"] is True
    assert body["persisted"]["lake_rows"] is False
    # The caller must be told how to recover, and that retrying is safe.
    assert "re-upload" in body["hint"].lower()
    assert "content-addressed" in body["hint"]


def test_the_failure_body_never_hides_that_something_was_written():
    """The specific round-1 complaint: a 500 with no trace_key and no created flag."""
    document = _document()
    with pytest.raises(trace_service.TraceNotPublishedError) as raised:
        trace_service._publish_ingest_request(_Db(), _RefusingBus(), document, created=True)
    body = raised.value.as_dict()
    for key in ("trace_key", "created", "published", "persisted", "message", "error"):
        assert key in body, key
    assert document["trace_key"] in body["message"]
