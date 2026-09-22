"""TR-001 — `GET /test-definitions` lists the definition mirror.

The mirror is read-only: planning owns every field, so no write route exists.
`actual_runs`, `status` and `orphaned` derive at read time, the same way the
work-order detail (#11) derives the first two.

A definition is **orphaned** when it names no work order, or when it names one
the mirror does not hold. The workbook (TR-001) asks for exactly that flag.
"""

from tests.factories_planning import make_definition, seed_mirror

# A work order id no mirror row carries.
MISSING_WO = "WO-2026-0899"


def _get(client, **params):
    return client.get("/api/v1/test-definitions", params=params or None)


def _seed(db) -> None:
    """The work-order cast, plus one orphan of each shape."""
    seed_mirror(db)
    db["test_definitions"].insert_many(
        [
            make_definition(
                td_id="TD-BAT-118",
                work_order_id=None,
                title="HV battery thermal cycling · cold-soak extension",
                planned_runs=2,
            ),
            make_definition(
                td_id="TD-RLD-301",
                work_order_id=MISSING_WO,
                title="Road load capture · instrumented durability route",
                planned_runs=1,
            ),
        ]
    )


# --- the list ---------------------------------------------------------------


def test_the_list_reads_every_mirror_row(client, routed_db) -> None:
    _seed(routed_db)

    body = _get(client).json()

    assert body["total"] == 5
    # The sort is fixed on the id, lowest first, so the list and the
    # work-order detail agree on the order of a definition.
    assert [row["td_id"] for row in body["items"]] == [
        "TD-BAT-118",
        "TD-EM-201",
        "TD-EM-204",
        "TD-INV-077",
        "TD-RLD-301",
    ]


def test_a_row_carries_the_definition_fields(client, routed_db) -> None:
    _seed(routed_db)

    rows = {row["td_id"]: row for row in _get(client).json()["items"]}

    assert rows["TD-EM-201"]["title"] == "E-machine efficiency map — WLTP points"
    assert rows["TD-EM-201"]["work_order_id"] == "WO-2026-0847"
    assert rows["TD-EM-201"]["planned_runs"] == 2
    assert rows["TD-EM-201"]["synced_at"].endswith("Z")


def test_planned_versus_actual_derives_at_read_time(client, routed_db) -> None:
    """The same derivation the work-order detail uses (#11)."""
    _seed(routed_db)

    rows = {row["td_id"]: row for row in _get(client).json()["items"]}

    assert rows["TD-EM-201"]["actual_runs"] == 2
    assert rows["TD-EM-201"]["status"] == "on_plan"
    assert rows["TD-EM-204"]["actual_runs"] == 0
    assert rows["TD-EM-204"]["status"] == "awaiting_data"


def test_a_definition_without_a_planned_count_reads_as_on_plan(client, routed_db) -> None:
    """`planned_runs` is nullable. A null plan can never be behind."""
    _seed(routed_db)
    routed_db["test_definitions"].update_one(
        {"_id": "TD-EM-204"}, {"$set": {"planned_runs": None}}
    )

    rows = {row["td_id"]: row for row in _get(client).json()["items"]}

    assert rows["TD-EM-204"]["planned_runs"] == 0
    assert rows["TD-EM-204"]["status"] == "on_plan"


# --- the orphan flag and the filter -----------------------------------------


def test_a_null_work_order_id_reads_as_orphaned(client, routed_db) -> None:
    _seed(routed_db)

    rows = {row["td_id"]: row for row in _get(client).json()["items"]}

    assert rows["TD-BAT-118"]["work_order_id"] is None
    assert rows["TD-BAT-118"]["orphaned"] is True


def test_a_work_order_id_that_names_no_mirror_row_reads_as_orphaned(client, routed_db) -> None:
    """The link survived the sync, the work order did not. TR-001 flags it."""
    _seed(routed_db)

    rows = {row["td_id"]: row for row in _get(client).json()["items"]}

    assert rows["TD-RLD-301"]["work_order_id"] == MISSING_WO
    assert rows["TD-RLD-301"]["orphaned"] is True


def test_a_linked_definition_is_not_orphaned(client, routed_db) -> None:
    _seed(routed_db)

    rows = {row["td_id"]: row for row in _get(client).json()["items"]}

    assert rows["TD-EM-201"]["orphaned"] is False


def test_orphaned_true_returns_the_orphans_only(client, routed_db) -> None:
    _seed(routed_db)

    body = _get(client, orphaned="true").json()

    assert [row["td_id"] for row in body["items"]] == ["TD-BAT-118", "TD-RLD-301"]
    assert body["total"] == 2
    assert all(row["orphaned"] is True for row in body["items"])


def test_orphaned_false_returns_the_linked_rows_only(client, routed_db) -> None:
    _seed(routed_db)

    body = _get(client, orphaned="false").json()

    assert [row["td_id"] for row in body["items"]] == ["TD-EM-201", "TD-EM-204", "TD-INV-077"]
    assert body["total"] == 3
    assert all(row["orphaned"] is False for row in body["items"])


def test_an_absent_filter_returns_both_kinds(client, routed_db) -> None:
    _seed(routed_db)

    body = _get(client).json()

    assert body["total"] == 5


