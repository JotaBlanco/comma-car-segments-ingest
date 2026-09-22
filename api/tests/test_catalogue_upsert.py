# POST /files feeds the signal inventory and the catalogue (ticket B-05).
# Only a registered file writes file_signals rows and catalogue rows.

import uuid
from datetime import UTC, datetime

from tests import factories
from tests.factories import insert_file_signal, upsert_run
from tests.factories_signals import make_signal

# The assignment re-exports the fixture without shadowing an import.
files_db = factories.files_db

RUN_ID = "TAS-88214"
SIGNAL = "Coolant_Inlet_Temp"
STATS = {"min": 18.2, "max": 47.9, "mean": 33.4, "std": 6.21}
# The registration stores the whole block the model takes. `sample_count`,
# `rms`, `p50`, `p95` and `p99` are optional, so a body that states none of
# them writes five nulls (FR-DM-014).
STORED_STATS = {
    **STATS,
    "sample_count": None,
    "rms": None,
    "p50": None,
    "p95": None,
    "p99": None,
}


def _checksum() -> str:
    # Each file needs its own checksum, or the route replays the first one.
    return uuid.uuid4().hex * 2


def _signal(name: str = SIGNAL, **overrides) -> dict:
    row = {
        "name": name,
        "unit": "°C",
        "rate_hz": 100.0,
        "dtype": "float64",
        "stats": dict(STATS),
    }
    row.update(overrides)
    return row


def _body(**overrides) -> dict:
    body = {
        "filename": "bat_cyc_20260814_0941.mf4",
        "run_id": RUN_ID,
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 1331439861,
        "checksum_sha256": _checksum(),
        "checksum_state": "verified",
        "signals": [_signal()],
    }
    body.update(overrides)
    return body


def _post(client, **overrides) -> dict:
    response = client.post("/api/v1/files", json=_body(**overrides))
    assert response.status_code == 201
    return response.json()


def test_new_signal_creates_catalogue_row_with_embedded_unit_source(client, files_db):
    upsert_run(files_db)

    _post(client)

    doc = files_db["signals"].find_one({"_id": SIGNAL})
    assert doc["unit"] == "°C"
    assert doc["unit_source"] == "embedded"
    assert doc["field_sources"]["unit"]["source"] == "embedded"
    assert doc["rig_ids"] == ["RIG-04"]
    assert doc["typical_rate_hz"] == 100.0


def test_file_unit_never_overwrites_manual_catalogue_unit(client, files_db):
    upsert_run(files_db)
    make_signal(
        files_db,
        SIGNAL,
        unit="°C",
        unit_source="manual",
        field_sources={
            "unit": {
                "source": "manual",
                "actor": "a.bergstrom",
                "at": datetime(2026, 8, 1, 12, 0, tzinfo=UTC),
            }
        },
    )

    _post(client, signals=[_signal(unit="K")])

    doc = files_db["signals"].find_one({"_id": SIGNAL})
    assert doc["unit"] == "°C"
    assert doc["unit_source"] == "manual"
    assert doc["field_sources"]["unit"]["source"] == "manual"


def test_file_unit_fills_null_catalogue_unit(client, files_db):
    upsert_run(files_db)
    make_signal(files_db, SIGNAL, unit=None, unit_source="embedded", field_sources={})

    _post(client)

    doc = files_db["signals"].find_one({"_id": SIGNAL})
    assert doc["unit"] == "°C"
    assert doc["unit_source"] == "embedded"
    assert doc["field_sources"]["unit"]["source"] == "embedded"


def test_a_manual_null_unit_survives_a_file_header(client, files_db):
    # A person may set the unit to null on purpose. Precedence protects it.
    upsert_run(files_db)
    make_signal(
        files_db,
        SIGNAL,
        unit=None,
        unit_source="manual",
        field_sources={
            "unit": {
                "source": "manual",
                "actor": "a.bergstrom",
                "at": datetime(2026, 8, 1, 12, 0, tzinfo=UTC),
            }
        },
    )

    _post(client, signals=[_signal(unit="K")])

    doc = files_db["signals"].find_one({"_id": SIGNAL})
    assert doc["unit"] is None
    assert doc["unit_source"] == "manual"
    assert doc["field_sources"]["unit"]["source"] == "manual"


