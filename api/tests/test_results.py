# POST /results and the #18 list (ticket B-16, appendix *).
#
# The provenance gate is this lane's mandatory guard. Malformed provenance is
# rejected. Unverifiable provenance is flagged. The two never swap places.

import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import pytest

from api.routers import results as results_router
from tests import factories_results
from tests.factories_results import (
    PROVENANCE_KEYS,
    RESULT_KEY,
    RESULTS,
    RUN_ID,
    provenance,
    result_body,
    seed_file,
    seed_result,
)

# The assignment re-exports the fixture without shadowing an import.
results_db = factories_results.results_db


def _stored(db) -> int:
    return db["processed_results"].count_documents({})


def test_missing_provenance_returns_422_and_stores_nothing(client, results_db):
    body = result_body()
    body.pop("provenance")

    response = client.post(RESULTS, json=body)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "provenance_required"
    assert _stored(results_db) == 0


def test_null_provenance_returns_422_and_stores_nothing(client, results_db):
    response = client.post(RESULTS, json=result_body(provenance=None))

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "provenance_required"
    assert _stored(results_db) == 0


@pytest.mark.parametrize("key", PROVENANCE_KEYS)
def test_each_missing_provenance_key_returns_422(client, results_db, key):
    incomplete = provenance()
    incomplete.pop(key)

    response = client.post(RESULTS, json=result_body(provenance=incomplete))

    assert response.status_code == 422, response.text
    body = response.json()
    assert body["code"] == "provenance_required"
    assert key in body["detail"]
    assert _stored(results_db) == 0


BLANK_VALUES = {
    "tool": "",
    "tool_version": "   ",
    "parameters": "",
    "produced_by": "  ",
    "produced_at": "",
    # A blank entry is a malformed id, so the gate rejects it. An empty
    # input_file_ids list is well-formed and the route flags it instead.
    "input_file_ids": [""],
}


@pytest.mark.parametrize("key", PROVENANCE_KEYS)
def test_each_blank_provenance_value_returns_422(client, results_db, key):
    blank = provenance(**{key: BLANK_VALUES[key]})

    response = client.post(RESULTS, json=result_body(provenance=blank))

    assert response.status_code == 422, response.text
    body = response.json()
    assert body["code"] == "provenance_required"
    assert key in body["detail"]
    assert _stored(results_db) == 0


def test_a_null_provenance_value_returns_422(client, results_db):
    response = client.post(RESULTS, json=result_body(provenance=provenance(tool=None)))

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "provenance_required"
    assert "tool" in response.json()["detail"]
    assert _stored(results_db) == 0


def test_a_wrong_provenance_type_is_a_validation_error(client, results_db):
    # A number is not blank, so the gate passes it on. The field validation
    # then answers 422 validation_error. The two codes never swap places.
    response = client.post(RESULTS, json=result_body(provenance=provenance(parameters=5)))

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "validation_error"
    assert _stored(results_db) == 0


def test_an_unknown_key_inside_provenance_is_rejected_not_replayed(client, results_db):
    # An unknown key never reaches the fingerprint. Without the nested guard
    # the second post would hash like the first, and the replay rule would
    # answer 200 and discard the caller's key without a word.
    first = client.post(RESULTS, json=result_body())

    response = client.post(
        RESULTS, json=result_body(provenance=provenance(wrong_field=1))
    )

    assert first.status_code == 201, first.text
    assert response.status_code == 422, response.text
    assert "wrong_field" in response.json()["detail"]
    assert _versions(results_db) == [1]


def test_a_body_that_is_not_an_object_returns_422_not_500(client, results_db):
    # The gate reads a mapping. A JSON array must fall through to the field
    # validation and answer 422, never a 500.
    response = client.post(RESULTS, json=["not", "an", "object"])

    assert response.status_code == 422, response.text
    assert _stored(results_db) == 0


def test_unknown_field_returns_422_naming_the_field(client, results_db):
    response = client.post(RESULTS, json=result_body(wrong_field=1))

    assert response.status_code == 422, response.text
    assert "wrong_field" in response.json()["detail"]
    assert _stored(results_db) == 0


# --- #18 GET /results over Mongo ---


def _ids(page: dict) -> list[str]:
    return [item["result_id"] for item in page["items"]]


