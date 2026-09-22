"""Guards for the seed's QuixLake samples (B-17). This file is UTF-8.

QuixLake stores no statistic. It stores samples and computes min, max, mean and
standard deviation with DuckDB. The seed therefore writes samples, and these
tests prove the samples produce the exact prototype numbers.

No test here opens a socket. A fake stands in for the lake: it keeps the CSV the
seed inserts, and it aggregates that CSV the way DuckDB would.
"""

import csv
import statistics
from typing import Self

import httpx
import pytest

from api.services import lake, queries_stats
from seed import fixtures_inventory as fx

SEED_DAY = fx.REFERENCE_DAY
LAKE_URL = "https://lake.test"

# DuckDB `stddev` is `stddev_samp`, so the fake divides by n - 1 as well.
STDEV = statistics.stdev


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Clear the lake variables, so a developer's environment cannot leak in."""
    for name in (
        "TM_LAKE_TABLE",
        "TM_SEED_MAY_DROP",
        "Quix__Lakehouse__Query__Url",
        "QUIX_LAKE_URL",
        "Quix__Sdk__Token",
        "API_AUTH_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)


class FakeLake:
    """Stand in for QuixLake. Keep the inserted rows, then aggregate them."""

    def __init__(self) -> None:
        self.rows: list[dict[str, str]] = []
        self.calls: list[dict] = []

    # --- the write half: POST /insert ---

    def post(self, url, params=None, content=None, headers=None):
        self.calls.append(
            {"method": "post", "url": url, "params": params, "headers": headers}
        )
        body = content.decode("utf-8")
        self.rows.extend(csv.DictReader(body.splitlines()))
        return httpx.Response(200, json={"rows_inserted": len(self.rows)})

    # --- the reset half: DELETE /delete?mode=drop ---

    def delete(self, url, params=None, headers=None):
        self.calls.append(
            {"method": "delete", "url": url, "params": params, "headers": headers}
        )
        self.rows.clear()
        return httpx.Response(200, json={"dropped": True})

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc) -> bool:
        return False

    # --- the read half: what DuckDB computes over those rows ---

    def query(self, sql: str, transport=None) -> list[dict[str, str]]:
        """Answer the aggregate the reader built, over the inserted rows."""
        if sql != queries_stats.signal_stats_sql(fx.HERO_SIGNAL_NAME):
            return []
        grouped: dict[str, list[float]] = {}
        for row in self.rows:
            if row["signal"] != fx.HERO_SIGNAL_NAME:
                continue
            grouped.setdefault(row["run_id"], []).append(float(row["value"]))
        return [
            {
                "run_id": run_id,
                "min": repr(min(values)),
                "max": repr(max(values)),
                "mean": repr(statistics.fmean(values)),
                "std": repr(STDEV(values)),
            }
            for run_id, values in grouped.items()
        ]


# --- The arithmetic: the samples must produce the recorded numbers ---


@pytest.mark.parametrize("record", fx.HERO_RUN_STATS, ids=lambda row: row["run_id"])
def test_the_generated_samples_yield_the_target_statistics(record):
    """This is the proof of B-17, and it needs no lake.

    Every seeded run must answer the exact prototype numbers. The lake computes
    them from these samples, so the samples decide the answer.
    """
    target = record["stats"]
    values = fx.samples_for_stats(target)

    assert min(values) == pytest.approx(target["min"], rel=1e-12)
    assert max(values) == pytest.approx(target["max"], rel=1e-12)
    assert statistics.fmean(values) == pytest.approx(target["mean"], rel=1e-9)
    assert STDEV(values) == pytest.approx(target["std"], rel=1e-9)


@pytest.mark.parametrize("record", fx.HERO_RUN_STATS, ids=lambda row: row["run_id"])
def test_every_sample_stays_inside_the_recorded_range(record):
    """A sample outside min..max would make the range a lie."""
    target = record["stats"]
    values = fx.samples_for_stats(target)

    assert len(values) >= 4
    assert all(target["min"] <= value <= target["max"] for value in values)


def test_an_impossible_target_fails_loudly():
    """A deviation no sample set can reach must raise, never return a near miss."""
    with pytest.raises(ValueError, match="no sample set"):
        fx.samples_for_stats({"min": 0.0, "max": 100.0, "mean": 50.0, "std": 0.0})