def test_a_stored_embedded_source_does_not_block_a_file_unit(client, files_db):
    # Equal rank passes. A second file header refreshes an embedded unit.
    upsert_run(files_db)
    make_signal(
        files_db,
        SIGNAL,
        unit=None,
        unit_source="embedded",
        field_sources={
            "unit": {
                "source": "embedded",
                "actor": "ingestion",
                "at": datetime(2026, 8, 1, 12, 0, tzinfo=UTC),
            }
        },
    )

    _post(client, signals=[_signal(unit="K")])

    doc = files_db["signals"].find_one({"_id": SIGNAL})
    assert doc["unit"] == "K"
    assert doc["unit_source"] == "embedded"
    assert doc["field_sources"]["unit"]["source"] == "embedded"


def test_run_count_counts_distinct_runs_not_registrations(client, files_db):
    upsert_run(files_db)

    _post(client)
    _post(client)

    doc = files_db["signals"].find_one({"_id": SIGNAL})
    assert doc["run_count"] == 1

    upsert_run(files_db, _id="TAS-88213", rig_id="RIG-07")
    _post(client, run_id="TAS-88213")

    doc = files_db["signals"].find_one({"_id": SIGNAL})
    assert doc["run_count"] == 2
    assert sorted(doc["rig_ids"]) == ["RIG-04", "RIG-07"]


def test_an_unlinked_inventory_row_does_not_count_as_a_run(client, files_db):
    # run_count counts runs. A file_signals row with a null run_id names no
    # run, so it must not lift the count.
    upsert_run(files_db)
    insert_file_signal(files_db, "f-unlinked", SIGNAL, run_id=None)

    _post(client)

    doc = files_db["signals"].find_one({"_id": SIGNAL})
    assert doc["run_count"] == 1


def test_same_inventory_twice_changes_nothing(client, files_db):
    upsert_run(files_db)
    body = _body()

    first = client.post("/api/v1/files", json=body)
    assert first.status_code == 201
    before = files_db["signals"].find_one({"_id": SIGNAL})
    rows_before = files_db["file_signals"].count_documents({})

    replay = client.post("/api/v1/files", json=body)

    assert replay.status_code == 200
    assert files_db["signals"].find_one({"_id": SIGNAL}) == before
    assert files_db["file_signals"].count_documents({}) == rows_before


def test_file_signals_rows_match_the_shared_shape(client, files_db):
    upsert_run(files_db)

    file = _post(client, signals=[_signal(), _signal("Chamber_Humidity", unit="%RH")])

    rows = list(files_db["file_signals"].find({"file_id": file["file_id"]}))
    assert len(rows) == 2
    assert {row["name"] for row in rows} == {SIGNAL, "Chamber_Humidity"}
    for row in rows:
        assert row["run_id"] == RUN_ID
        assert row["unit_source"] == "embedded"
        assert row["rate_hz"] == 100.0
        assert row["dtype"] == "float64"
        assert row["stats"] == STORED_STATS


def test_a_good_stats_block_registers_the_file_and_stores_four_numbers(client, files_db):
    # The stats block forbids an unknown key. A good block must still pass.
    upsert_run(files_db)

    file = _post(client)

    row = files_db["file_signals"].find_one({"file_id": file["file_id"], "name": SIGNAL})
    assert row["stats"] == STORED_STATS
    # The four core keys, plus the five optional ones the model takes. A body
    # that states none of the five writes them as null.
    assert set(row["stats"]) == {
        "min",
        "max",
        "mean",
        "std",
        "sample_count",
        "rms",
        "p50",
        "p95",
        "p99",
    }


def test_a_null_stats_block_registers_the_file(client, files_db):
    # stats is optional. A null block writes a null and never a 422.
    upsert_run(files_db)

    file = _post(client, signals=[_signal(stats=None)])

    row = files_db["file_signals"].find_one({"file_id": file["file_id"], "name": SIGNAL})
    assert row["stats"] is None


