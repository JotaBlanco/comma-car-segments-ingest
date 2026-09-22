# TR-011. The four list routes filter by the source tag, and GET /home/summary
# serves the aggregate.
#
# The tag lives in the `field_sources` map, which every run, file, signal and
# work order carries. A row matches when at least one of its fields carries a
# named tag. A row the server never tagged matches nothing, because nobody
# recorded a source for it.

from datetime import UTC, datetime

import pytest

from tests import factories
from tests.factories import register_file
from tests.factories_planning import make_run, make_work_order
from tests.factories_signals import make_signal

# The assignment re-exports the fixture without shadowing an import.
files_db = factories.files_db

AT = datetime(2026, 8, 14, 9, 0, tzinfo=UTC)


def _tag(source: str, actor: str = "ingestion") -> dict:
    return {"source": source, "actor": actor, "at": AT}


def _ids(body: dict, key: str) -> set[str]:
    return {item[key] for item in body["items"]}


def _get(client, path, **params) -> dict:
    response = client.get(path, params=params)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def tagged(files_db):
    """Three runs, two files, two signals and two work orders.

    Each entity carries the tag its own write path would have written. Two
    rows carry no map at all, and they are the ones no source may claim.
    """
    db = files_db
    db["test_runs"].insert_many(
        [
            make_run("TAS-1", rig_id="RIG-04", field_sources={"bench_sw": _tag("api:config", "config-sync")}),
            make_run("TAS-2", rig_id="RIG-04", field_sources={"operator": _tag("manual", "a.bergstrom")}),
            # No tag at all. It must answer no source filter.
            make_run("TAS-3", rig_id="RIG-07"),
        ]
    )
    register_file(
        db,
        _id="f-1",
        filename="a.mf4",
        run_id="TAS-1",
        source_system="TAS",
        field_sources={"size_bytes": _tag("embedded")},
    )
    register_file(
        db,
        _id="f-2",
        filename="b.mf4",
        run_id="TAS-2",
        source_system="INCA",
        field_sources={"filename": _tag("manual", "a.bergstrom")},
    )
    make_signal(db, "Cell_Temp_C", field_sources={"unit": _tag("embedded")})
    make_signal(
        db,
        "Pack_Current",
        field_sources={"catalogue_ref": _tag("api:catalogue", "catalog-sync")},
    )
    db["work_orders"].insert_many(
        [
            make_work_order(
                "WO-1",
                project="EX30",
                field_sources={"title": _tag("api:planning", "planning-sync")},
            ),
            make_work_order("WO-2", project="EX90"),
        ]
    )
    return db


# --- one filter alone, on each route the row names --------------------------


def test_runs_filter_by_one_source(client, tagged) -> None:
    body = _get(client, "/api/v1/test-runs", source="manual")

    assert _ids(body, "run_id") == {"TAS-2"}


def test_files_filter_by_one_source(client, tagged) -> None:
    body = _get(client, "/api/v1/files", source="embedded")

    assert _ids(body, "file_id") == {"f-1"}


def test_signals_filter_by_one_source(client, tagged) -> None:
    body = _get(client, "/api/v1/signals", source="api:catalogue")

    assert _ids(body, "name") == {"Pack_Current"}


def test_work_orders_filter_by_one_source(client, tagged) -> None:
    body = _get(client, "/api/v1/work-orders", source="api:planning")

    assert _ids(body, "wo_id") == {"WO-1"}


# --- the rules the filter must keep ----------------------------------------


def test_an_untagged_row_answers_no_source_filter(client, tagged) -> None:
    # TAS-3 carries no map, and WO-2 carries none either. Nobody recorded a
    # source for them, so no source may claim them.
    for source in ("manual", "embedded", "api:planning", "api:config"):
        assert "TAS-3" not in _ids(_get(client, "/api/v1/test-runs", source=source), "run_id")
        assert "WO-2" not in _ids(_get(client, "/api/v1/work-orders", source=source), "wo_id")


def test_two_sources_return_the_union(client, tagged) -> None:
    body = _get(client, "/api/v1/test-runs", source=["manual", "api:config"])

    assert _ids(body, "run_id") == {"TAS-1", "TAS-2"}


def test_a_source_nobody_wrote_returns_an_empty_page(client, tagged) -> None:
    body = _get(client, "/api/v1/files", source="api:post-processing")

    assert body["items"] == []
    assert body["total"] == 0


def test_an_absent_source_leaves_the_list_whole(client, tagged) -> None:
    assert _get(client, "/api/v1/test-runs")["total"] == 3


