"""The run's custom properties — free key and value pairs a person types.

`PATCH /test-runs/{run_id}` takes the whole map. The write replaces the stored
map, so an empty object clears every property. An absent field says nothing.
The edit follows the rules of every other manual field: the bearer token, the
`manual` source tag, the real actor and one journal entry.
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
    return list(
        db["journal_entries"].find(
            {"entity_type": "run", "entity_id": RUN, "field": "run.custom_properties"}
        )
    )


# --- the shape ---


def test_a_run_without_properties_reads_an_empty_map(client, routed_db) -> None:
    _seed(routed_db)

    assert client.get(f"/api/v1/test-runs/{RUN}").json()["custom_properties"] == {}


def test_the_patch_stores_the_map_and_the_next_read_shows_it(client, routed_db) -> None:
    _seed(routed_db)

    response = _patch(client, custom_properties={"rig serial": "R-9", "coolant": "50/50"})

    assert response.status_code == 200
    assert response.json()["custom_properties"] == {"rig serial": "R-9", "coolant": "50/50"}
    stored = client.get(f"/api/v1/test-runs/{RUN}").json()
    assert stored["custom_properties"] == {"rig serial": "R-9", "coolant": "50/50"}


def test_the_write_replaces_the_whole_map(client, routed_db) -> None:
    """A second write is a replacement, never a merge."""
    _seed(routed_db, custom_properties={"rig serial": "R-9", "coolant": "50/50"})

    body = _patch(client, custom_properties={"coolant": "60/40"}).json()

    assert body["custom_properties"] == {"coolant": "60/40"}


def test_an_empty_object_clears_every_property(client, routed_db) -> None:
    _seed(routed_db, custom_properties={"rig serial": "R-9"})

    body = _patch(client, custom_properties={}).json()

    assert body["custom_properties"] == {}


def test_an_absent_field_changes_nothing(client, routed_db) -> None:
    _seed(routed_db, custom_properties={"rig serial": "R-9"})

    body = _patch(client, operator="A. Bergström").json()

    assert body["custom_properties"] == {"rig serial": "R-9"}


def test_a_null_field_changes_nothing(client, routed_db) -> None:
    """A null is absent, never a clear. Same rule as every other field."""
    _seed(routed_db, custom_properties={"rig serial": "R-9"})

    body = _patch(client, custom_properties=None, operator="A. Bergström").json()

    assert body["custom_properties"] == {"rig serial": "R-9"}


def test_a_body_of_only_a_null_map_returns_400(client, routed_db) -> None:
    _seed(routed_db)

    response = _patch(client, custom_properties=None)

    assert response.status_code == 400
    assert response.json()["code"] == "no_fields_to_update"


def test_clearing_a_run_that_holds_none_writes_no_journal_line(client, routed_db) -> None:
    _seed(routed_db)

    _patch(client, custom_properties={}, operator="A. Bergström")

    assert _journal(routed_db) == []


# --- provenance ---


def test_the_write_carries_the_manual_source_tag(client, routed_db) -> None:
    _seed(routed_db)

    body = _patch(client, custom_properties={"coolant": "50/50"}).json()

    assert body["field_sources"]["custom_properties"]["source"] == "manual"
    assert body["field_sources"]["custom_properties"]["actor"] == ACTOR


def test_the_write_records_one_journal_entry_with_the_old_and_the_new_value(
    client, routed_db
) -> None:
    _seed(routed_db, custom_properties={"coolant": "50/50"})

    _patch(client, custom_properties={"coolant": "60/40"}, note="corrected the mix")

    entries = _journal(routed_db)
    assert len(entries) == 1
    assert entries[0]["kind"] == "change"
    assert entries[0]["source"] == "manual"
    assert entries[0]["actor"] == ACTOR
    assert entries[0]["note"] == "corrected the mix"
    assert "50/50" in entries[0]["old"]
    assert "60/40" in entries[0]["new"]


def test_a_removed_property_reaches_the_journal(client, routed_db) -> None:
    """Removing a property IS a change, so the journal records it."""
    _seed(routed_db, custom_properties={"coolant": "50/50", "rig serial": "R-9"})

    _patch(client, custom_properties={"coolant": "50/50"})

    entries = _journal(routed_db)
    assert len(entries) == 1
    assert "R-9" in entries[0]["old"]
    assert "R-9" not in entries[0]["new"]


def test_an_unchanged_map_adds_no_journal_noise(client, routed_db) -> None:
    _seed(routed_db, custom_properties={"coolant": "50/50"})

    _patch(client, custom_properties={"coolant": "50/50"})

    assert _journal(routed_db) == []


def test_a_placeholder_actor_is_refused(client, routed_db) -> None:
    """The journal never records a name that names nobody."""
    _seed(routed_db)

    response = _patch(client, custom_properties={"coolant": "50/50"}, actor="current-user")

    assert response.status_code == 422


def test_the_write_needs_the_bearer_token(bare_client, routed_db) -> None:
    _seed(routed_db)

    response = bare_client.patch(
        f"/api/v1/test-runs/{RUN}",
        json={"custom_properties": {"coolant": "50/50"}, "actor": ACTOR},
    )

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"
    assert routed_db["test_runs"].find_one({"_id": RUN}).get("custom_properties") is None


# --- the refusals ---


def test_an_empty_key_is_refused(client, routed_db) -> None:
    _seed(routed_db)

    response = _patch(client, custom_properties={"": "R-9"})

    assert response.status_code == 422
    assert response.json()["code"] == "custom_property_key_required"


def test_a_key_of_only_spaces_is_refused(client, routed_db) -> None:
    _seed(routed_db)

    response = _patch(client, custom_properties={"   ": "R-9"})

    assert response.status_code == 422
    assert response.json()["code"] == "custom_property_key_required"


def test_a_key_over_64_characters_is_refused(client, routed_db) -> None:
    _seed(routed_db)

    response = _patch(client, custom_properties={"k" * 65: "R-9"})

    assert response.status_code == 422
    assert response.json()["code"] == "custom_property_key_too_long"


def test_a_key_of_exactly_64_characters_passes(client, routed_db) -> None:
    _seed(routed_db)

    response = _patch(client, custom_properties={"k" * 64: "R-9"})

    assert response.status_code == 200


def test_a_value_over_512_characters_is_refused(client, routed_db) -> None:
    _seed(routed_db)

    response = _patch(client, custom_properties={"note": "v" * 513})

    assert response.status_code == 422
    assert response.json()["code"] == "custom_property_value_too_long"


def test_a_value_of_exactly_512_characters_passes(client, routed_db) -> None:
    _seed(routed_db)

    response = _patch(client, custom_properties={"note": "v" * 512})

    assert response.status_code == 200


def test_more_than_50_pairs_is_refused(client, routed_db) -> None:
    _seed(routed_db)

    response = _patch(client, custom_properties={f"k{index}": "v" for index in range(51)})

    assert response.status_code == 422
    assert response.json()["code"] == "too_many_custom_properties"


def test_exactly_50_pairs_passes(client, routed_db) -> None:
    _seed(routed_db)

    response = _patch(client, custom_properties={f"k{index}": "v" for index in range(50)})

    assert response.status_code == 200


def test_a_value_that_is_not_a_string_is_refused(client, routed_db) -> None:
    _seed(routed_db)

    response = _patch(client, custom_properties={"cycles": 12})

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


def test_a_map_that_is_not_an_object_is_refused(client, routed_db) -> None:
    _seed(routed_db)

    response = _patch(client, custom_properties=["coolant"])

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


def test_an_unknown_body_field_beside_the_map_returns_422(client, routed_db) -> None:
    """Every model in this repo forbids an extra field."""
    _seed(routed_db)

    response = _patch(client, custom_properties={"coolant": "50/50"}, customProperties={})

    assert response.status_code == 422
    assert "customProperties" in response.json()["detail"]


def test_the_run_keeps_its_stored_map_after_a_refusal(client, routed_db) -> None:
    _seed(routed_db, custom_properties={"coolant": "50/50"})

    _patch(client, custom_properties={"": "R-9"})

    assert client.get(f"/api/v1/test-runs/{RUN}").json()["custom_properties"] == {
        "coolant": "50/50"
    }