def test_a_deviation_too_wide_for_the_range_fails_loudly():
    """The mean sits at the bottom of the range, so no pair fits inside it."""
    with pytest.raises(ValueError, match="no sample set"):
        fx.samples_for_stats({"min": 0.0, "max": 10.0, "mean": 1.0, "std": 4.0})


# --- The writer and the reader must name the same table and columns ---


def test_the_seed_table_matches_the_table_the_reader_queries():
    """The one-line change point. Both sides read TM_LAKE_TABLE."""
    assert fx.lake_table() == queries_stats._lake_table()
    assert fx.LAKE_TABLE == "test_signal_samples"


def test_the_table_override_moves_both_sides(monkeypatch):
    monkeypatch.setenv("TM_LAKE_TABLE", "some_other_table")
    assert fx.lake_table() == "some_other_table"
    assert f"FROM {fx.lake_table()} " in queries_stats.signal_stats_sql(fx.HERO_SIGNAL_NAME)


def test_the_seed_columns_cover_every_column_the_reader_queries():
    """The reader groups by run_id, filters on signal and aggregates value."""
    sql = queries_stats.signal_stats_sql(fx.HERO_SIGNAL_NAME)
    assert "SELECT run_id" in sql
    assert "WHERE signal = " in sql
    assert "min(value)" in sql
    for column in ("run_id", "signal", "value"):
        assert column in fx.LAKE_COLUMNS
    assert fx.LAKE_HIVE_COLUMNS == "run_id,signal"


# --- The CSV body ---


def test_the_csv_header_is_the_column_list():
    body = fx.build_lake_csv(fx.lake_samples(SEED_DAY))
    assert body.splitlines()[0] == ",".join(fx.LAKE_COLUMNS)


def test_the_csv_keeps_every_digit_of_a_value():
    """A rounded cell would move the mean and the deviation off target."""
    rows = fx.lake_samples(SEED_DAY)
    parsed = list(csv.DictReader(fx.build_lake_csv(rows).splitlines()))

    assert len(parsed) == len(rows)
    assert [float(row["value"]) for row in parsed] == [row["value"] for row in rows]


def test_the_samples_cover_all_twelve_runs():
    rows = fx.lake_samples(SEED_DAY)
    run_ids = [row["run_id"] for row in rows]

    assert len(set(run_ids)) == 12
    assert set(run_ids) == {record["run_id"] for record in fx.HERO_RUN_STATS}
    assert {row["signal"] for row in rows} == {fx.HERO_SIGNAL_NAME}


def test_the_timestamps_are_epoch_milliseconds_on_the_seed_day():
    rows = [row for row in fx.lake_samples(SEED_DAY) if row["run_id"] == fx.HERO_RUN_ID]
    record = next(
        item for item in fx.build(SEED_DAY)["hero_run_stats"] if item["run_id"] == fx.HERO_RUN_ID
    )

    assert rows[0]["timestamp"] == round(record["run_started_at"].timestamp() * 1000)
    assert rows[1]["timestamp"] - rows[0]["timestamp"] == 1000
    assert all(isinstance(row["timestamp"], int) for row in rows)


def test_only_the_hero_run_carries_a_file_name():
    """The fifth cell names the file, and only the hero run holds one.

    The cell carried the minted file id until 2026-08-19. `api/ingest/lake.py`
    writes a file name into the same column, so the one table held two
    half-empty columns. The name won, because the watcher states one for every
    row it writes.
    """
    rows = fx.lake_samples(SEED_DAY, {fx.FILE_KEY_BAT: "file-123"})
    hero = {row["filename"] for row in rows if row["run_id"] == fx.HERO_RUN_ID}
    rest = {row["filename"] for row in rows if row["run_id"] != fx.HERO_RUN_ID}

    assert hero == {fx.HERO_FILENAME}
    assert rest == {""}


def test_the_hero_file_name_is_the_one_the_registry_holds():
    """A typed name would seed a lake row no file detail can reach."""
    named = next(row for row in fx.NAMED_FILES if row["key"] == fx.FILE_KEY_BAT)

    assert fx.HERO_FILENAME == named["filename"]


