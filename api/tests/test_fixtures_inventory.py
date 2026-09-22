"""Guards for the Lane B seed records (B-11, B-17). This file is UTF-8.

The counts and the exact prototype values live here. A fixture with no test is
a fixture that rots quietly.
"""

import hashlib
import re
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from api.services.file_bytes import blob_key
from seed import fixtures_inventory as fx

SEED_DAY = date(2026, 8, 28)


# --- One set of ids, not two ---


def test_the_hero_ids_match_the_reference_seed():
    """There is one set of demo ids. api/api/stub_data.py holds the reference.

    Skip when the module goes: the lanes replace it, and by then the ids live
    in Lane A's seed instead.
    """
    stub_data = pytest.importorskip("api.stub_data")
    assert fx.HERO_RUN_ID == stub_data.HERO_RUN_ID
    assert fx.HERO_WORK_ORDER_ID == stub_data.HERO_WO_ID
    assert fx.HERO_SIGNAL_NAME == stub_data.HERO_SIGNAL_NAME


def test_the_named_files_match_the_reference_seed():
    stub_data = pytest.importorskip("api.stub_data")
    reference = {record["filename"] for record in stub_data._seed_files()}
    assert {record["filename"] for record in fx.NAMED_FILES} <= reference


def test_the_catalogue_names_match_the_reference_seed():
    stub_data = pytest.importorskip("api.stub_data")
    reference = [signal["name"] for signal in stub_data._seed_signals()]
    assert [signal["name"] for signal in fx.CATALOGUE_SIGNALS] == reference


def test_the_result_key_matches_the_reference_seed():
    stub_data = pytest.importorskip("api.stub_data")
    reference = stub_data._seed_results()[0]
    result = fx.NAMED_RESULTS[0]
    assert result["result_key"] == reference["result_key"]
    assert result["name"] == reference["name"]
    assert result["provenance"]["tool"] == reference["provenance"]["tool"]
    assert result["provenance"]["tool_version"] == reference["provenance"]["tool_version"]


# --- Counts ---


def test_the_catalogue_holds_fourteen_named_signals():
    assert len(fx.CATALOGUE_SIGNALS) == 14


def test_the_catalogue_names_are_unique():
    names = [signal["name"] for signal in fx.CATALOGUE_SIGNALS]
    assert len(set(names)) == 14


def test_four_named_files():
    assert len(fx.NAMED_FILES) == 4
    assert [record["filename"] for record in fx.NAMED_FILES] == [
        "bat_cyc_20260814_0941.mf4",
        "inca_cal_20260814_0941.mf4",
        "chamber_log_0941.csv",
        "em_eff_20260813_1726.mf4",
    ]


def test_twelve_per_run_statistics_rows():
    assert len(fx.HERO_RUN_STATS) == 12
    run_ids = [row["run_id"] for row in fx.HERO_RUN_STATS]
    assert len(set(run_ids)) == 12
    assert run_ids[0] == "TAS-88214"
    assert run_ids[-1] == "TAS-88104"


def test_the_named_records_are_the_whole_lane_b_cast():
    """No filler hides in this module. Lane A's seed carries the vanity totals.

    The twelve statistics rows now have a writer: they go into QuixLake as
    samples. See api/tests/test_seed_lake_samples.py.
    """
    assert fx.ALL_FILES is fx.NAMED_FILES
    assert fx.ALL_FILE_SIGNALS is fx.NAMED_FILE_SIGNALS
    carried = {row["run_id"] for row in fx.ALL_FILE_SIGNALS}
    assert carried == {fx.HERO_RUN_ID}


def test_one_processed_result():
    assert len(fx.NAMED_RESULTS) == 1


def test_every_file_checksum_is_a_unique_sha256():
    digests = [record["checksum_sha256"] for record in fx.ALL_FILES]
    assert len(set(digests)) == len(digests)
    assert all(re.fullmatch(r"[0-9a-f]{64}", digest) for digest in digests)


