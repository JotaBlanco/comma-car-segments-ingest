"""A-07 — contract #8, the run journal, plus the ★ note POST.

A run's timeline is not only its own entries. A signal edit made while looking
at a run belongs to that run's story too, so the query unions on
`context_run_id`. That union is what puts a unit change inside TAS-88214.
"""

from datetime import UTC, datetime

from tests.factories_planning import make_run

RUN = "TAS-88214"
ACTOR = "a.bergstrom"


def _seed(db) -> None:
    db["test_runs"].insert_one(make_run(run_id=RUN))


def _entry(entry_id: str, **overrides) -> dict:
    doc = {
        "_id": entry_id,
        "entity_type": "run",
        "entity_id": RUN,
        "field": "run.work_order",
        "kind": "change",
        "old": "(empty)",
        "new": "WO-2026-0851",
        "source": "api:planning",
        "actor": "planning-sync",
        "note": None,
        "context_run_id": None,
        "at": datetime(2026, 8, 14, 11, 32, 4, tzinfo=UTC),
    }
    doc.update(overrides)
    return doc


def _journal(client, **params) -> dict:
    return client.get(f"/api/v1/test-runs/{RUN}/journal", params=params or None).json()


def test_the_journal_reads_the_run_entries(client, routed_db) -> None:
    _seed(routed_db)
    routed_db["journal_entries"].insert_one(_entry("j-1"))

    body = _journal(client)

    assert body["total"] == 1
    assert body["items"][0]["id"] == "j-1"
    assert body["items"][0]["entity_type"] == "run"


def test_a_signal_edit_in_run_context_joins_the_timeline(client, routed_db) -> None:
    """The union that puts `signal.<name>.unit` inside this run's story."""
    _seed(routed_db)
    routed_db["journal_entries"].insert_many(
        [
            _entry("j-1"),
            _entry(
                "j-2",
                entity_type="signal",
                entity_id="Coolant_Inlet_Temp",
                field="signal.Coolant_Inlet_Temp.unit",
                context_run_id=RUN,
                source="manual",
                actor=ACTOR,
            ),
        ]
    )

    body = _journal(client)

    assert body["total"] == 2
    assert {item["id"] for item in body["items"]} == {"j-1", "j-2"}


def test_another_run_s_entries_stay_out(client, routed_db) -> None:
    _seed(routed_db)
    routed_db["journal_entries"].insert_many(
        [_entry("j-1"), _entry("j-2", entity_id="TAS-88213")]
    )

    assert [item["id"] for item in _journal(client)["items"]] == ["j-1"]


def test_the_newest_entry_comes_first(client, routed_db) -> None:
    _seed(routed_db)
    routed_db["journal_entries"].insert_many(
        [
            _entry("j-old", at=datetime(2026, 8, 14, 9, 0, tzinfo=UTC)),
            _entry("j-new", at=datetime(2026, 8, 14, 12, 0, tzinfo=UTC)),
        ]
    )

    assert [item["id"] for item in _journal(client)["items"]] == ["j-new", "j-old"]


def test_the_kind_filter_filters(client, routed_db) -> None:
    _seed(routed_db)
    routed_db["journal_entries"].insert_many(
        [
            _entry("j-change", kind="change"),
            _entry("j-event", kind="event", old=None, new=None),
            _entry("j-note", kind="note", field=None, old=None, new=None, note="a note"),
        ]
    )

    assert [i["id"] for i in _journal(client, kind="note")["items"]] == ["j-note"]
    assert [i["id"] for i in _journal(client, kind="event")["items"]] == ["j-event"]


def test_the_journal_pages_default_to_fifty(client, routed_db) -> None:
    _seed(routed_db)

    assert _journal(client)["page_size"] == 50


def test_an_unknown_run_returns_404(client, routed_db) -> None:
    response = client.get("/api/v1/test-runs/TAS-99999/journal")

    assert response.status_code == 404
    assert response.json()["code"] == "run_not_found"


def test_a_run_with_no_entries_reads_empty(client, routed_db) -> None:
    _seed(routed_db)

    body = _journal(client)

    assert body["items"] == []
    assert body["total"] == 0


# --- the ★ note POST --------------------------------------------------------


def test_a_posted_note_persists(client, routed_db) -> None:
    _seed(routed_db)

    response = client.post(
        f"/api/v1/test-runs/{RUN}/journal",
        json={"note": "Bench recalibrated before this run.", "actor": ACTOR},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["kind"] == "note"
    assert body["note"] == "Bench recalibrated before this run."
    assert body["actor"] == ACTOR


def test_a_note_carries_no_field_and_no_old_or_new(client, routed_db) -> None:
    _seed(routed_db)

    body = client.post(
        f"/api/v1/test-runs/{RUN}/journal", json={"note": "a note", "actor": ACTOR}
    ).json()

    assert body["field"] is None
    assert body["old"] is None and body["new"] is None


def test_a_posted_note_appears_in_the_timeline(client, routed_db) -> None:
    _seed(routed_db)

    client.post(f"/api/v1/test-runs/{RUN}/journal", json={"note": "a note", "actor": ACTOR})

    assert _journal(client)["total"] == 1


def test_a_note_on_an_unknown_run_returns_404(client, routed_db) -> None:
    response = client.post(
        "/api/v1/test-runs/TAS-99999/journal", json={"note": "a note", "actor": ACTOR}
    )

    assert response.status_code == 404


def test_an_unknown_body_field_returns_422_naming_the_field(client, routed_db) -> None:
    _seed(routed_db)

    response = client.post(
        f"/api/v1/test-runs/{RUN}/journal",
        json={"note": "a note", "actor": ACTOR, "kind": "change"},
    )

    assert response.status_code == 422
    assert "kind" in response.json()["detail"]


# --- the page needs a tiebreak (finding 40b) -----------------------------------


def test_paging_a_tied_timeline_repeats_no_entry_and_drops_none(
    client, routed_db
) -> None:
    """The sort key alone is `at`, and the ingestion path ties it constantly.

    Several entries of one registration carry the same millisecond, so `at`
    puts them in no order at all. Mongo may then answer one order for page 1
    and another for page 2, and the reader sees an entry twice while another
    entry never appears. `_id` breaks the tie, so the pages partition the set.

    Drop `_id` from the sort in `list_run_journal` and this test can fail.
    """
    _seed(routed_db)
    tied = datetime(2026, 8, 14, 11, 32, 4, tzinfo=UTC)
    # The ids go in on purpose in an order that is not the insert order, so a
    # natural-order answer and an `_id` answer are two different sequences.
    ids = [f"j-{index:02d}" for index in range(30)]
    routed_db["journal_entries"].insert_many(
        [_entry(entry_id, at=tied) for entry_id in reversed(ids)]
    )

    seen: list[str] = []
    for page in (1, 2, 3):
        answer = _journal(client, page=page, page_size=10)
        assert answer["total"] == 30
        seen += [item["id"] for item in answer["items"]]

    assert sorted(seen) == sorted(ids)
    assert len(set(seen)) == 30


def test_a_tied_timeline_answers_the_same_page_twice(client, routed_db) -> None:
    """One request, one answer. A tie must not make the page wander."""
    _seed(routed_db)
    tied = datetime(2026, 8, 14, 11, 32, 4, tzinfo=UTC)
    routed_db["journal_entries"].insert_many(
        [_entry(f"j-{index:02d}", at=tied) for index in range(30)]
    )

    first = [item["id"] for item in _journal(client, page=2, page_size=10)["items"]]
    again = [item["id"] for item in _journal(client, page=2, page_size=10)["items"]]

    assert first == again
