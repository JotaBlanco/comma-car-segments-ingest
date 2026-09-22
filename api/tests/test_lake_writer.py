"""The QuixLake writer (B-13, new 2026-08-17).

These tests need no Docker, no Mongo and no lake. A fake HTTP transport
stands in for the lake API, so the client code path is the one production
runs — only the transport changes.

The rework this covers: statistics never reach Mongo. The samples reach
QuixLake, and a statistics question queries the lake.

**The caller, since 19 Aug 2026.** `POST /test-runs/{run_id}/signals` reaches
this client by a deferred import (`api/api/routers/test_runs.py`). The file
watcher called it before, and the watcher moved to the ingestion pipeline.
"""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime

import httpx
import pytest

from ingest.lake import (
    COLUMNS,
    DEFAULT_TABLE,
    HIVE_COLUMNS,
    ChannelSamples,
    QuixLakeClient,
    build_csv,
    build_lake_client,
    row_count,
    table_name,
)

RUN = "TAS-88214"
START = datetime(2026, 8, 14, 9, 41, 0, tzinfo=UTC)
START_MS = int(START.timestamp() * 1000)

SAMPLES = [
    ChannelSamples(name="HV_Batt_Cell_Temp_Max", offsets_s=[0.0, 0.5], values=[18.2, 33.4]),
    ChannelSamples(name="Coolant_Inlet_Temp", offsets_s=[0.0, 0.5], values=[20.0, 21.0]),
]


def rows(body: str) -> list[list[str]]:
    """Parse the CSV body back into rows."""
    return list(csv.reader(io.StringIO(body)))


# --- the CSV body --------------------------------------------------------------------


def test_the_csv_body_starts_with_the_header_row():
    assert rows(build_csv("a.mf4", RUN, START, SAMPLES))[0] == list(COLUMNS)


def test_the_csv_body_holds_one_row_per_sample():
    body = rows(build_csv("a.mf4", RUN, START, SAMPLES))

    assert len(body) == 1 + 4
    assert body[1] == [RUN, "HV_Batt_Cell_Temp_Max", str(START_MS), "18.2", "a.mf4"]
    assert body[2] == [RUN, "HV_Batt_Cell_Temp_Max", str(START_MS + 500), "33.4", "a.mf4"]
    assert body[3] == [RUN, "Coolant_Inlet_Temp", str(START_MS), "20.0", "a.mf4"]


def test_the_timestamp_is_epoch_milliseconds():
    """The lake reads a value above 1e12 as milliseconds. Seconds would be wrong."""
    stamp = int(rows(build_csv("a.mf4", RUN, START, SAMPLES))[1][2])

    assert stamp > 1e12
    assert stamp == START_MS


def test_the_csv_body_quotes_a_name_that_holds_a_comma():
    samples = [ChannelSamples(name="Temp, front", offsets_s=[0.0], values=[1.0])]

    body = build_csv("a,b.mf4", RUN, START, samples)

    assert rows(body)[1][1] == "Temp, front"
    assert rows(body)[1][4] == "a,b.mf4"


def test_the_csv_body_keeps_the_full_precision_of_a_value():
    samples = [ChannelSamples(name="x", offsets_s=[0.0], values=[0.1 + 0.2])]

    assert rows(build_csv("a.mf4", RUN, START, samples))[1][3] == repr(0.1 + 0.2)


def test_row_count_adds_every_channel():
    assert row_count(SAMPLES) == 4
    assert row_count([]) == 0


# --- the insert call -----------------------------------------------------------------


def fake_client(handler, token: str | None = "t-123") -> QuixLakeClient:
    """A lake client whose transport answers from the handler."""
    client = QuixLakeClient("http://lake.local", token)
    client._http = httpx.Client(
        base_url="http://lake.local",
        headers=client._http.headers,
        transport=httpx.MockTransport(handler),
    )
    return client


def test_the_insert_call_names_the_table_and_the_partitions():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = request.url
        seen["body"] = request.content.decode("utf-8")
        seen["auth"] = request.headers.get("Authorization")
        return httpx.Response(200, json={"rows_inserted": 4})

    written = fake_client(handler).write_samples(
        filename="a.mf4", run_id="TAS-88214", time_start=START, samples=SAMPLES
    )

    assert written == 4
    assert seen["url"].path == "/insert"
    assert seen["url"].params["table"] == DEFAULT_TABLE
    assert seen["url"].params["hive_columns"] == HIVE_COLUMNS
    assert seen["url"].params["timestamp_column"] == "timestamp"
    assert seen["url"].params["timestamp_format"] == "day"
    assert seen["auth"] == "Bearer t-123"
    assert seen["body"].splitlines()[0] == ",".join(COLUMNS)


