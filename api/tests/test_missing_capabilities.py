# A missing configuration must be VISIBLE, and it must never cost a reader
# the whole answer.
#
# The deployed pod paid for both halves of this file. Its workspace had blob
# storage switched off, so `blobStorage: bind: true` bound to nothing and the
# Portal injected no lake. The API then answered every run-signals call with
# 503, the Signals tab counted 261 signals and printed one red line, and the
# only trace of the real cause was one log line nobody read.
#
# Two rules hold here, and they pull in opposite directions on purpose:
#
# 1. The run-signals list (#7) reads the REGISTRY. The ingestion pipeline
#    measures the numbers and this service stores them, so the lake decides
#    nothing on that page. No lake at all, and a lake that fails, both leave
#    the same 200 with the same numbers. The envelope states how much of the
#    run the pipeline measured, so a blank number still has a reason.
# 2. A lake that this process asks and that FAILS is an outage, so a route
#    that DOES ask still answers 503. #16 is the one in this file.
#
# CHANGED 21 Aug 2026. Rule 1 used to send #7 to the lake for every signal the
# registry did not measure, so one lake outage broke the whole Signals tab.
# The tests that pinned a 503 on this route now pin the 200.

import logging

import pytest

from api import capabilities, main
from api.services import lake
from tests import factories_signals
from tests.factories import register_file, upsert_run
from tests.factories_signals import make_file_signal, make_signal

# The assignment re-exports the fixture without shadowing an import.
signals_db = factories_signals.signals_db

RUN_ID = "TAS-88214"
MEASURED = "HV_Batt_Cell_Temp_Max"
UNMEASURED = "Chamber_Humidity"
# The seeded block states the four core numbers. RMS and the three percentiles
# are optional (FR-DM-014), so the row serves them as null.
STATS = {"min": 18.2, "max": 47.9, "mean": 33.4, "std": 6.21}
SERVED_STATS = {**STATS, "rms": None, "p50": None, "p95": None, "p99": None}
URL = f"/api/v1/test-runs/{RUN_ID}/signals"


@pytest.fixture
def two_signals(signals_db) -> dict:
    """One signal the pipeline measured, one it did not, on one run."""
    upsert_run(signals_db, _id=RUN_ID)
    make_signal(signals_db, MEASURED)
    make_signal(signals_db, UNMEASURED)
    file = register_file(signals_db, run_id=RUN_ID, signal_count=2)
    make_file_signal(signals_db, file["_id"], MEASURED, run_id=RUN_ID, stats=STATS)
    make_file_signal(signals_db, file["_id"], UNMEASURED, run_id=RUN_ID, stats=None)
    return file


@pytest.fixture
def no_lake_at_all(monkeypatch):
    """Take every lake variable away. This is the deployed pod's state."""
    for name in (lake.URL_VAR, "QUIX_LAKE_URL", lake.TOKEN_VAR, "Quix__Sdk__Token"):
        monkeypatch.delenv(name, raising=False)


def _rows(body: dict) -> dict:
    return {row["name"]: row for row in body["items"]}


class _PingingClient:
    """Stand in for the process Mongo client. `/ready` pings it and passes.

    The readiness route answers 503 when Mongo does not answer, and these
    tests are about the capability report, not about Mongo.
    """

    class _Admin:
        def command(self, name: str):
            assert name == "ping"
            return {"ok": 1}

    admin = _Admin()


@pytest.fixture
def mongo_answers(monkeypatch):
    monkeypatch.setattr(main, "get_client", lambda: _PingingClient())


# --- Job 1: the list survives an absent lake -------------------------------


def test_an_absent_lake_still_lists_every_signal(client, two_signals, no_lake_at_all):
    response = client.get(URL)

    assert response.status_code == 200, response.text
    body = response.json()
    assert sorted(_rows(body)) == [UNMEASURED, MEASURED]
    assert body["total"] == 2, body


def test_an_absent_lake_keeps_the_numbers_the_pipeline_measured(
    client, two_signals, no_lake_at_all
):
    # The registry holds these four numbers. No lake is needed to read them,
    # so a missing lake must not hide them.
    rows = _rows(client.get(URL).json())

    assert rows[MEASURED]["stats"] == SERVED_STATS
    assert rows[UNMEASURED]["stats"] is None


