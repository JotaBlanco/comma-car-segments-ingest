"""A-06 — contract #4, `PATCH /test-runs/{run_id}`.

A person edits a run by hand. The edit persists, it carries the `manual` source
tag, and it writes exactly one journal line per field that actually changed.
Sending a field as null means "I said nothing about this", never "clear it".
"""

from tests.factories_planning import make_run

RUN = "TAS-88214"
ACTOR = "a.bergstrom"


def _seed(db, **overrides) -> None:
    db["test_runs"].insert_one(make_run(run_id=RUN, **overrides))


def _patch(client, **body):
    body.setdefault("actor", ACTOR)
    return client.patch(f"/api/v1/test-runs/{RUN}", json=body)


def _journal(db) -> list[dict]:
    return list(db["journal_entries"].find({"entity_type": "run", "entity_id": RUN}))


def test_a_patch_persists_and_the_next_read_shows_it(client, routed_db) -> None:
    _seed(routed_db, operator=None)

    response = _patch(client, operator="A. Bergström")

    assert response.status_code == 200
    assert response.json()["operator"] == "A. Bergström"
    assert client.get(f"/api/v1/test-runs/{RUN}").json()["operator"] == "A. Bergström"


def test_the_edit_carries_the_manual_source_tag(client, routed_db) -> None:
    _seed(routed_db, operator=None)

    body = _patch(client, operator="A. Bergström").json()

    assert body["field_sources"]["operator"]["source"] == "manual"
    assert body["field_sources"]["operator"]["actor"] == ACTOR


def test_the_edit_writes_one_journal_entry(client, routed_db) -> None:
    _seed(routed_db, operator=None)

    _patch(client, operator="A. Bergström", note="took over the bench")

    entries = _journal(routed_db)
    assert len(entries) == 1
    assert entries[0]["kind"] == "change"
    assert entries[0]["new"] == "A. Bergström"
    assert entries[0]["note"] == "took over the bench"


def test_the_journal_labels_the_field_with_the_run_prefix(client, routed_db) -> None:
    """Contract §A: a journal field reads dotted, `run.operator` not `operator`."""
    _seed(routed_db, operator=None)

    _patch(client, operator="A. Bergström")

    assert _journal(routed_db)[0]["field"] == "run.operator"


def test_an_unchanged_field_adds_no_journal_noise(client, routed_db) -> None:
    _seed(routed_db, operator="A. Bergström")

    _patch(client, operator="A. Bergström")

    assert _journal(routed_db) == []


def test_two_fields_write_two_entries(client, routed_db) -> None:
    _seed(routed_db, operator=None, description=None)

    _patch(client, operator="A. Bergström", description="HV battery thermal cycling")

    assert len(_journal(routed_db)) == 2


def test_null_keeps_stored_value(client, routed_db) -> None:
    """Guard test 8. A null field is absent, never a clear."""
    _seed(routed_db, operator="A. Bergström")

    body = _patch(client, operator=None, description="a real change").json()

    assert body["operator"] == "A. Bergström"
    assert body["description"] == "a real change"


def test_a_body_with_no_usable_field_returns_400(client, routed_db) -> None:
    _seed(routed_db)

    response = _patch(client)

    assert response.status_code == 400
    assert response.json()["code"] == "no_fields_to_update"


def test_a_body_of_only_nulls_returns_400(client, routed_db) -> None:
    """Nulls are absent, so a body of nulls says nothing at all."""
    _seed(routed_db)

    response = _patch(client, operator=None, description=None, bench_sw=None)

    assert response.status_code == 400
    assert response.json()["code"] == "no_fields_to_update"


def test_an_unknown_body_field_returns_422_naming_the_field(client, routed_db) -> None:
    """Guard test 11 for #4."""
    _seed(routed_db)

    response = client.patch(f"/api/v1/test-runs/{RUN}", json={"actor": ACTOR, "rig_id": "RIG-09"})

    assert response.status_code == 422
    assert "rig_id" in response.json()["detail"]


def test_an_unknown_run_returns_404(client, routed_db) -> None:
    response = _patch(client, operator="A. Bergström")

    assert response.status_code == 404
    assert response.json()["code"] == "run_not_found"


def test_a_manual_edit_survives_re_ingestion(client, routed_db) -> None:
    """Precedence, end to end: the upsert must not undo what a person typed."""
    _seed(routed_db, description=None)
    _patch(client, description="corrected by hand")

    client.post("/api/v1/test-runs", json={"run_id": RUN, "rig_id": "RIG-04",
                                           "description": "from the file header"})

    assert client.get(f"/api/v1/test-runs/{RUN}").json()["description"] == "corrected by hand"
