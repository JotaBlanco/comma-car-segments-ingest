import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from transform import message_to_document


def test_message_to_document_uses_key_as_id():
    doc = message_to_document("run-1", {"metric": "pass_rate", "value": 0.9})

    assert doc["_id"] == "run-1"
    assert doc["metric"] == "pass_rate"
    assert doc["value"] == 0.9


def test_message_to_document_without_key_has_no_id():
    doc = message_to_document(None, {"metric": "pass_rate"})

    assert "_id" not in doc
    assert doc["metric"] == "pass_rate"