def test_the_list_returns_the_stored_result_on_the_wire(client, results_db):
    stored = seed_result(results_db)

    page = client.get(RESULTS).json()

    assert page["total"] == 1
    item = page["items"][0]
    assert item["result_id"] == stored["_id"]
    assert item["version"] == 1
    assert item["supersedes"] is None
    assert item["provenance_status"] == "verified"
    assert set(PROVENANCE_KEYS) <= set(item["provenance"])
    assert item["provenance"]["produced_at"] == "2026-08-14T12:02:00Z"


def test_the_run_filter_splits_the_results(client, results_db):
    mine = seed_result(results_db)
    seed_result(results_db, run_id="TAS-88105")

    page = client.get(RESULTS, params={"run": RUN_ID}).json()

    assert _ids(page) == [mine["_id"]]
    assert page["total"] == 1


def test_the_result_key_filter_splits_the_results(client, results_db):
    mine = seed_result(results_db)
    seed_result(results_db, result_key="cycle_counts")

    page = client.get(RESULTS, params={"result_key": RESULT_KEY}).json()

    assert _ids(page) == [mine["_id"]]


def test_latest_only_keeps_the_newest_version_per_key(client, results_db):
    first = seed_result(results_db, version=1)
    second = seed_result(results_db, version=2, supersedes=first["_id"])
    other = seed_result(results_db, result_key="cycle_counts", version=1)

    every = client.get(RESULTS).json()
    latest = client.get(RESULTS, params={"latest_only": "true"}).json()

    assert every["total"] == 3
    assert latest["total"] == 2
    assert set(_ids(latest)) == {second["_id"], other["_id"]}


def test_the_list_pages_the_stored_results(client, results_db):
    for index in range(12):
        seed_result(
            results_db,
            result_key=f"key_{index:02d}",
            created_at=datetime(2026, 8, 14, 12, index, tzinfo=UTC),
        )

    first = client.get(RESULTS, params={"page": 1, "page_size": 10}).json()
    second = client.get(RESULTS, params={"page": 2, "page_size": 10}).json()

    assert first["total"] == 12 and second["total"] == 12
    assert first["total_pages"] == 2
    assert len(first["items"]) == 10
    assert len(second["items"]) == 2
    assert set(_ids(first)).isdisjoint(_ids(second))
    # Newest first: the last seeded result leads the first page.
    assert first["items"][0]["result_key"] == "key_11"


# --- POST /results stores the result and chains the versions ---


def _post(client, **overrides):
    return client.post(RESULTS, json=result_body(**overrides))


def _versions(db, result_key: str = RESULT_KEY) -> list[int]:
    stored = db["processed_results"].find({"result_key": result_key})
    return sorted(doc["version"] for doc in stored)


def test_a_full_result_stores_and_the_list_returns_it(client, results_db):
    # Every provenance assertion below reads the value the test SENT. Comparing
    # the answer against the answer proves nothing: the route could store a
    # constant and both sides would agree.
    sent = result_body(
        provenance=provenance(
            tool="mf4-reduce",
            tool_version="9.9.9",
            parameters="--dt 0.5",
            produced_by="k.svensson",
            produced_at="2026-08-15T06:30:00Z",
        )
    )
    response = client.post(RESULTS, json=sent)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["version"] == 1
    assert body["supersedes"] is None
    assert body["result_id"].startswith("res-")
    for key in PROVENANCE_KEYS:
        assert body["provenance"][key] == sent["provenance"][key], key

    page = client.get(RESULTS, params={"run": RUN_ID}).json()
    assert page["total"] == 1
    item = page["items"][0]
    assert item["result_id"] == body["result_id"]
    assert item["version"] == 1
    assert item["name"] == sent["name"]
    assert item["result_key"] == sent["result_key"]
    assert item["description"] == sent["description"]
    assert item["storage_ref"] == sent["storage_ref"]
    for key in PROVENANCE_KEYS:
        assert item["provenance"][key] == sent["provenance"][key], key


def test_a_changed_body_mints_version_2_and_sets_supersedes(client, results_db):
    first = _post(client).json()

    second = _post(client, description="Cycle-level aggregates, rerun")

    assert second.status_code == 201, second.text
    body = second.json()
    assert body["version"] == 2
    assert body["supersedes"] == first["result_id"]
    assert body["result_id"] != first["result_id"]

    # Nothing is overwritten. Both versions stay in the collection.
    assert _versions(results_db) == [1, 2]
    kept = results_db["processed_results"].find_one({"_id": first["result_id"]})
    assert kept["description"] == "Cycle-level aggregates"


