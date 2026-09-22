"""Table-filters coverage for GET /files (contract §2.2, §2.3, §2.4).

* multi-value ``status`` / ``source_system`` — OR within a key, AND across
  keys; single-value calls stay byte-identical.
* ``sort`` whitelist ``registered_at`` + ``size_bytes``, default
  ``registered_at desc`` (identical to today's fixed sort); bad ``sort`` or
  ``order`` → 422 ``validation_error`` with a ``["query", ...]`` loc.
* ``view_counts`` keys ``{"all", "registered", "quarantined", "archived",
  "deleted"}``, whole-table and filter-independent.
* Pagination stability across pages when combined with sort + filter — the
  deterministic ``_id asc`` tiebreak in ``ResolvedSort.as_mongo`` pins it.

Style follows tests/test_files_list.py exactly.
"""

from datetime import UTC, datetime, timedelta

from tests import factories
from tests.factories import register_file

# Re-export the fixture (indexes applied on the routed database).
files_db = factories.files_db

BASE_AT = datetime(2026, 8, 14, 9, 0, tzinfo=UTC)


def _get(client, **params) -> dict:
    response = client.get("/api/v1/files", params=params)
    assert response.status_code == 200
    return response.json()


def _names(body: dict) -> list[str]:
    return [item["filename"] for item in body["items"]]


def _seed_mixed_files(db) -> None:
    """Four files across the two statuses and two source systems."""
    register_file(
        db,
        filename="tas_reg.mf4",
        status="registered",
        source_system="TAS",
        size_bytes=10_000,
        registered_at=BASE_AT + timedelta(hours=3),
    )
    register_file(
        db,
        filename="inca_reg.dat",
        status="registered",
        source_system="INCA",
        size_bytes=999_000,
        registered_at=BASE_AT + timedelta(hours=2),
    )
    register_file(
        db,
        filename="tas_quar.mf4",
        status="quarantined",
        source_system="TAS",
        quarantine_reason="checksum mismatch",
        size_bytes=5_000,
        registered_at=BASE_AT + timedelta(hours=1),
    )
    register_file(
        db,
        filename="ifile_reg.bin",
        status="registered",
        source_system="ifile",
        size_bytes=200_000,
        registered_at=BASE_AT,
    )


# --- multi-value filters (§2.2) --------------------------------------------


def test_status_two_values_return_the_union(client, files_db) -> None:
    _seed_mixed_files(files_db)

    body = _get(client, status=["registered", "quarantined"])

    assert set(_names(body)) == {"tas_reg.mf4", "inca_reg.dat", "tas_quar.mf4", "ifile_reg.bin"}
    assert body["total"] == 4


def test_source_system_two_values_return_the_union(client, files_db) -> None:
    _seed_mixed_files(files_db)

    body = _get(client, source_system=["TAS", "INCA"])

    assert set(_names(body)) == {"tas_reg.mf4", "inca_reg.dat", "tas_quar.mf4"}


def test_status_and_source_system_combine_with_and(client, files_db) -> None:
    _seed_mixed_files(files_db)

    body = _get(client, status="quarantined", source_system=["TAS", "INCA"])

    assert _names(body) == ["tas_quar.mf4"]


def test_status_single_value_matches_pre_change_behavior(client, files_db) -> None:
    """Regression pin: the `/files?status=quarantined` deep link is v1."""
    _seed_mixed_files(files_db)

    body = _get(client, status="quarantined")

    assert _names(body) == ["tas_quar.mf4"]
    assert body["total"] == 1


def test_source_system_single_value_matches_pre_change_behavior(client, files_db) -> None:
    _seed_mixed_files(files_db)

    body = _get(client, source_system="INCA")

    assert _names(body) == ["inca_reg.dat"]


def test_absent_filters_return_the_whole_collection(client, files_db) -> None:
    _seed_mixed_files(files_db)

    body = _get(client)

    assert body["total"] == 4


# --- sort params (§2.3) -----------------------------------------------------


def test_default_sort_is_registered_at_desc(client, files_db) -> None:
    """Absent sort/order = the pre-change fixed sort (byte-identical)."""
    _seed_mixed_files(files_db)

    body = _get(client)

    assert _names(body) == [
        "tas_reg.mf4",
        "inca_reg.dat",
        "tas_quar.mf4",
        "ifile_reg.bin",
    ]


def test_sort_registered_at_asc_reverses_the_default(client, files_db) -> None:
    _seed_mixed_files(files_db)

    body = _get(client, sort="registered_at", order="asc")

    assert _names(body) == [
        "ifile_reg.bin",
        "tas_quar.mf4",
        "inca_reg.dat",
        "tas_reg.mf4",
    ]


