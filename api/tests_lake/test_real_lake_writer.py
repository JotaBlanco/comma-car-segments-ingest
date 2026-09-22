# Our sample writer against a REAL QuixLake (B-15, B-13 box 1).
#
# `test_real_lake.py` proves the read side and the seed helper's writer.
# `ingest/lake.py` is a different writer, and until now it had only ever met a
# recording fake. This file drives it against a running lake.
#
# `POST /test-runs/{run_id}/signals` is the caller. The route reaches the client
# by a deferred import in `api/api/routers/test_runs.py`.
#
# Read `conftest.py` for the run command. Every test here opens real sockets and
# passes no transport, so the code path is the one the demo runs. Every test
# takes its own throwaway table through the `lake_table` fixture.

from __future__ import annotations

import math

import httpx
import pytest

from api.services import lake as reader
from ingest import fixtures
from ingest import lake as writer_lake
from ingest.lake import ChannelSamples

# A real insert of 2000 rows plus a real aggregate needs more than a unit timeout.
TIMEOUT = 120.0

# DuckDB computes in float64 and our CSV carries repr() digits, so an aggregate
# comes back close but not always bit-identical.
TOLERANCE = 1e-9

# A small synthetic block, for the tests where the fixture is not the point.
SMALL = [ChannelSamples(name="Probe_Signal", offsets_s=[0.0, 1.0, 2.0], values=[1.0, 2.0, 4.0])]


# --- helpers -------------------------------------------------------------------------


@pytest.fixture
def writer(lake_url, lake_token):
    """The production lake client, built the way the API route builds it.

    `build_lake_client` reads the same environment the deployment injects, so
    the test never hand-builds the client the demo does not use.
    """
    client = writer_lake.build_lake_client()
    assert client is not None, "the lake environment must build a client"
    yield client
    client.close()


def record_paths(client: writer_lake.QuixLakeClient) -> list[str]:
    """Record every path the client calls. The socket stays real.

    An httpx event hook watches the live request. It replaces no transport, so
    the bytes still reach the lake.
    """
    paths: list[str] = []
    client._http.event_hooks["request"].append(lambda request: paths.append(request.url.path))
    return paths


def schema(lake_url: str, lake_token: str, table: str) -> dict:
    """Read `GET /schema`.

    **Measured 18 Aug 2026.** The lake answers 200 with an `error` key when the
    table is absent. It does not answer 404.
    """
    response = httpx.get(
        f"{lake_url}/schema",
        params={"table": table},
        headers={"Authorization": f"Bearer {lake_token}"},
        timeout=TIMEOUT,
    )
    response.raise_for_status()
    return response.json()


def absent(body: dict) -> bool:
    """Report whether `GET /schema` says the table does not exist."""
    return "error" in body


def row_count(table: str) -> int:
    """Count the rows the lake holds for the table."""
    return int(reader.query(f"SELECT count(*) AS n FROM {table}")[0]["n"])


# --- the docstring claims -------------------------------------------------------------


def test_the_insert_creates_an_absent_table_and_calls_no_create_table(
    writer, lake_table, lake_url, lake_token
):
    """`ingest/lake.py` states this and no real lake had ever answered it.

    The recorded paths prove the client sends one request, and that request is
    `/insert`. No `/create-table` call exists in the code, so a missing one
    would have shown as a failed insert instead.
    """
    assert absent(schema(lake_url, lake_token, lake_table)), "the table must not exist yet"
    paths = record_paths(writer)

    writer.write_samples(
        filename="probe.mf4", run_id="TAS-PROBE", time_start=fixtures.START_TIME, samples=SMALL
    )

    assert paths == ["/insert"]
    assert not absent(schema(lake_url, lake_token, lake_table))
    assert row_count(lake_table) == 3


def test_the_hive_partitions_land_as_partitions(writer, lake_table, lake_url, lake_token):
    """`HIVE_COLUMNS` must become the table's real partition columns.

    Both live statistics queries filter on a partition. A table partitioned on
    something else still answers, and it then scans every file.
    """
    writer.write_samples(
        filename="probe.mf4", run_id="TAS-PROBE", time_start=fixtures.START_TIME, samples=SMALL
    )

    body = schema(lake_url, lake_token, lake_table)

    assert body["partitions"] == writer_lake.HIVE_COLUMNS.split(",")


def test_the_schema_carries_every_column_the_writer_sends(writer, lake_table, lake_url, lake_token):
    """The five `COLUMNS` must all exist in the real table."""
    writer.write_samples(
        filename="probe.mf4", run_id="TAS-PROBE", time_start=fixtures.START_TIME, samples=SMALL
    )

    body = schema(lake_url, lake_token, lake_table)
    types = {column["name"]: column["type"] for column in body["columns"]}

    assert set(types) == set(writer_lake.COLUMNS)
    assert types["value"] == "double"


def test_the_timestamp_column_stays_a_long_and_never_becomes_a_datetime(
    writer, lake_table, lake_url, lake_token
):
    """The 2026-08-18 correction in `build_csv`, measured again.

    The comment used to claim the lake reads a value above 1e12 as milliseconds
    and mints a datetime column. It does not: the lake derives a time partition
    only when `hive_columns` holds a time part, and ours holds `run_id,signal`.
    """
    writer.write_samples(
        filename="probe.mf4", run_id="TAS-PROBE", time_start=fixtures.START_TIME, samples=SMALL
    )

    body = schema(lake_url, lake_token, lake_table)
    types = {column["name"]: column["type"] for column in body["columns"]}

    assert types["timestamp"] == "long"


