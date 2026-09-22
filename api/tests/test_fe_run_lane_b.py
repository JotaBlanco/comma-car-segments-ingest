"""B-11 — the automated stand-in for the Fri 21 front-end run. This file is UTF-8.

The acceptance line is: "The Fri 21 FE run loads the files list, file detail and
signals screens against the real API over this data." A person clicking three
screens proves nothing after the room empties. This module seeds the interim
cast through the real path, replays exactly the requests those screens send, and
asserts every field each screen reads arrives.

The requests come from the front-end source, not from a plan:

* Files list — `frontend/components/screens/files/files-screen.tsx:47` calls
  `useFiles({ status, source_system })`, which is `GET /api/v1/files`
  (`frontend/lib/api/files.ts:6`).
* File detail — `frontend/components/screens/files/file-detail-screen.tsx:27`
  calls `useFile(fileId)` = `GET /api/v1/files/{file_id}`, then line 29 calls
  `useRun(file.run_id)` = `GET /api/v1/test-runs/{run_id}` for the breadcrumb.
* Signals catalogue —
  `frontend/components/screens/signals/signals-screen.tsx:47` calls
  `useSignals({ unit, missing_unit, rig, rate })` = `GET /api/v1/signals`.
* Signal detail —
  `frontend/components/screens/signals/signal-detail-screen.tsx:30-34` calls
  `GET /api/v1/signals/{name}`,
  `GET /api/v1/signals/{name}/stats?window=run&include_invalid=true` and
  `GET /api/v1/test-runs?signal={name}&page_size=100`.

The field lists below mirror the front end's own TypeScript types. Each constant
names its source file and line. A test fails when the API drops a field, renames
a field, changes a field's type, or serves null where the front end declares the
field non-nullable.

The database mechanism is the shared one from `conftest.py`. This module adds no
second one, and it writes no fixture of its own: the seed and
`seed/fixtures_inventory.py` own every value.
"""

from datetime import date

import pytest

from seed import fixtures_inventory as fx
from seed import seed_demo

SEED_DAY = date(2026, 8, 28)

API = fx.API_PREFIX
HERO_FILE = "bat_cyc_20260814_0941.mf4"
QUARANTINED_FILE = "em_eff_20260813_1726.mf4"

# JSON numbers arrive as int or float. A TypeScript `number` accepts both.
NUMBER = (int, float)


# --- The front end's types, mirrored ------------------------------------------
#
# Shape: field name -> (accepted Python types, the front end declares it
# nullable). A `False` here is a promise the front end makes to itself: it
# dereferences the value without a null guard.

# frontend/types/common.ts:1-7 — Paginated<T>. `GET /files` and `GET /signals`
# both land in `api.get<Paginated<...>>` (lib/api/files.ts:6, signals.ts:14).
PAGINATED_FIELDS = {
    "items": ((list,), False),
    "total": ((int,), False),
    "page": ((int,), False),
    "page_size": ((int,), False),
    "total_pages": ((int,), False),
}

# frontend/types/file.ts:12-27 — FileEntity
FILE_ENTITY_FIELDS = {
    "file_id": ((str,), False),
    "filename": ((str,), False),
    "run_id": ((str,), True),
    "source_system": ((str,), False),
    "format": ((str,), False),
    "size_bytes": ((int,), False),
    "checksum_sha256": ((str,), False),
    "checksum_state": ((str,), False),
    "status": ((str,), False),
    "quarantine_reason": ((str,), True),
    "signal_count": ((int,), False),
    "time_start": ((str,), False),
    "time_end": ((str,), False),
    "registered_at": ((str,), False),
}

# frontend/types/file.ts:29-35 — FileDetail extends FileEntity
FILE_DETAIL_EXTRA_FIELDS = {
    "storage_ref": ((str,), False),
    "ingestion_job_id": ((str,), False),
    "field_sources": ((dict,), False),
    "ingestion_timeline": ((list,), False),
    "signals": ((list,), False),
}

