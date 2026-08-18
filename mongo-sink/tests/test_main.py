import os
import sys

os.environ.setdefault("input", "test-data-uploads")
os.environ.setdefault("MONGO_URI", "mongodb://localhost:27017/testmanager")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import upsert_message


class FakeCollection:
    def __init__(self):
        self.replace_calls = []
        self.insert_calls = []

    def replace_one(self, filter_, doc, upsert=False):
        self.replace_calls.append({"filter": filter_, "doc": doc, "upsert": upsert})

    def insert_one(self, doc):
        self.insert_calls.append(doc)


def test_upsert_message_with_key_uses_replace_one():
    collection = FakeCollection()

    upsert_message("run-1", {"metric": "pass_rate", "value": 0.9}, collection)

    assert len(collection.replace_calls) == 1
    call = collection.replace_calls[0]
    assert call["filter"] == {"_id": "run-1"}
    assert call["doc"]["_id"] == "run-1"
    assert call["doc"]["metric"] == "pass_rate"
    assert call["upsert"] is True
    assert collection.insert_calls == []


def test_upsert_message_without_key_uses_insert_one():
    collection = FakeCollection()

    upsert_message(None, {"metric": "pass_rate"}, collection)

    assert len(collection.insert_calls) == 1
    assert collection.insert_calls[0]["metric"] == "pass_rate"
    assert collection.replace_calls == []
