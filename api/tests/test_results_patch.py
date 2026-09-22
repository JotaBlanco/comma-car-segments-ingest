# PATCH /results/{result_id} — contract §B #18d.
#
# A person corrects the label or the provenance of a stored result version.
# The route never touches the identity of the version: the run, the key, the
# version number, the chain, the storage reference and the derived status stay
# where the server put them.
#
# Two rules carry the weight here:
#
# 1. The provenance gate stays. A stated value that is blank answers 422
#    `provenance_required`, the same code `POST /results` answers.
# 2. The "a person edited this" mark reads the journal. The registry stores it
#    nowhere, so the mark can never disagree with the timeline.

from __future__ import annotations

import pytest

from tests import factories_results
from tests.factories_results import RESULTS, RUN_ID, seed_file, seed_result

# The assignment re-exports the fixture without shadowing an import.
results_db = factories_results.results_db

PATCH_URL = RESULTS + "/{result_id}"
DETAIL_URL = RESULTS + "/{result_id}"


def changes(db, result_id: str) -> list[dict]:
    """Every manual change entry the journal holds for one result."""
    return list(
        db["journal_entries"].find(
            {"entity_type": "result", "entity_id": result_id, "kind": "change"}
        )
    )


def patch(client, result_id: str, **body):
    body.setdefault("actor", "a.bergstrom")
    return client.patch(PATCH_URL.format(result_id=result_id), json=body)


# --- the happy path ------------------------------------------------------------


def test_an_edit_of_a_provenance_value_answers_200_and_journals_it(client, results_db):
    """One change, one journal entry, with the true old value and the new one."""
    result = seed_result(results_db)

    response = patch(
        client,
        result["_id"],
        provenance={"parameters": "--cycles 1-9 --dt 0.05"},
        note="Re-run with the shorter step.",
    )

    assert response.status_code == 200, response.text
    assert response.json()["provenance"]["parameters"] == "--cycles 1-9 --dt 0.05"

    stored = results_db["processed_results"].find_one({"_id": result["_id"]})
    assert stored["provenance"]["parameters"] == "--cycles 1-9 --dt 0.05"
    # The rest of the block is untouched.
    assert stored["provenance"]["tool"] == "bat-post"

    entries = changes(results_db, result["_id"])
    assert len(entries) == 1
    entry = entries[0]
    assert entry["field"] == "result.provenance.parameters"
    assert entry["old"] == "--cycles all --dt 0.1"
    assert entry["new"] == "--cycles 1-9 --dt 0.05"
    assert entry["source"] == "manual"
    assert entry["actor"] == "a.bergstrom"
    assert entry["note"] == "Re-run with the shorter step."
    # The run timeline unions the entries that name it as the context.
    assert entry["context_run_id"] == RUN_ID


def test_the_name_and_the_description_are_patchable(client, results_db):
    result = seed_result(results_db)

    response = patch(client, result["_id"], name="thermal_summary_v1b.parquet")

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "thermal_summary_v1b.parquet"
    assert [entry["field"] for entry in changes(results_db, result["_id"])] == [
        "result.name"
    ]


def test_the_version_chain_never_moves(client, results_db):
    """A patch corrects a version. It never mints one and never re-links one."""
    result = seed_result(results_db)

    patch(client, result["_id"], provenance={"tool_version": "2.4.0"})

    assert results_db["processed_results"].count_documents({}) == 1
    stored = results_db["processed_results"].find_one({"_id": result["_id"]})
    assert stored["version"] == 1
    assert stored["supersedes"] is None
    assert stored["run_id"] == RUN_ID
    assert stored["result_key"] == result["result_key"]
    # The fingerprint names the request that created this version, never the
    # document. A re-post of the original body must still replay.
    assert stored["body_hash"] == result["body_hash"]


# --- the refusals ---------------------------------------------------------------


@pytest.mark.parametrize("blank", ["", "   "])
def test_a_blank_provenance_value_answers_422_and_writes_nothing(
    client, results_db, blank
):
    result = seed_result(results_db)

    response = patch(client, result["_id"], provenance={"tool": blank})

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "provenance_required"
    stored = results_db["processed_results"].find_one({"_id": result["_id"]})
    assert stored["provenance"]["tool"] == "bat-post"
    assert changes(results_db, result["_id"]) == []


