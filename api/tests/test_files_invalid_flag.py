# The invalid mark at FILE level (24 Aug 2026).
#
# The requirement asks for the mark on the container AND on the file. The run
# half is `api/tests/test_invalid_flag.py`. This file is the same story read at
# file level, and the rules are copied from that half on purpose: a reason is
# mandatory on both writes, a blank reason answers 422 `reason_required`, the
# stored block holds who, why and when, and the journal keeps both halves.
#
# One rule is NOT copied. A file mark never touches the run. The run stays what
# it was, `status` stays the verdict of the registry about the bytes, and a
# person condemns a run through the run route.
#
# Style follows tests/test_files_lifecycle.py.

import pytest

from tests import factories
from tests.factories import register_file, upsert_run

files_db = factories.files_db

FILES = "/api/v1/files"
RUN = "TAS-88214"
ACTOR = "a.bergstrom"
REASON = "Cell 7 thermocouple came loose at 10:12 — the trace is noise"


@pytest.fixture(autouse=True)
def stats_lake(stub_lake):
    """Answer the statistics from the stub lake. The file detail reads rows."""


def _flag(client, file_id: str, reason: str = REASON, actor: str = ACTOR):
    return client.post(f"{FILES}/{file_id}/invalid-flag", json={"reason": reason, "actor": actor})


def _clear(client, file_id: str, reason: str = "flagged in error", actor: str = ACTOR):
    return client.request(
        "DELETE", f"{FILES}/{file_id}/invalid-flag", json={"reason": reason, "actor": actor}
    )


def _entries(db, file_id: str) -> list[dict]:
    return list(
        db["journal_entries"]
        .find({"entity_type": "file", "entity_id": file_id, "field": "file.invalid_flag"})
        .sort("at", 1)
    )


def _seed(db) -> str:
    upsert_run(db)
    return register_file(db)["_id"]


# --- set ---------------------------------------------------------------------


def test_flagging_stores_the_reason_the_actor_and_the_time(client, files_db):
    file_id = _seed(files_db)

    body = _flag(client, file_id).json()

    assert body["invalid"]["flagged"] is True
    assert body["invalid"]["reason"] == REASON
    assert body["invalid"]["actor"] == ACTOR
    assert body["invalid"]["at"] is not None


def test_the_flag_records_its_provenance(client, files_db):
    """The file mark carries the same `manual` field-source the run mark does."""
    file_id = _seed(files_db)

    source = _flag(client, file_id).json()["field_sources"]["invalid"]

    assert source["source"] == "manual"
    assert source["actor"] == ACTOR
    assert source["at"] is not None


def test_the_flag_is_journalled_with_its_reason(client, files_db):
    file_id = _seed(files_db)

    _flag(client, file_id)

    entries = _entries(files_db, file_id)
    assert len(entries) == 1
    assert entries[0]["actor"] == ACTOR
    assert entries[0]["note"] == REASON
    assert entries[0]["source"] == "manual"
    assert (entries[0]["old"], entries[0]["new"]) == ("false", "true")


def test_the_flag_never_touches_the_status_of_the_file(client, files_db):
    """`status` is the verdict of the registry about the bytes, not a judgment."""
    upsert_run(files_db)
    file_id = register_file(files_db, status="quarantined", quarantine_reason="checksum mismatch")[
        "_id"
    ]

    body = _flag(client, file_id).json()

    assert body["status"] == "quarantined"
    assert body["quarantine_reason"] == "checksum mismatch"


def test_the_flag_never_touches_the_run(client, files_db):
    """The ruling: a file mark is the smaller thing. It marks the file only."""
    file_id = _seed(files_db)
    before = files_db["test_runs"].find_one({"_id": RUN})

    _flag(client, file_id)

    after = files_db["test_runs"].find_one({"_id": RUN})
    assert after["status"] == before["status"]
    assert after["invalid"] == before["invalid"]
    run_body = client.get(f"/api/v1/test-runs/{RUN}").json()
    assert run_body["invalid"]["flagged"] is False
    assert run_body["status"] != "invalid"


def test_a_second_flag_returns_409_and_keeps_the_first_reason(client, files_db):
    file_id = _seed(files_db)
    _flag(client, file_id, reason="first")

    response = _flag(client, file_id, reason="second")

    assert response.status_code == 409
    assert response.json()["code"] == "already_flagged"
    assert files_db["files"].find_one({"_id": file_id})["invalid"]["reason"] == "first"


def test_flagging_an_unknown_file_returns_404(client, files_db):
    response = _flag(client, "f-nobody")

    assert response.status_code == 404
    assert response.json()["code"] == "file_not_found"


# --- the blank reason --------------------------------------------------------


def test_a_blank_reason_returns_422_reason_required(client, files_db):
    file_id = _seed(files_db)

    response = _flag(client, file_id, reason="   ")

    assert response.status_code == 422
    assert response.json()["code"] == "reason_required"


def test_an_absent_reason_returns_422_reason_required(client, files_db):
    file_id = _seed(files_db)

    response = client.post(f"{FILES}/{file_id}/invalid-flag", json={"actor": ACTOR})

    assert response.status_code == 422
    assert response.json()["code"] == "reason_required"


