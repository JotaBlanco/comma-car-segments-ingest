# GET /files reads the real Mongo file collection (ticket B-03, contract #12).

from datetime import UTC, datetime, timedelta

from tests import factories
from tests.factories import register_file

# The assignments re-export the fixtures without shadowing an import.
# files_db points the app at this test's database, with indexes applied.
files_db = factories.files_db

BASE_AT = datetime(2026, 8, 14, 9, 0, tzinfo=UTC)


def _names(body: dict) -> list[str]:
    return [item["filename"] for item in body["items"]]


def _get(client, **params):
    response = client.get("/api/v1/files", params=params)
    assert response.status_code == 200
    return response.json()


def test_status_quarantined_deep_link(client, files_db):
    register_file(files_db, filename="ok.mf4", status="registered")
    register_file(
        files_db,
        filename="bad.mf4",
        status="quarantined",
        quarantine_reason="checksum mismatch",
    )

    body = _get(client, status="quarantined")

    assert _names(body) == ["bad.mf4"]
    assert body["total"] == 1


def test_source_system_filter(client, files_db):
    register_file(files_db, filename="tas.mf4", source_system="TAS")
    register_file(files_db, filename="inca.dat", source_system="INCA")

    body = _get(client, source_system="INCA")

    assert _names(body) == ["inca.dat"]


def test_run_filter(client, files_db):
    register_file(files_db, filename="in_88214.mf4", run_id="TAS-88214")
    register_file(files_db, filename="in_88213.mf4", run_id="TAS-88213")

    body = _get(client, run="TAS-88213")

    assert _names(body) == ["in_88213.mf4"]


def test_unlinked_filter(client, files_db):
    register_file(files_db, filename="orphan.mf4", run_id=None)
    register_file(files_db, filename="linked.mf4", run_id="TAS-88214")

    unlinked = _get(client, unlinked="true")
    linked = _get(client, unlinked="false")

    assert _names(unlinked) == ["orphan.mf4"]
    assert _names(linked) == ["linked.mf4"]


def test_run_and_unlinked_filters_combine(client, files_db):
    # The clauses must combine with $and. A merged dict loses one of them,
    # because run and unlinked both write the run_id key.
    register_file(files_db, filename="linked_88214.mf4", run_id="TAS-88214")
    register_file(files_db, filename="linked_77001.mf4", run_id="TAS-77001")
    register_file(files_db, filename="orphan.mf4", run_id=None)

    linked = _get(client, run="TAS-88214", unlinked="false")
    impossible = _get(client, run="TAS-88214", unlinked="true")

    assert _names(linked) == ["linked_88214.mf4"]
    assert linked["total"] == 1
    # A named run and unlinked can never both hold, so the page is empty.
    assert _names(impossible) == []
    assert impossible["total"] == 0


def test_q_escapes_regex_metacharacters_and_trims_the_needle(client, files_db):
    # A dot in the needle must match a dot, never any character.
    register_file(files_db, filename="bat.cyc.mf4", run_id=None)
    register_file(files_db, filename="batXcycYmf4", run_id=None)

    literal = _get(client, q="bat.cyc")
    padded = _get(client, q="  bat.cyc  ")

    assert _names(literal) == ["bat.cyc.mf4"]
    assert _names(padded) == ["bat.cyc.mf4"]


def test_q_matches_filename_checksum_and_run_id_case_insensitive(client, files_db):
    register_file(
        files_db,
        filename="bat_cyc_20260814.mf4",
        run_id="TAS-88214",
        checksum_sha256="a" * 64,
    )
    register_file(
        files_db,
        filename="em_eff.mf4",
        run_id="TAS-88214",
        checksum_sha256="9f2c8a41" + "b" * 56,
    )
    register_file(
        files_db,
        filename="coolant.csv",
        run_id="TAS-77001",
        checksum_sha256="c" * 64,
    )
    # This file matches none of the three queries below.
    register_file(
        files_db,
        filename="other.bin",
        run_id="TAS-88214",
        checksum_sha256="d" * 64,
    )

    by_filename = _get(client, q="BAT_CYC")
    by_checksum = _get(client, q="9F2C8A41")
    by_run_id = _get(client, q="77001")

    assert _names(by_filename) == ["bat_cyc_20260814.mf4"]
    assert _names(by_checksum) == ["em_eff.mf4"]
    assert _names(by_run_id) == ["coolant.csv"]


def test_sorted_by_registered_at_descending(client, files_db):
    register_file(files_db, filename="oldest.mf4", registered_at=BASE_AT)
    register_file(files_db, filename="middle.mf4", registered_at=BASE_AT + timedelta(hours=1))
    register_file(files_db, filename="newest.mf4", registered_at=BASE_AT + timedelta(hours=2))

    body = _get(client)

    assert _names(body) == ["newest.mf4", "middle.mf4", "oldest.mf4"]


def test_pagination_page_two_differs(client, files_db):
    for index in range(12):
        register_file(
            files_db,
            filename=f"file_{index:02d}.mf4",
            checksum_sha256=f"{index:064x}",
            registered_at=BASE_AT + timedelta(minutes=index),
        )

    first = _get(client, page=1, page_size=10)
    second = _get(client, page=2, page_size=10)

    assert len(first["items"]) == 10
    assert len(second["items"]) == 2
    assert first["total"] == 12
    assert first["total_pages"] == 2
    assert second["page"] == 2
    first_ids = {item["file_id"] for item in first["items"]}
    second_ids = {item["file_id"] for item in second["items"]}
    assert first_ids.isdisjoint(second_ids)


def test_page_past_the_end_returns_an_empty_page(client, files_db):
    for index in range(12):
        register_file(
            files_db,
            filename=f"file_{index:02d}.mf4",
            registered_at=BASE_AT + timedelta(minutes=index),
        )

    body = _get(client, page=3, page_size=10)

    assert body["items"] == []
    assert body["total"] == 12
    assert body["total_pages"] == 2
    assert body["page"] == 3