# --- The exact prototype values ---


def test_the_hero_file_carries_the_prototype_headline_statistics():
    row = next(
        item
        for item in fx.NAMED_FILE_SIGNALS
        if item["file_key"] == fx.FILE_KEY_BAT and item["name"] == fx.HERO_SIGNAL_NAME
    )
    assert row["stats"] == {
        "min": 18.2, "max": 47.9, "mean": 33.4, "std": 6.21,
        "rms": 33.97, "sample_count": 5400,
    }
    assert row["unit"] == "°C"


def test_the_twelve_rows_hold_the_exact_prototype_values():
    assert [
        (row["run_id"], row["stats"]["min"], row["stats"]["max"], row["stats"]["mean"],
         row["stats"]["std"])
        for row in fx.HERO_RUN_STATS
    ] == [
        ("TAS-88214", 18.2, 47.9, 33.4, 6.21),
        ("TAS-88207", 19.4, 46.2, 32.8, 5.98),
        ("TAS-88198", 21.0, 48.3, 34.9, 6.4),
        ("TAS-88190", 24.6, 49.7, 38.2, 5.7),
        ("TAS-88183", 25.1, 49.4, 37.6, 5.5),
        ("TAS-88177", 23.8, 48.9, 36.4, 5.8),
        ("TAS-88168", 24.2, 47.6, 36.9, 5.6),
        ("TAS-88159", 15.8, 44.1, 29.6, 6.9),
        ("TAS-88150", 16.3, 43.5, 30.2, 6.7),
        ("TAS-88141", 22.7, 46.8, 35.1, 5.9),
        ("TAS-88123", 15.2, 42.8, 28.9, 7.0),
        ("TAS-88104", 16.1, 43.9, 29.8, 6.8),
    ]


def test_the_hero_run_row_matches_the_hero_file_row():
    """The per-run table and the file inventory must agree on TAS-88214."""
    table_row = next(
        row for row in fx.HERO_RUN_STATS if row["run_id"] == fx.HERO_RUN_ID
    )
    file_row = next(
        item
        for item in fx.NAMED_FILE_SIGNALS
        if item["file_key"] == fx.FILE_KEY_BAT and item["name"] == fx.HERO_SIGNAL_NAME
    )
    assert table_row["stats"] == file_row["stats"]


# --- The named catalogue details ---


def test_chamber_humidity_and_em_shaft_torque_carry_no_unit():
    missing = [
        signal["name"] for signal in fx.CATALOGUE_SIGNALS if signal["unit"] is None
    ]
    assert missing == ["Chamber_Humidity", "EM_Shaft_Torque"]


def test_the_hero_signal_carries_a_manual_sensor_ref_and_a_catalogue_ref():
    hero = next(
        signal
        for signal in fx.CATALOGUE_SIGNALS
        if signal["name"] == fx.HERO_SIGNAL_NAME
    )
    assert hero["sensor_ref"] == "PT100-B4-07"
    assert hero["catalogue_ref"] == "TEMP-CELL-MAX"
    assert hero["field_sources"]["sensor_ref"]["source"] == "manual"
    assert hero["field_sources"]["catalogue_ref"]["source"] == "api:catalogue"
    # Derived, not the concept's printed 12: only the hero run carries
    # file_signals rows, so the stored run_count is 1 (2026-08-18 meta-review
    # §2 — the seed's counts state what its own inventory backs). The twelve-
    # run history still lives in the lake samples.
    assert hero["run_count"] == 1


def test_every_catalogue_run_count_matches_the_seeded_inventory():
    """The seed derives `run_count` from its own `file_signals` rows, the way
    ingestion does (`queries_signals.upsert_file_signals`): distinct non-null
    run_ids per name. A literal that drifts from the inventory fails here."""
    for signal in fx.CATALOGUE_SIGNALS:
        backed = {
            row["run_id"]
            for row in fx.NAMED_FILE_SIGNALS
            if row["name"] == signal["name"] and row["run_id"]
        }
        assert signal["run_count"] == len(backed), signal["name"]