def test_an_input_list_that_holds_a_blank_entry_answers_422(client, results_db):
    result = seed_result(results_db)

    response = patch(client, result["_id"], provenance={"input_file_ids": ["f-1", " "]})

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "provenance_required"


@pytest.mark.parametrize(
    "key,value",
    [
        ("run_id", "TAS-99999"),
        ("version", 7),
        ("storage_ref", "blob://somewhere/else"),
        ("result_key", "other_key"),
        ("supersedes", "res-other"),
        ("provenance_status", "verified"),
        ("created_at", "2026-08-14T12:02:00Z"),
        ("result_id", "res-other"),
    ],
)
def test_a_key_the_route_never_patches_answers_422_and_names_itself(
    client, results_db, key, value
):
    """The identity of a version is minted or derived. A body may not state it."""
    result = seed_result(results_db)

    response = client.patch(
        PATCH_URL.format(result_id=result["_id"]),
        json={"actor": "a.bergstrom", key: value},
    )

    assert response.status_code == 422, response.text
    body = response.json()
    assert key in body["detail"]
    assert changes(results_db, result["_id"]) == []


@pytest.mark.parametrize("actor", ["current-user", "unknown", "quix user"])
def test_a_produced_by_that_names_nobody_answers_422(client, results_db, actor):
    result = seed_result(results_db)

    response = patch(client, result["_id"], provenance={"produced_by": actor})

    assert response.status_code == 422, response.text
    assert changes(results_db, result["_id"]) == []


def test_a_body_that_states_only_the_actor_answers_400(client, results_db):
    result = seed_result(results_db)

    response = client.patch(
        PATCH_URL.format(result_id=result["_id"]), json={"actor": "a.bergstrom"}
    )

    assert response.status_code == 400, response.text
    assert response.json()["code"] == "no_fields_to_update"


def test_a_null_value_counts_as_absent(client, results_db):
    """A null never clears a value, exactly as PATCH /files treats a null."""
    result = seed_result(results_db)

    response = client.patch(
        PATCH_URL.format(result_id=result["_id"]),
        json={"actor": "a.bergstrom", "name": None, "description": None},
    )

    assert response.status_code == 400, response.text
    assert response.json()["code"] == "no_fields_to_update"


def test_an_unknown_result_id_answers_404(client, results_db):
    response = patch(client, "res-nothing", name="whatever")

    assert response.status_code == 404, response.text
    assert response.json()["code"] == "result_not_found"


def test_an_unchanged_value_writes_no_journal_entry(client, results_db):
    """A repeated statement of the stored value is not a change."""
    result = seed_result(results_db)

    response = patch(client, result["_id"], provenance={"tool": "bat-post"})

    assert response.status_code == 200, response.text
    assert changes(results_db, result["_id"]) == []
    assert response.json()["edited"] is None


# --- the derived provenance status ---------------------------------------------


def test_an_input_id_that_names_no_file_flags_the_result(client, results_db):
    """An unresolvable input is never a refusal. It flags the result."""
    result = seed_result(results_db)
    assert result["provenance_status"] == "verified"

    response = patch(
        client, result["_id"], provenance={"input_file_ids": ["f-nothing"]}
    )

    assert response.status_code == 200, response.text
    assert response.json()["provenance_status"] == "flagged"
    # The status is derived, so it writes no journal entry of its own.
    assert [entry["field"] for entry in changes(results_db, result["_id"])] == [
        "result.provenance.input_file_ids"
    ]


def test_an_input_id_that_names_a_registered_file_verifies_the_result(
    client, results_db
):
    result = seed_result(results_db, provenance_status="flagged")
    stored_file = seed_file(results_db)

    response = patch(
        client, result["_id"], provenance={"input_file_ids": [stored_file["_id"]]}
    )

    assert response.status_code == 200, response.text
    assert response.json()["provenance_status"] == "verified"


# --- the "a person edited this" mark -------------------------------------------


def test_a_result_nobody_edited_carries_no_mark(client, results_db):
    result = seed_result(results_db)

    detail = client.get(DETAIL_URL.format(result_id=result["_id"])).json()
    listed = client.get(RESULTS, params={"run": RUN_ID}).json()["items"][0]

    assert detail["edited"] is None
    assert listed["edited"] is None