def test_the_client_counts_the_rows_when_the_lake_states_none():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"message": "ok"})

    written = fake_client(handler).write_samples(
        filename="a.mf4", run_id=RUN, time_start=START, samples=SAMPLES
    )

    assert written == 4


def test_the_client_raises_on_a_refused_insert():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"error_type": "partition_mismatch"})

    with pytest.raises(httpx.HTTPStatusError):
        fake_client(handler).write_samples(
            filename="a.mf4", run_id=RUN, time_start=START, samples=SAMPLES
        )


def test_no_samples_means_no_call():
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("the client must send nothing")

    assert (
        fake_client(handler).write_samples(
            filename="a.mf4", run_id=RUN, time_start=START, samples=[]
        )
        == 0
    )


def test_a_file_without_a_start_time_writes_nothing():
    """A sample offset is seconds from the start. No start means no honest row.

    A CSV export states no start time, so its samples stay out of the lake. The
    registry still holds the file and its signal inventory. This is a recorded
    limit, not a defect.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("the client must send nothing")

    assert (
        fake_client(handler).write_samples(
            filename="a.csv", run_id=RUN, time_start=None, samples=SAMPLES
        )
        == 0
    )


def test_a_file_without_a_run_key_writes_nothing():
    """`run_id` is the first hive partition. An empty partition answers no query."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("the client must send nothing")

    assert (
        fake_client(handler).write_samples(
            filename="a.mf4", run_id=None, time_start=START, samples=SAMPLES
        )
        == 0
    )


def test_the_client_sends_no_bearer_header_without_a_token():
    def handler(request: httpx.Request) -> httpx.Response:
        assert "Authorization" not in request.headers
        return httpx.Response(200, json={"rows_inserted": 4})

    assert (
        fake_client(handler, token=None).write_samples(
            filename="a.mf4", run_id=RUN, time_start=START, samples=SAMPLES
        )
        == 4
    )


def test_the_client_closes_its_transport():
    client = QuixLakeClient("http://lake.local", "t")
    client.close()

    assert client._http.is_closed


# --- the builder ---------------------------------------------------------------------


def test_the_builder_reads_the_injected_url_and_token(monkeypatch):
    monkeypatch.setenv("Quix__Lakehouse__Query__Url", "http://lake.svc.cluster.local:80/")
    monkeypatch.delenv("Quix__Lakehouse__Query__AuthToken", raising=False)
    monkeypatch.setenv("Quix__Sdk__Token", "sdk-token")

    client = build_lake_client()

    assert client is not None
    assert client.base_url == "http://lake.svc.cluster.local:80"
    assert client._http.headers["Authorization"] == "Bearer sdk-token"
    client.close()


def test_the_query_auth_token_wins_over_the_sdk_token(monkeypatch):
    monkeypatch.setenv("Quix__Lakehouse__Query__Url", "http://lake.local")
    monkeypatch.setenv("Quix__Lakehouse__Query__AuthToken", "query-token")
    monkeypatch.setenv("Quix__Sdk__Token", "sdk-token")

    client = build_lake_client()

    assert client._http.headers["Authorization"] == "Bearer query-token"
    client.close()


def test_the_builder_answers_none_without_a_url(monkeypatch):
    """Without the lake the API still registers the file. It never stops."""
    monkeypatch.delenv("Quix__Lakehouse__Query__Url", raising=False)

    assert build_lake_client() is None


# --- the drift guard: the writer and the reader must name the same thing -------------


def test_the_writer_and_the_reader_name_the_same_table(monkeypatch):
    """The two halves must agree, or no query reads what the writer wrote.

    The first build wrote `mdf_file_test` with `file_name,channel`. The reader
    queries `test_signal_samples` and groups by `run_id`. Nothing matched. The
    backend lead ruled on 2026-08-17 that the reader is right. This test stops
    the drift from coming back.
    """
    from api.services import queries_stats

    monkeypatch.delenv("TM_LAKE_TABLE", raising=False)
    assert table_name() == queries_stats._lake_table()

    monkeypatch.setenv("TM_LAKE_TABLE", "other_table")
    assert table_name() == queries_stats._lake_table() == "other_table"


def test_the_writer_holds_every_column_the_reader_queries():
    """Every column the reader's SQL names must exist in the CSV the writer sends."""
    from api.services import queries_stats

    sql = queries_stats.signal_stats_sql("HV_Batt_Cell_Temp_Max") + queries_stats.run_stats_sql(
        "TAS-88214"
    )

    for column in ("run_id", "signal", "value"):
        assert column in sql
        assert column in COLUMNS