def test_the_module_never_writes_the_old_catalogue_spelling():
    source = Path(fx.__file__).read_text(encoding="utf-8")
    assert re.search(r"catalog(?!ue|-sync)", source) is None


def test_the_module_is_utf8_and_holds_the_degree_sign():
    raw = Path(fx.__file__).read_bytes()
    source = raw.decode("utf-8")
    assert "This file is UTF-8." in source
    # "°C" is two bytes in UTF-8 and one byte in the Windows code page.
    assert "°C".encode() in raw
    units = {signal["unit"] for signal in fx.CATALOGUE_SIGNALS}
    assert "°C" in units


# --- The processed result ---


def test_the_result_is_thermal_summary_version_one_and_verified():
    result = fx.NAMED_RESULTS[0]
    assert result["run_id"] == fx.HERO_RUN_ID
    assert result["result_key"] == "thermal_summary"
    assert result["version"] == 1
    assert result["supersedes"] is None
    assert result["provenance_status"] == "verified"
    provenance = result["provenance"]
    assert provenance["tool"] == "bat-post"
    assert provenance["tool_version"] == "2.3.1"
    assert provenance["input_file_keys"] == [fx.FILE_KEY_BAT, fx.FILE_KEY_CSV]
    assert provenance["produced_by"] == "e.lindqvist"


def test_every_result_input_key_names_a_real_file():
    keys = {record["key"] for record in fx.ALL_FILES}
    for result in fx.NAMED_RESULTS:
        assert set(result["provenance"]["input_file_keys"]) <= keys


def test_every_inventory_row_names_a_real_file():
    keys = {record["key"] for record in fx.ALL_FILES}
    assert {row["file_key"] for row in fx.ALL_FILE_SIGNALS} <= keys


# --- The time-basing rule ---


def test_dates_rebase_and_values_never_rebase():
    early = fx.build(date(2026, 8, 20))
    late = fx.build(date(2026, 8, 28))

    early_hero = early["files"][0]
    late_hero = late["files"][0]
    assert (late_hero["time_start"] - early_hero["time_start"]).days == 8
    # The clock time survives the shift. The hero file starts at 09:41:07.
    assert late_hero["time_start"].timetz() == early_hero["time_start"].timetz()

    assert [row["stats"] for row in early["hero_run_stats"]] == [
        row["stats"] for row in late["hero_run_stats"]
    ]
    assert early["file_signals"][0]["stats"] == late["file_signals"][0]["stats"]


def test_build_puts_the_hero_files_on_the_seed_day():
    built = fx.build(SEED_DAY)
    hero_files = [
        record for record in built["files"] if record["run_id"] == fx.HERO_RUN_ID
    ]
    assert len(hero_files) == 3
    assert all(record["time_start"].date() == SEED_DAY for record in hero_files)


def test_build_defaults_to_today():
    built = fx.build()
    hero = next(
        record for record in built["files"] if record["run_id"] == fx.HERO_RUN_ID
    )
    assert hero["time_start"].date() == datetime.now(UTC).date()


def test_build_never_mutates_the_records():
    before = fx.NAMED_FILES[0]["time_start"]
    fx.build(SEED_DAY)
    assert fx.NAMED_FILES[0]["time_start"] == before


# --- The write path, against real Mongo ---


@pytest.fixture
def runs_seeded(routed_db):
    """Stand in for Lane A: register every run the files point at.

    Lane A owns `test_runs`. This fixture writes only the fields the Lane B
    reads need: the rig, the definition and the first-data date.
    """
    from api.db import ensure_indexes

    ensure_indexes(routed_db)
    first_data = {
        row["run_id"]: row["run_started_at"]
        for row in fx.build(SEED_DAY)["hero_run_stats"]
    }
    run_ids = {record["run_id"] for record in fx.ALL_FILES if record["run_id"]}
    assert run_ids <= set(first_data)
    routed_db["test_runs"].insert_many(
        [
            {
                "_id": run_id,
                "rig_id": "RIG-04",
                "definition_id": "TD-BAT-114",
                "status": "complete",
                "invalid": {"flagged": False, "reason": None, "actor": None, "at": None},
                "first_data_at": first_data[run_id],
                "file_count": 0,
                "signal_count": 0,
            }
            for run_id in sorted(run_ids)
        ]
    )
    return routed_db


