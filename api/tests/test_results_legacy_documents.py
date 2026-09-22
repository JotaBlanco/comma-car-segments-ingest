# A stored result must never turn a read into a 500 (contract SS-A).
#
# Contract SS-A states the rule: "A block that a response also uses gets a
# separate input model, never a shared one... a stored document written by an
# older build must never turn a read into a 500. So the gate sits on the input
# model only." `Provenance` is the write gate and it stays strict.
# `ProvenanceOut` reads, and it refuses nothing.
#
# Every case below writes a document Mongo already accepts, then reads it over
# HTTP on both routes that serve a provenance block: the #18 list and the #9
# lineage. The write gate keeps its own tests in test_results.py.

import uuid
from datetime import UTC, datetime

import pytest

from tests import factories_results
from tests.factories import upsert_run
from tests.factories_results import (
    RESULT_KEY,
    RESULTS,
    RUN_ID,
    provenance,
    seed_result,
)


def seed_legacy(db, block, **overrides):
    """Store a result whose provenance the write model would refuse.

    `seed_result` cannot do this. It hashes the document through
    `ResultCreateRequest`, which is the strict write gate, and a legacy block
    never passes it. Its `setdefault` call evaluates the hash before it tests
    the key, so an explicit hash does not skip the work either. The hash plays
    no part in a read, so this inserts the document and states one.
    """
    doc = {
        "_id": f"res-{uuid.uuid4()}",
        "run_id": RUN_ID,
        "name": "thermal_summary_v1.parquet",
        "result_key": RESULT_KEY,
        "version": 1,
        "supersedes": None,
        "description": "Cycle-level aggregates",
        "storage_ref": "blob://results/thermal_summary_v1.parquet",
        "provenance": block,
        "provenance_status": "verified",
        "created_at": datetime.now(UTC),
        "body_hash": f"legacy-{uuid.uuid4()}",
    }
    doc.update(overrides)
    db["processed_results"].insert_one(doc)
    return doc


results_db = factories_results.results_db

LINEAGE = f"/api/v1/test-runs/{RUN_ID}/lineage"

# Each case is a provenance block a stored document may legitimately carry.
# The name says which build wrote it.
LEGACY_BLOCKS = {
    "an_extra_key_from_a_later_build": provenance(
        legacy_field="written by an older build"
    ),
    "a_placeholder_produced_by": provenance(produced_by="system"),
    "a_blank_produced_by": provenance(produced_by="   "),
    "no_parameters_key": {
        key: value for key, value in provenance().items() if key != "parameters"
    },
    "no_produced_at_key": {
        key: value for key, value in provenance().items() if key != "produced_at"
    },
    "an_empty_block": {},
}


@pytest.fixture
def run(results_db):
    """The lineage route needs the run to exist."""
    upsert_run(results_db)
    return results_db


@pytest.mark.parametrize("case", sorted(LEGACY_BLOCKS))
def test_the_results_list_reads_a_legacy_provenance_block(client, run, case):
    seed_legacy(run, LEGACY_BLOCKS[case])

    response = client.get(RESULTS)

    assert response.status_code == 200, response.text
    assert response.json()["total"] == 1


@pytest.mark.parametrize("case", sorted(LEGACY_BLOCKS))
def test_the_lineage_route_reads_a_legacy_provenance_block(client, run, case):
    seed_legacy(run, LEGACY_BLOCKS[case])

    response = client.get(LINEAGE)

    assert response.status_code == 200, response.text
    assert len(response.json()["results"]) == 1


def test_one_legacy_document_never_hides_the_others(client, run):
    """The 500 took the whole page, so the guard must cover a mixed page."""
    for index, block in enumerate(LEGACY_BLOCKS.values()):
        seed_legacy(run, block, result_key=f"legacy_{index}")
    seed_result(run)

    response = client.get(RESULTS)

    assert response.status_code == 200, response.text
    assert response.json()["total"] == len(LEGACY_BLOCKS) + 1


def test_the_write_gate_still_refuses_an_unknown_provenance_key(client, run):
    """The read got tolerant. The write must not."""
    body = factories_results.result_body(
        provenance=provenance(legacy_field="written by an older build")
    )

    response = client.post(RESULTS, json=body)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "validation_error"
    assert "provenance.legacy_field" in response.json()["detail"]


def test_the_write_gate_still_refuses_a_placeholder_produced_by(client, run):
    response = client.post(
        RESULTS,
        json=factories_results.result_body(provenance=provenance(produced_by="system")),
    )

    assert response.status_code == 422, response.text
