# Signal test factories and seeds.
#
# The lane B region of conftest.py owns the database routing. This module
# only builds and seeds signal documents.

from datetime import UTC, datetime

import pytest


def _now() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


def seed_demo_signals(database) -> None:
    # Insert the stub seed catalogue with the name moved into _id.
    from api import stub_data

    docs = []
    for signal in stub_data._seed_signals():
        doc = dict(signal)
        doc["_id"] = doc.pop("name")
        docs.append(doc)
    database["signals"].insert_many(docs)


@pytest.fixture
def signals_db(routed_db):
    # Kept name: the signals tests read better with it.
    return routed_db


def make_signal(db, name, **overrides) -> dict:
    doc = {
        "_id": name,
        "description": "Test signal",
        "unit": "°C",
        "unit_source": "embedded",
        "dtype": "float64",
        "typical_rate_hz": 10.0,
        "run_count": 1,
        "first_seen": _now(),
        "last_seen": _now(),
        "sensor_ref": None,
        "catalogue_ref": None,
        "rig_ids": ["RIG-04"],
        "source_systems": [],
        "field_sources": {},
    }
    doc.update(overrides)
    db["signals"].replace_one({"_id": doc["_id"]}, doc, upsert=True)
    return doc


def make_file_signal(db, file_id, name, **overrides) -> dict:
    doc = {
        "file_id": file_id,
        "run_id": "TAS-88214",
        "name": name,
        "unit": "°C",
        "unit_source": "embedded",
        "rate_hz": 10.0,
        "dtype": "float64",
        "stats": {"min": 1.0, "max": 2.0, "mean": 1.5, "std": 0.5},
    }
    doc.update(overrides)
    db["file_signals"].replace_one(
        {"file_id": doc["file_id"], "name": doc["name"]}, doc, upsert=True
    )
    return doc