# frontend/types/journal.ts:7-19 — JournalEntry. The ingestion timeline is a
# list of these (file.ts:33), and IngestionTimeline reads every field.
JOURNAL_ENTRY_FIELDS = {
    "id": ((str,), False),
    "entity_type": ((str,), False),
    "entity_id": ((str,), False),
    "field": ((str,), True),
    "kind": ((str,), False),
    "old": ((str,), True),
    "new": ((str,), True),
    "source": ((str,), False),
    "actor": ((str,), False),
    "note": ((str,), True),
    "at": ((str,), False),
}

# frontend/types/signal.ts:13-20 — FileSignal
FILE_SIGNAL_FIELDS = {
    "name": ((str,), False),
    "unit": ((str,), True),
    "unit_source": ((str,), True),
    "rate_hz": (NUMBER, False),
    "dtype": ((str,), False),
    "stats": ((dict,), False),
}

# frontend/types/signal.ts:5-10 — SignalStats
SIGNAL_STATS_FIELDS = {
    "min": (NUMBER, False),
    "max": (NUMBER, False),
    "mean": (NUMBER, False),
    "std": (NUMBER, False),
}

# frontend/types/signal.ts:22-32 — SignalCatalogueEntry
SIGNAL_CATALOGUE_FIELDS = {
    "name": ((str,), False),
    "description": ((str,), False),
    "unit": ((str,), True),
    "unit_source": ((str,), True),
    "dtype": ((str,), False),
    "typical_rate_hz": (NUMBER, False),
    "run_count": ((int,), False),
    "first_seen": ((str,), False),
    "last_seen": ((str,), False),
}

# frontend/types/signal.ts:34-39 — SignalDetail extends SignalCatalogueEntry
SIGNAL_DETAIL_EXTRA_FIELDS = {
    "sensor_ref": ((str,), True),
    "catalogue_ref": ((str,), True),
    "rig_ids": ((list,), False),
    "field_sources": ((dict,), False),
}

# frontend/types/signal.ts:41-51 — SignalRunStat
SIGNAL_RUN_STAT_FIELDS = {
    "run_id": ((str,), False),
    "definition_id": ((str,), True),
    "rig_id": ((str,), False),
    "run_date": ((str,), False),
    "status": ((str,), False),
    "min": (NUMBER, False),
    "max": (NUMBER, False),
    "mean": (NUMBER, False),
    "std": (NUMBER, False),
}

# frontend/types/signal.ts:53-62 — SignalRunStatsResponse
SIGNAL_RUN_STATS_RESPONSE_FIELDS = {
    "name": ((str,), False),
    "unit": ((str,), True),
    "window": ((str,), False),
    "items": ((list,), False),
    "total": ((int,), False),
    "page": ((int,), False),
    "page_size": ((int,), False),
    "total_pages": ((int,), False),
}

# frontend/components/screens/files/file-detail-screen.tsx:66-76 — the
# breadcrumb reads these two run fields and nothing else.
BREADCRUMB_RUN_FIELDS = {
    "work_order_id": ((str,), True),
    "definition_id": ((str,), True),
}

# frontend/components/screens/signals/signal-detail-screen.tsx:67-69 — the run
# list feeds a run_id -> description map.
SIGNAL_RUN_LIST_FIELDS = {
    "run_id": ((str,), False),
    "description": ((str,), True),
}


# --- The seed -----------------------------------------------------------------


@pytest.fixture
def demo(client, routed_db, monkeypatch):
    """The whole named cast, written through the real API.

    `seed_demo.seed` registers Lane A's runs and Lane B's inventory over HTTP
    (`api/seed/seed_demo.py:241`). The filler stays off, so every row the
    screens show is a named row a test can name back.

    The suite configures no QuixLake. Clear both lake variables, or a developer
    machine that points at one turns this run into a network call.
    """
    monkeypatch.delenv("Quix__Lakehouse__Query__Url", raising=False)
    monkeypatch.delenv("QUIX_LAKE_URL", raising=False)
    seed_demo.seed(routed_db, client, SEED_DAY, inventory=True, filler_records=False)
    return routed_db


