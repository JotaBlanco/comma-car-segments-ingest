"""A-02 — POST /test-runs, the idempotent registry upsert (BE-PLAN §4.1).

The run appears the moment its first file lands, and the same call may arrive
many times: a rig retries, the watcher restarts, the seed replays. So the four
cases are insert, merge, replay and conflict, and only the first one creates.
"""

from datetime import UTC, datetime

import pytest

from api.models.runs import RunUpsertRequest
from api.services.queries_runs import upsert_run

RUN = "TAS-88214"


def _post(client, **overrides) -> tuple[int, dict]:
    body = {"run_id": RUN, "rig_id": "RIG-04"}
    body.update(overrides)
    response = client.post("/api/v1/test-runs", json=body)
    return response.status_code, response.json()


def _journal(db, run_id: str = RUN) -> list[dict]:
    return list(db["journal_entries"].find({"entity_type": "run", "entity_id": run_id}))


# --- insert -----------------------------------------------------------------


def test_a_first_registration_creates_the_run(client, routed_db) -> None:
    status, body = _post(client, test_cell="TC-2", description="HV battery thermal cycling")

    assert status == 201
    assert body["run_id"] == RUN
    assert body["rig_id"] == "RIG-04"
    assert body["test_cell"] == "TC-2"
    assert routed_db["test_runs"].count_documents({}) == 1


def test_a_new_run_starts_awaiting_its_work_order(client, routed_db) -> None:
    """No work order yet is the normal amber state, not an error."""
    _status, body = _post(client)

    assert body["work_order_id"] is None
    assert body["status"] == "awaiting_work_order"


def test_the_insert_tags_every_field_it_wrote(client, routed_db) -> None:
    _status, body = _post(client, test_cell="TC-2")

    assert body["field_sources"]["rig_id"]["source"] == "embedded"
    assert body["field_sources"]["rig_id"]["actor"] == "ingestion"
    assert body["field_sources"]["test_cell"]["source"] == "embedded"


def test_the_insert_journals_one_registration_event(client, routed_db) -> None:
    _post(client)

    entries = _journal(routed_db)
    assert len(entries) == 1
    assert entries[0]["kind"] == "event"
    assert entries[0]["field"] == "run.registered"
    assert entries[0]["actor"] == "ingestion"


def test_first_data_at_falls_back_to_the_registry_clock(client, routed_db) -> None:
    """The arrival column needs a value even when the file carries no start."""
    _status, body = _post(client)

    assert body["first_data_at"] is not None


# --- replay -----------------------------------------------------------------


def test_an_exact_replay_returns_200_and_changes_nothing(client, routed_db) -> None:
    first_status, _ = _post(client, test_cell="TC-2")
    before = routed_db["test_runs"].find_one({"_id": RUN})

    replay_status, _ = _post(client, test_cell="TC-2")
    after = routed_db["test_runs"].find_one({"_id": RUN})

    assert (first_status, replay_status) == (201, 200)
    assert routed_db["test_runs"].count_documents({}) == 1
    assert after["updated_at"] == before["updated_at"], "an unchanged replay is not a write"


def test_a_replay_adds_no_journal_entry(client, routed_db) -> None:
    _post(client, test_cell="TC-2")
    _post(client, test_cell="TC-2")

    assert len(_journal(routed_db)) == 1, "only the first registration is journalled"


# --- merge ------------------------------------------------------------------


def test_a_merge_fills_a_field_that_was_empty(client, routed_db) -> None:
    _post(client)

    status, body = _post(client, description="HV battery thermal cycling")

    assert status == 200
    assert body["description"] == "HV battery thermal cycling"
    assert body["field_sources"]["description"]["source"] == "embedded"


def test_a_merge_never_overwrites_a_manual_value(client, routed_db) -> None:
    """Precedence: re-ingestion loses to the person who typed the value."""
    _post(client)
    routed_db["test_runs"].update_one(
        {"_id": RUN},
        {
            "$set": {
                "description": "corrected by hand",
                "field_sources.description": {
                    "source": "manual",
                    "actor": "a.bergstrom",
                    "at": datetime.now(UTC),
                },
            }
        },
    )

    _status, body = _post(client, description="from the file header")

    assert body["description"] == "corrected by hand"
    assert body["field_sources"]["description"]["source"] == "manual"