def test_a_file_without_a_start_time_never_touches_the_real_lake(
    writer, lake_table, lake_url, lake_token
):
    """A CSV export states no start time, so its samples stay out of the lake.

    A unit test pins the return value. This test pins the part a fake cannot
    show: the real lake is never asked, and it mints no empty table.
    """
    paths = record_paths(writer)

    written = writer.write_samples(
        filename="probe.csv", run_id="TAS-PROBE", time_start=None, samples=SMALL
    )

    assert written == 0
    assert paths == []
    assert absent(schema(lake_url, lake_token, lake_table))


def test_a_file_without_a_run_key_never_touches_the_real_lake(
    writer, lake_table, lake_url, lake_token
):
    """`run_id` is the first hive partition, so a row without one answers no query."""
    paths = record_paths(writer)

    written = writer.write_samples(
        filename="probe.mf4", run_id=None, time_start=fixtures.START_TIME, samples=SMALL
    )

    assert written == 0
    assert paths == []
    assert absent(schema(lake_url, lake_token, lake_table))


def test_an_insert_with_other_partitions_answers_409(writer, lake_table, lake_url, lake_token):
    """`ingest/lake.py` states the 409 rule. This measures it.

    The claim: `POST /insert` answers 409 only when the table already exists
    with other partition columns. Our client always sends `HIVE_COLUMNS`, so it
    never meets this. A future change to the constant would, and it would then
    break every existing table instead of creating a new one.
    """
    writer.write_samples(
        filename="probe.mf4", run_id="TAS-PROBE", time_start=fixtures.START_TIME, samples=SMALL
    )
    body = writer_lake.build_csv("probe.mf4", "TAS-PROBE", fixtures.START_TIME, SMALL)

    refused = httpx.post(
        f"{lake_url}/insert",
        params={
            "table": lake_table,
            "hive_columns": "filename",
            "timestamp_column": writer_lake.TIMESTAMP_COLUMN,
            "timestamp_format": writer_lake.TIMESTAMP_FORMAT,
        },
        content=body.encode("utf-8"),
        headers={"Authorization": f"Bearer {lake_token}", "Content-Type": "text/csv"},
        timeout=TIMEOUT,
    )

    assert refused.status_code == 409
    assert refused.json()["error_type"] == "partition_mismatch"


def test_the_lake_loses_the_last_bit_of_one_awkward_value(writer, lake_table):
    """**A contradiction, measured 18 Aug 2026. The round trip is not bit-exact.**

    `build_csv` sends `repr(value)`, and a unit test proves the request body
    carries every digit. The lake still loses the last bit of some values.
    `0.30000000000000004` comes back as `0.3`, one unit in the last place away.
    Every other value measured here survives exactly.

    The cause sits on the lake side, not in ours. The synchronous insert parses
    our CSV with `pandas.read_csv`
    (`Quix.DataLake.Timeseries/quix-ts-datalake-api/main.py:1477`, and
    `duck_db_service.py:3083` for the async path). The default pandas float
    parser is fast, not exact. DuckDB itself is exact: the same lake answers
    `'0.30000000000000004'::DOUBLE` with every digit.

    The error is one ULP, about 6e-17 relative. Every statistics test holds to
    1e-9, so no screen changes today. This test pins the **size** of the error.
    A larger loss then fails loudly instead of moving a number in silence.
    """
    awkward = 0.1 + 0.2
    exact = [0.1, 1.5, 1.2345678901234567, 123456789.12345678, 3.141592653589793]
    values = [awkward, *exact]
    samples = [
        ChannelSamples(
            name="Probe_Signal",
            offsets_s=[float(index) for index in range(len(values))],
            values=values,
        )
    ]

    writer.write_samples(
        filename="probe.mf4", run_id="TAS-PROBE", time_start=fixtures.START_TIME, samples=samples
    )

    # printf carries every digit. A plain SELECT prints the shortest form, and
    # that form alone would hide which side lost the bit.
    rows = reader.query(
        f"SELECT printf('%.17g', value) AS p FROM {lake_table} ORDER BY timestamp"
    )
    served = [float(row["p"]) for row in rows]

    assert served[0] == pytest.approx(awkward, abs=2 * math.ulp(awkward))
    assert served[1:] == exact, "only the one awkward value loses a bit"


def test_a_second_write_of_the_same_file_appends_and_never_replaces(writer, lake_table):
    """`POST /insert` appends. It does not replace the partition.

    Only a real lake answers this. It matters for a re-sent submission: the
    route must never reach the lake twice for one file, or the rows double.
    `POST /test-runs/{run_id}/signals` runs its replay check before the lake
    write. `_forward_samples` in `api/api/routers/test_runs.py` holds that order.
    """
    for _ in range(2):
        writer.write_samples(
            filename="probe.mf4",
            run_id="TAS-PROBE",
            time_start=fixtures.START_TIME,
            samples=SMALL,
        )

    assert row_count(lake_table) == 2 * writer_lake.row_count(SMALL)