# --- The insert call ---


def test_the_insert_carries_the_documented_shape(monkeypatch):
    monkeypatch.setenv("Quix__Lakehouse__Query__Url", LAKE_URL)
    fake = FakeLake()

    written = fx.write_lake_samples(fake, fx.lake_samples(SEED_DAY))

    assert written == len(fx.lake_samples(SEED_DAY))
    call = fake.calls[0]
    assert call["url"] == f"{LAKE_URL}/insert"
    assert call["params"] == {
        "table": "test_signal_samples",
        "hive_columns": "run_id,signal",
        "timestamp_column": "timestamp",
        "timestamp_format": "day",
    }


def test_an_empty_sample_list_writes_nothing():
    assert fx.write_lake_samples(FakeLake(), []) == 0


def test_the_lake_client_carries_the_bearer_token(monkeypatch):
    monkeypatch.setenv("Quix__Sdk__Token", "token-abc")
    with fx.lake_http() as http:
        assert http.headers["Authorization"] == "Bearer token-abc"


def test_the_lake_client_sends_no_header_without_a_token():
    with fx.lake_http() as http:
        assert "authorization" not in http.headers


def test_an_unconfigured_lake_stops_the_insert(monkeypatch):
    with pytest.raises(RuntimeError, match="Quix__Lakehouse__Query__Url"):
        fx.write_lake_samples(FakeLake(), fx.lake_samples(SEED_DAY))


def test_a_refused_insert_raises(monkeypatch):
    monkeypatch.setenv("Quix__Lakehouse__Query__Url", LAKE_URL)

    class Refusing(FakeLake):
        def post(self, url, params=None, content=None, headers=None):
            return httpx.Response(409, text="partition columns differ")

    with pytest.raises(RuntimeError, match="409"):
        fx.write_lake_samples(Refusing(), fx.lake_samples(SEED_DAY))


def test_an_unconfigured_lake_skips_the_seed_and_writes_nothing(caplog):
    assert fx.seed_lake(SEED_DAY) == 0
    assert "no QuixLake is configured" in caplog.text


# --- The reset: --reset drops the table before it inserts ---
#
# `POST /insert` appends. Without the drop, a second `seed --reset` run would
# double every sample row and the statistics would drift.


def _delete_calls(fake: FakeLake) -> list[dict]:
    return [call for call in fake.calls if call["method"] == "delete"]


def test_a_drop_without_a_configured_lake_raises():
    """The guard states the variable an operator sets, the way the insert does."""
    with pytest.raises(RuntimeError, match="Quix__Lakehouse__Query__Url"):
        fx.drop_lake_table(FakeLake())


def test_a_reset_drops_the_table_before_it_inserts(seeded_lake):
    """One DELETE, with mode=drop, and it comes first."""
    written = fx.seed_lake(SEED_DAY, reset=True)

    assert written > 0
    assert [call["method"] for call in seeded_lake.calls] == ["delete", "post"]
    drop = seeded_lake.calls[0]
    assert drop["url"] == f"{LAKE_URL}/delete"
    assert drop["params"] == {"table": "test_signal_samples", "mode": "drop"}


def test_the_drop_names_the_table_the_writer_inserts_into(seeded_lake, monkeypatch):
    """The table override moves the drop as well, so no other table is dropped.

    The override alone refuses now, so the operator also names the table in
    `TM_SEED_MAY_DROP`. The tests below hold that half.
    """
    monkeypatch.setenv("TM_LAKE_TABLE", "some_other_table")
    monkeypatch.setenv("TM_SEED_MAY_DROP", "some_other_table")

    fx.seed_lake(SEED_DAY, reset=True)

    assert _delete_calls(seeded_lake)[0]["params"]["table"] == "some_other_table"


# --- The reset drops only a table the seed owns ---
#
# `mf4-sink` writes `test_signal_samples_v3`, and the demo API deployment points
# `TM_LAKE_TABLE` at that same project value. An unguarded `seed --reset` would
# therefore drop the ingestion pipeline's rows.

PIPELINE_TABLE = "test_signal_samples_v3"