def test_the_time_range_extends_in_both_directions(client, routed_db) -> None:
    """A run spans every file it holds, so the union only ever grows."""
    _post(
        client,
        started_at="2026-08-14T09:41:07Z",
        ended_at="2026-08-14T10:00:00Z",
    )

    _status, body = _post(
        client,
        started_at="2026-08-14T09:30:00Z",
        ended_at="2026-08-14T11:18:52Z",
    )

    assert body["started_at"] == "2026-08-14T09:30:00Z"
    assert body["ended_at"] == "2026-08-14T11:18:52Z"


def test_the_time_range_ignores_a_narrower_window(client, routed_db) -> None:
    _post(
        client,
        started_at="2026-08-14T09:00:00Z",
        ended_at="2026-08-14T12:00:00Z",
    )

    _status, body = _post(
        client,
        started_at="2026-08-14T10:00:00Z",
        ended_at="2026-08-14T11:00:00Z",
    )

    assert body["started_at"] == "2026-08-14T09:00:00Z"
    assert body["ended_at"] == "2026-08-14T12:00:00Z"


def test_the_insert_drops_the_epoch_sentinel_start(client, routed_db) -> None:
    """1970-01-01 means "the source has no wall clock". It is not a start time.

    Without the guard the run registers at 1970 and sorts to the bottom of
    `GET /test-runs`, because `first_data_at` is the list sort key.
    """
    _status, body = _post(client, started_at="1970-01-01T00:00:00Z")

    assert body["started_at"] is None
    assert not body["first_data_at"].startswith("1970")


def test_a_merge_never_lowers_the_start_to_the_sentinel(client, routed_db) -> None:
    _post(client, started_at="2026-08-10T09:00:00Z")

    _status, body = _post(client, started_at="1970-01-01T00:00:00Z")

    assert body["started_at"] == "2026-08-10T09:00:00Z"
    assert body["first_data_at"] == "2026-08-10T09:00:00Z"


def test_a_merge_journals_only_what_changed(client, routed_db) -> None:
    _post(client, test_cell="TC-2")

    _post(client, test_cell="TC-2", description="added later")

    fields = [entry["field"] for entry in _journal(routed_db)]
    assert fields == ["run.registered", "run.description"], "no journal noise for unchanged fields"


# --- rig conflict -----------------------------------------------------------


def test_rig_conflict_keeps_identity(client, routed_db) -> None:
    """Guard test 4. A second rig for the same run never mutates the identity.

    The contract answers 200 and records the attempt. The older ticket text said
    409; contract v1.1 settles on 200 plus a journal entry, and the contract wins.
    """
    _post(client, rig_id="RIG-04")

    status, body = _post(client, rig_id="RIG-09")

    assert status == 200
    assert body["rig_id"] == "RIG-04", "the stored rig identity stands"

    changes = [e for e in _journal(routed_db) if e["kind"] == "change"]
    assert len(changes) == 1
    assert changes[0]["field"] == "rig_id"
    assert changes[0]["new"] == "RIG-09"
    assert "conflict" in (changes[0]["note"] or "").lower()


def test_a_repeated_rig_conflict_does_not_pile_up_journal_entries(client, routed_db) -> None:
    _post(client, rig_id="RIG-04")
    _post(client, rig_id="RIG-09")
    _post(client, rig_id="RIG-09")

    changes = [e for e in _journal(routed_db) if e["kind"] == "change"]
    assert len(changes) == 1, "the same conflict is reported once"


def test_a_rig_conflict_is_journalled_even_after_a_manual_correction(client, routed_db) -> None:
    """Precedence blocks the write, never the report (BE-PLAN §4.1)."""
    _post(client, rig_id="RIG-04")
    routed_db["test_runs"].update_one(
        {"_id": RUN},
        {
            "$set": {
                "rig_id": "RIG-05",
                "field_sources.rig_id": {
                    "source": "manual",
                    "actor": "a.bergstrom",
                    "at": datetime.now(UTC),
                },
            }
        },
    )

    status, body = _post(client, rig_id="RIG-09")

    assert status == 200
    assert body["rig_id"] == "RIG-05", "the corrected identity stands"

    changes = [e for e in _journal(routed_db) if e["kind"] == "change"]
    assert [c["field"] for c in changes] == ["rig_id"]
    assert changes[0]["old"] == "RIG-05"
    assert changes[0]["new"] == "RIG-09"


