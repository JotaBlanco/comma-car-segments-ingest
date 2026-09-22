# Contract guards: the committed OpenAPI snapshot, and one answering test
# per §B demo endpoint.

import json
import pathlib

import pytest

SNAPSHOT_PATH = pathlib.Path(__file__).parent.parent / "docs" / "openapi.v1.json"
FIXTURE_PATH = pathlib.Path(__file__).parent / "golden_requests.json"

HERO_RUN = "TAS-88214"
HERO_WO = "WO-2026-0847"
HERO_SIGNAL = "HV_Batt_Cell_Temp_Max"


@pytest.fixture(autouse=True)
def stats_lake(stub_lake):
    """Answer the statistics from the stub lake. The local suite has no lake.

    QuixLake answers golden request 16 in a deployment. The stub serves the
    registry's own numbers in the same shape, so this guard still checks the
    contract. api/tests/test_signal_stats.py covers the real lake path.
    """


def test_openapi_matches_the_committed_snapshot(app):
    # A shape change must update plans/API-CONTRACT.md first, then this
    # snapshot, in the same commit. Regenerate with scripts/snapshot.
    committed = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    assert app.openapi() == committed


def _file_id(client) -> str:
    return client.get("/api/v1/files").json()["items"][0]["file_id"]


# The 21 §B golden requests live in golden_requests.json.
# The frontend guard (frontend/tests/contract.golden.test.ts) replays
# the same file, so both sides always test the same requests.
GOLDEN_REQUESTS = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["requests"]


@pytest.mark.parametrize(
    "req", GOLDEN_REQUESTS, ids=[r["name"] for r in GOLDEN_REQUESTS]
)
def test_every_demo_endpoint_answers(client, seeded_db, planning_offline, req):
    # planning_offline routes the toggle request (#21) to the in-process
    # planning mock. Without it the test would open a real socket — and on a
    # machine with the compose stack up, flip the real mock mid-suite.
    path = req["path"]
    if path == "__FIRST_FILE__":
        path = f"/files/{_file_id(client)}"
    response = client.request(
        req["method"], f"/api/v1{path}", params=req["query"], json=req["body"]
    )
    assert response.status_code == req["status"], response.text
    assert response.json() is not None


def test_run_detail_matches_the_contract_example(client, seeded_db):
    body = client.get(f"/api/v1/test-runs/{HERO_RUN}").json()
    assert body["run_id"] == HERO_RUN
    assert body["operator"] == "A. Bergström"  # UTF-8 survives the wire
    assert body["status"] == "awaiting_work_order"
    assert body["result_count"] == 1 and body["journal_count"] == 3
    assert body["first_data_at"] == "2026-08-14T09:41:00Z"  # ISO-8601 with Z
    assert body["field_sources"]["bench_sw"]["source"] == "api:config"
    assert body["invalid"] == {
        "flagged": False, "reason": None, "actor": None, "at": None,
    }


def test_signal_detail_carries_catalogue_fields(client, seeded_db):
    body = client.get(f"/api/v1/signals/{HERO_SIGNAL}").json()
    assert body["unit"] == "°C"
    assert body["sensor_ref"] == "PT100-B4-07"
    assert body["catalogue_ref"] == "TEMP-CELL-MAX"
    assert body["field_sources"]["catalogue_ref"]["source"] == "api:catalogue"


def test_home_summary_matches_the_contract_example(client, seeded_db):
    body = client.get("/api/v1/home/summary").json()
    assert body["counts"]["test_runs"] == 128
    # The factory cast's six definitions carry no `work_order_id` at all
    # (`api/api/stub_data.py:377-386`), so every one of them reads as orphaned.
    # The REAL demo seed writes exactly one orphan, and the contract example
    # states that number — `api/tests/test_seed_final.py` pins it.
    assert body["needs_attention"] == {
        "awaiting_work_order": 1, "quarantined_files": 2, "invalid_runs": 1,
        "orphaned_definitions": 6,
    }
    assert body["planning_sync"] == {"online": False, "last_sync_at": None}
    assert len(body["recent_runs"]) == 5


def test_toggle_off_reports_no_reset(client, routed_db, planning_offline):
    # The toggle answered `demo_reset: true` until 20 Aug 2026. It deletes
    # nothing now, so the answer is the status body of #20 and nothing more.
    # The toggle is idempotent, so each off must follow a real on.
    client.post("/api/v1/planning-sync/toggle", json={"online": True})
    body = client.post("/api/v1/planning-sync/toggle", json={"online": False}).json()
    assert body["online"] is False
    assert "demo_reset" not in body
