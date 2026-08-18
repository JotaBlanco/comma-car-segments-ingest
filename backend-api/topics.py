"""Kafka access from the API, through QuixStreams only.

The API is not a stream processor; it is a producer. It therefore uses the
framework's ``Application`` and ``topic.serialize()`` rather than a hand-rolled
confluent_kafka producer or a bespoke JSON encoder - the serialiser is named on
the topic (``value_serializer="json"``) and the framework owns the wire format.

The ``Application`` is built lazily on first publish so that importing this
module (and therefore the whole service) never requires broker configuration.
That matters for the smoke check: ``import main`` must succeed on a laptop.

Lazy construction has a consequence that used to leak into a 500. The *first*
publish is where a missing ``Quix__Sdk__Token`` or broker address is discovered,
and in the trace-upload path that moment is after the blob object and the Mongo
record have already been written. So every failure to hand a message to the
broker is raised as :class:`EventBusUnavailableError` - the bus equivalent of
``blob_storage.BlobUnavailableError`` - and mapped by ``error_handlers`` to a 503
that names the cause. Architecture doc, departure 14.
"""

import logging
import threading

from quixstreams import Application

import settings

logger = logging.getLogger(__name__)

CONFIG_HINT = (
    "set Quix__Sdk__Token (Quix-managed broker) or the broker address (BYOK) on "
    "this deployment, then retry; the API only produces, so nothing is consumed "
    "twice by retrying"
)


class EventBusUnavailableError(RuntimeError):
    """The message was not published, and the message says why.

    Deliberately one condition rather than one exception per underlying library:
    from the API's point of view "the broker address is not configured", "the
    broker refused the message" and "the produce timed out" have the same
    consequence and the same remedy, and no caller's decision depends on which of
    them it was. The original exception is always chained and logged with its
    traceback, so the distinction is still available in the log.
    """


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
        """Produce one message. Returns the value that was produced.

        Raises :class:`EventBusUnavailableError` if the message could not be
        handed to the broker. Serialisation is deliberately left *outside* the
        guarded blocks: a value that will not serialise is a defect in the
        caller, not an unavailable bus, and must not be reported as one.
        """
        name = self._names[topic_key]
        with self._lock:
            try:
                topic = self._topic(name)
                app = self._application()
            except Exception as exc:
                logger.exception("Event bus is not usable for topic %s", name)
                raise EventBusUnavailableError(
                    f"cannot reach the event bus to publish to {name!r}: {exc}. {CONFIG_HINT}"
                ) from exc

        message = topic.serialize(key=key, value=value)

        try:
            with app.get_producer() as producer:
                producer.produce(topic=name, key=message.key, value=message.value)
        except Exception as exc:
            logger.exception("Publish to %s failed", name)
            raise EventBusUnavailableError(
                f"the event bus refused the message for {name!r}: {exc}. {CONFIG_HINT}"
            ) from exc

        logger.info("Published to %s key=%s", name, key)
        return value


_bus: EventBus | None = None


def get_bus() -> EventBus:
    global _bus
    if _bus is None:
        _bus = EventBus()
    return _bus
