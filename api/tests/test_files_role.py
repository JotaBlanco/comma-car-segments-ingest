# `role` on a file: recording vs. evaluator (spec §4.3-§4.4, dev-planning/
# implementation-as-run-file/spec.md). The no-backfill claim (§4.4): a document
# stored with no `role` key at all must filter and serve as "recording".

from tests import factories
from tests.factories import register_file, upsert_run

# The assignments re-export the fixtures without shadowing an import.
files_db = factories.files_db

RUN_ID = "TAS-88214"
CHECKSUM = "9f" * 32


def _body(**overrides) -> dict:
    body = {
        "filename": "bat_cyc_20260814_0941.mf4",
        "run_id": RUN_ID,
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 1331439861,
        "checksum_sha256": CHECKSUM,
        "checksum_state": "verified",
    }
    body.update(overrides)
    return body


def test_a_file_with_no_role_key_serves_as_a_recording(client, files_db):
    """Validates spec §4.4: `$ne: "evaluator"` matches a missing key, and the
    model default reads the same document as `role: "recording"`."""
    upsert_run(files_db, _id=RUN_ID)
    doc = register_file(files_db, filename="legacy.mf4", run_id=RUN_ID)
    assert "role" not in doc

    response = client.get(f"/api/v1/files/{doc['_id']}")

    assert response.status_code == 200, response.text
    assert response.json()["role"] == "recording"


def test_a_file_registered_as_an_evaluator_serves_that_role(client, files_db):
    upsert_run(files_db, _id=RUN_ID)
    doc = register_file(files_db, filename="impl.py", run_id=RUN_ID, role="evaluator")

    response = client.get(f"/api/v1/files/{doc['_id']}")

    assert response.status_code == 200, response.text
    assert response.json()["role"] == "evaluator"


def test_post_files_with_no_role_still_registers_and_defaults_to_recording(client, files_db):
    """Every existing producer body states no `role` and must keep working
    (spec §5.1: "so POST /files is unchanged for every existing producer")."""
    upsert_run(files_db, _id=RUN_ID)

    response = client.post("/api/v1/files", json=_body())

    assert response.status_code == 201, response.text
    assert response.json()["role"] == "recording"
    stored = files_db["files"].find_one({"checksum_sha256": CHECKSUM})
    assert stored["role"] == "recording"