@pytest.fixture
def mongo_stats(stub_lake):
    """Answer the statistics routes from the stub lake.

    QuixLake answers `GET /signals/{name}/stats` in the demo, and the suite runs
    no lake. The stub serves the registry's own numbers instead.
    """


# --- The field checker ---------------------------------------------------------


def check_fields(body: dict, spec: dict, where: str) -> None:
    """Fail when the API drops a field, changes its type, or nulls a non-null."""
    assert isinstance(body, dict), f"{where} is {type(body).__name__}, wanted an object"

    missing = [name for name in spec if name not in body]
    assert not missing, f"{where} serves no {', '.join(missing)}"

    faults = []
    for name, (types, nullable) in spec.items():
        value = body[name]
        if value is None:
            if not nullable:
                faults.append(f"{name} is null and the front end declares it non-null")
            continue
        if not isinstance(value, types):
            wanted = " or ".join(item.__name__ for item in types)
            faults.append(f"{name} is {type(value).__name__}, wanted {wanted}")
    assert not faults, f"{where}: " + "; ".join(faults)


def get(client, path: str, **params) -> dict:
    """Send one screen request and return its body. A non-200 names the path."""
    response = client.get(f"{API}{path}", params=params)
    assert response.status_code == 200, f"GET {path} answered {response.status_code}"
    return response.json()


def file_id_of(client, filename: str) -> str:
    """Find one file the way the screen does: list first, then open the row."""
    body = get(client, "/files")
    matches = [row for row in body["items"] if row["filename"] == filename]
    assert len(matches) == 1, f"the list holds {len(matches)} rows named {filename}"
    return matches[0]["file_id"]


def named_filenames() -> set[str]:
    return {record["filename"] for record in fx.NAMED_FILES}


# --- Screen 1: the files list --------------------------------------------------


def test_the_files_list_screen_serves_every_field_it_reads(client, demo) -> None:
    """files-screen.tsx:47 — GET /files, no chip and then a chip.

    The screen opens with both filters undefined, so the plain list is the call
    that matters most. It is also the only one that carries the quarantined row,
    and that row is where run_id and quarantine_reason arrive filled.
    """
    plain = get(client, "/files")
    chipped = get(client, "/files", status="registered", source_system="TAS")

    for body, where in ((plain, "GET /files"), (chipped, "GET /files?status&source_system")):
        check_fields(body, PAGINATED_FIELDS, where)
        assert body["items"], f"{where} came back empty"
        for row in body["items"]:
            check_fields(row, FILE_ENTITY_FIELDS, f"{where} item {row.get('filename')}")

    quarantined = next(row for row in plain["items"] if row["filename"] == QUARANTINED_FILE)
    assert quarantined["run_id"] is None
    assert isinstance(quarantined["quarantine_reason"], str)


def test_the_files_list_holds_the_hero_files_and_the_quarantine_case(client, demo) -> None:
    """The screen opens on four named rows: three hero files, one quarantine."""
    body = get(client, "/files")

    assert {row["filename"] for row in body["items"]} == named_filenames()
    assert body["total"] == len(fx.NAMED_FILES)
    linked = {row["filename"] for row in body["items"] if row["run_id"] == fx.HERO_RUN_ID}
    assert len(linked) == 3


def test_the_quarantined_chip_returns_the_quarantine_case_only(client, demo) -> None:
    """files-screen.tsx:47 sends `status`. The chip must isolate one row."""
    body = get(client, "/files", status="quarantined")

    assert [row["filename"] for row in body["items"]] == [QUARANTINED_FILE]
    assert body["total"] == 1
    row = body["items"][0]
    assert row["status"] == "quarantined"
    assert row["quarantine_reason"] == "checksum mismatch"
    assert row["run_id"] is None


