"""Per-run file identity (24 Aug 2026): registered files key on
(run, checksum). A redelivery of the same bytes to the same run replays; the
same bytes declared for a NEW run register fresh — a test platform re-runs
known recordings on purpose. Ours (overlay) until upstream takes the model."""

from tests import factories

# The assignment re-exports the fixture without shadowing an import.
files_db = factories.files_db

CHECKSUM = "ab" * 32


def _create_run(client, run_id: str) -> None:
    response = client.post(
        "/api/v1/test-runs",
        json={
            "run_id": run_id,
            "rig_id": "RIG-04",
            "source": "embedded",
            "actor": "ingestion",
        },
    )
    assert response.status_code == 201


def _body(run_id: str) -> dict:
    return {
        "filename": "bat_cyc_20260824_0900.mf4",
        "run_id": run_id,
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 120184,
        "checksum_sha256": CHECKSUM,
        "checksum_state": "verified",
    }


def test_the_same_bytes_register_fresh_on_a_new_run(client, files_db):
    _create_run(client, "TAS-97001")
    _create_run(client, "TAS-97002")

    first = client.post("/api/v1/files", json=_body("TAS-97001"))
    assert first.status_code == 201

    second = client.post("/api/v1/files", json=_body("TAS-97002"))
    assert second.status_code == 201
    assert second.json()["file_id"] != first.json()["file_id"]

    docs = list(
        files_db["files"].find({"checksum_sha256": CHECKSUM, "status": "registered"})
    )
    assert {doc["run_id"] for doc in docs} == {"TAS-97001", "TAS-97002"}


def test_a_redelivery_to_the_same_run_still_replays(client, files_db):
    _create_run(client, "TAS-97003")

    first = client.post("/api/v1/files", json=_body("TAS-97003"))
    assert first.status_code == 201

    replay = client.post("/api/v1/files", json=_body("TAS-97003"))
    assert replay.status_code == 200
    assert replay.json()["file_id"] == first.json()["file_id"]
