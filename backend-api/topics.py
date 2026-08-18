"""Kafka access from the API, through QuixStreams only.

The API is not a stream processor; it is a producer. It therefore uses the
framework's ``Application`` and ``topic.serialize()`` rather than a hand-rolled
confluent_kafka producer or a bespoke JSON encoder - the serialiser is named on
the topic (``value_serializer="json"``) and the framework owns the wire format.

The ``Application`` is built lazily on first publish so that importing this
module (and therefore the whole service) never requires broker configuration.
That matters for the smoke check: ``import main`` must succeed on a laptop.
"""

import logging
import threading

from quixstreams import Application

import settings

logger = logging.getLogger(__name__)


class EventBus:
    """One Application, one topic object per name, one producer per publish."""

    def __init__(self, consumer_group: str = "backend-api") -> None:
        self._consumer_group = consumer_group
        self._lock = threading.Lock()
        self._app: Application | None = None
        self._topics: dict[str, object] = {}
        self._names = settings.topic_names()

    def topic_name(self, key: str) -> str:
        return self._names[key]

    def _application(self) -> Application:
        if self._app is None:
            self._app = Application(consumer_group=self._consumer_group)
        return self._app

    def _topic(self, name: str):
        if name not in self._topics:
            self._topics[name] = self._application().topic(
                name, value_serializer="json", key_serializer="string"
            )
        return self._topics[name]

    def publish(self, topic_key: str, key: str, value: dict) -> dict:
        """Produce one message. Returns the value that was produced."""
        name = self._names[topic_key]
        with self._lock:
            topic = self._topic(name)
            app = self._application()
        message = topic.serialize(key=key, value=value)
        with app.get_producer() as producer:
            producer.produce(topic=name, key=message.key, value=message.value)
        logger.info("Published to %s key=%s", name, key)
        return value


_bus: EventBus | None = None


def get_bus() -> EventBus:
    global _bus
    if _bus is None:
        _bus = EventBus()
    return _bus