def test_the_source_system_chip_filters_the_list(client, demo) -> None:
    """files-screen.tsx:47 sends `source_system` for the INCA and TAS chips."""
    body = get(client, "/files", source_system="INCA")

    expected = {
        record["filename"] for record in fx.NAMED_FILES if record["source_system"] == "INCA"
    }
    assert {row["filename"] for row in body["items"]} == expected
    assert all(row["source_system"] == "INCA" for row in body["items"])


# --- Screen 2: the file detail -------------------------------------------------


def test_the_file_detail_screen_serves_every_field_it_reads(client, demo) -> None:
    """file-detail-screen.tsx:27 — GET /files/{file_id}, one call for the page.

    Every named row is a row a person can click, so every named row is checked.
    The quarantined file is the one with a null run_id, and the CSV file is the
    one with a null signal unit.
    """
    for filename in sorted(named_filenames()):
        body = get(client, f"/files/{file_id_of(client, filename)}")
        where = f"GET /files/{filename}"

        check_fields(body, FILE_ENTITY_FIELDS, where)
        check_fields(body, FILE_DETAIL_EXTRA_FIELDS, where)
        for entry in body["ingestion_timeline"]:
            check_fields(entry, JOURNAL_ENTRY_FIELDS, f"{where} timeline entry")
        for row in body["signals"]:
            check_fields(row, FILE_SIGNAL_FIELDS, f"{where} signal {row.get('name')}")
            check_fields(row["stats"], SIGNAL_STATS_FIELDS, f"{where} stats {row.get('name')}")


def test_the_hero_file_detail_serves_its_signals_sources_and_timeline_at_once(
    client, demo
) -> None:
    """The screen makes one call. Signals, field_sources and the timeline all
    ride in it (file-detail-screen.tsx:155-202).

    `b9d78da` widened the tag list from two fields to eight (TR-011). The
    registration tags every field the file itself proves, so this test expected
    six keys too few. The new shape is right and this assertion follows it.
    """
    from api.routers.files import _EMBEDDED_FIELDS

    body = get(client, f"/files/{file_id_of(client, HERO_FILE)}")

    seeded = [row for row in fx.NAMED_FILE_SIGNALS if row["file_key"] == fx.FILE_KEY_BAT]
    assert {row["name"] for row in body["signals"]} == {row["name"] for row in seeded}
    assert body["signal_count"] == len(seeded)

    assert set(body["field_sources"]) == set(_EMBEDDED_FIELDS)
    assert len(_EMBEDDED_FIELDS) == 8
    # The screen reads these two, so the map must keep them whatever else joins.
    assert {"size_bytes", "checksum_sha256"} <= set(body["field_sources"])
    assert body["field_sources"]["checksum_sha256"]["source"] == "embedded"

    fields = [entry["field"] for entry in body["ingestion_timeline"]]
    assert "file.registered" in fields


def test_the_hero_file_detail_carries_the_prototype_statistics(client, demo) -> None:
    """The signals table shows the headline numbers. They must survive the API."""
    body = get(client, f"/files/{file_id_of(client, HERO_FILE)}")

    seeded = next(
        row
        for row in fx.NAMED_FILE_SIGNALS
        if row["file_key"] == fx.FILE_KEY_BAT and row["name"] == fx.HERO_SIGNAL_NAME
    )
    served = next(row for row in body["signals"] if row["name"] == fx.HERO_SIGNAL_NAME)
    # The seed states six numbers (rms and sample_count joined 24 Aug 2026).
    # The file detail serves five of them - sample_count is merge machinery,
    # not display - and the percentiles stay null: they come from the lake.
    expected = {key: value for key, value in seeded["stats"].items() if key != "sample_count"}
    assert served["stats"] == {
        **expected,
        "p50": None,
        "p95": None,
        "p99": None,
    }
    assert served["unit"] == seeded["unit"]


