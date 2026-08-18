import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from transform import build_upload_message


def test_build_upload_message_uses_test_run_id_as_key():
    payload = {"test_run_id": "run-42", "metric": "pass_rate", "value": 0.9}
    key, value = build_upload_message(payload)

    assert key == "run-42"
    assert value == payload


def test_build_upload_message_falls_back_to_id_field():
    payload = {"id": "id-99"}
    key, value = build_upload_message(payload)

    assert key == "id-99"


def test_build_upload_message_generates_key_when_missing():
    payload = {"metric": "pass_rate"}
    key, value = build_upload_message(payload)

    assert isinstance(key, str) and len(key) > 0
    assert value == payload
