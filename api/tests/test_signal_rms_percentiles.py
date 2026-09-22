# FR-DM-014 — RMS and the three percentiles, beside the four core statistics.
#
# The requirement names six statistical quantities and the code computed four.
# `rms`, `p50`, `p95` and `p99` join them on 21 Aug 2026. Every key is
# optional, on the request and on the response, exactly as `sample_count` is.
#
# The four do not behave alike over a run of two files, and these tests hold
# the difference:
#
# * RMS merges exactly, because it is a mean of squares.
# * A percentile does NOT merge. Two medians do not give the median of the
#   union, so a multi-file signal lists a blank percentile. The API states no
#   approximation of one.
#
# The merge arithmetic is asserted against `statistics` over the pooled
# samples, so no test repeats the code under test.

import math
import statistics
import uuid

import pytest

from api.services import queries_stats
from tests import factories
from tests.factories import upsert_run

files_db = factories.files_db

FILES = "/api/v1/files"
RUN = "TAS-88214"
NAME = "HV_Batt_Cell_Temp_Max"

# Two files of one run, as the demo runbook lands them.
FIRST_SAMPLES = [1.0, 2.0, 3.0]
SECOND_SAMPLES = [8.0, 10.0]


@pytest.fixture(autouse=True)
def stats_lake(stub_lake):
    """Answer the statistics from the stub lake. This suite runs no real lake."""


def _rms(samples: list[float]) -> float:
    """The root mean square of one sample list."""
    return math.sqrt(statistics.fmean([value * value for value in samples]))


def _percentile(samples: list[float], fraction: float) -> float:
    """The linear-interpolated percentile DuckDB's quantile_cont answers."""
    ordered = sorted(samples)
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def _stats(samples: list[float], *, with_rms: bool = True, with_count: bool = True) -> dict:
    block = {
        "min": min(samples),
        "max": max(samples),
        "mean": statistics.fmean(samples),
        "std": statistics.stdev(samples),
        "p50": _percentile(samples, 0.5),
        "p95": _percentile(samples, 0.95),
        "p99": _percentile(samples, 0.99),
    }
    if with_rms:
        block["rms"] = _rms(samples)
    if with_count:
        block["sample_count"] = len(samples)
    return block


