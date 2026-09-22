"""The demo, end to end, against the real compose stack.

Every request here crosses a real socket into a real container, and the seed
runs inside the api image — so a wrong Dockerfile, a dead compose service, a
broken cross-container URL or a seed that only works on a laptop all fail
HERE, before they fail on stage.

The tests run top to bottom against one seeded stack. Any test that flips
state puts the stage back to amber, because that is the demo's opening state
and the next test's premise.
"""

import uuid

import httpx

HERO = "TAS-88214"
HERO_TOGGLE_WO = "WO-2026-0851"

# A filler run: no other test asserts anything about it, so the file-drop
# beat below can change its rollup without moving anyone else's ground.
FILE_DROP_RUN = "TAS-70000"

# Contract §B #1 — the Home example, verbatim.
CONTRACT_HOME_COUNTS = {
    "test_runs": 128,
    "files": 512,
    "signals": 6412,
    "work_orders": 42,
    "test_definitions": 7,
    "runs_today": 6,
    "files_today": 31,
    "rig_count": 4,
}
CONTRACT_NEEDS_ATTENTION = {
    "awaiting_work_order": 1,
    "quarantined_files": 2,
    "invalid_runs": 1,
}


def test_the_stack_guards_its_door(stack) -> None:
    """The mock answers its healthcheck; the API answers only with the token."""
    health = httpx.get(f"{stack.mock_url}/health", timeout=30)
    assert health.status_code == 200

    bare = httpx.get(f"{stack.api_url}/api/v1/home/summary", timeout=30)
    assert bare.status_code == 401

    with stack.client() as client:
        assert client.get("/home/summary").status_code == 200


def test_the_docs_page_is_open_in_development(stack) -> None:
    assert httpx.get(f"{stack.api_url}/docs", timeout=30).status_code == 200


def test_the_seeded_home_matches_the_contract_example(seeded_stack) -> None:
    """Contract §B #1 against the real seed, through the real wire."""
    with seeded_stack.client() as client:
        body = client.get("/home/summary").json()

    assert body["counts"] == CONTRACT_HOME_COUNTS
    assert body["needs_attention"] == CONTRACT_NEEDS_ATTENTION
    assert body["planning_sync"]["online"] is False
    assert len(body["recent_runs"]) == 5


def test_the_self_verify_passes_inside_the_container(seeded_stack) -> None:
    """The run-book's second command, exactly where the run-book runs it."""
    result = seeded_stack.seed("--self-verify")

    assert result.returncode == 0, result.stdout + result.stderr
    assert "The demo is ready." in result.stdout
    assert "FAIL" not in result.stdout


def test_the_toggle_beat_flips_and_restores_over_http(seeded_stack) -> None:
    """The money shot: amber, green under WO-2026-0851, amber again — exact."""
    with seeded_stack.client() as client:
        before = client.get(f"/test-runs/{HERO}").json()
        assert before["status"] == "awaiting_work_order"

        on = client.post("/planning-sync/toggle", json={"online": True}).json()
        hero = client.get(f"/test-runs/{HERO}").json()
        badge = client.get("/home/summary").json()["planning_sync"]
        assert hero["status"] == "complete"
        assert hero["work_order_id"] == HERO_TOGGLE_WO
        assert on["work_orders_mirrored"] == CONTRACT_HOME_COUNTS["work_orders"] + 1
        assert badge["online"] is True

        off = client.post("/planning-sync/toggle", json={"online": False}).json()
        after = client.get(f"/test-runs/{HERO}").json()
        assert "demo_reset" not in off
        assert off["work_orders_mirrored"] == CONTRACT_HOME_COUNTS["work_orders"] + 1
        assert client.get("/home/summary").json()["planning_sync"]["online"] is False

    # A real registry never un-remembers. Toggling off stopped the sync AND
    # deleted the sync's writes until 20 Aug 2026. It only stops the sync now,
    # so the hero stays green on the wire and the mirror keeps every row.
    assert after["status"] == "complete"
    assert after["work_order_id"] == HERO_TOGGLE_WO


def test_the_work_order_that_rides_the_toggle_is_absent_at_rest(seeded_stack) -> None:
    """After the beat above, the stage is amber: 0851 must be gone again."""
    with seeded_stack.client() as client:
        response = client.get(f"/work-orders/{HERO_TOGGLE_WO}")

    assert response.status_code == 404


def test_the_file_drop_beat_registers_and_rolls_up_over_http(seeded_stack) -> None:
    """The other money shot: a file lands, the run's screens react (★ route).

    Runs LAST: a registry never forgets a file, so the test ends with the
    run-book's `--reset` — which also proves "reset the world" at stack
    level, because the Home counts come back to the contract example.
    """
    body = {
        "filename": "integration_drop_0001.mf4",
        "run_id": FILE_DROP_RUN,
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 123_456_789,
        "checksum_sha256": uuid.uuid4().hex * 2,
        "checksum_state": "verified",
        "storage_ref": "blob://quixlake-dev/integration/integration_drop_0001.mf4",
        "time_start": "2026-08-14T09:00:00Z",
        "time_end": "2026-08-14T10:00:00Z",
        "signals": [
            {"name": "INT_Sig_A", "unit": "°C", "rate_hz": 10.0, "dtype": "float64"},
            {"name": "INT_Sig_B", "unit": "V", "rate_hz": 10.0, "dtype": "float64"},
        ],
    }

    with seeded_stack.client() as client:
        before = client.get(f"/test-runs/{FILE_DROP_RUN}").json()

        created = client.post("/files", json=body)
        assert created.status_code == 201, created.text
        assert created.json()["status"] == "registered"
        file_id = created.json()["file_id"]

        after = client.get(f"/test-runs/{FILE_DROP_RUN}").json()
        assert after["file_count"] == before["file_count"] + 1

        run_files = client.get(f"/test-runs/{FILE_DROP_RUN}/files").json()
        assert any(row["file_id"] == file_id for row in run_files["items"])

        detail = client.get(f"/files/{file_id}").json()
        assert [row["name"] for row in detail["signals"]] == ["INT_Sig_A", "INT_Sig_B"]

        # A file with no run key is never dropped: it quarantines, in
        # contract order, with the server writing the reason itself.
        stray = client.post(
            "/files",
            json={
                **body,
                "filename": "integration_drop_stray.mf4",
                "run_id": "TAS-DOES-NOT-EXIST",
                "checksum_sha256": uuid.uuid4().hex * 2,
                "signals": [],
            },
        )
        assert stray.status_code == 201
        assert stray.json()["status"] == "quarantined"
        assert stray.json()["quarantine_reason"] == "no run key"

    # Back to the pristine cast — the run-book's "reset the world".
    result = seeded_stack.seed("--reset")
    assert result.returncode == 0, result.stderr
    with seeded_stack.client() as client:
        counts = client.get("/home/summary").json()["counts"]
    assert counts == CONTRACT_HOME_COUNTS