def test_the_hive_partitions_are_the_two_columns_the_reader_filters_on():
    """Both live queries filter on a partition, so neither reads the whole table."""
    assert HIVE_COLUMNS == "run_id,signal"


# --- the writer and the reader must accept the same URL names ----------------------


def test_the_writer_accepts_the_fallback_url_name(monkeypatch):
    """`QUIX_LAKE_URL` must build a writer, because the reader builds on it.

    `api/api/services/lake.py` accepts two names and `api/README.md` documents
    the second as the fallback. When only the reader accepted it, the API
    answered from the lake while the writer wrote nothing, and the only sign
    was one warning line. The two lists must stay equal.
    """
    from ingest import lake as writer

    monkeypatch.delenv("Quix__Lakehouse__Query__Url", raising=False)
    monkeypatch.setenv("QUIX_LAKE_URL", "http://fallback.test")
    monkeypatch.setenv("Quix__Sdk__Token", "test-token")

    client = build_lake_client()

    assert client is not None, "the writer ignored the name the reader accepts"
    assert client.base_url == "http://fallback.test"
    assert writer.query_url() == "http://fallback.test"


def test_the_writer_and_the_reader_read_the_same_url_names():
    """One list on each side. A name on one side only splits the two halves."""
    from api.services import lake as reader
    from ingest import lake as writer

    assert writer.URL_VARS == reader._URL_VARS


def test_the_primary_url_name_still_wins(monkeypatch):
    from ingest import lake as writer

    monkeypatch.setenv("Quix__Lakehouse__Query__Url", "http://primary.test")
    monkeypatch.setenv("QUIX_LAKE_URL", "http://fallback.test")

    assert writer.query_url() == "http://primary.test"


# --- the value contract: what a cell may hold (R-05, 2026-08-19) ---------------------

NON_FINITE = [
    ChannelSamples(
        name="Coolant_Inlet_Temp",
        offsets_s=[0.0, 0.5, 1.0],
        values=[20.0, float("inf"), 21.0],
    )
]


def test_a_value_that_is_not_finite_writes_no_row():
    """One `inf` in a channel drops that sample and keeps the rest.

    The lake stores the cell as text. DuckDB then aggregates it, and an `inf`
    makes the aggregate answer a number JSON cannot carry, which the API maps
    to 503. The whole statistics beat fails on one bad sample, so the writer
    drops the sample and keeps the file.
    """
    body = rows(build_csv("a.mf4", RUN, START, NON_FINITE))

    assert len(body) == 1 + 2, "the inf sample still reached the lake"
    assert [row[3] for row in body[1:]] == ["20.0", "21.0"]
    assert row_count(NON_FINITE) == 2, "row_count must agree with the body"


def test_a_nan_writes_no_row():
    samples = [ChannelSamples(name="s", offsets_s=[0.0], values=[float("nan")])]

    assert len(rows(build_csv("a.mf4", RUN, START, samples))) == 1
    assert row_count(samples) == 0


def test_a_numpy_value_writes_a_plain_number():
    """`repr` of a numpy scalar names the type. `float()` first is the fix.

    numpy 2 renders `repr(np.float64(18.2))` as `np.float64(18.2)`. A caller
    that reads a measurement file with asammdf hands the writer numpy arrays,
    so this is a real path, not a corner. The cell must hold a number DuckDB
    can read.
    """
    numpy = pytest.importorskip("numpy")
    samples = [
        ChannelSamples(name="s", offsets_s=[0.0], values=list(numpy.array([18.2])))
    ]

    assert rows(build_csv("a.mf4", RUN, START, samples))[1][3] == "18.2"


def test_the_two_writers_name_the_same_columns():
    """The lake writer and the seed write one table, so they state one column list.

    They drifted: this module named the fifth column `filename` and the seed
    named it `file_id`, so one table grew two half-empty columns. This test
    fails the moment they drift again.
    """
    from ingest import lake as writer
    from seed import fixtures_inventory as seed

    assert writer.COLUMNS == seed.LAKE_COLUMNS
    assert writer.DEFAULT_TABLE == seed.LAKE_TABLE
    assert writer.HIVE_COLUMNS == seed.LAKE_HIVE_COLUMNS
    assert writer.TIMESTAMP_COLUMN == seed.LAKE_TIMESTAMP_COLUMN
    assert writer.TIMESTAMP_FORMAT == seed.LAKE_TIMESTAMP_FORMAT