# --- the envelope -----------------------------------------------------------


def test_the_page_envelope_carries_the_contract_keys(client, routed_db) -> None:
    _seed(routed_db)

    body = _get(client, page=1, page_size=10).json()

    assert body["page"] == 1
    assert body["page_size"] == 10
    assert body["total_pages"] == 1


def test_page_two_differs_from_page_one(client, routed_db) -> None:
    _seed(routed_db)

    first = _get(client, page=1, page_size=10).json()
    second = _get(client, page=2, page_size=10).json()

    assert len(first["items"]) == 5
    assert second["items"] == []


def test_the_page_size_allow_list_holds(client, routed_db) -> None:
    """§2.2. A page size outside the allow-list is a 422, never a silent clamp."""
    _seed(routed_db)

    assert _get(client, page_size=7).status_code == 422


def test_an_empty_mirror_lists_nothing(client, routed_db) -> None:
    body = _get(client).json()

    assert body["items"] == []
    assert body["total"] == 0
    assert body["total_pages"] == 0


# --- auth and the read-only mirror ------------------------------------------


def test_the_route_needs_the_bearer_token(bare_client, routed_db) -> None:
    """Every /api/v1 read carries the same 401."""
    _seed(routed_db)

    response = bare_client.get("/api/v1/test-definitions")

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


def test_the_mirror_rejects_writes(client, routed_db) -> None:
    """No write route exists, so the method is not allowed."""
    _seed(routed_db)

    for response in (
        client.post("/api/v1/test-definitions", json={"title": "x"}),
        client.patch("/api/v1/test-definitions", json={"title": "x"}),
        client.delete("/api/v1/test-definitions"),
    ):
        assert response.status_code == 405


# --- the detail read --------------------------------------------------------
#
# The definition was the one node of the traceability chain a person could not
# click (FR-DM-074). The detail read serves that screen.


def _detail(client, td_id: str):
    return client.get(f"/api/v1/test-definitions/{td_id}")


def test_the_detail_carries_the_list_row_fields(client, routed_db) -> None:
    """The detail extends the row, so no field reads two ways."""
    _seed(routed_db)

    body = _detail(client, "TD-EM-201").json()

    assert body["td_id"] == "TD-EM-201"
    assert body["title"] == "E-machine efficiency map — WLTP points"
    assert body["work_order_id"] == "WO-2026-0847"
    assert body["planned_runs"] == 2
    assert body["actual_runs"] == 2
    assert body["status"] == "on_plan"
    assert body["orphaned"] is False
    assert body["synced_at"].endswith("Z")


def test_the_detail_names_the_work_order(client, routed_db) -> None:
    _seed(routed_db)

    work_order = _detail(client, "TD-EM-201").json()["work_order"]

    assert work_order["wo_id"] == "WO-2026-0847"
    assert work_order["title"] == "E-machine efficiency characterisation"
    assert work_order["project"] == "EX90"
    assert work_order["status"] == "active"


def test_the_detail_lists_the_runs_newest_first(client, routed_db) -> None:
    _seed(routed_db)

    runs = _detail(client, "TD-EM-201").json()["runs"]

    assert [run["run_id"] for run in runs] == ["TAS-88213", "TAS-88212"]
    assert runs[0]["rig_id"] == "RIG-02"
    assert runs[0]["definition_id"] == "TD-EM-201"
    assert runs[0]["status"] == "complete"


def test_a_definition_with_no_run_lists_none(client, routed_db) -> None:
    _seed(routed_db)

    body = _detail(client, "TD-EM-204").json()

    assert body["runs"] == []
    assert body["actual_runs"] == 0
    assert body["status"] == "awaiting_data"


def test_a_null_work_order_id_reads_as_an_orphan_on_the_detail(client, routed_db) -> None:
    _seed(routed_db)

    body = _detail(client, "TD-BAT-118").json()

    assert body["work_order_id"] is None
    assert body["work_order"] is None
    assert body["orphaned"] is True


def test_a_work_order_the_mirror_does_not_hold_reads_as_an_orphan(client, routed_db) -> None:
    """The link survived the sync, the work order did not. The list agrees."""
    _seed(routed_db)

    body = _detail(client, "TD-RLD-301").json()

    assert body["work_order_id"] == MISSING_WO
    assert body["work_order"] is None
    assert body["orphaned"] is True


def test_an_unknown_definition_answers_404(client, routed_db) -> None:
    _seed(routed_db)

    response = _detail(client, "TD-NOPE-000")

    assert response.status_code == 404
    assert response.json()["code"] == "td_not_found"


def test_the_detail_needs_the_bearer_token(bare_client, routed_db) -> None:
    _seed(routed_db)

    response = bare_client.get("/api/v1/test-definitions/TD-EM-201")

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


def test_the_detail_and_the_list_agree_on_every_row(client, routed_db) -> None:
    """One helper derives the fields, so the two reads can never drift."""
    _seed(routed_db)

    for row in _get(client).json()["items"]:
        body = _detail(client, row["td_id"]).json()
        assert {key: body[key] for key in row} == row