def _register(client, samples: list[float], size_bytes: int = 1000, **block) -> dict:
    body = {
        "filename": f"bat_cyc_{uuid.uuid4().hex}.mf4",
        "run_id": RUN,
        "source_system": "INCA",
        "format": "MDF 4.10",
        "size_bytes": size_bytes,
        "checksum_sha256": uuid.uuid4().hex * 2,
        "checksum_state": "verified",
        "signals": [
            {
                "name": NAME,
                "unit": "°C",
                "rate_hz": 100.0,
                "dtype": "float64",
                "stats": _stats(samples, **block),
            }
        ],
    }
    response = client.post(FILES, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _two_files(client, db, **block) -> None:
    upsert_run(db, _id=RUN)
    _register(client, FIRST_SAMPLES, size_bytes=1000, **block)
    _register(client, SECOND_SAMPLES, size_bytes=9000, **block)


def _run_row(client) -> dict:
    response = client.get(f"/api/v1/test-runs/{RUN}/signals", params={"page_size": 50})
    assert response.status_code == 200, response.text
    return next(row for row in response.json()["items"] if row["name"] == NAME)


# --- the model takes the three keys -------------------------------------------


def test_the_registration_stores_the_rms_and_the_three_percentiles(client, files_db) -> None:
    upsert_run(files_db, _id=RUN)

    file = _register(client, FIRST_SAMPLES)

    stored = files_db["file_signals"].find_one({"file_id": file["file_id"], "name": NAME})
    assert stored["stats"]["rms"] == pytest.approx(_rms(FIRST_SAMPLES))
    assert stored["stats"]["p50"] == pytest.approx(_percentile(FIRST_SAMPLES, 0.5))
    assert stored["stats"]["p95"] == pytest.approx(_percentile(FIRST_SAMPLES, 0.95))
    assert stored["stats"]["p99"] == pytest.approx(_percentile(FIRST_SAMPLES, 0.99))


def test_a_body_without_the_four_keys_still_registers(client, files_db) -> None:
    """Each key is optional. A producer that measures none registers as before."""
    upsert_run(files_db, _id=RUN)
    body = {
        "filename": "bat_cyc_20260814_0941.mf4",
        "run_id": RUN,
        "source_system": "INCA",
        "format": "MDF 4.10",
        "size_bytes": 1000,
        "checksum_sha256": uuid.uuid4().hex * 2,
        "checksum_state": "verified",
        "signals": [
            {
                "name": NAME,
                "unit": "°C",
                "rate_hz": 100.0,
                "dtype": "float64",
                "stats": {"min": 1.0, "max": 3.0, "mean": 2.0, "std": 1.0},
            }
        ],
    }

    response = client.post(FILES, json=body)

    assert response.status_code == 201, response.text
    stats = _run_row(client)["stats"]
    assert stats["min"] == 1.0
    assert stats["rms"] is None
    assert stats["p50"] is None
    assert stats["p95"] is None
    assert stats["p99"] is None


def test_an_unknown_statistic_key_still_answers_422(client, files_db) -> None:
    """`extra="forbid"` holds. Four named keys opened, nothing else.

    `p99` is a field of the model since 21 Aug 2026, so this gate cannot use
    it. `not_a_statistic` is not the name of a quantity at all, so no model
    can ever take it.
    """
    upsert_run(files_db, _id=RUN)
    body = {
        "filename": "bat_cyc_20260814_0941.mf4",
        "run_id": RUN,
        "source_system": "INCA",
        "format": "MDF 4.10",
        "size_bytes": 1000,
        "checksum_sha256": uuid.uuid4().hex * 2,
        "checksum_state": "verified",
        "signals": [
            {
                "name": NAME,
                "unit": "°C",
                "rate_hz": 100.0,
                "dtype": "float64",
                "stats": {
                    "min": 1.0,
                    "max": 3.0,
                    "mean": 2.0,
                    "std": 1.0,
                    "not_a_statistic": 2.9,
                },
            }
        ],
    }

    response = client.post(FILES, json=body)

    assert response.status_code == 422, response.text
    assert "not_a_statistic" in response.text


# --- one measured file --------------------------------------------------------


def test_one_measured_file_passes_all_four_through(client, files_db) -> None:
    """One file describes the whole run, so its own numbers pass through."""
    upsert_run(files_db, _id=RUN)
    _register(client, FIRST_SAMPLES)

    stats = _run_row(client)["stats"]

    assert stats["rms"] == pytest.approx(_rms(FIRST_SAMPLES))
    assert stats["p50"] == pytest.approx(_percentile(FIRST_SAMPLES, 0.5))
    assert stats["p95"] == pytest.approx(_percentile(FIRST_SAMPLES, 0.95))
    assert stats["p99"] == pytest.approx(_percentile(FIRST_SAMPLES, 0.99))


# --- two measured files -------------------------------------------------------


def test_two_measured_files_merge_the_rms_exactly(client, files_db) -> None:
    """The merged RMS equals the RMS of the pooled samples."""
    _two_files(client, files_db)
    pooled = FIRST_SAMPLES + SECOND_SAMPLES

    stats = _run_row(client)["stats"]

    assert stats["rms"] == pytest.approx(_rms(pooled))


def test_the_merged_rms_weighs_the_count_and_never_the_bytes(client, files_db) -> None:
    """The larger file holds the smaller count, so the two weights disagree."""
    _two_files(client, files_db)
    by_bytes = math.sqrt(
        (1000 * _rms(FIRST_SAMPLES) ** 2 + 9000 * _rms(SECOND_SAMPLES) ** 2) / 10000
    )

    rms = _run_row(client)["stats"]["rms"]

    assert rms == pytest.approx(_rms(FIRST_SAMPLES + SECOND_SAMPLES))
    assert rms != pytest.approx(by_bytes)


def test_two_measured_files_list_a_blank_percentile(client, files_db) -> None:
    """A percentile does not merge, so the run states none.

    Both files state a `p50`, a `p95` and a `p99`. The union's median is
    neither of them and no arithmetic on the stated numbers recovers it, so the
    row lists blank. This is the same rule the module holds everywhere: it
    never states a number the data does not support.
    """
    _two_files(client, files_db)

    stats = _run_row(client)["stats"]

    assert stats["p50"] is None
    assert stats["p95"] is None
    assert stats["p99"] is None
    # The four core numbers still merge, and so does the RMS.
    assert stats["mean"] == pytest.approx(statistics.fmean(FIRST_SAMPLES + SECOND_SAMPLES))
    assert stats["rms"] is not None


def test_two_measured_files_without_counts_list_blank(client, files_db) -> None:
    """No count, no merge. The four-or-none rule costs the RMS too."""
    _two_files(client, files_db, with_count=False)

    assert _run_row(client)["stats"] is None


def test_one_file_without_an_rms_costs_the_run_its_rms_alone(client, files_db) -> None:
    """A part is never served as the whole, and it costs one field only."""
    upsert_run(files_db, _id=RUN)
    _register(client, FIRST_SAMPLES, size_bytes=1000)
    _register(client, SECOND_SAMPLES, size_bytes=9000, with_rms=False)

    stats = _run_row(client)["stats"]

    assert stats["rms"] is None
    assert stats["mean"] == pytest.approx(statistics.fmean(FIRST_SAMPLES + SECOND_SAMPLES))
    assert stats["std"] == pytest.approx(statistics.stdev(FIRST_SAMPLES + SECOND_SAMPLES))


# --- the lake aggregate -------------------------------------------------------


def test_the_lake_aggregate_selects_the_four_quantities() -> None:
    """`GET /signals/{name}/stats` asks the lake for all eight numbers.

    The lake reads every sample of the group, so a percentile is exact there.
    That is why the aggregate carries one and the merge does not.
    """
    sql = queries_stats.signal_stats_sql(NAME)

    assert "sqrt(avg(value * value)) AS rms" in sql
    assert "quantile_cont(value, 0.5) AS p50" in sql
    assert "quantile_cont(value, 0.95) AS p95" in sql
    assert "quantile_cont(value, 0.99) AS p99" in sql


def test_the_stats_route_serves_the_lake_percentiles(client, files_db) -> None:
    """A run the registry could not merge takes its percentiles from the lake.

    Two measured files without counts leave the registry with nothing to
    state, so #16 asks the lake and the lake reads the samples itself.
    """
    files_db["signals"].replace_one(
        {"_id": NAME},
        {
            "_id": NAME,
            "description": None,
            "unit": "°C",
            "unit_source": "embedded",
            "dtype": "float64",
            "typical_rate_hz": 100.0,
            "run_count": 1,
            "first_seen": "2026-08-14T09:41:00Z",
            "last_seen": "2026-08-14T09:41:00Z",
            "sensor_ref": None,
            "catalogue_ref": None,
            "rig_ids": ["RIG-04"],
            "field_sources": {},
        },
        upsert=True,
    )
    _two_files(client, files_db, with_count=False)

    response = client.get(f"/api/v1/signals/{NAME}/stats")

    assert response.status_code == 200, response.text
    row = next(item for item in response.json()["items"] if item["run_id"] == RUN)
    # The stub lake answers the block of the first file by id, as the module
    # docstring states. The point is that the percentile travels at all.
    assert row["p50"] is not None
    assert row["p95"] is not None
    assert row["p99"] is not None
    assert row["rms"] is not None
