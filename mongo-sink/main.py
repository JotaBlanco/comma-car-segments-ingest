from dotenv import load_dotenv
load_dotenv()  # reads .env if present; does not override env vars already set by the platform

import logging
import os

from pymongo import MongoClient
from pymongo.collection import Collection
from quixstreams import Application

from transform import message_to_document

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MONGO_DB_NAME = "testmanager"
MONGO_COLLECTION_NAME = "test_data"


def upsert_message(key: str | None, value: dict, collection: Collection) -> None:
    doc = message_to_document(key, value)
    collection.replace_one({"_id": doc["_id"]}, doc, upsert=True) if "_id" in doc else collection.insert_one(doc)


def main() -> None:
    mongo_client = MongoClient(os.environ.get("MONGO_URI", "mongodb://admin:mongo_password@mongodb:27017/testmanager?authSource=admin"))
    collection = mongo_client[MONGO_DB_NAME][MONGO_COLLECTION_NAME]

    app = Application(consumer_group="mongo-sink", auto_offset_reset="earliest")
    input_topic = app.topic(os.environ["input"], value_deserializer="json", key_deserializer="string")

    sdf = app.dataframe(input_topic)
    sdf = sdf.apply(lambda value, key, timestamp, headers: upsert_message(key, value, collection), metadata=True)

    logger.info("Starting mongo-sink, writing to %s.%s", MONGO_DB_NAME, MONGO_COLLECTION_NAME)
    app.run()


if __name__ == "__main__":
    main()
