# POST /test-runs/{run_id}/signals accepts signals by run over the API.
# PROPOSED second-wave surface — a facade over the POST /files registration
# path: the submission becomes a logical file, so the inventory, the
# catalogue, the rollups and the journal all move through the one path.

import hashlib
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest

from api.models.files import RunSignalsSubmitRequest
from api.routers import test_runs
from tests import factories
from tests.factories import upsert_run

# The assignment re-exports the fixture without shadowing an import.
files_db = factories.files_db

RUN_ID = "TAS-88214"
URL = f"/api/v1/test-runs/{RUN_ID}/signals"
ACTOR = "e.lindqvist"

T0 = datetime(2026, 8, 14, 9, 0, tzinfo=UTC)
T0_MS = int(T0.timestamp() * 1000)
T1_MS = T0_MS + 500  # half a second later


@pytest.fixture(autouse=True)
def no_lake(monkeypatch):
    """Keep the lake unconfigured, unless a test wires a fake client."""
    monkeypatch.delenv("Quix__Lakehouse__Query__Url", raising=False)
    monkeypatch.delenv("QUIX_LAKE_URL", raising=False)


def _signal(name: str = "Coolant_Inlet_Temp", **overrides) -> dict:
    row = {"name": name, "unit": "°C", "rate_hz": 100.0, "dtype": "float64"}
    row.update(overrides)
    return row


def _body(**overrides) -> dict:
    body = {"signals": [_signal()], "actor": ACTOR}
    body.update(overrides)
    return body


def _run(db) -> dict:
    return db["test_runs"].find_one({"_id": RUN_ID})


def _registered_events(db, file_id: str) -> list[dict]:
    return list(
        db["journal_entries"].find(
            {"entity_type": "file", "entity_id": file_id, "field": "file.registered"}
        )
    )


def test_inventory_only_registers_a_logical_file(client, files_db):
    upsert_run(files_db)

    response = client.post(
        URL, json=_body(signals=[_signal(), _signal("Chamber_Humidity", unit="%RH")])
    )

    assert response.status_code == 201
    body = response.json()
    assert body["run_id"] == RUN_ID
    assert body["accepted"] == [
        {"name": "Coolant_Inlet_Temp", "sample_count": 0},
        {"name": "Chamber_Humidity", "sample_count": 0},
    ]
    assert body["samples"] == "skipped"
    assert body["sample_rows"] == 0

    doc = files_db["files"].find_one({"_id": body["file_id"]})
    assert doc["run_id"] == RUN_ID
    assert doc["source_system"] == "api"  # the default, nothing sent
    assert doc["status"] == "registered"
    assert doc["checksum_state"] == "verified"
    assert doc["storage_ref"] is None
    assert doc["filename"].startswith("api-submission-")
    assert doc["filename"].endswith(".json")
    assert doc["signal_count"] == 2
    assert doc["time_start"] is None
    assert doc["time_end"] is None

    rows = list(files_db["file_signals"].find({"file_id": body["file_id"]}))
    assert {row["name"] for row in rows} == {"Coolant_Inlet_Temp", "Chamber_Humidity"}
    for row in rows:
        assert row["run_id"] == RUN_ID
        assert row["unit_source"] == "embedded"


def test_samples_with_no_lake_defer_and_the_inventory_still_lands(client, files_db):
    upsert_run(files_db, file_count=0, signal_count=0, started_at=None, ended_at=None)
    samples = [[T0_MS, 21.5], [T1_MS, 22.0]]

    response = client.post(
        URL, json=_body(signals=[_signal(rate_hz=None, samples=samples)])
    )

    assert response.status_code == 201
    body = response.json()
    assert body["samples"] == "deferred"
    assert body["sample_rows"] == 0
    assert body["accepted"] == [{"name": "Coolant_Inlet_Temp", "sample_count": 2}]

    # The inventory landed, with the rate derived from the samples.
    row = files_db["file_signals"].find_one({"file_id": body["file_id"]})
    assert row["name"] == "Coolant_Inlet_Temp"
    assert row["rate_hz"] == 2.0  # (2 - 1) samples over half a second
    # Mongo never stores a sample value.
    assert "samples" not in row
    assert "samples" not in files_db["files"].find_one({"_id": body["file_id"]})

    # The file carries the sample window, and the rollup moved the run.
    doc = files_db["files"].find_one({"_id": body["file_id"]})
    assert doc["time_start"] == T0
    assert doc["time_end"] == datetime.fromtimestamp(T1_MS / 1000.0, tz=UTC)
    run = _run(files_db)
    assert run["file_count"] == 1
    assert run["signal_count"] == 1
    assert run["started_at"] == T0

    # The journal narrates the registration, with the caller as the actor.
    events = _registered_events(files_db, body["file_id"])
    assert len(events) == 1
    assert events[0]["actor"] == ACTOR
    assert events[0]["note"] == f"Linked to run {RUN_ID}."