def test_an_edited_result_carries_the_mark_on_both_read_routes(client, results_db):
    result = seed_result(results_db)

    patched = patch(
        client,
        result["_id"],
        name="thermal_summary_v1b.parquet",
        provenance={"tool_version": "2.4.0"},
    ).json()

    detail = client.get(DETAIL_URL.format(result_id=result["_id"])).json()
    listed = client.get(RESULTS, params={"run": RUN_ID}).json()["items"][0]

    expected = ["result.name", "result.provenance.tool_version"]
    for body in (patched, detail, listed):
        assert body["edited"]["actor"] == "a.bergstrom"
        assert body["edited"]["fields"] == expected
        assert body["edited"]["at"].endswith("Z")


def test_the_mark_names_the_person_who_edited_last(client, results_db):
    result = seed_result(results_db)

    patch(client, result["_id"], provenance={"tool_version": "2.4.0"})
    patch(client, result["_id"], actor="e.lindqvist", name="thermal_summary_v2.parquet")

    detail = client.get(DETAIL_URL.format(result_id=result["_id"])).json()

    assert detail["edited"]["actor"] == "e.lindqvist"
    assert detail["edited"]["fields"] == [
        "result.name",
        "result.provenance.tool_version",
    ]


def test_a_write_the_server_made_never_raises_the_mark(client, results_db):
    """`POST /results` writes an event row. Only a change row is an edit."""
    from tests.factories_results import result_body

    created = client.post(RESULTS, json=result_body())

    assert created.status_code == 201, created.text
    assert created.json()["edited"] is None
    detail = client.get(
        DETAIL_URL.format(result_id=created.json()["result_id"])
    ).json()
    assert detail["edited"] is None


def test_the_mark_needs_the_bearer_token(bare_client, results_db):
    result = seed_result(results_db)

    response = bare_client.patch(
        PATCH_URL.format(result_id=result["_id"]),
        json={"actor": "a.bergstrom", "name": "x.parquet"},
    )

    assert response.status_code == 401, response.text


def test_a_microsecond_produced_at_is_no_change_when_the_millis_agree(client, results_db):
    """Mongo stores milliseconds. A µs-precision restatement of the stored
    instant once journaled a phantom "change" whose old and new differ only
    in invisible digits — and every identical retry stacked another entry on
    the result and run timelines (25 Aug 2026)."""
    from datetime import timedelta

    result = seed_result(results_db)
    stored = results_db["processed_results"].find_one({"_id": result["_id"]})
    stated = stored["provenance"]["produced_at"] + timedelta(microseconds=456)

    response = patch(
        client, result["_id"], provenance={"produced_at": stated.isoformat()}
    )

    assert response.status_code == 200, response.text
    assert changes(results_db, result["_id"]) == []
    after = results_db["processed_results"].find_one({"_id": result["_id"]})
    assert after["provenance"]["produced_at"] == stored["provenance"]["produced_at"]
    assert response.json().get("edited") is None, "a no-op must not raise the mark"


def test_a_replayed_post_serves_the_edit_mark(client, results_db):
    """A replayed POST (200) of a hand-edited result once answered
    `edited: null` while the next GET said otherwise — the mark rides every
    serve path now (25 Aug 2026 deep review)."""
    from tests.factories_results import RESULTS as RESULTS_URL
    from tests.factories_results import result_body

    body = result_body()
    first = client.post(RESULTS_URL, json=body)
    assert first.status_code == 201, first.text
    created = first.json()
    result_id = created.get("result_id") or created["_id"]
    assert created["edited"] is None, "a fresh result carries no mark"

    patch(client, result_id, provenance={"tool_version": "9.9.9"})

    replay = client.post(RESULTS_URL, json=body)

    assert replay.status_code == 200, replay.text
    assert replay.json()["edited"] is not None, "the replay must serve the mark"


def test_stored_source_reads_the_nested_dotted_shape():
    """`$set {"field_sources.provenance.tool": …}` NESTS — it writes no
    literal dotted key — so the reader walks the path the writer produced
    (25 Aug 2026 deep review, finding 5). Flat keys stay first."""
    from api.provenance import stored_source

    nested = {
        "field_sources": {"provenance": {"tool": {"source": "manual", "actor": "a", "at": "t"}}}
    }
    assert stored_source(nested, "provenance.tool") == "manual"

    flat = {"field_sources": {"rig_id": {"source": "embedded", "actor": "a", "at": "t"}}}
    assert stored_source(flat, "rig_id") == "embedded"
    assert stored_source(flat, "provenance.tool") is None
