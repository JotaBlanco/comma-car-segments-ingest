"""The requirement status gate: who may write which status.

Validates `dev-planning/requirement-status-gates/spec.md` §4.1 (the
transition table), §4.2 (the `illegal_transition` refusal), §4.3 (`Implemented`
and `Tested` are never stored), §4.4 (`second_actor` lands on the journal
note), and §4.7 (the mirror never lands a derived status, and the empty-string
row stays movable).
"""

ROUTE = "/api/v1/requirements"
ACTOR = "T. Ester"


def _create(client, req_id: str, status: str = "Draft") -> dict:
    response = client.post(
        ROUTE,
        json={
            "id": req_id,
            "title": "Hold the current",
            "text": "The battery system shall hold the current.",
            "ears_pattern": "Ubiquitous",
            "status": status,
            "actor": ACTOR,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _force_status(routed_db, req_id: str, status: str) -> None:
    """Set `status` directly, bypassing the gate under test — test setup only."""
    routed_db["requirements"].update_one({"_id": req_id}, {"$set": {"status": status}})


def _patch(client, req_id: str, **body):
    return client.patch(f"{ROUTE}/{req_id}", json=body)


def _journal_entries(routed_db, req_id: str) -> list[dict]:
    return list(routed_db["journal_entries"].find({"entity_id": req_id}).sort("at", 1))


def test_tested_cannot_be_authored(client, routed_db):
    """Spec §4.1: `Tested` is a derived status, absent from `AUTHOR_TARGETS`."""
    detail = _create(client, "REQ-GATE-001", status="Draft")

    response = _patch(
        client,
        "REQ-GATE-001",
        status="Tested",
        parent_version=detail["item_version"],
        actor=ACTOR,
    )

    assert response.status_code == 409
    assert response.json()["code"] == "illegal_transition"

    stored = routed_db["requirements"].find_one({"_id": "REQ-GATE-001"})
    assert stored["status"] == "Draft"
    assert stored["item_version"] == detail["item_version"]


def test_reviewed_cannot_be_set_by_hand(client, routed_db):
    """Spec §4.1: `Ready for Review -> Reviewed` is band B, refused on `PATCH`.

    `Ready for Review -> Draft` is the same row's legal band-A move.
    """
    detail = _create(client, "REQ-GATE-002", status="Draft")
    detail = _patch(
        client,
        "REQ-GATE-002",
        status="Ready for Review",
        parent_version=detail["item_version"],
        actor=ACTOR,
    ).json()

    refused = _patch(
        client,
        "REQ-GATE-002",
        status="Reviewed",
        parent_version=detail["item_version"],
        actor=ACTOR,
    )
    assert refused.status_code == 409
    assert refused.json()["code"] == "illegal_transition"

    accepted = _patch(
        client,
        "REQ-GATE-002",
        status="Draft",
        parent_version=detail["item_version"],
        actor=ACTOR,
    )
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "Draft"


def test_the_free_band_moves(client, routed_db):
    """Spec §4.1: `Draft -> Ready for Review -> Rejected -> Draft`, band A.

    Each move journals one entry with `field_label="requirement.status"`.
    """
    detail = _create(client, "REQ-GATE-003", status="Draft")

    for target in ("Ready for Review", "Rejected", "Draft"):
        response = _patch(
            client,
            "REQ-GATE-003",
            status=target,
            parent_version=detail["item_version"],
            actor=ACTOR,
        )
        assert response.status_code == 200, response.text
        detail = response.json()
        assert detail["status"] == target

    entries = _journal_entries(routed_db, "REQ-GATE-003")
    status_entries = [e for e in entries if e["field"] == "requirement.status"]
    assert len(status_entries) == 3


def test_a_retired_requirement_never_moves(client, routed_db):
    """Spec §4.1: `Obsolete -> anything` is refused; retiring again is too."""
    detail = _create(client, "REQ-GATE-004", status="Draft")
    retired = client.post(
        f"{ROUTE}/REQ-GATE-004/retire",
        json={"parent_version": detail["item_version"], "actor": ACTOR},
    )
    assert retired.status_code == 200, retired.text
    detail = retired.json()

    moved = _patch(
        client,
        "REQ-GATE-004",
        status="Draft",
        parent_version=detail["item_version"],
        actor=ACTOR,
    )
    assert moved.status_code == 409
    assert moved.json()["code"] == "illegal_transition"

    retired_again = client.post(
        f"{ROUTE}/REQ-GATE-004/retire",
        json={"parent_version": detail["item_version"], "actor": ACTOR},
    )
    assert retired_again.status_code == 409
    assert retired_again.json()["code"] == "already_obsolete"


def test_an_unknown_status_can_still_reach_draft(client, routed_db):
    """Spec §4.1, §4.7: the mirror's empty-string default still reaches band A."""
    detail = _create(client, "REQ-GATE-005", status="Draft")
    _force_status(routed_db, "REQ-GATE-005", "")

    read = client.get(f"{ROUTE}/REQ-GATE-005")
    assert read.status_code == 200
    assert read.json()["status"] == ""

    accepted = _patch(
        client,
        "REQ-GATE-005",
        status="Draft",
        parent_version=detail["item_version"],
        actor=ACTOR,
    )
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "Draft"

    detail = _create(client, "REQ-GATE-005B", status="Draft")
    _force_status(routed_db, "REQ-GATE-005B", "")
    refused = _patch(
        client,
        "REQ-GATE-005B",
        status="Reviewed",
        parent_version=detail["item_version"],
        actor=ACTOR,
    )
    assert refused.status_code == 409
    assert refused.json()["code"] == "illegal_transition"


def test_a_content_edit_still_demotes_a_frozen_row(client, routed_db):
    """Spec §4.1: the BL-71 demotion (`queries_requirements.py:658-674`) is not
    refused by the new check — a `text` edit on a `Reviewed` row still lands
    `Draft`."""
    detail = _create(client, "REQ-GATE-006", status="Draft")
    _force_status(routed_db, "REQ-GATE-006", "Reviewed")
    detail = client.get(f"{ROUTE}/REQ-GATE-006").json()
    assert detail["status"] == "Reviewed"

    response = _patch(
        client,
        "REQ-GATE-006",
        text="The battery system shall hold the current within limits.",
        parent_version=detail["item_version"],
        actor=ACTOR,
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "Draft"


def test_a_status_move_suspects_no_link(client, routed_db):
    """Spec §4.1, §5.1: a status move mints `item_version` and changes neither
    hash — a status move is a person's act, not a content edit."""
    detail = _create(client, "REQ-GATE-007", status="Draft")
    before_content = detail["content_sha256"]
    before_normative = detail["normative_sha256"]
    before_version = detail["item_version"]

    moved = _patch(
        client,
        "REQ-GATE-007",
        status="Ready for Review",
        parent_version=detail["item_version"],
        actor=ACTOR,
    )
    assert moved.status_code == 200, moved.text
    after = moved.json()

    assert after["content_sha256"] == before_content
    assert after["normative_sha256"] == before_normative
    assert after["item_version"] == before_version + 1


def test_planning_cannot_push_a_derived_status(client, routed_db):
    """Spec §4.7: a push naming a derived status lands every other field and
    leaves the stored status untouched; `requirements_mirrored` still counts
    the row.

    The row is seeded through a first push, not `POST /requirements`: a
    manually-created row's fields are `manual`-sourced, and `manual` outranks
    `api:planning` (`authoring-controls/spec.md` §9) — a second push would
    then have its `title` blocked for that reason alone, which is not the
    behaviour this test targets.
    """
    seeded = client.post(
        "/api/v1/planning/sync",
        json={"requirements": [{"id": "REQ-GATE-008", "title": "Hold the current"}]},
    )
    assert seeded.status_code == 200, seeded.text

    response = client.post(
        "/api/v1/planning/sync",
        json={
            "requirements": [
                {
                    "id": "REQ-GATE-008",
                    "title": "A retitled requirement",
                    "status": "Tested",
                }
            ]
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["requirements_mirrored"] == 1

    stored = routed_db["requirements"].find_one({"_id": "REQ-GATE-008"})
    assert stored["status"] == ""
    assert stored["title"] == "A retitled requirement"


def test_planning_push_omitting_status_on_a_new_row_still_moves(client, routed_db):
    """Spec §4.7: a brand-new row born of a push that omits `status` stores the
    empty string, and it is still reachable by the unknown-current row of the
    table."""
    response = client.post(
        "/api/v1/planning/sync",
        json={"requirements": [{"id": "REQ-GATE-009", "title": "Born of a push"}]},
    )
    assert response.status_code == 200, response.text

    stored = routed_db["requirements"].find_one({"_id": "REQ-GATE-009"})
    assert stored["status"] == ""

    read = client.get(f"{ROUTE}/REQ-GATE-009")
    assert read.status_code == 200, read.text
    detail = read.json()

    moved = _patch(
        client,
        "REQ-GATE-009",
        status="Draft",
        parent_version=detail["item_version"],
        actor=ACTOR,
    )
    assert moved.status_code == 200, moved.text


def test_the_second_actor_is_recorded(client, routed_db):
    """Spec §4.4, §2.2: a content edit on a `Reviewed` row names its second
    reviewer in the note of every journal entry the edit produces, including
    the frozen-row demotion entry."""
    detail = _create(client, "REQ-GATE-010", status="Draft")
    _force_status(routed_db, "REQ-GATE-010", "Reviewed")
    detail = client.get(f"{ROUTE}/REQ-GATE-010").json()
    before_ids = {e["_id"] for e in _journal_entries(routed_db, "REQ-GATE-010")}

    response = _patch(
        client,
        "REQ-GATE-010",
        text="The battery system shall hold the current, revised.",
        parent_version=detail["item_version"],
        actor=ACTOR,
        second_actor="A. Second",
    )
    assert response.status_code == 200, response.text

    new_entries = [
        e for e in _journal_entries(routed_db, "REQ-GATE-010") if e["_id"] not in before_ids
    ]
    assert new_entries, "no journal entry was written by this edit"
    for entry in new_entries:
        assert entry["note"] is not None
        assert "Second reviewer: A. Second." in entry["note"]

    status_entry = next(e for e in new_entries if e["field"] == "requirement.status")
    assert status_entry["new"] == "Draft"
    assert "Second reviewer: A. Second." in status_entry["note"]