def test_the_write_journals_run_result_written(client, results_db):
    stored = _post(client).json()

    entries = list(
        results_db["journal_entries"].find(
            {
                "entity_type": "result",
                "entity_id": stored["result_id"],
                "field": "run.result_written",
            }
        )
    )
    assert len(entries) == 1
    entry = entries[0]
    assert entry["kind"] == "event"
    assert entry["source"] == "api:post-processing"
    # The actor is the person the caller named, never a server-side constant.
    assert entry["actor"] == provenance()["produced_by"]
    assert "bat-post" in entry["note"] and "2.3.1" in entry["note"]


def test_the_write_entry_names_the_result_and_keeps_the_run_timeline(
    client, results_db
):
    """Finding 24: the entry hung off the run, so no query found result X.

    It names the result now. `context_run_id` keeps it on the run timeline,
    which is where the screen reads it.
    """
    stored = _post(client).json()

    entry = results_db["journal_entries"].find_one({"field": "run.result_written"})
    assert entry["entity_type"] == "result"
    assert entry["entity_id"] == stored["result_id"]
    assert entry["context_run_id"] == RUN_ID
    # The run timeline unions the two clauses, so the entry still shows there.
    timeline = client.get(f"/api/v1/test-runs/{RUN_ID}/journal")
    assert timeline.status_code == 200, timeline.text
    assert entry["_id"] in [item["id"] for item in timeline.json()["items"]]


# --- the run must exist (finding 25) -------------------------------------------


def test_a_result_for_an_unknown_run_is_refused_and_stores_nothing(
    client, results_db
):
    """A result describes a run. A result whose run is absent describes nothing.

    `PATCH /files/{file_id}` refuses an unknown run id the same way, and with
    the same code, because there the id also arrives inside a body.
    """
    response = client.post(RESULTS, json=result_body(run_id="TAS-00000"))

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "unknown_run"
    assert _stored(results_db) == 0
    assert results_db["journal_entries"].count_documents({}) == 0


def test_the_run_gate_never_touches_a_result_of_a_known_run(client, results_db):
    """The gate must refuse an absent run only, never every write."""
    assert _post(client).status_code == 201


@pytest.mark.parametrize("actor", ["system", "unknown", "current-user", "  System  "])
def test_a_placeholder_produced_by_returns_422_and_stores_nothing(
    client, results_db, actor
):
    # produced_by lands in the journal, and the helper refuses a placeholder.
    # The refusal must answer 422 before the write. It used to reach the helper
    # after the insert, so the caller read a 500 and the row stayed on disk.
    response = client.post(
        RESULTS, json=result_body(provenance=provenance(produced_by=actor))
    )

    assert response.status_code == 422, response.text
    assert "produced_by" in response.json()["detail"]
    assert _stored(results_db) == 0
    assert results_db["journal_entries"].count_documents({}) == 0


# --- Replay idempotency (guard test #12, contract v1.1) ---


def _journal_count(db) -> int:
    return db["journal_entries"].count_documents({"field": "run.result_written"})


def test_byte_identical_replay_no_new_version(client, results_db):
    body = result_body()

    first = client.post(RESULTS, json=body)
    replay = client.post(RESULTS, json=body)

    assert first.status_code == 201, first.text
    assert replay.status_code == 200, replay.text
    assert replay.json() == first.json()
    assert _versions(results_db) == [1]
    assert _journal_count(results_db) == 1


def test_a_replay_of_a_seeded_result_mints_no_new_version(client, results_db):
    # The seed writes the same fingerprint the route writes. A demo replay of
    # a seeded result therefore answers 200 and never mints a phantom version.
    seeded = seed_result(results_db)

    response = client.post(RESULTS, json=result_body())

    assert response.status_code == 200, response.text
    assert response.json()["result_id"] == seeded["_id"]
    assert _versions(results_db) == [1]
    assert _journal_count(results_db) == 0