def test_sort_by_size_bytes_desc(client, files_db) -> None:
    _seed_mixed_files(files_db)

    body = _get(client, sort="size_bytes", order="desc")

    assert _names(body) == [
        "inca_reg.dat",
        "ifile_reg.bin",
        "tas_reg.mf4",
        "tas_quar.mf4",
    ]


def test_sort_by_size_bytes_asc(client, files_db) -> None:
    _seed_mixed_files(files_db)

    body = _get(client, sort="size_bytes", order="asc")

    assert _names(body) == [
        "tas_quar.mf4",
        "tas_reg.mf4",
        "ifile_reg.bin",
        "inca_reg.dat",
    ]


def test_ties_break_deterministically_by_id_asc(client, files_db) -> None:
    """Files at the same size must not shuffle across pages."""
    for name, file_id in (("b.mf4", "f-002"), ("a.mf4", "f-001"), ("c.mf4", "f-003")):
        register_file(files_db, _id=file_id, filename=name, size_bytes=1024)

    body = _get(client, sort="size_bytes", order="desc")

    assert [item["file_id"] for item in body["items"]] == ["f-001", "f-002", "f-003"]


def test_unknown_sort_key_returns_422_validation_error(client, files_db) -> None:
    response = client.get("/api/v1/files", params={"sort": "checksum"})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert body["errors"][0]["loc"] == ["query", "sort"]


def test_bad_order_value_returns_422_validation_error(client, files_db) -> None:
    response = client.get("/api/v1/files", params={"order": "up"})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert body["errors"][0]["loc"] == ["query", "order"]


# --- view_counts (§2.4) -----------------------------------------------------


def test_view_counts_carries_the_five_keys(client, files_db) -> None:
    _seed_mixed_files(files_db)

    view_counts = _get(client)["view_counts"]

    assert set(view_counts) == {
        "all",
        "registered",
        "quarantined",
        "archived",
        "deleted",
    }


def test_view_counts_match_the_seeded_data(client, files_db) -> None:
    _seed_mixed_files(files_db)

    view_counts = _get(client)["view_counts"]

    # 4 files, 3 registered, 1 quarantined. Nobody archived or deleted one.
    assert view_counts == {
        "all": 4,
        "registered": 3,
        "quarantined": 1,
        "archived": 0,
        "deleted": 0,
    }


def test_view_counts_are_filter_independent(client, files_db) -> None:
    """Applying a filter must not change the whole-table counts."""
    _seed_mixed_files(files_db)

    unfiltered = _get(client)["view_counts"]
    filtered = _get(client, status="quarantined")["view_counts"]
    sorted_filtered = _get(
        client, source_system=["TAS", "INCA"], sort="size_bytes", order="desc"
    )["view_counts"]

    assert filtered == unfiltered
    assert sorted_filtered == unfiltered


# --- pagination + filter + sort (§2.2/§2.3) --------------------------------


def test_pagination_slices_the_filtered_sorted_result(client, files_db) -> None:
    """Filter + non-default sort + paging = disjoint slices with total intact."""
    for index in range(12):
        register_file(
            files_db,
            filename=f"file_{index:02d}.mf4",
            status="registered",
            source_system="TAS",
            size_bytes=1_000 + index,  # unique size so no tie ambiguity
            registered_at=BASE_AT + timedelta(minutes=index),
        )
    # One quarantined file that must not leak into the filtered pages.
    register_file(
        files_db,
        filename="quarantined_outlier.mf4",
        status="quarantined",
        source_system="TAS",
        size_bytes=5_000,
    )

    params = {"status": "registered", "sort": "size_bytes", "order": "asc", "page_size": 10}
    first = _get(client, **params, page=1)
    second = _get(client, **params, page=2)

    assert first["total"] == 12
    assert first["total_pages"] == 2
    assert len(first["items"]) == 10
    assert len(second["items"]) == 2
    first_ids = {item["file_id"] for item in first["items"]}
    second_ids = {item["file_id"] for item in second["items"]}
    assert first_ids.isdisjoint(second_ids)
    # And the outlier stayed out of both pages.
    all_names = _names(first) + _names(second)
    assert "quarantined_outlier.mf4" not in all_names


def test_q_combines_with_filters_by_and(client, files_db) -> None:
    _seed_mixed_files(files_db)

    body = _get(client, status="registered", q="inca")

    assert _names(body) == ["inca_reg.dat"]