def test_a_reset_refuses_to_drop_a_table_the_seed_does_not_own(seeded_lake, monkeypatch):
    """`TM_LAKE_TABLE` names the pipeline's table, so no drop may reach the lake."""
    monkeypatch.setenv("TM_LAKE_TABLE", PIPELINE_TABLE)

    with pytest.raises(fx.LakeDropRefused) as refusal:
        fx.seed_lake(SEED_DAY, reset=True)

    assert seeded_lake.calls == []
    message = str(refusal.value)
    assert PIPELINE_TABLE in message
    assert "TM_SEED_MAY_DROP" in message


def test_a_refused_drop_inserts_no_row_into_the_pipeline_table(seeded_lake, monkeypatch):
    """The whole lake step stops. The seed pollutes no table it may not drop."""
    monkeypatch.setenv("TM_LAKE_TABLE", PIPELINE_TABLE)

    with pytest.raises(fx.LakeDropRefused):
        fx.seed_lake(SEED_DAY, reset=True)

    assert [call for call in seeded_lake.calls if call["method"] == "post"] == []
    assert seeded_lake.rows == []


@pytest.mark.parametrize("permission", ["", "true", "1", "yes", "test_signal_samples"])
def test_only_the_exact_table_name_permits_the_drop(seeded_lake, monkeypatch, permission):
    """A flag value, a stale name or a missing value permits nothing."""
    monkeypatch.setenv("TM_LAKE_TABLE", PIPELINE_TABLE)
    monkeypatch.setenv("TM_SEED_MAY_DROP", permission)

    with pytest.raises(fx.LakeDropRefused):
        fx.seed_lake(SEED_DAY, reset=True)

    assert seeded_lake.calls == []


def test_the_permission_names_the_table_and_the_drop_goes_through(seeded_lake, monkeypatch):
    """An operator who states the exact name gets the drop back."""
    monkeypatch.setenv("TM_LAKE_TABLE", PIPELINE_TABLE)
    monkeypatch.setenv("TM_SEED_MAY_DROP", PIPELINE_TABLE)

    written = fx.seed_lake(SEED_DAY, reset=True)

    assert written > 0
    assert _delete_calls(seeded_lake)[0]["params"]["table"] == PIPELINE_TABLE


def test_the_seed_owns_the_table_it_names_itself(seeded_lake):
    """Nothing sets `TM_LAKE_TABLE`, so the seed created this table. No flag."""
    fx.seed_lake(SEED_DAY, reset=True)

    assert _delete_calls(seeded_lake)[0]["params"]["table"] == fx.LAKE_TABLE


def test_a_seed_without_reset_drops_nothing(seeded_lake):
    """A demo points at a real lake, so an unasked drop would delete real data."""
    written = fx.seed_lake(SEED_DAY)

    assert written > 0
    assert _delete_calls(seeded_lake) == []


def test_an_unconfigured_lake_drops_nothing_and_inserts_nothing(monkeypatch, caplog):
    """The seed must still finish: the registry half works without a lake."""
    fake = FakeLake()
    monkeypatch.setattr(fx, "lake_http", lambda: fake)

    assert fx.seed_lake(SEED_DAY, reset=True) == 0
    assert fake.calls == []
    assert "no QuixLake is configured" in caplog.text


def test_a_drop_of_an_absent_table_answers_404_and_the_seed_carries_on(
    monkeypatch, seeded_lake
):
    """A first seed finds no table. 404 is the normal answer, not a failure."""

    def missing(url, params=None, headers=None):
        seeded_lake.calls.append({"method": "delete", "url": url, "params": params})
        return httpx.Response(404, text="table not found")

    monkeypatch.setattr(seeded_lake, "delete", missing)

    written = fx.seed_lake(SEED_DAY, reset=True)

    assert written == len(fx.lake_samples(SEED_DAY))
    assert len(_delete_calls(seeded_lake)) == 1