def test_an_absent_lake_keeps_the_registry_metadata(client, two_signals, no_lake_at_all):
    # The name, the unit, the rate and the dtype come from Mongo, so every one
    # of them is complete without a lake. A blank number is the only loss.
    row = _rows(client.get(URL).json())[UNMEASURED]

    assert row["unit_source"] == "embedded"
    assert row["rate_hz"] > 0
    assert row["dtype"]


def test_an_absent_lake_states_the_reason_on_the_envelope(client, two_signals, no_lake_at_all):
    reason = client.get(URL).json()["stats_unavailable"]

    # One signal of the two carries numbers, so the run is partly measured.
    assert reason["reason"] == "partly_measured"
    # The reason states a measurement. It never sends a reader to a lake
    # variable, because no lake variable changes one number on this page.
    assert lake.URL_VAR not in reason["detail"]
    assert lake.TOKEN_VAR not in reason["detail"]
    assert "measured" in reason["detail"]


def test_a_run_nobody_measured_reads_as_not_measured(client, signals_db, no_lake_at_all):
    # Every signal blank. The reason must say so, and it must never read as
    # "we could not ask".
    upsert_run(signals_db, _id=RUN_ID)
    make_signal(signals_db, UNMEASURED)
    file = register_file(signals_db, run_id=RUN_ID, signal_count=1)
    make_file_signal(signals_db, file["_id"], UNMEASURED, run_id=RUN_ID, stats=None)

    body = client.get(URL).json()

    assert body["items"][0]["stats"] is None, body
    assert body["stats_unavailable"]["reason"] == "not_measured", body


def test_a_missing_token_alone_changes_nothing_on_this_list(client, two_signals, monkeypatch):
    # A URL with no token cannot ask the lake. This list asks nobody, so the
    # answer must not move one character.
    monkeypatch.setenv(lake.URL_VAR, "http://lake.internal.invalid:8080")
    for name in (lake.TOKEN_VAR, "Quix__Sdk__Token"):
        monkeypatch.delenv(name, raising=False)

    body = client.get(URL).json()

    assert _rows(body)[MEASURED]["stats"] == SERVED_STATS
    assert body["stats_unavailable"]["reason"] == "partly_measured", body


# --- Job 1: a lake outage never reaches this list --------------------------
#
# CHANGED 21 Aug 2026. These two tests demanded a 503 here. The decision moved
# the line: the numbers of this page live in the database, so a lake outage
# cannot hide them and must not blank the page. The loud 503 stays where the
# route really asks the lake. The #16 test below holds that line.


def test_a_configured_lake_that_fails_never_touches_this_list(
    client, two_signals, monkeypatch
):
    monkeypatch.setenv(lake.URL_VAR, "http://lake.internal.invalid:8080")
    monkeypatch.setenv(lake.TOKEN_VAR, "token-not-a-secret")
    monkeypatch.setattr(
        lake, "query", lambda sql, transport=None: (_ for _ in ()).throw(lake.LakeError("down"))
    )

    response = client.get(URL)

    assert response.status_code == 200, response.text
    body = response.json()
    assert _rows(body)[MEASURED]["stats"] == SERVED_STATS, body
    assert body["stats_unavailable"]["reason"] == "partly_measured", body


def test_a_refused_token_never_touches_this_list(client, two_signals, monkeypatch):
    monkeypatch.setenv(lake.URL_VAR, "http://lake.internal.invalid:8080")
    monkeypatch.setenv(lake.TOKEN_VAR, "token-not-a-secret")
    monkeypatch.setattr(
        lake,
        "query",
        lambda sql, transport=None: (_ for _ in ()).throw(lake.LakeAuthError("no")),
    )

    assert client.get(URL).status_code == 200


def test_a_working_lake_changes_no_reason(client, two_signals, stub_lake, monkeypatch):
    # The reason describes the measurement, so a reachable lake never removes
    # it. One signal of the two is blank, and it stays blank with a reason.
    monkeypatch.setenv(lake.URL_VAR, "http://lake.golden.test")
    monkeypatch.setenv(lake.TOKEN_VAR, "token-not-a-secret")

    body = client.get(URL).json()

    assert body["stats_unavailable"]["reason"] == "partly_measured", body
    assert _rows(body)[UNMEASURED]["stats"] is None, body


