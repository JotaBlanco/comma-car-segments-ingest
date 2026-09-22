"""A-06 — contract #5, `POST /test-runs/{run_id}/invalid-flag`.

Marking a run invalid is a judgment, so it needs a reason and an actor, and it
is recorded. A second flag on a flagged run is a conflict, not a silent
overwrite: the first reason is the one a reader must see.
"""

from tests.factories_planning import make_run

RUN = "TAS-88209"
ACTOR = "e.lindqvist"
REASON = "Torque flange calibration expired — readings suspect"


def _seed(db, **overrides) -> None:
    db["test_runs"].insert_one(make_run(run_id=RUN, **overrides))


def _flag(client, reason: str = REASON, actor: str = ACTOR):
    return client.post(
        f"/api/v1/test-runs/{RUN}/invalid-flag", json={"reason": reason, "actor": actor}
    )


def test_flagging_stores_the_reason_the_actor_and_the_time(client, routed_db) -> None:
    _seed(routed_db)

    body = _flag(client).json()

    assert body["invalid"]["flagged"] is True
    assert body["invalid"]["reason"] == REASON
    assert body["invalid"]["actor"] == ACTOR
    assert body["invalid"]["at"] is not None


def test_the_flag_re_derives_the_status(client, routed_db) -> None:
    _seed(routed_db, work_order_id="WO-2026-0847", status="complete")

    assert _flag(client).json()["status"] == "invalid"


def test_the_flag_is_journalled_with_its_reason(client, routed_db) -> None:
    _seed(routed_db)

    _flag(client)

    entries = list(routed_db["journal_entries"].find({"entity_type": "run", "entity_id": RUN}))
    assert len(entries) == 1
    assert entries[0]["field"] == "run.invalid_flag"
    assert entries[0]["note"] == REASON
    assert entries[0]["actor"] == ACTOR


def test_the_flag_records_its_provenance(client, routed_db) -> None:
    """An API flag carries the same field_sources entry the seed writes."""
    _seed(routed_db)

    body = _flag(client).json()

    source = body["field_sources"]["invalid"]
    assert source["source"] == "manual"
    assert source["actor"] == ACTOR
    assert source["at"] is not None


def test_the_flag_journal_shows_the_contract_literals(client, routed_db) -> None:
    """Contract #5: the flag journals `false → true`, never the stored block."""
    _seed(routed_db)

    _flag(client)

    entry = routed_db["journal_entries"].find_one({"entity_id": RUN, "kind": "change"})
    assert (entry["old"], entry["new"]) == ("false", "true")


def test_a_second_flag_returns_409_and_keeps_the_first_reason(client, routed_db) -> None:
    _seed(routed_db)
    _flag(client, reason="first")

    response = _flag(client, reason="second")

    assert response.status_code == 409
    assert response.json()["code"] == "already_flagged"
    assert routed_db["test_runs"].find_one({"_id": RUN})["invalid"]["reason"] == "first"


def test_a_blank_reason_returns_422_reason_required(client, routed_db) -> None:
    _seed(routed_db)

    response = _flag(client, reason="   ")

    assert response.status_code == 422
    assert response.json()["code"] == "reason_required"


def test_an_absent_reason_returns_422_reason_required(client, routed_db) -> None:
    """Conformance H4: the plain Pydantic path answers the wrong code."""
    _seed(routed_db)

    response = client.post(f"/api/v1/test-runs/{RUN}/invalid-flag", json={"actor": ACTOR})

    assert response.status_code == 422
    assert response.json()["code"] == "reason_required"


def test_an_unknown_body_field_returns_422_naming_the_field(client, routed_db) -> None:
    """Guard test 11 for #5."""
    _seed(routed_db)

    response = client.post(
        f"/api/v1/test-runs/{RUN}/invalid-flag",
        json={"reason": REASON, "actor": ACTOR, "severity": "high"},
    )

    assert response.status_code == 422
    assert "severity" in response.json()["detail"]


def test_flagging_an_unknown_run_returns_404(client, routed_db) -> None:
    response = _flag(client)

    assert response.status_code == 404
    assert response.json()["code"] == "run_not_found"