def test_a_drop_of_an_absent_table_answers_500_and_the_seed_carries_on(
    monkeypatch, seeded_lake
):
    """The measured answer of a real lake, 18 Aug 2026. A fresh stack hits this."""
    body = '{"error": "Table \'test_signal_samples\' not found in catalog or at default location"}'

    def missing(url, params=None, headers=None):
        seeded_lake.calls.append({"method": "delete", "url": url, "params": params})
        return httpx.Response(500, text=body)

    monkeypatch.setattr(seeded_lake, "delete", missing)

    written = fx.seed_lake(SEED_DAY, reset=True)

    assert written == len(fx.lake_samples(SEED_DAY))
    assert len(_delete_calls(seeded_lake)) == 1
    assert [call["method"] for call in seeded_lake.calls] == ["delete", "post"]


def test_a_refused_drop_stops_the_seed(monkeypatch, seeded_lake):
    """A drop that fails would leave the old rows, and the insert would double them."""

    def refused(url, params=None, headers=None):
        return httpx.Response(500, text="storage is down")

    monkeypatch.setattr(seeded_lake, "delete", refused)

    with pytest.raises(RuntimeError, match="refused the drop"):
        fx.seed_lake(SEED_DAY, reset=True)


def test_the_reset_flag_reaches_the_lake_through_write_inventory(
    twelve_runs, client, seeded_lake
):
    fx.write_inventory(twelve_runs, client, SEED_DAY, reset=True)

    assert len(_delete_calls(seeded_lake)) == 1


def test_the_seed_command_reset_flag_reaches_the_lake(routed_db, client, seeded_lake):
    """`seed --reset` drops the Mongo collections and the lake table together."""
    from seed import seed_demo

    seed_demo.seed(
        routed_db, client, SEED_DAY, reset=True, inventory=True, filler_records=False
    )

    assert len(_delete_calls(seeded_lake)) == 1


def test_a_reset_of_the_pipeline_table_skips_the_lake_and_still_resets_mongo(
    routed_db, client, seeded_lake, monkeypatch, caplog
):
    """The stage case. `--reset` keeps the pipeline's rows and rebuilds the cast.

    Prep step 1 of the run-book runs this command against the deployment, and
    that deployment points `TM_LAKE_TABLE` at the table `mf4-sink` fills. The
    lake step stops whole. The Mongo reset still drops the stale rows, and the
    seed still writes the cast.
    """
    from seed import seed_demo

    monkeypatch.setenv("TM_LAKE_TABLE", PIPELINE_TABLE)
    routed_db["files"].insert_one({"_id": "stale-file", "filename": "stale.mf4"})

    counts = seed_demo.seed(
        routed_db, client, SEED_DAY, reset=True, inventory=True, filler_records=False
    )

    # The lake keeps every row: no drop, no insert.
    assert seeded_lake.calls == []
    assert counts["lake_samples"] == 0
    # The Mongo reset ran, and the cast landed on top of it.
    assert routed_db["files"].find_one({"_id": "stale-file"}) is None
    assert counts["files"] == 4
    assert routed_db["files"].count_documents({}) == 4
    assert routed_db["signals"].count_documents({}) == 14
    assert seed_demo.read_watermark(routed_db) is not None
    # A person reading the log learns the table and the variable.
    assert PIPELINE_TABLE in caplog.text
    assert "TM_SEED_MAY_DROP" in caplog.text


# --- The acceptance line: twelve rows on the wire ---


@pytest.fixture
def twelve_runs(routed_db):
    """Stand in for Lane A: register every run of the hero signal's history."""
    from api.db import ensure_indexes

    ensure_indexes(routed_db)
    routed_db["test_runs"].insert_many(
        [
            {
                "_id": record["run_id"],
                "rig_id": "RIG-04",
                "definition_id": "TD-BAT-114",
                "status": "complete",
                "invalid": {"flagged": False, "reason": None, "actor": None, "at": None},
                "first_data_at": record["run_started_at"],
                "file_count": 0,
                "signal_count": 0,
            }
            for record in fx.build(SEED_DAY)["hero_run_stats"]
        ]
    )
    return routed_db


@pytest.fixture
def seeded_lake(monkeypatch):
    """Configure a lake, then answer both halves from one fake."""
    fake = FakeLake()
    monkeypatch.setenv("Quix__Lakehouse__Query__Url", LAKE_URL)
    monkeypatch.setenv("Quix__Sdk__Token", "test-token")
    monkeypatch.setattr(fx, "lake_http", lambda: fake)
    monkeypatch.setattr(lake, "query", fake.query)
    return fake


