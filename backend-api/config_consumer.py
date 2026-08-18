"""Background consumer loop that keeps the in-memory ConfigStore up to date
with the latest config-updates event."""
import logging
import threading

from quixstreams import Application
from quixstreams.models import MessageField, SerializationContext
from quixstreams.models.serializers.json import JSONDeserializer

from config_store import ConfigStore, handle_config_message

logger = logging.getLogger(__name__)


def consume_config_updates(topic_name: str, store: ConfigStore, stop_event: threading.Event) -> None:
    quix_app = Application(consumer_group="backend-config-consumer", auto_offset_reset="latest")
    deserializer = JSONDeserializer()

    with quix_app.get_consumer() as consumer:
        consumer.subscribe([topic_name])
        while not stop_event.is_set():
            msg = consumer.poll(1.0)
            if msg is None:
                continue
            if msg.error():
                logger.warning("Kafka consumer error: %s", msg.error())
                continue

            ctx = SerializationContext(topic=msg.topic(), field=MessageField.VALUE, headers=msg.headers())
            value = deserializer(msg.value(), ctx=ctx)
            handle_config_message(value, store)
            consumer.store_offsets(message=msg)


def start_background_consumer(topic_name: str, store: ConfigStore) -> tuple[threading.Thread, threading.Event]:
    stop_event = threading.Event()
    thread = threading.Thread(
        target=consume_config_updates, args=(topic_name, store, stop_event), daemon=True
    )
    thread.start()
    return thread, stop_event