def test_the_home_needs_attention_count_moves(client, routed_db) -> None:
    """The flag has to reach the Home block, or the demo shows a stale count."""
    _seed(routed_db, work_order_id="WO-2026-0847", status="complete")
    before = client.get("/api/v1/home/summary").json()["needs_attention"]["invalid_runs"]

    _flag(client)

    after = client.get("/api/v1/home/summary").json()["needs_attention"]["invalid_runs"]
    assert after == before + 1


def test_the_invalid_filter_finds_the_flagged_run(client, routed_db) -> None:
    _seed(routed_db, work_order_id="WO-2026-0847", status="complete")
    _flag(client)

    items = client.get("/api/v1/test-runs", params={"status": "invalid"}).json()["items"]

    assert [item["run_id"] for item in items] == [RUN]


# --- the optional clear route (★), for rehearsal resets ---------------------


def test_clearing_the_flag_restores_the_run(client, routed_db) -> None:
    _seed(routed_db, work_order_id="WO-2026-0847")
    _flag(client)

    response = client.request(
        "DELETE",
        f"/api/v1/test-runs/{RUN}/invalid-flag",
        json={"reason": "flagged in error during rehearsal", "actor": ACTOR},
    )

    assert response.status_code == 200
    assert response.json()["invalid"]["flagged"] is False
    assert response.json()["status"] == "complete"


def test_clearing_needs_its_own_reason(client, routed_db) -> None:
    _seed(routed_db)
    _flag(client)

    response = client.request(
        "DELETE", f"/api/v1/test-runs/{RUN}/invalid-flag", json={"reason": "", "actor": ACTOR}
    )

    assert response.status_code == 422
    assert response.json()["code"] == "reason_required"


def test_clearing_a_run_that_is_not_flagged_returns_409(client, routed_db) -> None:
    _seed(routed_db)

    response = client.request(
        "DELETE",
        f"/api/v1/test-runs/{RUN}/invalid-flag",
        json={"reason": "nothing to clear", "actor": ACTOR},
    )

    assert response.status_code == 409
    assert response.json()["code"] == "not_flagged"


def test_clearing_is_journalled(client, routed_db) -> None:
    _seed(routed_db)
    _flag(client)

    client.request(
        "DELETE",
        f"/api/v1/test-runs/{RUN}/invalid-flag",
        json={"reason": "flagged in error", "actor": ACTOR},
    )

    entries = list(routed_db["journal_entries"].find({"entity_type": "run", "entity_id": RUN}))
    assert len(entries) == 2
    assert entries[-1]["note"] == "flagged in error"


def test_clearing_records_its_provenance_too(client, routed_db) -> None:
    """The clear is a judgment as well, so it re-tags who made it."""
    _seed(routed_db)
    _flag(client)

    body = client.request(
        "DELETE",
        f"/api/v1/test-runs/{RUN}/invalid-flag",
        json={"reason": "flagged in error", "actor": "a.bergstrom"},
    ).json()

    source = body["field_sources"]["invalid"]
    assert source["source"] == "manual"
    assert source["actor"] == "a.bergstrom"


def test_clearing_journals_the_reverse_literals(client, routed_db) -> None:
    """Contract #5 read backwards: the clear journals `true → false`."""
    _seed(routed_db)
    _flag(client)

    client.request(
        "DELETE",
        f"/api/v1/test-runs/{RUN}/invalid-flag",
        json={"reason": "flagged in error", "actor": ACTOR},
    )

    entries = list(
        routed_db["journal_entries"].find({"entity_id": RUN, "kind": "change"}).sort("at", 1)
    )
    assert [(e["old"], e["new"]) for e in entries] == [("false", "true"), ("true", "false")]


def test_an_unknown_field_on_the_clear_route_returns_422(client, routed_db) -> None:
    """Guard test 11 for the ★ clear route."""
    _seed(routed_db)
    _flag(client)

    response = client.request(
        "DELETE",
        f"/api/v1/test-runs/{RUN}/invalid-flag",
        json={"reason": "clearing", "actor": ACTOR, "severity": "high"},
    )

    assert response.status_code == 422
    assert "severity" in response.json()["detail"]
