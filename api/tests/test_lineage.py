"""A-09 — contract #9 lineage and #6 run files.

Lineage is sync-state aware. While a run has no work order, the chain above it
is genuinely unknown, so those blocks are null and the screen draws them
dashed. The stub always showed the synced state, which hid the amber beat.
"""

from tests.factories import register_file
from tests.factories_planning import make_definition, make_run, make_work_order
from tests.factories_signals import make_file_signal

RUN = "TAS-88214"


def _seed_run(db, **overrides) -> None:
    db["test_runs"].insert_one(make_run(run_id=RUN, **overrides))


def _lineage(client, run_id: str = RUN):
    return client.get(f"/api/v1/test-runs/{run_id}/lineage")


def test_an_unsynced_run_has_no_chain_above_it(client, routed_db) -> None:
    _seed_run(routed_db, work_order_id=None, definition_id=None, status="awaiting_work_order")

    body = _lineage(client).json()

    assert body["work_order"] is None
    assert body["definition"] is None
    assert body["run"]["run_id"] == RUN


def test_the_chain_appears_after_the_backfill(client, routed_db) -> None:
    _seed_run(routed_db, work_order_id="WO-2026-0847", definition_id="TD-EM-201")
    routed_db["work_orders"].insert_one(make_work_order())
    routed_db["test_definitions"].insert_one(make_definition())

    body = _lineage(client).json()

    assert body["work_order"]["wo_id"] == "WO-2026-0847"
    assert body["work_order"]["source"] == "api:planning"
    assert body["definition"]["td_id"] == "TD-EM-201"


def test_a_missing_mirror_row_reads_as_unsynced(client, routed_db) -> None:
    """The run names a work order the mirror does not hold yet."""
    _seed_run(routed_db, work_order_id="WO-2026-0851")

    assert _lineage(client).json()["work_order"] is None


def test_the_run_block_carries_the_screen_fields(client, routed_db) -> None:
    """The two counts derive from the rows, so the case states rows (R-01).

    This test used to seed `file_count: 3` and `signal_count: 142` on a run
    that held no file at all, and read the two literals back. A run now has
    one read model, and it counts what the collections hold. 142 is the very
    figure the 18 August walk found stated against a real 11.
    """
    _seed_run(routed_db)
    for index in range(3):
        register_file(routed_db, _id=f"f-{index}")
    for name in ("CAR_SPEED", "ACC_STATUS", "AEB_REQ", "Yaw_Rate", "HV_Batt_SOC"):
        make_file_signal(routed_db, "f-0", name)
    # The same signal in a second file counts once.
    make_file_signal(routed_db, "f-1", "CAR_SPEED")

    run = _lineage(client).json()["run"]

    assert run["rig_id"] == "RIG-02"
    assert run["file_count"] == 3
    assert run["signal_count"] == 5
    assert run["status"]


def test_the_files_hang_off_the_run(client, routed_db) -> None:
    _seed_run(routed_db)
    register_file(routed_db, _id="f-1", size_bytes=1331439861, signal_count=96)

    files = _lineage(client).json()["files"]

    assert [f["file_id"] for f in files] == ["f-1"]
    assert files[0]["filename"] == "bat_cyc_20260814_0941.mf4"


def test_the_results_hang_off_the_run(client, routed_db) -> None:
    _seed_run(routed_db)
    routed_db["processed_results"].insert_one(
        {
            "_id": "res-1",
            "run_id": RUN,
            "name": "thermal_summary_v1.parquet",
            "result_key": "thermal_summary",
            "version": 1,
            "provenance_status": "verified",
            "provenance": {
                "tool": "bat-post",
                "tool_version": "2.3.1",
                "parameters": "--cycles all",
                "input_file_ids": ["f-1"],
                "produced_by": "e.lindqvist",
                "produced_at": "2026-08-14T12:02:00Z",
            },
        }
    )

    results = _lineage(client).json()["results"]

    assert [r["result_id"] for r in results] == ["res-1"]
    assert results[0]["provenance"]["tool"] == "bat-post"


def test_a_run_with_nothing_attached_reads_empty(client, routed_db) -> None:
    _seed_run(routed_db)

    body = _lineage(client).json()

    assert body["files"] == []
    assert body["results"] == []


def test_an_unknown_run_returns_404(client, routed_db) -> None:
    response = _lineage(client, "TAS-99999")

    assert response.status_code == 404
    assert response.json()["code"] == "run_not_found"


# --- #6 run files -----------------------------------------------------------


def test_the_run_files_route_reads_the_real_documents(client, routed_db) -> None:
    _seed_run(routed_db)
    register_file(routed_db, _id="f-1", filename="a.mf4")
    register_file(routed_db, _id="f-2", filename="b.csv")
    register_file(routed_db, _id="f-3", run_id="TAS-88213", filename="other.mf4")

    body = client.get(f"/api/v1/test-runs/{RUN}/files").json()

    assert body["total"] == 2
    assert {item["file_id"] for item in body["items"]} == {"f-1", "f-2"}


def test_the_run_files_envelope_is_unpaginated(client, routed_db) -> None:
    """Contract #6 returns {items, total} — no page fields."""
    _seed_run(routed_db)

    body = client.get(f"/api/v1/test-runs/{RUN}/files").json()

    assert set(body) == {"items", "total"}


def test_run_files_on_an_unknown_run_returns_404(client, routed_db) -> None:
    response = client.get("/api/v1/test-runs/TAS-99999/files")

    assert response.status_code == 404