def test_the_two_screens_badge_one_unit_source_differently_on_purpose(
    client, demo
) -> None:
    """The run found a split badge on Coolant_Inlet_Temp. This pins the answer.

    The file detail badges the unit `embedded` and the catalogue badges it
    `manual`. Both are right, and the difference is the point of the tag. A
    `file_signals` row records what **that file header** carried, so
    `api/api/services/queries_signals.py:156` always writes `embedded`. The
    catalogue row records what the field is worth **across every file**, and a
    person outranks a header there.

    `api/seed/fixtures_inventory.py` states `unit_source` on the per-file row,
    and `_file_request_body` never sends it. That value is documentation, not
    data. A reader who trusts it expects a manual badge on the file screen.
    """
    detail = get(client, f"/files/{file_id_of(client, HERO_FILE)}")
    served = next(row for row in detail["signals"] if row["name"] == "Coolant_Inlet_Temp")
    assert served["unit_source"] == "embedded"

    catalogue = get(client, "/signals/Coolant_Inlet_Temp")
    assert catalogue["unit_source"] == "manual"
    assert catalogue["field_sources"]["unit"]["source"] == "manual"


def test_the_file_detail_breadcrumb_reads_the_run(client, demo) -> None:
    """file-detail-screen.tsx:29 — GET /test-runs/{run_id} for the crumb ids."""
    detail = get(client, f"/files/{file_id_of(client, HERO_FILE)}")
    assert detail["run_id"] == fx.HERO_RUN_ID

    body = get(client, f"/test-runs/{detail['run_id']}")

    check_fields(body, BREADCRUMB_RUN_FIELDS, f"GET /test-runs/{fx.HERO_RUN_ID}")


# --- Screen 3: the signals catalogue ------------------------------------------


def test_the_signals_screen_serves_every_field_it_reads(client, demo) -> None:
    """signals-screen.tsx:47 — GET /signals with the four chip filters."""
    body = get(client, "/signals")

    check_fields(body, PAGINATED_FIELDS, "GET /signals")
    assert body["items"], "the seeded catalogue came back empty"
    for row in body["items"]:
        check_fields(row, SIGNAL_CATALOGUE_FIELDS, f"GET /signals item {row.get('name')}")


def test_the_catalogue_lists_the_fourteen_named_signals(client, demo) -> None:
    body = get(client, "/signals")

    assert body["total"] == len(fx.CATALOGUE_SIGNALS) == 14
    assert {row["name"] for row in body["items"]} == {
        signal["name"] for signal in fx.CATALOGUE_SIGNALS
    }


def test_the_missing_unit_chip_returns_the_two_signals_without_a_unit(client, demo) -> None:
    """signals-screen.tsx:40 turns `?missing_unit=true` into the filter."""
    body = get(client, "/signals", missing_unit=True)

    assert [row["name"] for row in body["items"]] == ["Chamber_Humidity", "EM_Shaft_Torque"]
    assert all(row["unit"] is None for row in body["items"])


def test_the_rig_and_rate_chips_filter_the_catalogue(client, demo) -> None:
    """signals-screen.tsx:41-44 sends `rig` and `rate`."""
    by_rig = get(client, "/signals", rig="RIG-04")
    by_rate = get(client, "/signals", rate=100)

    assert {row["name"] for row in by_rig["items"]} == {
        signal["name"] for signal in fx.CATALOGUE_SIGNALS if "RIG-04" in signal["rig_ids"]
    }
    assert {row["name"] for row in by_rate["items"]} == {
        signal["name"] for signal in fx.CATALOGUE_SIGNALS if signal["typical_rate_hz"] == 100
    }
    assert by_rate["items"], "no signal answers the 100 Hz chip"


# --- Screen 4: the signal detail ----------------------------------------------