def test_quarantined_file_feeds_no_inventory(client, files_db):
    upsert_run(files_db)

    file = _post(client, checksum_state="mismatch")

    assert files_db["file_signals"].count_documents({"file_id": file["file_id"]}) == 0
    assert files_db["signals"].find_one({"_id": SIGNAL}) is None


# --- the ingest path journals its catalogue writes (finding 23, 21 Aug 2026) ---
#
# `_upsert_catalogue_row` built a journal entry on both call sites and threw it
# away, so the catalogue journalled only a human `PATCH /signals/{name}`.


def _unit_entries(db, name: str = SIGNAL) -> list[dict]:
    return list(db["journal_entries"].find({"field": f"signal.{name}.unit"}))


def test_a_new_catalogue_row_journals_the_unit_it_learned(client, files_db):
    upsert_run(files_db)

    _post(client)

    entries = _unit_entries(files_db)
    assert len(entries) == 1
    entry = entries[0]
    assert entry["entity_type"] == "signal"
    assert entry["entity_id"] == SIGNAL
    assert entry["kind"] == "change"
    assert entry["new"] == "°C"
    assert entry["source"] == "embedded"
    assert entry["actor"] == "ingestion"


def test_filling_a_null_catalogue_unit_journals_the_change(client, files_db):
    upsert_run(files_db)
    make_signal(files_db, SIGNAL, unit=None, unit_source="embedded", field_sources={})

    _post(client)

    entries = _unit_entries(files_db)
    assert len(entries) == 1
    assert entries[0]["old"] == "(empty)"
    assert entries[0]["new"] == "°C"


def test_a_blocked_write_journals_nothing(client, files_db):
    """Precedence rules the journal too: a manual unit stands, so nothing lands."""
    upsert_run(files_db)
    make_signal(
        files_db,
        SIGNAL,
        unit="°C",
        unit_source="manual",
        field_sources={
            "unit": {
                "source": "manual",
                "actor": "a.bergstrom",
                "at": datetime(2026, 8, 1, 12, 0, tzinfo=UTC),
            }
        },
    )

    _post(client, signals=[_signal(unit="K")])

    assert _unit_entries(files_db) == []


def test_a_signal_with_no_unit_journals_nothing(client, files_db):
    upsert_run(files_db)

    _post(client, signals=[_signal(unit=None)])

    assert _unit_entries(files_db) == []


def test_a_second_file_with_the_same_unit_journals_once(client, files_db):
    """The refresh path only writes when the stored unit is null, so no repeat."""
    upsert_run(files_db)

    _post(client)
    _post(client)

    assert len(_unit_entries(files_db)) == 1


# --- two parallel registrations of one new name (finding 29c, 21 Aug 2026) ---


class _BlindSignals:
    """The real ``signals`` collection, but the first read answers None.

    That is exactly what the loser of a parallel registration sees: it read the
    catalogue one moment before the winner inserted the row. The recovery read
    inside the ``DuplicateKeyError`` handler is the second read, so it sees the
    truth.
    """

    def __init__(self, collection):
        self._collection = collection
        self._blind = True

    def find_one(self, *args, **kwargs):
        if self._blind:
            self._blind = False
            return None
        return self._collection.find_one(*args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._collection, name)


class _RacedDb:
    """The real database, with a blinded first read of ``signals``."""

    def __init__(self, db):
        self._db = db
        self._signals = _BlindSignals(db["signals"])

    def __getitem__(self, name):
        return self._signals if name == "signals" else self._db[name]


def test_a_lost_race_on_a_new_signal_name_does_not_raise(client, files_db):
    """The loser re-reads the winner's row instead of answering 500."""
    from api.models.files import FileSignalInput
    from api.services import queries_signals

    upsert_run(files_db)
    _post(client)  # the winner: it creates the catalogue row
    file_doc = files_db["files"].find_one({}, {"_id": 1, "run_id": 1})

    signal = FileSignalInput(**_signal(unit="K"))
    queries_signals.upsert_file_signals(_RacedDb(files_db), file_doc, [signal])

    doc = files_db["signals"].find_one({"_id": SIGNAL})
    # The winner's unit stands: an equal-ranked embedded write may refresh a
    # null unit only, and the winner already stored one.
    assert doc["unit"] == "°C"
    assert doc["unit_source"] == "embedded"
