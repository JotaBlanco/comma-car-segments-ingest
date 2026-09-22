"""FR-DM-108 — a person defines their own grouping criterion.

The workbook asks that "users can define or customise grouping criteria". A
fixed list of three fields answers that narrowly, so `group_by` also takes
`custom:<key>` and reads the run's own custom property map — the free key and
value pairs a person types in the run metadata dialog.

The rules under test:

* a custom key groups the runs by the value they store under it;
* the fixed three keep the exact behaviour they had;
* a key no run carries answers an empty group list, never an error;
* a bad key is refused, and it keeps the code the property validator gives;
* every filter of §2 still narrows a custom group, the way it narrows a fixed
  one, so a count can never disagree with the filtered list;
* `GET /test-runs/facets` names the keys, so the control offers real ones.
"""

from datetime import UTC, datetime, timedelta

from tests.factories_planning import make_run

BASE_AT = datetime(2026, 8, 14, 9, 0, tzinfo=UTC)

GROUPS_PATH = "/api/v1/test-runs/groups"


def _groups(client, **params) -> dict:
    return client.get(GROUPS_PATH, params=params).json()


def _pairs(body: dict) -> list[tuple[str | None, int]]:
    return [(item["value"], item["count"]) for item in body["items"]]


def _seed_runs(db) -> None:
    """Five runs. Three carry `rig-owner`, two of those share an owner.

    One run carries a second key, one carries an empty map, and one carries no
    map at all — a run written before the field existed.
    """
    db["test_runs"].insert_many(
        [
            make_run(
                run_id="TAS-88214", rig_id="RIG-04", project="EX90", status="complete",
                custom_properties={"rig-owner": "powertrain", "coolant": "50/50"},
                first_data_at=BASE_AT + timedelta(hours=4),
            ),
            make_run(
                run_id="TAS-88213", rig_id="RIG-04", project="EX90", status="complete",
                custom_properties={"rig-owner": "powertrain"},
                first_data_at=BASE_AT + timedelta(hours=3),
            ),
            make_run(
                run_id="TAS-88212", rig_id="RIG-02", project="EC40", status="invalid",
                custom_properties={"rig-owner": "chassis"},
                first_data_at=BASE_AT + timedelta(hours=2),
            ),
            make_run(
                run_id="TAS-88209", rig_id="RIG-02", project="EC40", status="complete",
                custom_properties={},
                first_data_at=BASE_AT + timedelta(hours=1),
            ),
            make_run(
                run_id="TAS-88200", rig_id="RIG-02", project=None, status="complete",
                first_data_at=BASE_AT,
            ),
        ]
    )


# --- grouping by a custom property -------------------------------------------


def test_a_custom_property_groups_the_runs_that_carry_it(client, routed_db):
    _seed_runs(routed_db)
    body = _groups(client, group_by="custom:rig-owner")
    assert _pairs(body) == [("powertrain", 2), ("chassis", 1)]
    assert body["total"] == 2


def test_a_run_without_the_property_forms_no_group(client, routed_db):
    _seed_runs(routed_db)
    body = _groups(client, group_by="custom:coolant")
    # Only TAS-88214 carries `coolant`. The other four are absent, not a null
    # group: a custom property is sparse, so "not set" would say nothing.
    assert _pairs(body) == [("50/50", 1)]


def test_a_key_no_run_carries_answers_an_empty_group_list(client, routed_db):
    _seed_runs(routed_db)
    body = _groups(client, group_by="custom:nobody-uses-this")
    assert body["items"] == []
    assert body["total"] == 0


def test_a_key_holding_a_dot_reads_the_property_and_not_a_nested_field(client, routed_db):
    # `$getField` reads the map by name, so the key never becomes a field path.
    # Without that, `custom:rig.owner` would address `custom_properties.rig`.
    routed_db["test_runs"].insert_one(
        make_run(run_id="TAS-90001", custom_properties={"rig.owner": "chassis"})
    )
    assert _pairs(_groups(client, group_by="custom:rig.owner")) == [("chassis", 1)]


def test_a_key_holding_a_dollar_sign_is_read_as_a_plain_name(client, routed_db):
    routed_db["test_runs"].insert_one(
        make_run(run_id="TAS-90002", custom_properties={"$rate": "10 Hz"})
    )
    response = client.get(GROUPS_PATH, params={"group_by": "custom:$rate"})
    assert response.status_code == 200
    assert _pairs(response.json()) == [("10 Hz", 1)]


# --- the fixed three do not change -------------------------------------------


def test_the_fixed_names_still_group_and_still_keep_the_null_group(client, routed_db):
    _seed_runs(routed_db)
    assert _pairs(_groups(client, group_by="project")) == [("EC40", 2), ("EX90", 2), (None, 1)]
    assert _pairs(_groups(client, group_by="rig")) == [("RIG-02", 3), ("RIG-04", 2)]
    assert _pairs(_groups(client, group_by="test_cell")) == [("TC-1", 5)]


# --- the filters still narrow a custom group ---------------------------------


def test_a_filter_narrows_a_custom_group(client, routed_db):
    _seed_runs(routed_db)
    body = _groups(client, group_by="custom:rig-owner", rig="RIG-04")
    assert _pairs(body) == [("powertrain", 2)]


def test_two_filters_at_once_narrow_a_custom_group(client, routed_db):
    _seed_runs(routed_db)
    body = _groups(client, group_by="custom:rig-owner", rig="RIG-02", status="complete")
    # TAS-88212 is the only RIG-02 run with an owner, and it is invalid.
    assert body["items"] == []


def test_a_custom_group_counts_only_the_runs_the_flat_list_keeps(client, routed_db):
    _seed_runs(routed_db)
    grouped = _groups(client, group_by="custom:rig-owner", status="complete", page_size=500)
    flat = client.get("/api/v1/test-runs", params={"status": "complete", "page_size": 500}).json()
    summed = sum(item["count"] for item in grouped["items"])
    # Every grouped run is a listed run. The sum is smaller, because the runs
    # that carry no such property form no group.
    assert summed <= flat["total"]
    assert summed == 2


# --- the refusals ------------------------------------------------------------


def test_an_empty_custom_key_is_refused(client, routed_db):
    response = client.get(GROUPS_PATH, params={"group_by": "custom:"})
    assert response.status_code == 422
    assert response.json()["code"] == "custom_property_key_required"


def test_a_blank_custom_key_is_refused(client, routed_db):
    response = client.get(GROUPS_PATH, params={"group_by": "custom:   "})
    assert response.status_code == 422
    assert response.json()["code"] == "custom_property_key_required"


def test_a_custom_key_over_the_cap_is_refused(client, routed_db):
    response = client.get(GROUPS_PATH, params={"group_by": "custom:" + "x" * 65})
    assert response.status_code == 422
    assert response.json()["code"] == "custom_property_key_too_long"


def test_a_name_that_is_neither_fixed_nor_prefixed_still_answers_422(client, routed_db):
    response = client.get(GROUPS_PATH, params={"group_by": "custom_properties.rig-owner"})
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert body["errors"][0]["loc"] == ["query", "group_by"]


# --- the facets name the keys ------------------------------------------------


def test_the_facets_name_every_custom_property_key(client, routed_db):
    _seed_runs(routed_db)
    body = client.get("/api/v1/test-runs/facets").json()
    assert body["custom_property_keys"] == ["coolant", "rig-owner"]


def test_the_facets_name_no_key_when_no_run_carries_one(client, routed_db):
    routed_db["test_runs"].insert_one(make_run(run_id="TAS-90003"))
    body = client.get("/api/v1/test-runs/facets").json()
    assert body["custom_property_keys"] == []