def test_a_repost_of_the_stored_timestamp_mints_no_phantom_version(client, results_db):
    # Mongo keeps milliseconds only, so the answer carries a shorter timestamp
    # than the request. A caller that reads the answer and posts it again sends
    # the instant the server stored. That is a replay, never a change.
    sent = "2026-08-14T12:02:00.123456Z"
    first = client.post(RESULTS, json=result_body(provenance=provenance(produced_at=sent)))

    assert first.status_code == 201, first.text
    echoed = first.json()["provenance"]["produced_at"]
    assert echoed != sent, "Mongo must have dropped the microseconds"

    replay = client.post(RESULTS, json=result_body(provenance=provenance(produced_at=echoed)))

    assert replay.status_code == 200, replay.text
    assert replay.json()["result_id"] == first.json()["result_id"]
    assert _versions(results_db) == [1]
    assert _journal_count(results_db) == 1


def test_a_replay_of_a_superseded_body_mints_a_new_version(client, results_db):
    # Only the newest version answers a replay. An older body is a change.
    original = result_body()
    client.post(RESULTS, json=original)
    client.post(RESULTS, json=result_body(description="rerun"))

    response = client.post(RESULTS, json=original)

    assert response.status_code == 201, response.text
    assert response.json()["version"] == 3
    assert _versions(results_db) == [1, 2, 3]


def test_a_dropped_optional_field_is_a_change_not_a_replay(client, results_db):
    # description is optional, so a dump that skipped a null would hash the
    # body without it like the body with it. Dropping a field is a change.
    full = result_body()
    client.post(RESULTS, json=full)

    bare = {key: value for key, value in full.items() if key != "description"}
    response = client.post(RESULTS, json=bare)

    assert response.status_code == 201, response.text
    assert response.json()["version"] == 2
    assert response.json()["description"] is None
    assert _versions(results_db) == [1, 2]


def test_the_gate_and_the_model_read_the_same_duplicate_key(client, results_db):
    # A raw body may name provenance twice. The parser keeps the last value, so
    # the gate and the field validation must never see different blocks.
    raw = (
        '{"run_id": "TAS-88214", "name": "n", "result_key": "k",'
        ' "provenance": {"tool": "bat-post", "tool_version": "2.3.1",'
        ' "parameters": "p", "input_file_ids": [], "produced_by": "e.lindqvist",'
        ' "produced_at": "2026-08-14T12:02:00Z"},'
        ' "provenance": {"tool": ""}}'
    )

    response = client.post(
        RESULTS, content=raw, headers={"Content-Type": "application/json"}
    )

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "provenance_required"
    assert _stored(results_db) == 0


def test_a_replay_under_another_result_key_stores_its_own_chain(client, results_db):
    client.post(RESULTS, json=result_body())

    response = client.post(RESULTS, json=result_body(result_key="cycle_counts"))

    assert response.status_code == 201, response.text
    assert response.json()["version"] == 1
    assert _versions(results_db, "cycle_counts") == [1]


# --- Reject malformed, flag unverifiable ---
#
# The split is the point of this block. A body the server cannot parse is a
# rejection. An input id the server cannot resolve is a flag, never a
# rejection. The old T10 "404 on unknown input file" scenario does not apply.


def test_a_result_that_names_no_input_file_is_flagged(client, results_db):
    # An empty input_file_ids list is well-formed, so the write is accepted.
    # It names no registered file, so it never claims verified provenance.
    response = client.post(
        RESULTS, json=result_body(provenance=provenance(input_file_ids=[]))
    )

    assert response.status_code == 201, response.text
    assert response.json()["provenance_status"] == "flagged"
    assert _stored(results_db) == 1


def test_a_resolved_input_file_id_stays_verified(client, results_db):
    file_doc = seed_file(results_db)

    response = client.post(
        RESULTS, json=result_body(provenance=provenance(input_file_ids=[file_doc["_id"]]))
    )

    assert response.status_code == 201, response.text
    assert response.json()["provenance_status"] == "verified"


def test_a_filename_resolves_like_an_id(client, results_db):
    file_doc = seed_file(results_db)

    response = client.post(
        RESULTS,
        json=result_body(provenance=provenance(input_file_ids=[file_doc["filename"]])),
    )

    assert response.status_code == 201, response.text
    assert response.json()["provenance_status"] == "verified"


