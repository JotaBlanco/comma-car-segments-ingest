# FR-DM-014 — the `stats` block of a POST /files body carries a sample count.
#
# The `mf4-stats` pipeline stage measures min, max, mean, std and a sample
# count for every signal. `SignalStatsInput` refused the count until 21 Aug
# 2026, so a signal spread over two files could not merge and fell to the lake.
#
# These tests ride the real route, so they prove the model takes the key and
# the merge reads it. The merge arithmetic itself is asserted against
# `statistics.stdev` of the union, so no test repeats the code under test.

import statistics
import uuid

import pytest

from tests import factories
from tests.factories import upsert_run

files_db = factories.files_db

FILES = "/api/v1/files"
RUN = "TAS-88214"
NAME = "HV_Batt_Cell_Temp_Max"

# Two files of one run. The counts disagree with the byte sizes on purpose, so
# a merge that weighed the bytes would answer a different mean.
FIRST_SAMPLES = [1.0, 2.0, 3.0]
SECOND_SAMPLES = [8.0, 10.0]


@pytest.fixture(autouse=True)
def stats_lake(stub_lake):
    """Answer the statistics from the stub lake. This suite runs no real lake."""


def _stats(samples: list[float], with_count: bool) -> dict:
    block = {
        "min": min(samples),
        "max": max(samples),
        "mean": statistics.fmean(samples),
        "std": statistics.stdev(samples),
    }
    if with_count:
        block["sample_count"] = len(samples)
    return block


def _register(client, samples: list[float], size_bytes: int, with_count: bool) -> dict:
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
                "stats": _stats(samples, with_count),
            }
        ],
    }
    response = client.post(FILES, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _two_files(client, db, with_count: bool) -> None:
    upsert_run(db, _id=RUN)
    # The smaller file holds the larger count, so bytes and counts disagree.
    _register(client, FIRST_SAMPLES, size_bytes=1000, with_count=with_count)
    _register(client, SECOND_SAMPLES, size_bytes=9000, with_count=with_count)


def _run_row(client) -> dict:
    response = client.get(f"/api/v1/test-runs/{RUN}/signals", params={"page_size": 50})
    assert response.status_code == 200, response.text
    return next(row for row in response.json()["items"] if row["name"] == NAME)


# --- the model takes the key --------------------------------------------------


def test_the_registration_stores_a_sample_count(client, files_db) -> None:
    upsert_run(files_db, _id=RUN)

    file = _register(client, FIRST_SAMPLES, size_bytes=1000, with_count=True)

    stored = files_db["file_signals"].find_one(
        {"file_id": file["file_id"], "name": NAME}
    )
    assert stored["stats"]["sample_count"] == len(FIRST_SAMPLES)


def test_a_body_without_a_sample_count_still_registers(client, files_db) -> None:
    """The key is optional. An older producer registers exactly as before."""
    upsert_run(files_db, _id=RUN)

    file = _register(client, FIRST_SAMPLES, size_bytes=1000, with_count=False)

    stored = files_db["file_signals"].find_one(
        {"file_id": file["file_id"], "name": NAME}
    )
    assert stored["stats"]["sample_count"] is None


def test_another_unknown_key_in_the_stats_block_still_answers_422(
    client, files_db
) -> None:
    """`extra="forbid"` holds. Only the named keys opened, nothing else.

    The block took `rms`, `p50`, `p95` and `p99` on 21 Aug 2026 (FR-DM-014),
    so this gate names a key no version of the model ever took.
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
                    "kurtosis": 2.16,
                },
            }
        ],
    }

    response = client.post(FILES, json=body)

    assert response.status_code == 422, response.text
    assert "kurtosis" in response.text


# --- the merge across two files ----------------------------------------------


def test_two_measured_files_with_counts_merge_exactly(client, files_db) -> None:
    """The merged row equals the statistics of the pooled samples."""
    _two_files(client, files_db, with_count=True)
    pooled = FIRST_SAMPLES + SECOND_SAMPLES

    stats = _run_row(client)["stats"]

    assert stats["min"] == min(pooled)
    assert stats["max"] == max(pooled)
    assert stats["mean"] == pytest.approx(statistics.fmean(pooled))
    assert stats["std"] == pytest.approx(statistics.stdev(pooled))


def test_the_merged_mean_weighs_the_count_and_never_the_bytes(
    client, files_db
) -> None:
    """The larger file holds the smaller count, so the two weights disagree."""
    _two_files(client, files_db, with_count=True)
    by_bytes = (
        1000 * statistics.fmean(FIRST_SAMPLES) + 9000 * statistics.fmean(SECOND_SAMPLES)
    ) / 10000

    mean = _run_row(client)["stats"]["mean"]

    assert mean == pytest.approx(statistics.fmean(FIRST_SAMPLES + SECOND_SAMPLES))
    assert mean != pytest.approx(by_bytes)


def test_two_measured_files_without_counts_list_blank(client, files_db) -> None:
    """The old rule holds. A part is never served as the whole.

    The route reads the registry alone, so the refusal now costs the row its
    numbers instead of sending it to the lake.
    """
    _two_files(client, files_db, with_count=False)

    assert _run_row(client)["stats"] is None


def test_one_measured_file_needs_no_count(client, files_db) -> None:
    """A single file already describes the run, so no merge and no lake."""
    upsert_run(files_db, _id=RUN)
    _register(client, FIRST_SAMPLES, size_bytes=1000, with_count=False)

    stats = _run_row(client)["stats"]

    assert stats["mean"] == pytest.approx(statistics.fmean(FIRST_SAMPLES))
    assert stats["std"] == pytest.approx(statistics.stdev(FIRST_SAMPLES))


def test_a_count_below_one_lists_blank(client, files_db) -> None:
    """Zero is not a count. The reader drops it instead of weighing by it."""
    upsert_run(files_db, _id=RUN)
    _register(client, FIRST_SAMPLES, size_bytes=1000, with_count=True)
    second = _register(client, SECOND_SAMPLES, size_bytes=9000, with_count=True)
    files_db["file_signals"].update_one(
        {"file_id": second["file_id"], "name": NAME},
        {"$set": {"stats.sample_count": 0}},
    )

    assert _run_row(client)["stats"] is None
