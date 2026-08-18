from dotenv import load_dotenv
load_dotenv()  # reads .env if present; does not override env vars already set by the platform

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from quixstreams import Application

import blob_storage
import lakehouse
from config_consumer import start_background_consumer
from config_store import ConfigStore
from crud import make_crud_router, serialize_doc
from db import get_client, get_db
from transform import build_upload_message

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

config_store = ConfigStore()

mongo_client = get_client()
db = get_db(mongo_client)

quix_app = Application(consumer_group="backend-api")
uploads_topic = quix_app.topic(
    os.environ.get("uploads_output", "test-data-uploads"),
    value_serializer="json",
    key_serializer="string",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.consumer_thread, app.state.consumer_stop_event = start_background_consumer(
        os.environ.get("config_input", "config-updates"), config_store
    )
    yield
    app.state.consumer_stop_event.set()


api = FastAPI(title="Test Manager Backend API", lifespan=lifespan)

api.include_router(make_crud_router(db["requirements"], "/requirements", "requirements"))
api.include_router(make_crud_router(db["test_specs"], "/test-specs", "test_specs"))
api.include_router(make_crud_router(db["test_runs"], "/test-runs", "test_runs"))
api.include_router(make_crud_router(db["results"], "/results", "results"))


@api.get("/config/current")
def get_current_config():
    current = config_store.get()
    if current is None:
        return {"config": None}
    return {"config": current}


def publish_upload_event(payload: dict, producer, topic) -> dict:
    """Serialize and produce the upload event. Split out for unit testing
    with a fake producer/topic."""
    key, value = build_upload_message(payload)
    msg = topic.serialize(key=key, value=value)
    producer.produce(topic=topic, key=msg.key, value=msg.value)
    return value


@api.post("/uploads/test-data")
def post_upload(payload: dict):
    with quix_app.get_producer() as producer:
        value = publish_upload_event(payload, producer, uploads_topic)
    return {"status": "accepted", "key": build_upload_message(payload)[0], "payload": value}


@api.get("/evaluate")
def evaluate(test_run_id: str | None = None, status: str | None = None):
    query = {}
    if test_run_id:
        query["test_run_id"] = test_run_id
    if status:
        query["status"] = status

    results = list(db["results"].find(query))
    summary: dict[str, int] = {}
    for r in results:
        s = r.get("status", "unknown")
        summary[s] = summary.get(s, 0) + 1

    return {
        "count": len(results),
        "summary": summary,
        "results": [serialize_doc(r) for r in results],
    }


@api.get("/health")
def health():
    return {
        "status": "ok",
        "blob_storage_available": blob_storage.is_available(),
        "lakehouse_available": lakehouse.is_available(),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(api, host="0.0.0.0", port=80)