def test_the_catalogue_upsert_runs_for_a_submission(client, files_db):
    upsert_run(files_db)

    response = client.post(URL, json=_body())

    assert response.status_code == 201
    doc = files_db["signals"].find_one({"_id": "Coolant_Inlet_Temp"})
    assert doc is not None
    assert doc["unit"] == "°C"
    assert doc["unit_source"] == "embedded"
    assert doc["rig_ids"] == ["RIG-04"]
    assert doc["run_count"] == 1


def test_an_unknown_run_answers_404(client, files_db):
    response = client.post("/api/v1/test-runs/TAS-00000/signals", json=_body())

    assert response.status_code == 404
    assert response.json()["code"] == "run_not_found"
    assert files_db["files"].count_documents({}) == 0


def test_an_unknown_field_answers_422(client, files_db):
    upsert_run(files_db)

    response = client.post(URL, json=_body(surprise=True))

    assert response.status_code == 422
    assert files_db["files"].count_documents({}) == 0


def test_an_empty_signals_list_answers_422(client, files_db):
    upsert_run(files_db)

    response = client.post(URL, json=_body(signals=[]))

    assert response.status_code == 422
    assert files_db["files"].count_documents({}) == 0


def test_a_byte_identical_replay_returns_200_and_writes_nothing(client, files_db):
    # POST /files replay semantics ride along: the canonical payload JSON is
    # the file's bytes, so the same payload carries the same checksum and the
    # replay answers 200 with the stored file — no second document, no second
    # journal line, no rollup move, and no sample write anywhere.
    upsert_run(files_db, file_count=0, signal_count=0, started_at=None, ended_at=None)
    body = _body(signals=[_signal(samples=[[T0_MS, 21.5], [T1_MS, 22.0]])])

    first = client.post(URL, json=body)
    assert first.status_code == 201
    run_before = _run(files_db)

    replay = client.post(URL, json=body)

    assert replay.status_code == 200
    assert replay.json()["file_id"] == first.json()["file_id"]
    assert replay.json()["samples"] == "skipped"
    assert replay.json()["sample_rows"] == 0
    assert files_db["files"].count_documents({}) == 1
    assert len(_registered_events(files_db, first.json()["file_id"])) == 1
    run_after = _run(files_db)
    assert run_after["file_count"] == run_before["file_count"] == 1
    assert run_after["signal_count"] == run_before["signal_count"]
    assert run_after["updated_at"] == run_before["updated_at"]

    # A different actor is a different claim, not different data: the actor
    # stays out of the checksum, so the call is still a replay.
    other_actor = client.post(URL, json={**body, "actor": "m.larsson"})
    assert other_actor.status_code == 200
    assert other_actor.json()["file_id"] == first.json()["file_id"]


def test_samples_reach_a_configured_lake(client, files_db, monkeypatch):
    upsert_run(files_db)
    calls = []

    class FakeLakeClient:
        def write_samples(self, *, filename, run_id, time_start, samples):
            calls.append(
                {
                    "filename": filename,
                    "run_id": run_id,
                    "time_start": time_start,
                    "samples": samples,
                }
            )
            return sum(len(block.values) for block in samples)

        def close(self):
            pass

    monkeypatch.setattr("ingest.lake.build_lake_client", lambda: FakeLakeClient())

    response = client.post(
        URL, json=_body(signals=[_signal(samples=[[T0_MS, 21.5], [T1_MS, 22.0]])])
    )

    assert response.status_code == 201
    assert response.json()["samples"] == "written"
    assert response.json()["sample_rows"] == 2

    assert len(calls) == 1
    call = calls[0]
    assert call["run_id"] == RUN_ID
    assert call["filename"] == files_db["files"].find_one({})["filename"]
    assert call["time_start"] == T0
    block = call["samples"][0]
    assert block.name == "Coolant_Inlet_Temp"
    assert block.offsets_s == [0.0, 0.5]
    assert block.values == [21.5, 22.0]


