import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backup import export_collection_to_json


class FakeCollection:
    def __init__(self, documents):
        self._documents = documents

    def find(self):
        return iter(self._documents)


def test_export_collection_to_json_produces_expected_structure():
    documents = [
        {"_id": "req-1", "name": "Requirement 1"},
        {"_id": "req-2", "name": "Requirement 2"},
    ]
    collection = FakeCollection(documents)

    result = export_collection_to_json(collection)
    parsed = json.loads(result)

    assert isinstance(parsed, list)
    assert len(parsed) == 2
    assert parsed[0]["_id"] == "req-1"
    assert parsed[0]["name"] == "Requirement 1"
    assert parsed[1]["_id"] == "req-2"


def test_export_collection_to_json_empty_collection():
    collection = FakeCollection([])

    result = export_collection_to_json(collection)
    parsed = json.loads(result)

    assert parsed == []