def test_a_blank_source_is_refused(client, tagged) -> None:
    # The param takes the `Source` enum, so a blank value never reaches Mongo.
    # `status` on /files already behaves this way, and the screen clears the
    # filter by dropping the key rather than by sending an empty one.
    response = client.get("/api/v1/test-runs", params={"source": ""})

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


def test_an_unknown_source_value_is_refused(client, tagged) -> None:
    response = client.get("/api/v1/files", params={"source": "guesswork"})

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


# --- two filters together ---------------------------------------------------


def test_source_and_rig_combine_with_and(client, tagged) -> None:
    body = _get(client, "/api/v1/test-runs", source="manual", rig="RIG-04")

    assert _ids(body, "run_id") == {"TAS-2"}


def test_source_and_source_system_combine_with_and(client, tagged) -> None:
    body = _get(client, "/api/v1/files", source="manual", source_system="INCA")

    assert _ids(body, "file_id") == {"f-2"}


def test_two_filters_that_share_no_row_return_an_empty_page(client, tagged) -> None:
    body = _get(client, "/api/v1/files", source="embedded", source_system="INCA")

    assert body["items"] == []


def test_source_and_project_combine_on_work_orders(client, tagged) -> None:
    body = _get(client, "/api/v1/work-orders", source="api:planning", project="EX90")

    assert body["items"] == []


# --- the aggregate ----------------------------------------------------------


def test_the_summary_carries_one_row_per_source(client, tagged) -> None:
    body = _get(client, "/api/v1/home/summary")

    assert [row["source"] for row in body["source_breakdown"]] == [
        "embedded",
        "manual",
        "api:planning",
        "api:config",
        "api:catalogue",
        "api:post-processing",
    ]


def test_the_aggregate_counts_the_tagged_fields(client, tagged) -> None:
    body = _get(client, "/api/v1/home/summary")
    counts = {row["source"]: row["field_count"] for row in body["source_breakdown"]}

    # embedded: file f-1 size_bytes + signal Cell_Temp_C unit.
    # manual: run TAS-2 operator + file f-2 filename.
    assert counts["embedded"] == 2
    assert counts["manual"] == 2
    assert counts["api:config"] == 1
    assert counts["api:catalogue"] == 1
    assert counts["api:planning"] == 1


def test_a_source_nobody_wrote_reads_as_zero_and_never_drops(client, tagged) -> None:
    body = _get(client, "/api/v1/home/summary")
    counts = {row["source"]: row["field_count"] for row in body["source_breakdown"]}

    assert counts["api:post-processing"] == 0


def test_an_empty_registry_still_carries_every_source(client, files_db) -> None:
    body = _get(client, "/api/v1/home/summary")

    assert len(body["source_breakdown"]) == 6
    assert {row["field_count"] for row in body["source_breakdown"]} == {0}


# --- the token guard --------------------------------------------------------


def test_a_filtered_list_refuses_a_call_with_no_token(bare_client, tagged) -> None:
    response = bare_client.get("/api/v1/files", params={"source": "embedded"})

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


def test_the_summary_refuses_a_call_with_no_token(bare_client, tagged) -> None:
    response = bare_client.get("/api/v1/home/summary")

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


# --- the file registration tags every field the bytes prove -----------------


def _file_body(checksum: str) -> dict:
    """A POST /files body that states every field the registration tags."""
    return {
        "filename": "run.mf4",
        "run_id": "TAS-9",
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 1024,
        "checksum_sha256": checksum,
        "checksum_state": "verified",
        "storage_ref": "blob://test/run.mf4",
        "time_start": "2026-08-14T09:00:00Z",
        "time_end": "2026-08-14T10:00:00Z",
    }


def test_a_registered_file_tags_eight_fields(client, files_db) -> None:
    from api.routers.files import _EMBEDDED_FIELDS

    files_db["test_runs"].insert_one(make_run("TAS-9"))
    response = client.post("/api/v1/files", json=_file_body("c" * 64))
    assert response.status_code == 201, response.text

    stored = files_db["files"].find_one({"checksum_sha256": "c" * 64})
    assert set(stored["field_sources"]) == set(_EMBEDDED_FIELDS)
    assert len(_EMBEDDED_FIELDS) == 8
    assert stored["field_sources"]["filename"]["source"] == "embedded"


def test_a_registered_file_answers_the_embedded_filter(client, files_db) -> None:
    files_db["test_runs"].insert_one(make_run("TAS-9"))
    assert client.post("/api/v1/files", json=_file_body("d" * 64)).status_code == 201

    assert _get(client, "/api/v1/files", source="embedded")["total"] == 1
