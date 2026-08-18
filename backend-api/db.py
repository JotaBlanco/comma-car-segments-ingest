"""MongoDB connection helper."""
import os

from pymongo import MongoClient

MONGO_DB_NAME = "testmanager"


def get_client() -> MongoClient:
    uri = os.environ.get("MONGO_URI", "mongodb://admin:mongo_password@mongodb:27017/testmanager?authSource=admin")
    return MongoClient(uri)


def get_db(client: MongoClient):
    return client[MONGO_DB_NAME]
