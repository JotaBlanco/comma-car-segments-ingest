# The REAL QuixLake harness. Every other lake test answers from a mock.
#
# This suite exists to close risk 1 in `plans/STATUS.md`: no code had ever
# reached a real QuixLake. A mock agrees with our code by construction, so a
# green suite proved nothing about the table name, the column names, the insert
# shape or the CSV answer.
#
# Two suites use this harness.
#
# * `test_real_lake.py` proves the READ side (`api/services/lake.py`) and the
#   seed helper's writer.
# * `test_real_lake_writer.py` proves the WRITE side (`api/ingest/lake.py`).
#   The file watcher owned that client until 19 Aug 2026. The watcher moved to
#   the ingestion pipeline, and `POST /test-runs/{run_id}/signals` is the
#   caller that stays (`plans/design/INGEST-SPLIT.md`).
#
# It is not collected by a plain `pytest` run (`testpaths = ["tests"]`). Run it
# on purpose, against a lake:
#
#     docker compose -f docker-compose.integration-test.yml -p tmlake \
#         up -d --build postgres minio minio-setup catalog api
#     cd api
#     Quix__Lakehouse__Query__Url=http://localhost:8080 \
#     Quix__Sdk__Token=test-token-123 \
#     uv run pytest tests_lake -q
#
# The stack is the platform's own compose file, in
# `C:\Repos\Quix.DataLake.Timeseries`. See `plans/reference/LAKE-STORES.md`.
#
# **Every test writes to its own throwaway table** and drops it afterwards. No
# test reads a table another test wrote, and no run touches a shared table.

import os
import uuid

import httpx
import pytest

# A real insert plus a real aggregate needs more than a unit-test timeout.
TIMEOUT_SECONDS = 120.0


def _url() -> str:
    return os.environ.get("Quix__Lakehouse__Query__Url", "").strip().rstrip("/")


@pytest.fixture(scope="session")
def lake_url() -> str:
    """Skip the whole suite when no lake is configured."""
    url = _url()
    if not url:
        pytest.skip("no QuixLake is configured, and this suite exists to use a real one")
    return url


@pytest.fixture(scope="session")
def lake_token() -> str:
    token = os.environ.get("Quix__Lakehouse__Query__AuthToken", "").strip() or os.environ.get(
        "Quix__Sdk__Token", ""
    ).strip()
    if not token:
        pytest.skip("no QuixLake token is set")
    return token


@pytest.fixture
def lake_table(monkeypatch, lake_url, lake_token):
    """Take a throwaway table, and drop it when the test ends.

    `TM_LAKE_TABLE` moves the writer and the reader together, so the test proves
    the two sides against the same real table.
    """
    name = f"tm_probe_{uuid.uuid4().hex[:12]}"
    monkeypatch.setenv("TM_LAKE_TABLE", name)
    yield name
    with httpx.Client(timeout=TIMEOUT_SECONDS) as client:
        client.delete(
            f"{lake_url}/delete",
            params={"table": name, "mode": "drop"},
            headers={"Authorization": f"Bearer {lake_token}"},
        )