def test_a_fully_measured_run_carries_no_reason(client, signals_db, no_lake_at_all):
    # The field is absent when every row carries numbers. That absence is the
    # only page a reader may read as "nothing is missing here".
    upsert_run(signals_db, _id=RUN_ID)
    make_signal(signals_db, MEASURED)
    file = register_file(signals_db, run_id=RUN_ID, signal_count=1)
    make_file_signal(signals_db, file["_id"], MEASURED, run_id=RUN_ID, stats=STATS)

    body = client.get(URL).json()

    assert body["stats_unavailable"] is None, body


def test_the_cross_run_stats_still_refuse_without_a_lake(client, two_signals, no_lake_at_all):
    # #16 is deliberately NOT degraded. The lake can hold a run the registry
    # has no file row for, so its list cannot be proved complete. A list that
    # cannot be complete must not pretend that it is.
    response = client.get(f"/api/v1/signals/{MEASURED}/stats")

    assert response.status_code == 503, response.text
    assert response.json()["code"] == "lake_unavailable", response.text


# --- Job 2: the missing configuration is loud ------------------------------


def test_the_report_names_both_capabilities(no_lake_at_all, monkeypatch):
    monkeypatch.delenv(capabilities.BLOB_CONNECTION_VAR, raising=False)

    names = [item["name"] for item in capabilities.report()]

    assert names == ["statistics", "file_downloads"]


def test_a_missing_capability_names_its_variable_and_its_cost(no_lake_at_all, monkeypatch):
    monkeypatch.delenv(capabilities.BLOB_CONNECTION_VAR, raising=False)

    gaps = {item["name"]: item for item in capabilities.missing()}

    assert gaps["statistics"]["missing_variable"] == lake.URL_VAR
    assert "statistics" in gaps["statistics"]["impact"]
    assert gaps["file_downloads"]["missing_variable"] == capabilities.BLOB_CONNECTION_VAR
    assert "download" in gaps["file_downloads"]["impact"]


def test_a_configured_capability_reports_no_variable(monkeypatch):
    monkeypatch.setenv(capabilities.BLOB_CONNECTION_VAR, '{"provider": "Minio"}')

    downloads = capabilities.report()[1]

    assert downloads["configured"] is True
    assert downloads["missing_variable"] is None
    assert downloads["impact"] is None


def test_the_warning_names_the_variable_and_the_cost(caplog, no_lake_at_all, monkeypatch):
    monkeypatch.delenv(capabilities.BLOB_CONNECTION_VAR, raising=False)
    monkeypatch.setattr(capabilities, "_warned", False)

    with caplog.at_level(logging.WARNING, logger="api.capabilities"):
        capabilities.warn_once()

    assert lake.URL_VAR in caplog.text
    assert capabilities.BLOB_CONNECTION_VAR in caplog.text
    assert "is not set" in caplog.text


def test_the_warning_says_it_once_and_not_per_request(
    caplog, client, two_signals, no_lake_at_all, monkeypatch
):
    # A warning on every list call is noise, and the pod already proved that.
    monkeypatch.setattr(capabilities, "_warned", False)
    capabilities.warn_once()
    # caplog holds the whole test, so drop the first, wanted warning.
    caplog.clear()

    with caplog.at_level(logging.WARNING, logger="api.capabilities"):
        capabilities.warn_once()
        client.get(URL)
        client.get(URL)

    # Read this logger only. Another module's warning is not this test's fault.
    ours = [record for record in caplog.records if record.name == "api.capabilities"]
    assert ours == [], [record.getMessage() for record in ours]


def test_ready_states_which_capabilities_this_process_can_serve(
    bare_client, no_lake_at_all, mongo_answers, monkeypatch
):
    monkeypatch.delenv(capabilities.BLOB_CONNECTION_VAR, raising=False)

    response = bare_client.get("/ready")

    listed = {item["name"]: item for item in response.json()["capabilities"]}
    assert listed["statistics"]["configured"] is False
    assert listed["statistics"]["missing_variable"] == lake.URL_VAR
    assert listed["file_downloads"]["configured"] is False


def test_a_missing_capability_never_fails_the_readiness_probe(
    bare_client, no_lake_at_all, mongo_answers, monkeypatch
):
    # The registry works without a lake and without a bucket. A probe that
    # failed on either would restart a healthy pod for a demo that runs.
    monkeypatch.delenv(capabilities.BLOB_CONNECTION_VAR, raising=False)

    response = bare_client.get("/ready")

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "ready"
