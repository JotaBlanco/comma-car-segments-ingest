# B-12 — the demo wording must match the real architecture.
#
# A claim list is a document, and a document rots. These tests hold the two
# claims that a reader cannot check by reading.
#
# 1. "Statistics computed lakeside" is FALSE on the File-detail screen.
#    `GET /files/{file_id}` serves the registry numbers, so
#    the caption at frontend/components/screens/files/file-signals-table.tsx
#    names a path that route never takes. CHANGED 21 Aug 2026: it is false on
#    the run-detail Signals tab too, and that caption is gone. That tab reads
#    `GET /test-runs/{run_id}/signals`, which asks no lake at all, so it names
#    the ingestion pipeline instead. The captions that may still name the lake
#    sit on `GET /signals/{name}/stats` and on Explore, which do ask it. See
#    plans/FE-STATS-CAPTION-CHRIS.md.
#
# 2. B-12 asks the signer to read the statistics log line before signing the
#    wording off. The line used to name one provider. It states the split now,
#    because the side that measured a signal serves its numbers.

import json
import logging

import pytest

from api.services import lake, queries_stats
from ingest.store import DEFAULT_PREFIX
from seed import fixtures_inventory
from tests import factories_signals
from tests.factories import register_file, upsert_run
from tests.factories_signals import make_file_signal, make_signal

# The assignment re-exports the fixture without shadowing an import.
signals_db = factories_signals.signals_db

NAME = "HV_Batt_Cell_Temp_Max"
RUN_ID = "TAS-88214"
STATS = {"min": 18.2, "max": 47.9, "mean": 33.4, "std": 6.21}
# The wire adds the four optional quantities of FR-DM-014. This block states
# none of them, so all four serve as null.
SERVED_STATS = {**STATS, "rms": None, "p50": None, "p95": None, "p99": None}


@pytest.fixture
def demo_build(monkeypatch):
    """Take the demo build's own configuration: the default provider, no lake.

    The demo compose sets the lake variables, so the caller never sees this
    state. A developer's shell can hold either variable, and it would then
    decide the answer. The fixture removes both.
    """
    for name in ("Quix__Lakehouse__Query__Url", "QUIX_LAKE_URL"):
        monkeypatch.delenv(name, raising=False)


def _file_with_one_signal(db) -> dict:
    """Register one file that carries the prototype's headline numbers."""
    upsert_run(db, _id=RUN_ID)
    make_signal(db, NAME)
    file = register_file(db, run_id=RUN_ID, signal_count=1)
    make_file_signal(db, file["_id"], NAME, run_id=RUN_ID, stats=STATS)
    return file


def _file_with_one_unmeasured_signal(db) -> dict:
    """Register one file the way the pipeline registers it: no statistic."""
    upsert_run(db, _id=RUN_ID)
    make_signal(db, NAME)
    file = register_file(db, run_id=RUN_ID, signal_count=1)
    make_file_signal(db, file["_id"], NAME, run_id=RUN_ID, stats=None)
    return file


class _SqlRecorder:
    """Stand in for QuixLake. Keep the SQL, then answer one aggregate row."""

    def __init__(self) -> None:
        self.statements: list[str] = []

    def __call__(self, sql: str, transport=None) -> list[dict[str, str]]:
        self.statements.append(sql)
        return [{"run_id": RUN_ID, **{key: repr(value) for key, value in STATS.items()}}]


def test_the_file_detail_serves_registry_numbers_with_no_lake(
    client, signals_db, demo_build
):
    # The screen behind this route prints "Statistics computed lakeside".
    # The route reads file_signals in Mongo and asks no lake, so the caption
    # is false. Break this test and the caption becomes true.
    file = _file_with_one_signal(signals_db)

    response = client.get(f"/api/v1/files/{file['_id']}")

    assert response.status_code == 200, response.text
    assert response.json()["signals"][0]["stats"] == SERVED_STATS


def test_one_screen_needs_the_lake_and_the_file_detail_does_not(
    client, signals_db, demo_build
):
    # One seeded file, two screens, one unconfigured lake. The lake-backed
    # screen refuses. The File-detail screen answers. That split is the whole
    # reason the caption is true on four screens and false on the fifth.
    file = _file_with_one_signal(signals_db)

    detail = client.get(f"/api/v1/files/{file['_id']}")
    lakeside = client.get(f"/api/v1/signals/{NAME}/stats")

    assert detail.status_code == 200, detail.text
    assert detail.json()["signals"][0]["stats"] == SERVED_STATS
    assert lakeside.status_code == 503, lakeside.text
    assert lakeside.json()["code"] == "lake_unavailable"


