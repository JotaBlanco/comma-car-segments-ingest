import os
import sys

os.environ.setdefault("output", "config-updates")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import publish_config_event


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


def test_publish_config_event_produces_expected_message():
    producer = FakeProducer()
    topic = FakeTopic()

    value = publish_config_event({"config_id": "cfg-1", "threshold": 5}, producer, topic)

    assert len(producer.produced) == 1
    produced = producer.produced[0]
    assert produced["key"] == b"cfg-1"
    assert produced["value"]["config_id"] == "cfg-1"
    assert produced["value"]["threshold"] == 5
    assert "event_id" in produced["value"]
    assert "received_at" in produced["value"]
    assert value == produced["value"]
