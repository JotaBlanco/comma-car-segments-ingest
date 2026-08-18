"""MongoDB connection helper."""
import os
from urllib.parse import quote_plus

from pymongo import MongoClient


def build_mongo_uri() -> str:
    """Assemble the MongoDB connection URI from discrete env vars.

    Using separate host/user/password/db vars (rather than a single
    pre-built URI) lets MONGO_PASSWORD be sourced from a Quix project
    secret and keeps special characters in credentials safe via
    urllib.parse.quote_plus.
    """
    mongo_host = os.environ["MONGO_HOST"]
    mongo_user = quote_plus(os.environ["MONGO_USER"])
    mongo_password = quote_plus(os.environ["MONGO_PASSWORD"])
    mongo_db_name = os.environ["MONGO_DB_NAME"]
    return f"mongodb://{mongo_user}:{mongo_password}@{mongo_host}/{mongo_db_name}?authSource=admin"


def get_client() -> MongoClient:
    return MongoClient(build_mongo_uri())


def get_db(client: MongoClient):
    return client[os.environ["MONGO_DB_NAME"]]
