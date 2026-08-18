from dotenv import load_dotenv
load_dotenv()  # reads .env if present; does not override env vars already set by the platform

import logging
import os

from fastapi import FastAPI
from quixstreams import Application

from transform import build_config_event

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

api = FastAPI(title="Dynamic Config Manager")

quix_app = Application(consumer_group="dynamic-config-manager")
output_topic = quix_app.topic(
    os.environ.get("output", "config-updates"),
    value_serializer="json",
    key_serializer="string",
)


def publish_config_event(payload: dict, producer, topic) -> dict:
    """Serialize and produce the config event. Split out from the endpoint
    so it can be unit tested with a fake producer/topic."""
    key, value = build_config_event(payload)
    msg = topic.serialize(key=key, value=value)
    producer.produce(topic=topic, key=msg.key, value=msg.value)
    return value


@api.post("/config")
def post_config(payload: dict):
    with quix_app.get_producer() as producer:
        value = publish_config_event(payload, producer, output_topic)
    return {"status": "accepted", "event_id": value["event_id"], "received_at": value["received_at"]}


@api.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(api, host="0.0.0.0", port=80)