def test_write_inventory_registers_every_file_through_the_api(runs_seeded, client):
    counts = fx.write_inventory(runs_seeded, client, SEED_DAY)

    assert counts["files"] == 4
    assert counts["file_signals"] == 12
    assert counts["signals"] == 14
    assert counts["processed_results"] == 1
    assert runs_seeded["files"].count_documents({}) == 4
    assert runs_seeded["file_signals"].count_documents({}) == 12
    # POST /files wrote the journal event for every file. Nothing raw-inserted.
    assert runs_seeded["journal_entries"].count_documents({"entity_type": "file"}) == 4


def test_the_quarantine_case_registers_quarantined_and_unlinked(runs_seeded, client):
    fx.write_inventory(runs_seeded, client, SEED_DAY)
    doc = runs_seeded["files"].find_one({"filename": "em_eff_20260813_1726.mf4"})
    assert doc["status"] == "quarantined"
    assert doc["quarantine_reason"] == "checksum mismatch"
    assert doc["run_id"] is None


def test_the_hero_file_statistics_survive_the_write(runs_seeded, client):
    fx.write_inventory(runs_seeded, client, SEED_DAY)
    rows = list(runs_seeded["file_signals"].find({"name": fx.HERO_SIGNAL_NAME}))
    assert len(rows) == 1
    assert rows[0]["run_id"] == fx.HERO_RUN_ID
    # The registration stores the whole block the model takes. The optional
    # keys of FR-DM-014 land as null, because the fixture states none of them.
    assert rows[0]["stats"] == {
        "min": 18.2,
        "max": 47.9,
        "mean": 33.4,
        "std": 6.21,
        "sample_count": 5400,
        "rms": 33.97,
        "p50": None,
        "p95": None,
        "p99": None,
    }


def test_the_registry_holds_one_file_row_for_the_hero_signal(runs_seeded, client, stub_lake):
    """The registry holds one file row, and QuixLake holds twelve runs.

    A real lake answers all twelve runs over the seeded samples —
    `test_seed_lake_samples.py` proves that. The stub lake reads the registry,
    so it answers the one run the registry carries. Nobody may read that single
    row as the demo answer.
    """
    fx.write_inventory(runs_seeded, client, SEED_DAY)
    response = client.get(
        f"{fx.API_PREFIX}/signals/{fx.HERO_SIGNAL_NAME}/stats",
        params={"window": "run", "include_invalid": True, "page_size": 50},
    )
    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert len(fx.HERO_RUN_STATS) == 12


def test_the_seed_writes_no_sample_when_no_lake_is_configured(runs_seeded, client):
    """The registry half of the seed must finish without a lake.

    The suite runs no lake, so the count is zero here. A configured lake takes
    every sample — `test_seed_lake_samples.py` covers that path.
    """
    counts = fx.write_inventory(runs_seeded, client, SEED_DAY)
    assert counts["lake_samples"] == 0


def test_the_catalogue_survives_the_write(runs_seeded, client):
    fx.write_inventory(runs_seeded, client, SEED_DAY)
    hero = runs_seeded["signals"].find_one({"_id": fx.HERO_SIGNAL_NAME})
    assert hero["sensor_ref"] == "PT100-B4-07"
    assert hero["catalogue_ref"] == "TEMP-CELL-MAX"
    assert hero["unit"] == "°C"
    assert runs_seeded["signals"].count_documents({"unit": None}) == 2