def test_the_signal_detail_screen_serves_every_field_it_reads(client, demo) -> None:
    """signal-detail-screen.tsx:30 — GET /signals/{name}."""
    body = get(client, f"/signals/{fx.HERO_SIGNAL_NAME}")
    where = f"GET /signals/{fx.HERO_SIGNAL_NAME}"

    check_fields(body, SIGNAL_CATALOGUE_FIELDS, where)
    check_fields(body, SIGNAL_DETAIL_EXTRA_FIELDS, where)


def test_the_hero_signal_detail_carries_its_sensor_and_catalogue_reference(
    client, demo
) -> None:
    """The screen prints both references and badges their sources (lines 182-204)."""
    body = get(client, f"/signals/{fx.HERO_SIGNAL_NAME}")

    assert body["sensor_ref"] == "PT100-B4-07"
    assert body["catalogue_ref"] == "TEMP-CELL-MAX"
    assert body["field_sources"]["sensor_ref"]["source"] == "manual"
    assert body["field_sources"]["catalogue_ref"]["source"] == "api:catalogue"
    assert body["rig_ids"][0] == "RIG-04"
    # Derived from the seeded file_signals inventory (only the hero run
    # carries rows), no longer the concept's printed 12 — 2026-08-18
    # meta-review §2. The stats table still answers 12 runs from the lake.
    assert body["run_count"] == 1


def test_the_signal_stats_screen_serves_every_field_it_reads(
    client, demo, mongo_stats
) -> None:
    """signal-detail-screen.tsx:33 — GET /signals/{name}/stats, window=run,
    include_invalid=true."""
    body = get(
        client,
        f"/signals/{fx.HERO_SIGNAL_NAME}/stats",
        window="run",
        include_invalid=True,
    )
    where = f"GET /signals/{fx.HERO_SIGNAL_NAME}/stats"

    check_fields(body, SIGNAL_RUN_STATS_RESPONSE_FIELDS, where)
    assert body["window"] == "run"
    assert body["name"] == fx.HERO_SIGNAL_NAME
    assert body["items"], "the statistics table came back empty"
    for row in body["items"]:
        check_fields(row, SIGNAL_RUN_STAT_FIELDS, f"{where} row {row.get('run_id')}")


def test_the_stats_row_holds_the_exact_prototype_numbers(client, demo, mongo_stats) -> None:
    """The prototype prints 18.2 / 47.9 / 33.4 / 6.21 for TAS-88214.

    The Mongo opt-out answers one run, because Mongo holds one file row. The
    lake answers all twelve — `api/tests/test_seed_lake_samples.py` covers that
    path. The numbers of the hero run are the same either way.
    """
    body = get(
        client,
        f"/signals/{fx.HERO_SIGNAL_NAME}/stats",
        window="run",
        include_invalid=True,
    )

    row = next(item for item in body["items"] if item["run_id"] == fx.HERO_RUN_ID)
    seeded = next(item for item in fx.HERO_RUN_STATS if item["run_id"] == fx.HERO_RUN_ID)
    assert (row["min"], row["max"], row["mean"], row["std"]) == (18.2, 47.9, 33.4, 6.21)
    assert [row["min"], row["max"], row["mean"], row["std"]] == [
        seeded["stats"]["min"],
        seeded["stats"]["max"],
        seeded["stats"]["mean"],
        seeded["stats"]["std"],
    ]
    assert row["run_date"] == SEED_DAY.isoformat()
    assert row["rig_id"] == "RIG-04"


def test_the_signal_detail_run_list_serves_the_descriptions_it_maps(client, demo) -> None:
    """signal-detail-screen.tsx:34 — GET /test-runs?signal={name}&page_size=100."""
    body = get(client, "/test-runs", signal=fx.HERO_SIGNAL_NAME, page_size=100)

    check_fields(body, PAGINATED_FIELDS, "GET /test-runs?signal=")
    assert [row["run_id"] for row in body["items"]] == [fx.HERO_RUN_ID]
    for row in body["items"]:
        check_fields(row, SIGNAL_RUN_LIST_FIELDS, f"GET /test-runs?signal= row {row['run_id']}")
