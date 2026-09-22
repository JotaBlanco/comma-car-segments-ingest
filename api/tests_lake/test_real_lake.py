# Our lake client against a REAL QuixLake. Read `conftest.py` for the run command.
#
# These tests open real sockets. They pass no transport, so the code path is the
# one the demo runs.

import httpx
import pytest

from api.services import lake, queries_stats
from seed import fixtures_inventory as inventory

HERO = inventory.HERO_SIGNAL_NAME

# DuckDB computes in float64 and our CSV carries repr() digits, so the numbers
# come back close but not bit-identical.
TOLERANCE = 1e-9


@pytest.fixture
def written(lake_table):
    """Write the hero signal's samples into the real lake. Return the rows."""
    rows = inventory.lake_samples()
    with inventory.lake_http() as http:
        written = inventory.write_lake_samples(http, rows)
    assert written == len(rows)
    return rows


def test_the_client_reaches_a_real_lake_and_reads_its_csv(lake_table):
    """The transport works end to end: auth, the path, and the CSV answer."""
    rows = lake.query("SELECT 1 AS x, 'ok' AS y")

    assert rows == [{"x": "1", "y": "ok"}]


def test_the_insert_creates_the_table_and_no_create_table_call_runs(written, lake_table):
    """`POST /insert` creates an absent table, so no pre-create step exists.

    `api/ingest/lake.py` states this. Nothing had ever proved it.
    """
    rows = lake.query(f"SELECT count(*) AS n FROM {lake_table}")

    assert int(rows[0]["n"]) == len(written)


def test_the_seeded_samples_answer_the_signal_stats_query(written, lake_table):
    """#16 end to end: our writer, the real DuckDB aggregate, our reader.

    This is the risk-1 proof. The table name, the four column names, the hive
    partitions, the insert shape and the CSV parsing all hold at once, or this
    test fails.
    """
    rows = lake.query(queries_stats.signal_stats_sql(HERO))
    served = {row["run_id"]: queries_stats._numbers(row) for row in rows}

    expected = {record["run_id"]: record["stats"] for record in inventory.HERO_RUN_STATS}
    assert set(served) == set(expected), "the lake must answer one row per run"
    for run_id, target in expected.items():
        for field in ("min", "max", "mean", "std"):
            assert served[run_id][field] == pytest.approx(target[field], rel=TOLERANCE), (
                f"{run_id}.{field}"
            )


def test_the_run_signals_query_answers_the_mirror_question(written, lake_table):
    """#7 end to end. The two endpoints must never disagree about one run."""
    rows = lake.query(queries_stats.run_stats_sql(inventory.HERO_RUN_ID))
    served = {row["signal"]: queries_stats._numbers(row) for row in rows}

    hero = next(
        record for record in inventory.HERO_RUN_STATS
        if record["run_id"] == inventory.HERO_RUN_ID
    )
    assert set(served) == {HERO}
    for field in ("min", "max", "mean", "std"):
        assert served[HERO][field] == pytest.approx(hero["stats"][field], rel=TOLERANCE)


def test_the_sample_writer_lands_in_the_same_table_the_reader_queries(lake_table):
    """The sample writer writes a different column set. `union_by_name` must carry it.

    The seed writes `file_id`, the sample writer writes `filename`. Both hit one
    table. A unit test pins the two column tuples; only a real lake proves the
    read still works across them.
    """
    from datetime import UTC, datetime

    from ingest import lake as lake_writer
    from ingest.lake import ChannelSamples

    samples = [ChannelSamples(name=HERO, offsets_s=[0.0, 1.0, 2.0], values=[1.0, 2.0, 3.0])]
    client = lake_writer.QuixLakeClient(lake.query_url(), lake._first_env(lake._TOKEN_VARS))
    try:
        written = client.write_samples(
            filename="probe.mf4",
            run_id="TAS-PROBE",
            time_start=datetime(2026, 8, 14, 9, 41, tzinfo=UTC),
            samples=samples,
        )
    finally:
        client.close()

    assert written == 3
    rows = lake.query(queries_stats.signal_stats_sql(HERO))
    served = {row["run_id"]: queries_stats._numbers(row) for row in rows}
    assert served["TAS-PROBE"]["min"] == pytest.approx(1.0)
    assert served["TAS-PROBE"]["max"] == pytest.approx(3.0)
    assert served["TAS-PROBE"]["mean"] == pytest.approx(2.0)


def test_a_wrong_token_never_returns_rows_and_never_leaks_the_token(lake_table):
    """A wrong token must fail. It must never answer rows.

    **Measured against the running service, 18 Aug 2026.** A self-hosted lake
    answers **500**, not 403. `auth.py:67` misses the static token, `auth.py:36`
    then builds `quixportal.auth.Auth()`, and that call needs a Portal. Without
    one it raises `KeyError: 'Quix__Portal__Api'`; with an unreachable one it
    raises inside `validate_permissions`. Flask turns both into 500.

    So the 403 path belongs to a platform-hosted lake, where a Portal answers.
    `tests/test_lake_client.py` pins the 401 and 403 mapping with a mock. This
    test pins the part that holds everywhere: the call fails, and the message
    carries no token.
    """
    import os

    os.environ["Quix__Lakehouse__Query__AuthToken"] = "wrong-token-not-a-secret"
    try:
        with pytest.raises(lake.LakeError) as raised:
            lake.query("SELECT 1")
    finally:
        del os.environ["Quix__Lakehouse__Query__AuthToken"]

    assert "wrong-token-not-a-secret" not in str(raised.value)


def test_a_missing_table_never_answers_a_silent_empty_result(lake_table):
    """A wrong table name must fail loudly, or a demo screen empties in silence.

    With no Storage Access Gateway the lake reaches DuckDB, which refuses the
    unknown table and streams the `# ERROR:` trailer. Our client raises.
    """
    with pytest.raises(lake.LakeError):
        lake.query("SELECT count(*) AS n FROM table_that_does_not_exist")


def test_the_schema_call_reports_the_columns_we_wrote(written, lake_table, lake_url, lake_token):
    """`GET /schema` is the one call that settles a column name.

    Risk 1 asks for it by name. This proves the call works and that the table
    carries every column the aggregate reads.
    """
    response = httpx.get(
        f"{lake_url}/schema",
        params={"table": lake_table},
        headers={"Authorization": f"Bearer {lake_token}"},
        timeout=60.0,
    )
    response.raise_for_status()
    body = response.text

    for column in ("run_id", "signal", "timestamp", "value"):
        assert column in body, f"the real table must carry {column}"