def test_the_result_goes_in_through_the_api_and_resolves_its_inputs(runs_seeded, client):
    fx.write_inventory(runs_seeded, client, SEED_DAY)
    result = runs_seeded["processed_results"].find_one({"result_key": "thermal_summary"})
    assert result["version"] == 1
    assert result["supersedes"] is None
    assert result["provenance_status"] == "verified"
    # POST /results wrote the journal event. Nothing raw-inserted. The entry
    # names the RESULT, so "what happened to result X" reads one query, and
    # `context_run_id` keeps it on the run timeline as well.
    assert runs_seeded["journal_entries"].count_documents(
        {
            "entity_type": "result",
            "entity_id": result["_id"],
            "field": "run.result_written",
            "context_run_id": fx.HERO_RUN_ID,
        }
    ) == 1

    input_ids = result["provenance"]["input_file_ids"]
    assert len(input_ids) == 2
    registered = runs_seeded["files"].count_documents({"_id": {"$in": input_ids}})
    assert registered == 2
    assert "input_file_keys" not in result["provenance"]


def test_the_run_signals_total_equals_the_seeded_distinct_count(
    runs_seeded, client, stub_lake
):
    """Contract #7: the count agrees with the rows.

    The seed writes no lake sample here, so this installs the stub lake. The
    count comes from the registry either way.
    """
    fx.write_inventory(runs_seeded, client, SEED_DAY)
    response = client.get(f"{fx.API_PREFIX}/test-runs/{fx.HERO_RUN_ID}/signals")
    assert response.status_code == 200
    expected = len(
        runs_seeded["file_signals"].distinct("name", {"run_id": fx.HERO_RUN_ID})
    )
    assert response.json()["total"] == expected == 11


def test_the_catalogue_lists_through_the_api_after_the_write(runs_seeded, client):
    fx.write_inventory(runs_seeded, client, SEED_DAY)
    response = client.get(f"{fx.API_PREFIX}/signals", params={"page_size": 50})
    assert response.status_code == 200
    assert response.json()["total"] == 14
    missing = client.get(f"{fx.API_PREFIX}/signals", params={"missing_unit": True})
    assert [row["name"] for row in missing.json()["items"]] == [
        "Chamber_Humidity",
        "EM_Shaft_Torque",
    ]


def test_write_inventory_stops_when_lane_a_seeded_no_runs(routed_db, client):
    from api.db import ensure_indexes

    ensure_indexes(routed_db)
    with pytest.raises(RuntimeError, match="TAS-88214"):
        fx.write_inventory(routed_db, client, SEED_DAY)


# --- The bytes behind the named files (findings 20 and 21) ---
#
# The seed wrote file documents and no object, so the hero file stated 1.24 GB
# and `ingest.blob_seed` later put a 40 kB fixture at the same key. The seed
# writes the bytes itself now, and it registers the size and the digest of the
# bytes it wrote.


class _MemoryStore:
    """A store the byte seed can read and write, with no bucket behind it."""

    def __init__(self, objects: dict | None = None, refused: set | None = None) -> None:
        self.objects = dict(objects or {})
        self.refused = set(refused or ())

    def read_bytes(self, key: str) -> bytes | None:
        if key in self.refused:
            raise PermissionError("403 Forbidden")
        return self.objects.get(key)

    def write(self, key: str, data: bytes) -> None:
        self.objects[key] = data


@pytest.fixture
def memory_store(monkeypatch):
    """Take the seed's byte path onto an in-memory store. Return the store."""
    store = _MemoryStore()
    monkeypatch.setattr(fx, "build_store", lambda: (store, ""))
    monkeypatch.setattr(fx, "mf4_bytes", lambda fixture: f"MDF {fixture.key}".encode())
    monkeypatch.setattr(fx, "put_object", lambda s, key, data: s.write(key, data))
    return store


def _registered_records() -> list[dict]:
    return fx.build(SEED_DAY)["files"]