def test_the_seed_writes_every_sample_into_the_lake(twelve_runs, client, seeded_lake):
    counts = fx.write_inventory(twelve_runs, client, SEED_DAY)

    assert counts["lake_samples"] == len(seeded_lake.rows)
    assert counts["lake_samples"] > 0
    assert len({row["run_id"] for row in seeded_lake.rows}) == 12


def test_the_stats_endpoint_returns_twelve_rows_over_the_seeded_samples(
    twelve_runs, client, seeded_lake
):
    """B-17 acceptance: the count and the table agree, and both say twelve.

    The screen says "seen in 12 runs". The seed writes samples, the lake
    aggregate reads them, and the endpoint answers twelve rows.
    """
    fx.write_inventory(twelve_runs, client, SEED_DAY)

    response = client.get(
        f"{fx.API_PREFIX}/signals/{fx.HERO_SIGNAL_NAME}/stats",
        params={"window": "run", "include_invalid": True, "page_size": 50},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 12
    assert len(body["items"]) == 12


def test_the_served_rows_hold_the_exact_prototype_numbers(twelve_runs, client, seeded_lake):
    """Every served number must match the approved concept, run by run."""
    fx.write_inventory(twelve_runs, client, SEED_DAY)

    response = client.get(
        f"{fx.API_PREFIX}/signals/{fx.HERO_SIGNAL_NAME}/stats",
        params={"window": "run", "include_invalid": True, "page_size": 50},
    )

    served = {row["run_id"]: row for row in response.json()["items"]}
    for record in fx.HERO_RUN_STATS:
        row = served[record["run_id"]]
        for field, target in record["stats"].items():
            if field in ("rms", "sample_count"):
                # Registry-side additions (24 Aug 2026): the lake computes its
                # own aggregate for these; only the four numbers the samples
                # were CONSTRUCTED to hit are exact by design.
                continue
            assert row[field] == pytest.approx(target, rel=1e-9), (
                f"{record['run_id']} {field}"
            )


# --- A dead lake: the seed finishes, and it reports the missing half ---
#
# Lane A finding 3. The lake step is the last one, so a raise here left Mongo
# full, the filler unwritten and the watermark absent. A person who re-ran the
# seed could not tell what had landed.


class _DeadLake(FakeLake):
    """A configured lake that refuses every connection."""

    def post(self, url, params=None, content=None, headers=None):
        raise httpx.ConnectError("connection refused")

    def delete(self, url, params=None, headers=None):
        raise httpx.ConnectError("connection refused")


@pytest.fixture
def dead_lake(monkeypatch):
    monkeypatch.setenv("Quix__Lakehouse__Query__Url", LAKE_URL)
    monkeypatch.setattr(fx, "lake_http", _DeadLake)
    return _DeadLake


def test_a_dead_lake_does_not_stop_the_inventory(twelve_runs, client, dead_lake, caplog):
    """The Mongo half must land whole, and the report must state the zero."""
    counts = fx.write_inventory(twelve_runs, client, SEED_DAY)

    assert counts["lake_samples"] == 0
    assert counts["files"] == 4
    assert counts["file_signals"] == 12
    assert counts["processed_results"] == 1
    assert twelve_runs["files"].count_documents({}) == 4
    assert "the QuixLake seed failed" in caplog.text
    assert "connection refused" in caplog.text


def test_a_dead_lake_still_lets_the_seed_write_its_watermark(routed_db, client, dead_lake):
    """The watermark is the record of a finished seed. A dead lake must not eat it."""
    from seed import seed_demo

    counts = seed_demo.seed(
        routed_db, client, SEED_DAY, reset=True, inventory=True, filler_records=False
    )

    assert counts["lake_samples"] == 0
    assert seed_demo.read_watermark(routed_db) is not None


def test_a_refused_drop_still_stops_the_lake_write(monkeypatch, seeded_lake):
    """The report road must not reach the drop guard: no run may double the rows."""

    def refused(url, params=None, headers=None):
        return httpx.Response(500, text="storage is down")

    monkeypatch.setattr(seeded_lake, "delete", refused)

    assert fx._seed_lake_or_report(SEED_DAY, {}, True) == 0
    assert seeded_lake.rows == []