def test_the_statistics_endpoints_log_which_side_measured_on_a_demo_build(
    client, signals_db, demo_build, caplog
):
    # B-12 signs the wording off against this log line. Pin it, or the check
    # rests on a person reading a console at the wrong moment. The seeded file
    # carries a measured block, so both lines read one of one.
    _file_with_one_signal(signals_db)

    with caplog.at_level(logging.INFO, logger="api.services.queries_stats"):
        client.get(f"/api/v1/signals/{NAME}/stats")
        client.get(f"/api/v1/test-runs/{RUN_ID}/signals")

    assert "signal stats: the registry measured 1 of 1 runs" in caplog.text
    assert "run signals stats: the registry measured 1 of 1 signals" in caplog.text
    # No mode ever names a provider again. The data decides which side answers.
    assert "provider" not in caplog.text


def test_the_file_detail_serves_no_statistic_when_the_registration_carried_none(
    client, signals_db, demo_build
):
    # Caption: "Per-signal values from the file registration".
    # The ingestion pipeline registers no statistic. The lake answers a
    # statistics question, so no registry document holds one.
    # The screen then shows an empty statistic, because the registration held one.
    file = _file_with_one_unmeasured_signal(signals_db)

    response = client.get(f"/api/v1/files/{file['_id']}")

    assert response.status_code == 200, response.text
    assert response.json()["signals"][0]["stats"] is None


def test_the_signal_stats_route_asks_duckdb_to_aggregate_the_lake_samples(
    client, signals_db, demo_build, monkeypatch
):
    # Caption: "DuckDB aggregates the samples of the registered MF4 files".
    # The route must send one aggregate over the lake samples table. A recorder
    # keeps the SQL, so the caption fails the moment the route stops aggregating.
    _file_with_one_signal(signals_db)
    monkeypatch.delenv("TM_LAKE_TABLE", raising=False)
    monkeypatch.setenv("Quix__Lakehouse__Query__Url", "http://lake.invalid")
    monkeypatch.setenv("Quix__Sdk__Token", "test-token-not-a-secret")
    recorder = _SqlRecorder()
    monkeypatch.setattr(lake, "query", recorder)

    response = client.get(f"/api/v1/signals/{NAME}/stats")

    assert response.status_code == 200, response.text
    assert recorder.statements == [queries_stats.signal_stats_sql(NAME)]
    assert "FROM test_signal_samples" in recorder.statements[0]
    assert "min(value)" in recorder.statements[0]


def test_the_two_sidebar_routes_serve_no_lake_name(
    client, signals_db, demo_build, planning_offline
):
    # Caption: the sidebar no longer prints a lake name.
    # The sidebar reads these two routes only (frontend/components/shell/
    # sidebar.tsx:57-58), so a lake name on screen must come from one of them.
    _file_with_one_signal(signals_db)

    summary = client.get("/api/v1/home/summary")
    status = client.get("/api/v1/planning-sync/status")

    assert summary.status_code == 200, summary.text
    assert status.status_code == 200, status.text
    assert "lake" not in json.dumps(summary.json()).lower()
    assert "lake" not in json.dumps(status.json()).lower()


def test_the_signal_catalogue_serves_no_statistic(client, signals_db, demo_build):
    # Caption: the catalogue sub-heading no longer promises a statistic.
    # The screen draws seven columns and no statistic (frontend/components/
    # screens/signals/signals-screen.tsx:91-97).
    make_signal(signals_db, NAME)

    response = client.get("/api/v1/signals")

    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert items, response.text
    for item in items:
        for key in ("min", "max", "mean", "std", "stats"):
            assert key not in item


def test_the_cross_run_list_still_refuses_when_the_lake_is_down(
    client, signals_db, demo_build
):
    # The cross-run list (#16) lists every run of one signal, and the lake can
    # hold a run the registry has no file row for. It cannot answer a partial
    # list as a whole one, so it refuses. The registry numbers of this run stay
    # out of the answer.
    _file_with_one_signal(signals_db)

    response = client.get(f"/api/v1/signals/{NAME}/stats")

    assert response.status_code == 503, response.text
    assert response.json()["code"] == "lake_unavailable", response.text
    for value in STATS.values():
        assert str(value) not in response.text, response.text


def test_every_seeded_file_points_at_the_landing_prefix():
    # Caption: the seed no longer addresses a measurement file as a lake bucket.
    # The measurement files live under the SAG landing prefix, and the lake
    # holds only the samples.
    assert fixtures_inventory.NAMED_FILES
    for record in fixtures_inventory.NAMED_FILES:
        assert record["storage_ref"].startswith(f"blob://{DEFAULT_PREFIX}/"), record["key"]
