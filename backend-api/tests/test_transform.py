import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from transform import build_upload_message


def test_build_upload_message_uses_test_run_id_as_key():
    payload = {"test_run_id": "run-42", "metric": "pass_rate", "value": 0.9}
    key, value = build_upload_message(payload)

    assert key == "run-42"
    assert value["metric"] == "pass_rate"
    assert value["value"] == 0.9


def test_build_upload_message_falls_back_to_id_field():
    payload = {"id": "id-99"}
    key, value = build_upload_message(payload)

    assert key == "id-99"


def test_build_upload_message_generates_key_when_missing():
    payload = {"metric": "pass_rate"}
    key, value = build_upload_message(payload)

    assert isinstance(key, str) and len(key) > 0
    assert value["metric"] == "pass_rate"


def test_build_upload_message_adds_received_at_iso_timestamp():
    payload = {"test_run_id": "run-1"}
    _, value = build_upload_message(payload)

    assert "received_at" in value
    datetime.fromisoformat(value["received_at"])  # raises if not valid ISO-8601


def test_build_upload_message_overwrites_caller_supplied_received_at():
    payload = {"test_run_id": "run-1", "received_at": "not-a-real-timestamp"}
    _, value = build_upload_message(payload)

    assert value["received_at"] != "not-a-real-timestamp"
    datetime.fromisoformat(value["received_at"])
