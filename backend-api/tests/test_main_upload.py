import os
import sys

os.environ.setdefault("config_input", "config-updates")
os.environ.setdefault("uploads_output", "test-data-uploads")
os.environ.setdefault("MONGO_URI", "mongodb://localhost:27017/testmanager")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import publish_upload_event


class FakeMessage:
    def __init__(self, key, value):
        self.key = key
        self.value = value


class FakeTopic:
    def serialize(self, key, value):
        return FakeMessage(key=key.encode() if isinstance(key, str) else key, value=value)


class FakeProducer:
    def __init__(self):
        self.produced = []

    def produce(self, topic, key, value):
        self.produced.append({"topic": topic, "key": key, "value": value})


def test_publish_upload_event_produces_expected_message():
    producer = FakeProducer()
    topic = FakeTopic()

    value = publish_upload_event({"test_run_id": "run-1", "status": "pass"}, producer, topic)

    assert len(producer.produced) == 1
    produced = producer.produced[0]
    assert produced["key"] == b"run-1"
    assert produced["value"] == {"test_run_id": "run-1", "status": "pass"}
    assert value == produced["value"]