def test_clearing_needs_its_own_reason(client, files_db):
    file_id = _seed(files_db)
    _flag(client, file_id)

    response = _clear(client, file_id, reason="")

    assert response.status_code == 422
    assert response.json()["code"] == "reason_required"


def test_an_unknown_body_field_returns_422_naming_the_field(client, files_db):
    file_id = _seed(files_db)

    response = client.post(
        f"{FILES}/{file_id}/invalid-flag",
        json={"reason": REASON, "actor": ACTOR, "severity": "high"},
    )

    assert response.status_code == 422
    assert "severity" in response.json()["detail"]


# --- the bearer token --------------------------------------------------------


def test_flagging_without_a_token_returns_401(bare_client, files_db):
    file_id = _seed(files_db)

    response = bare_client.post(
        f"{FILES}/{file_id}/invalid-flag", json={"reason": REASON, "actor": ACTOR}
    )

    assert response.status_code == 401
    assert files_db["files"].find_one({"_id": file_id}).get("invalid") is None


def test_clearing_without_a_token_returns_401(bare_client, client, files_db):
    file_id = _seed(files_db)
    _flag(client, file_id)

    response = bare_client.request(
        "DELETE", f"{FILES}/{file_id}/invalid-flag", json={"reason": "x", "actor": ACTOR}
    )

    assert response.status_code == 401
    assert files_db["files"].find_one({"_id": file_id})["invalid"]["flagged"] is True


# --- clear -------------------------------------------------------------------


def test_clearing_the_flag_empties_the_block(client, files_db):
    file_id = _seed(files_db)
    _flag(client, file_id)

    response = _clear(client, file_id)

    assert response.status_code == 200, response.text
    assert response.json()["invalid"] == {
        "flagged": False,
        "reason": None,
        "actor": None,
        "at": None,
    }


def test_clearing_is_journalled_with_the_reverse_literals(client, files_db):
    file_id = _seed(files_db)
    _flag(client, file_id)

    _clear(client, file_id, reason="thermocouple re-seated and the trace re-read")

    entries = _entries(files_db, file_id)
    assert len(entries) == 2
    assert entries[-1]["note"] == "thermocouple re-seated and the trace re-read"
    assert [(entry["old"], entry["new"]) for entry in entries] == [
        ("false", "true"),
        ("true", "false"),
    ]


def test_clearing_records_its_provenance_too(client, files_db):
    file_id = _seed(files_db)
    _flag(client, file_id)

    body = _clear(client, file_id, actor="e.lindqvist").json()

    source = body["field_sources"]["invalid"]
    assert source["source"] == "manual"
    assert source["actor"] == "e.lindqvist"


def test_clearing_a_file_that_is_not_flagged_returns_409(client, files_db):
    file_id = _seed(files_db)

    response = _clear(client, file_id, reason="nothing to clear")

    assert response.status_code == 409
    assert response.json()["code"] == "not_flagged"


def test_clearing_an_unknown_file_returns_404(client, files_db):
    response = _clear(client, "f-nobody")

    assert response.status_code == 404
    assert response.json()["code"] == "file_not_found"


# --- a file nobody marked ----------------------------------------------------


def test_a_file_that_was_never_marked_serves_the_empty_block(client, files_db):
    """The stored document holds no `invalid` key at all. The wire still does."""
    file_id = _seed(files_db)
    assert "invalid" not in files_db["files"].find_one({"_id": file_id})

    detail = client.get(f"{FILES}/{file_id}").json()
    row = client.get(FILES, params={"run": RUN}).json()["items"][0]

    empty = {"flagged": False, "reason": None, "actor": None, "at": None}
    assert detail["invalid"] == empty
    assert row["invalid"] == empty


# --- the list filter ---------------------------------------------------------


def test_the_invalid_filter_finds_the_flagged_file(client, files_db):
    upsert_run(files_db)
    flagged = register_file(files_db, filename="loose_thermocouple.mf4")["_id"]
    clean = register_file(files_db, filename="clean.mf4")["_id"]
    _flag(client, flagged)

    items = client.get(FILES, params={"invalid": "true"}).json()["items"]

    assert [item["file_id"] for item in items] == [flagged]
    assert clean not in [item["file_id"] for item in items]


def test_invalid_false_serves_the_files_nobody_marked(client, files_db):
    upsert_run(files_db)
    flagged = register_file(files_db, filename="loose_thermocouple.mf4")["_id"]
    clean = register_file(files_db, filename="clean.mf4")["_id"]
    _flag(client, flagged)

    ids = [
        item["file_id"] for item in client.get(FILES, params={"invalid": "false"}).json()["items"]
    ]

    assert ids == [clean]


def test_no_invalid_filter_serves_both(client, files_db):
    upsert_run(files_db)
    flagged = register_file(files_db, filename="loose_thermocouple.mf4")["_id"]
    clean = register_file(files_db, filename="clean.mf4")["_id"]
    _flag(client, flagged)

    ids = {item["file_id"] for item in client.get(FILES).json()["items"]}

    assert {flagged, clean} <= ids


def test_a_cleared_file_leaves_the_invalid_filter(client, files_db):
    file_id = _seed(files_db)
    _flag(client, file_id)
    _clear(client, file_id)

    items = client.get(FILES, params={"invalid": "true"}).json()["items"]

    assert items == []
