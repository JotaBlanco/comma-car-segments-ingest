"""Write one real MF4 into blob storage for every registered file.

The demo seed writes file DOCUMENTS into Mongo. It writes no object, so the
download route reached a bucket with nothing in it and answered
`503 storage_unreachable` on every press. This job closes that gap for a
developer machine: it reads each registered file's `storage_ref` and puts a
real, small MF4 at that key.

It writes no document and it changes no document. The registry stays the seed's
business.

**It never overwrites.** A key the bucket already holds keeps its bytes, so a
real ingested file survives a re-run. A key the store **refuses** to read keeps
its bytes too: a refusal is not an absence.

The demo seed fills the four named files by itself now
(`seed/fixtures_inventory.py`), because only the writer of the bytes can state
their size and their digest. This job stays the sweep for every other
registered key, and for a bucket somebody emptied.

Run it after the seed:

    python -m ingest.blob_seed

`MONGO_URL` names the registry. `TM_INGEST_SOURCE` and
`Quix__BlobStorage__Connection__Json` name the store, the same two names the
watcher and the download route read (`ingest/store.py`,
`api/services/file_bytes.py`).
"""

from __future__ import annotations

import logging
import os

from pymongo import MongoClient

from api.db import DATABASE_NAME
from api.services.file_bytes import blob_key
from ingest.fixtures import FIXTURES, mf4_bytes, put_object
from ingest.store import BlobStore, build_store

log = logging.getLogger("ingest.blob_seed")


def registered_keys(database) -> list[str]:
    """Every distinct object key of a registered file, in a stable order."""
    keys = {
        blob_key(doc["storage_ref"])
        for doc in database["files"].find(
            {"status": "registered", "storage_ref": {"$nin": [None, ""]}},
            {"storage_ref": 1},
        )
    }
    return sorted(key for key in keys if key)


def fill(store, keys: list[str]) -> tuple[int, int, int]:
    """Write a real MF4 at each key the store does not hold.

    Return `(wrote, kept, refused)`.

    **A key the store refuses to read is never written** (21 Aug 2026). The
    job asked "does the bucket hold this key?" and read every failure as "no".
    s3fs raises `PermissionError` on a 403, so one refused read replaced a real
    captured measurement file with a demo fixture — against the promise this
    module opens with. `store.read_bytes` tells the two apart now: it answers
    None for an absent key and it raises for every other fault. This loop
    writes on the None alone.
    """
    payload = mf4_bytes(FIXTURES[0])
    wrote = 0
    kept = 0
    refused = 0
    for key in keys:
        try:
            present = store.read_bytes(key) is not None
        except OSError as error:
            refused += 1
            log.warning(
                "the store refused to read %s, so this job writes nothing there: %s",
                key,
                error,
            )
            continue
        if present:
            kept += 1
            continue
        put_object(store, key, payload)
        wrote += 1
        log.info("wrote %s (%d bytes)", key, len(payload))
    return wrote, kept, refused


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    store, _prefix = build_store()
    if not isinstance(store, BlobStore):
        log.info("the source is not blob storage, so this job has nothing to do")
        return
    client = MongoClient(os.environ["MONGO_URL"])
    try:
        keys = registered_keys(client.get_database(DATABASE_NAME))
    finally:
        client.close()
    wrote, kept, refused = fill(store, keys)
    log.info(
        "%d keys: %d written, %d already present, %d refused",
        len(keys),
        wrote,
        kept,
        refused,
    )


if __name__ == "__main__":
    main()


__all__ = ["fill", "main", "registered_keys"]