def test_an_unresolvable_input_file_id_is_flagged_not_rejected(client, results_db):
    response = client.post(
        RESULTS, json=result_body(provenance=provenance(input_file_ids=["f-missing"]))
    )

    assert response.status_code == 201, response.text
    assert response.json()["provenance_status"] == "flagged"
    # The flag never drops the result. The row is on disk.
    assert _stored(results_db) == 1


def test_an_input_file_of_another_run_is_flagged(client, results_db):
    stranger = seed_file(results_db, run_id="TAS-88105")

    response = client.post(
        RESULTS, json=result_body(provenance=provenance(input_file_ids=[stranger["_id"]]))
    )

    assert response.status_code == 201, response.text
    assert response.json()["provenance_status"] == "flagged"


def test_a_quarantined_input_file_is_flagged(client, results_db):
    bad = seed_file(results_db, status="quarantined", quarantine_reason="checksum mismatch")

    response = client.post(
        RESULTS, json=result_body(provenance=provenance(input_file_ids=[bad["_id"]]))
    )

    assert response.status_code == 201, response.text
    assert response.json()["provenance_status"] == "flagged"


def test_one_bad_id_among_good_ones_flags_the_whole_result(client, results_db):
    good = seed_file(results_db)

    response = client.post(
        RESULTS,
        json=result_body(
            provenance=provenance(input_file_ids=[good["_id"], "f-missing"])
        ),
    )

    assert response.status_code == 201, response.text
    assert response.json()["provenance_status"] == "flagged"


def test_malformed_is_rejected_and_unverifiable_is_flagged(client, results_db):
    # Malformed provenance: a key is missing. The server rejects and stores
    # nothing.
    malformed = provenance()
    malformed.pop("tool_version")
    rejected = client.post(RESULTS, json=result_body(provenance=malformed))

    assert rejected.status_code == 422
    assert rejected.json()["code"] == "provenance_required"
    assert _stored(results_db) == 0

    # Unverifiable provenance: every key is present, one input id does not
    # resolve. The server stores the result and flags it.
    unverifiable = provenance(input_file_ids=["f-missing"])
    flagged = client.post(RESULTS, json=result_body(provenance=unverifiable))

    assert flagged.status_code == 201, flagged.text
    assert flagged.json()["provenance_status"] == "flagged"
    assert _stored(results_db) == 1


# --- The unique index carries the race ---


def test_a_lost_version_race_retries_and_mints_the_next_version(
    client, results_db, monkeypatch
):
    # Hide the stored version from the route one time. The unique index on
    # (run_id, result_key, version) must catch the duplicate insert.
    first = _post(client).json()
    real_latest = results_router._latest
    calls = {"count": 0}

    def stale_once(db, run_id, result_key):
        calls["count"] += 1
        if calls["count"] == 1:
            return None
        return real_latest(db, run_id, result_key)

    monkeypatch.setattr(results_router, "_latest", stale_once)
    response = _post(client, description="rerun")

    assert response.status_code == 201, response.text
    assert response.json()["version"] == 2
    assert response.json()["supersedes"] == first["result_id"]
    assert _versions(results_db) == [1, 2]


def test_an_endless_version_race_answers_409_and_never_500(
    client, results_db, monkeypatch
):
    _post(client)
    monkeypatch.setattr(results_router, "_latest", lambda db, run, key: None)

    response = _post(client, description="rerun")

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "version_conflict"
    assert _versions(results_db) == [1]


def test_concurrent_same_key_writes_produce_distinct_versions(
    client, results_db, monkeypatch
):
    # Every writer reads the newest version before any writer inserts. Three
    # writers then lose the unique index. Only the retry in the route saves
    # them, so this test fails if somebody deletes the retry.
    bodies = [result_body(description=f"rerun {index}") for index in range(4)]
    together = threading.Barrier(len(bodies), timeout=30)
    thread_state = threading.local()
    real_latest = results_router._latest

    def read_together(db, run_id, result_key):
        previous = real_latest(db, run_id, result_key)
        if not getattr(thread_state, "waited", False):
            # Hold the first read of each writer until every writer has read.
            thread_state.waited = True
            together.wait()
        return previous

    monkeypatch.setattr(results_router, "_latest", read_together)

    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda one: client.post(RESULTS, json=one), bodies))

    assert [response.status_code for response in responses] == [201, 201, 201, 201]
    assert _versions(results_db) == [1, 2, 3, 4]
    minted = {response.json()["result_id"] for response in responses}
    assert len(minted) == 4