def test_the_seed_writes_one_object_for_every_registered_named_file(memory_store):
    records = _registered_records()

    payloads = fx.write_file_bytes(records)

    assert len(payloads) == 3
    assert len(set(payloads.values())) == 3, "two files may never share a digest"
    for record in records:
        key = blob_key(record["storage_ref"])
        if record["key"] in payloads:
            assert memory_store.objects[key] == payloads[record["key"]]
        else:
            assert key not in memory_store.objects


def test_the_registered_size_and_digest_follow_the_written_bytes(memory_store):
    records = _registered_records()
    payloads = fx.write_file_bytes(records)

    stamped = fx.stamp_real_bytes(records, payloads)

    for record in stamped:
        payload = payloads.get(record["key"])
        if payload is None:
            continue
        assert record["size_bytes"] == len(payload)
        assert record["checksum_sha256"] == hashlib.sha256(payload).hexdigest()


def test_the_quarantine_case_keeps_its_literals(memory_store):
    records = _registered_records()
    literal = next(row for row in records if row["key"] == fx.FILE_KEY_QUARANTINE)

    stamped = fx.stamp_real_bytes(records, fx.write_file_bytes(records))

    quarantined = next(
        row for row in stamped if row["key"] == fx.FILE_KEY_QUARANTINE
    )
    assert quarantined["size_bytes"] == literal["size_bytes"]
    assert quarantined["checksum_sha256"] == literal["checksum_sha256"]


def test_a_key_the_store_already_holds_keeps_its_own_bytes(memory_store):
    """A re-seed never replaces a real capture, and it states its digest."""
    records = _registered_records()
    hero = next(row for row in records if row["key"] == fx.FILE_KEY_BAT)
    key = blob_key(hero["storage_ref"])
    memory_store.objects[key] = b"the real ingested file"

    stamped = fx.stamp_real_bytes(records, fx.write_file_bytes(records))

    assert memory_store.objects[key] == b"the real ingested file"
    written = next(row for row in stamped if row["key"] == fx.FILE_KEY_BAT)
    assert written["size_bytes"] == len(b"the real ingested file")
    assert (
        written["checksum_sha256"]
        == hashlib.sha256(b"the real ingested file").hexdigest()
    )


def test_a_refused_read_writes_nothing_and_keeps_the_literals(memory_store):
    """`read_bytes` raises on a refusal, so the seed may not call the key empty."""
    records = _registered_records()
    hero = next(row for row in records if row["key"] == fx.FILE_KEY_BAT)
    key = blob_key(hero["storage_ref"])
    memory_store.refused.add(key)

    payloads = fx.write_file_bytes(records)

    assert fx.FILE_KEY_BAT not in payloads
    assert key not in memory_store.objects
    stamped = next(
        row
        for row in fx.stamp_real_bytes(records, payloads)
        if row["key"] == fx.FILE_KEY_BAT
    )
    assert stamped["size_bytes"] == hero["size_bytes"]


def test_no_reachable_store_leaves_the_seed_records_alone(monkeypatch):
    """A machine with no blob storage still seeds the registry."""

    def explode():
        raise RuntimeError("no credential")

    monkeypatch.setattr(fx, "build_store", explode)
    records = _registered_records()

    payloads = fx.write_file_bytes(records)

    assert payloads == {}
    assert fx.stamp_real_bytes(records, payloads) == records


def test_the_write_path_registers_the_size_of_the_stored_bytes(
    runs_seeded, client, memory_store
):
    """End to end: what the registry serves is what the store holds."""
    counts = fx.write_inventory(runs_seeded, client, SEED_DAY)

    assert counts["file_bytes"] == 3
    for doc in runs_seeded["files"].find({"status": "registered"}):
        payload = memory_store.objects[blob_key(doc["storage_ref"])]
        assert doc["size_bytes"] == len(payload)
        assert doc["checksum_sha256"] == hashlib.sha256(payload).hexdigest()