# --- concurrent registration -------------------------------------------------


class _RacingRuns:
    """A test_runs stand-in. Another writer lands between the find and the insert."""

    def __init__(self, collection, winner) -> None:
        self._collection = collection
        self._winner = winner

    def __getattr__(self, name):
        return getattr(self._collection, name)

    def find_one(self, *args, **kwargs):
        found = self._collection.find_one(*args, **kwargs)
        winner, self._winner = self._winner, None
        if winner is not None:
            winner()
        return found


class _RacingDb:
    """Route test_runs through the racing wrapper. Every other collection is real."""

    def __init__(self, db, winner) -> None:
        self._db = db
        self._runs = _RacingRuns(db["test_runs"], winner)

    def __getitem__(self, name):
        if name == "test_runs":
            return self._runs
        return self._db[name]


def test_a_lost_insert_race_falls_back_to_the_merge(db) -> None:
    """Two concurrent first registrations. The loser merges instead of crashing."""
    body = RunUpsertRequest(run_id=RUN, rig_id="RIG-04")
    racing = _RacingDb(db, winner=lambda: upsert_run(db, body))

    doc, created = upsert_run(racing, body)

    assert created is False, "the loser answers as a merge, never a 500"
    assert doc["_id"] == RUN
    assert db["test_runs"].count_documents({}) == 1


def test_a_lost_insert_race_journals_one_registration_only(db) -> None:
    body = RunUpsertRequest(run_id=RUN, rig_id="RIG-04")
    racing = _RacingDb(db, winner=lambda: upsert_run(db, body))

    upsert_run(racing, body)

    events = list(db["journal_entries"].find({"field": "run.registered"}))
    assert len(events) == 1, "only the winner registers the run"


# --- validation -------------------------------------------------------------


def test_an_unknown_body_field_returns_422_naming_the_field(client, routed_db) -> None:
    """Guard test 11 for this route."""
    response = client.post(
        "/api/v1/test-runs", json={"run_id": RUN, "rig_id": "RIG-04", "rig": "RIG-04"}
    )

    assert response.status_code == 422
    assert "rig" in response.json()["detail"]


@pytest.mark.parametrize("missing", ["run_id", "rig_id"])
def test_the_two_required_fields_are_required(client, routed_db, missing: str) -> None:
    body = {"run_id": RUN, "rig_id": "RIG-04"}
    body.pop(missing)

    response = client.post("/api/v1/test-runs", json=body)

    assert response.status_code == 422
    assert missing in response.json()["detail"]


def test_the_422_detail_is_one_friendly_string(client, routed_db) -> None:
    """Guard test 2. Never a raw Pydantic dump, and the detail names the field."""
    response = client.post("/api/v1/test-runs", json={"run_id": RUN})

    body = response.json()
    assert isinstance(body["detail"], str)
    assert "rig_id" in body["detail"], "the friendly string still names the bad field"
    assert body["code"] == "validation_error"
    assert isinstance(body["errors"], list)


@pytest.mark.parametrize("actor", ["", "   ", "current-user"])
def test_an_actor_that_names_nobody_returns_422(client, routed_db, actor: str) -> None:
    # A blank or placeholder actor is a caller error, never a server error.
    status, body = _post(client, actor=actor)

    assert status == 422
    assert body["code"] == "validation_error"
    assert "actor" in body["detail"]
    assert routed_db["test_runs"].count_documents({}) == 0


def test_a_padded_actor_is_stored_stripped(client, routed_db) -> None:
    _status, body = _post(client, actor="  planning-sync  ")

    assert body["field_sources"]["rig_id"]["actor"] == "planning-sync"


def test_a_caller_may_name_its_own_source_and_actor(client, routed_db) -> None:
    """The seed writes through this route too, and it is not the watcher."""
    _status, body = _post(client, source="api:planning", actor="planning-sync")

    assert body["field_sources"]["rig_id"]["source"] == "api:planning"
    assert body["field_sources"]["rig_id"]["actor"] == "planning-sync"
