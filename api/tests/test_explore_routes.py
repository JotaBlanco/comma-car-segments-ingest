# The Explore context route: GET /test-runs/{run_id}/explore/context.
#
# POST /explore/query was retired on 24 Aug 2026 — the workbench posts its SQL
# straight to QuixLake through the frontend's own route. See
# plans/design/EXPLORE-DIRECT-LAKE.md and the note in plans/API-CONTRACT.md
# §D-Explore. The context route never touches the lake.

import pytest

from api.services import lake
from tests.factories import upsert_run

RUN = "TAS-88214"
CONTEXT_PATH = f"/api/v1/test-runs/{RUN}/explore/context"


@pytest.fixture(autouse=True)
def no_lake_env(monkeypatch):
    """Start every test lake-free, so a developer's shell cannot leak in."""
    for name in (lake.URL_VAR, "QUIX_LAKE_URL", lake.TOKEN_VAR, "Quix__Sdk__Token"):
        monkeypatch.delenv(name, raising=False)


# --- auth ---


def test_context_without_a_token_returns_401(bare_client):
    response = bare_client.get(CONTEXT_PATH)
    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


# --- the unknown run ---


def test_context_on_an_unknown_run_returns_404(client, routed_db):
    response = client.get("/api/v1/test-runs/TAS-00000/explore/context")
    assert response.status_code == 404
    body = response.json()
    assert set(body) == {"detail", "code", "errors"}
    assert body["code"] == "run_not_found"
    assert body["detail"] == "Run TAS-00000 not found"


# --- context ---


def test_context_answers_the_pinned_columns_and_the_run_counts(client, routed_db):
    upsert_run(routed_db, file_count=3, signal_count=142)
    response = client.get(CONTEXT_PATH)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "table": "test_signal_samples",
        "columns": ["run_id", "signal", "timestamp", "value", "filename"],
        "file_count": 3,
        "signal_count": 142,
        "sample_count": None,
        "ai_available": False,
    }


def test_context_needs_no_lake(client, routed_db):
    # Context is registry data. It answers 200 with no lake configured.
    upsert_run(routed_db)
    assert client.get(CONTEXT_PATH).status_code == 200


def test_the_context_table_name_does_not_follow_tm_lake_table(
    client, routed_db, monkeypatch
):
    """The context states the LOGICAL name, whatever the physical table is.

    The physical table and its column spellings are deployment detail. The
    frontend resolves them (`frontend/lib/explore/lake-schema.ts`); this API
    states the one logical name.
    """
    upsert_run(routed_db)
    monkeypatch.setenv("TM_LAKE_TABLE", "test_signal_samples_v3")

    body = client.get(CONTEXT_PATH).json()
    assert body["table"] == "test_signal_samples"
    assert body["columns"] == ["run_id", "signal", "timestamp", "value", "filename"]
