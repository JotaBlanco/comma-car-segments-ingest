from dotenv import load_dotenv
load_dotenv()  # reads .env if present; does not override env vars already set by the platform

import logging
import os
import time
from datetime import datetime, timezone
from urllib.parse import quote_plus

from pymongo import MongoClient

import blob_storage
from backup import export_collection_to_json

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


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


def run_backup_cycle(db) -> None:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    logger.info("Starting backup cycle at %s", timestamp)

    for collection_name in db.list_collection_names():
        json_data = export_collection_to_json(db[collection_name])
        path = f"backups/mongo/{timestamp}/{collection_name}.json"
        uploaded = blob_storage.write_text(path, json_data)
        if uploaded:
            logger.info("Uploaded backup for collection %s to %s", collection_name, path)
        else:
            logger.warning("Skipped upload for collection %s (blob storage unavailable)", collection_name)

    logger.info("Finished backup cycle at %s", timestamp)


def main() -> None:
    mongo_client = MongoClient(build_mongo_uri())
    db = mongo_client[os.environ["MONGO_DB_NAME"]]

    interval_hours = float(os.environ.get("BACKUP_INTERVAL_HOURS", "24"))
    interval_seconds = interval_hours * 3600

    while True:
        run_backup_cycle(db)
        time.sleep(interval_seconds)


if __name__ == "__main__":
    main()