# --- the doubled lake write (finding 29a) --------------------------------------


def _counting_lake(monkeypatch, calls: list, lock: threading.Lock):
    """Wire a lake client that records every write_samples call."""

    class FakeLakeClient:
        def write_samples(self, *, filename, run_id, time_start, samples):
            with lock:
                calls.append(filename)
            return sum(len(block.values) for block in samples)

        def close(self):
            pass

    monkeypatch.setattr("ingest.lake.build_lake_client", lambda: FakeLakeClient())


def test_two_identical_submissions_write_the_lake_once(client, files_db, monkeypatch):
    """The replay check alone let both callers through, and the lake doubled.

    The route reads "is this checksum registered?", writes the samples, then
    registers the file. Two identical submissions both read "no", so both wrote
    the samples, and every sample row landed twice. Nothing joined the read to
    the write.

    The test holds both callers at the replay check with a barrier, so both
    pass it before either goes on. The claim on the checksum is the one atomic
    step that separates them. Remove `_claim_submission` from the route and
    this test fails: `calls` then holds two writes.
    """
    upsert_run(files_db)
    calls: list[str] = []
    lock = threading.Lock()
    _counting_lake(monkeypatch, calls, lock)

    barrier = threading.Barrier(2, timeout=15)
    real_lookup = test_runs._existing_registered
    seen: list[int] = []

    def hold_both_callers_at_the_replay_check(db, checksum, run_id):
        found = real_lookup(db, checksum, run_id)
        with lock:
            first_pass = len(seen) < 2
            seen.append(1)
        if first_pass and found is None:
            try:
                barrier.wait()
            except threading.BrokenBarrierError:  # pragma: no cover - a slow box
                pass
        return found

    monkeypatch.setattr(
        test_runs, "_existing_registered", hold_both_callers_at_the_replay_check
    )

    body = _body(signals=[_signal(samples=[[T0_MS, 21.5], [T1_MS, 22.0]])])
    with ThreadPoolExecutor(max_workers=2) as pool:
        answers = [pool.submit(client.post, URL, json=body) for _ in range(2)]
        responses = [answer.result() for answer in answers]

    # The one guarantee: the lake saw the submission once.
    assert calls == [calls[0]]
    # One logical file, and one winner. The loser reads the winner's row, or it
    # reads 409 while the winner is still working.
    assert files_db["files"].count_documents({}) == 1
    codes = sorted(response.status_code for response in responses)
    assert codes in ([200, 201], [201, 409]), [r.text for r in responses]


def test_a_loser_that_finds_no_file_yet_answers_409(client, files_db, monkeypatch):
    """The claim is held and nothing is registered, so the caller must retry."""
    upsert_run(files_db)
    body = _body(signals=[_signal(samples=[[T0_MS, 21.5]])])
    checksum = hashlib.sha256(
        test_runs._canonical_submission(RUN_ID, RunSignalsSubmitRequest(**body))
    ).hexdigest()
    files_db[test_runs.SUBMISSION_CLAIMS].insert_one(
        {"_id": checksum, "at": datetime.now(UTC)}
    )

    response = client.post(URL, json=body)

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "submission_in_flight"
    assert files_db["files"].count_documents({}) == 0


def test_an_abandoned_claim_is_taken_over(client, files_db, monkeypatch):
    """A caller that died must not block its checksum for good."""
    upsert_run(files_db)
    body = _body(signals=[_signal(samples=[[T0_MS, 21.5]])])
    checksum = hashlib.sha256(
        test_runs._canonical_submission(RUN_ID, RunSignalsSubmitRequest(**body))
    ).hexdigest()
    stale = datetime.now(UTC) - test_runs.CLAIM_TIMEOUT - timedelta(minutes=1)
    files_db[test_runs.SUBMISSION_CLAIMS].insert_one({"_id": checksum, "at": stale})

    response = client.post(URL, json=body)

    assert response.status_code == 201, response.text
    assert files_db["files"].count_documents({}) == 1


def test_the_claim_ends_with_the_call(client, files_db):
    """A held claim would turn the next identical submission into a 409."""
    upsert_run(files_db)

    first = client.post(URL, json=_body())
    replay = client.post(URL, json=_body())

    assert first.status_code == 201, first.text
    assert replay.status_code == 200, replay.text
    assert replay.json()["file_id"] == first.json()["file_id"]
    assert files_db[test_runs.SUBMISSION_CLAIMS].count_documents({}) == 0
