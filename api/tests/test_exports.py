"""The server-side CSV export of the three lists (FR-DM-043, export half).

The browser export writes the file from the pages the screen already walked
(`frontend/components/shared/export-button.tsx`). These routes answer the two
halves it cannot: a program can fetch a file, and the file carries the WHOLE
matching set.

The five guarantees each get a test, and each one would fail if the route
stopped keeping it:

1. The export streams every matching row, never one page.
2. A filter narrows the file, and it narrows it the way the list route does.
3. The row cap refuses an export nobody sized.
4. The audit row is written BEFORE the first row leaves.
5. An unknown column is refused, never quietly dropped.
"""

import csv
import io
from datetime import UTC, datetime

import pytest
from pymongo.errors import PyMongoError

from api.services import exports
from tests import factories
from tests.factories import register_file
from tests.factories_planning import make_run
from tests.factories_signals import make_signal

RUNS_URL = "/api/v1/test-runs/export"
FILES_URL = "/api/v1/files/export"
SIGNALS_URL = "/api/v1/signals/export"

# The files fixture lives in `tests/factories.py`. `test_files_download.py`
# re-exports it the same way.
files_db = factories.files_db

# More rows than the largest page the list routes serve would need in one call,
# so a route that exported "the first page" fails test 1 loudly.
SEEDED_RUNS = 45


def _rows(text: str) -> list[list[str]]:
    """Parse a CSV answer. The first row is the header."""
    return list(csv.reader(io.StringIO(text)))


@pytest.fixture
def runs_db(routed_db):
    """`SEEDED_RUNS` runs on two rigs, newest first by arrival."""
    routed_db["test_runs"].insert_many(
        [
            make_run(
                run_id=f"TAS-{90000 + index}",
                description=f"Run {index}",
                rig_id="RIG-04" if index % 3 == 0 else "RIG-02",
                # No project. One column of the file must prove that an absent
                # value writes an empty field and never a screen glyph.
                project=None,
                first_data_at=datetime(2026, 8, 14, 9, index % 60, tzinfo=UTC),
            )
            for index in range(SEEDED_RUNS)
        ]
    )
    return routed_db


def test_the_export_carries_every_matching_row_and_not_one_page(client, runs_db):
    answer = client.get(RUNS_URL)

    assert answer.status_code == 200
    assert answer.headers["content-type"].startswith("text/csv")
    rows = _rows(answer.text)
    # One header row plus every seeded run. The default page is 20 rows, so a
    # route that served a page would stop at 21 lines.
    assert len(rows) == SEEDED_RUNS + 1
    assert answer.headers["X-Export-Rows"] == str(SEEDED_RUNS)
    assert rows[0] == [column.header for column in exports.RUN_COLUMNS]
    assert {row[0] for row in rows[1:]} == {
        f"TAS-{90000 + index}" for index in range(SEEDED_RUNS)
    }


def test_the_export_names_the_file_and_refuses_a_cache(client, runs_db):
    answer = client.get(RUNS_URL)

    assert "attachment" in answer.headers["Content-Disposition"]
    assert "test-runs-" in answer.headers["Content-Disposition"]
    assert answer.headers["Cache-Control"] == "no-store"


def test_a_filter_narrows_the_export_the_way_it_narrows_the_list(client, runs_db):
    listed = client.get("/api/v1/test-runs", params={"rig": "RIG-04"}).json()
    exported = _rows(client.get(RUNS_URL, params={"rig": "RIG-04"}).text)

    assert len(exported) - 1 == listed["total"]
    assert listed["total"] < SEEDED_RUNS  # the filter really removed rows
    assert all(row[5] == "RIG-04" for row in exported[1:])


def test_the_run_counts_come_from_the_read_model(client, runs_db):
    """`file_count` is derived, not stored, so the export must overlay it too."""
    register_file(runs_db, run_id="TAS-90000")
    register_file(runs_db, run_id="TAS-90000")

    rows = _rows(client.get(RUNS_URL, params={"q": "TAS-90000"}).text)
    files_column = rows[0].index("Files")

    assert [row[files_column] for row in rows[1:]] == ["2"]


def test_the_caller_picks_the_columns(client, runs_db):
    answer = client.get(RUNS_URL, params={"columns": ["Status", "Run"]})

    rows = _rows(answer.text)
    # The declared order of the screen wins over the order the caller typed.
    assert rows[0] == ["Run", "Status"]
    assert len(rows[1]) == 2


def test_an_unknown_column_is_refused(client, runs_db):
    answer = client.get(RUNS_URL, params={"columns": ["Run", "Salary"]})

    assert answer.status_code == 422
    body = answer.json()
    assert body["code"] == "unknown_column"
    assert "Salary" in body["detail"]


def test_the_cap_refuses_an_export_nobody_sized(client, runs_db, monkeypatch):
    monkeypatch.setattr(exports, "EXPORT_ROW_CAP", SEEDED_RUNS - 1)

    answer = client.get(RUNS_URL)

    assert answer.status_code == 413
    body = answer.json()
    assert body["code"] == "export_too_large"
    assert str(SEEDED_RUNS) in body["detail"]
    # A refused export moves no row, so it records no egress either.
    assert runs_db["journal_entries"].count_documents({"entity_type": "export"}) == 0


def test_the_cap_lets_the_exact_count_through(client, runs_db, monkeypatch):
    """The cap refuses ABOVE it. An export of exactly the cap still answers."""
    monkeypatch.setattr(exports, "EXPORT_ROW_CAP", SEEDED_RUNS)

    assert client.get(RUNS_URL).status_code == 200


def test_the_audit_row_is_written_before_the_first_row_leaves(client, runs_db):
    with client.stream("GET", RUNS_URL) as answer:
        assert answer.status_code == 200
        # The headers arrived and no body byte has been read yet. The journal
        # row must already stand — the file download keeps the same rule
        # (`api/api/routers/files.py`).
        entry = runs_db["journal_entries"].find_one({"entity_type": "export"})
        assert entry is not None
        answer.read()

    assert entry["entity_id"] == "test-runs"
    assert entry["field"] == "export.downloaded"
    assert entry["kind"] == "event"
    assert entry["source"] == "manual"
    assert entry["actor"] == "static token holder"
    # The note states how much left, under which columns, with which filters.
    assert f"Exported {SEEDED_RUNS} test-runs rows as CSV" in entry["note"]
    assert "Columns: Run, Description" in entry["note"]
    assert "Filters: (none)" in entry["note"]
    assert answer.headers["X-Journal-Id"] == entry["_id"]


def test_the_audit_row_states_the_filters(client, runs_db):
    client.get(RUNS_URL, params={"rig": "RIG-04"})

    entry = runs_db["journal_entries"].find_one({"entity_type": "export"})
    assert "Filters: rig=RIG-04" in entry["note"]


def test_a_failed_audit_write_refuses_the_export(client, runs_db, monkeypatch):
    """No row moves without a trace. Same refusal as the file download."""

    def refuse(*args, **kwargs):
        raise PyMongoError("mongo is down")

    monkeypatch.setattr(type(runs_db["journal_entries"]), "insert_one", refuse)

    answer = client.get(RUNS_URL)

    assert answer.status_code == 503
    assert answer.json()["code"] == "not_ready"


def test_the_files_export_answers_and_holds_the_active_files(client, files_db):
    register_file(files_db, filename="one.mf4")
    register_file(files_db, filename="two.mf4")
    register_file(files_db, filename="gone.mf4", lifecycle="deleted")

    rows = _rows(client.get(FILES_URL).text)

    assert rows[0] == [column.header for column in exports.FILE_COLUMNS]
    assert {row[1] for row in rows[1:]} == {"one.mf4", "two.mf4"}
    entry = files_db["journal_entries"].find_one({"entity_type": "export"})
    assert entry["entity_id"] == "files"


def test_the_signals_export_answers_and_a_filter_narrows_it(client, routed_db):
    make_signal(routed_db, "HV_Batt_Cell_Temp_Max", unit="°C")
    make_signal(routed_db, "Motor_Torque", unit="Nm")

    whole = _rows(client.get(SIGNALS_URL).text)
    filtered = _rows(client.get(SIGNALS_URL, params={"unit": "Nm"}).text)

    assert whole[0] == [column.header for column in exports.SIGNAL_COLUMNS]
    assert len(whole) == 3
    assert [row[0] for row in filtered[1:]] == ["Motor_Torque"]
    entry = routed_db["journal_entries"].find_one({"entity_type": "export"})
    assert entry["entity_id"] == "signals"


def test_a_utf8_cell_survives_the_wire(client, routed_db):
    make_signal(routed_db, "Cell_Temp", unit="°C", description='He said "hot", loudly')

    rows = _rows(client.get(SIGNALS_URL).text)

    assert rows[1][1] == 'He said "hot", loudly'
    assert rows[1][2] == "°C"


def test_a_bad_sort_is_refused_the_way_the_list_refuses_it(client, runs_db):
    """The export reuses the sort dependency, so it inherits the 422."""
    answer = client.get(RUNS_URL, params={"sort": "salary"})

    assert answer.status_code == 422
    assert answer.json()["code"] == "validation_error"


def test_the_export_needs_the_bearer_token(bare_client, runs_db):
    assert bare_client.get(RUNS_URL).status_code == 401
    assert bare_client.get(FILES_URL).status_code == 401
    assert bare_client.get(SIGNALS_URL).status_code == 401


def test_an_absent_value_stays_an_empty_field(client, runs_db):
    """The screen prints a dash. The dash must never reach a spreadsheet."""
    rows = _rows(client.get(RUNS_URL, params={"columns": ["Run", "Project"]}).text)

    assert rows[1][1] == ""


def test_the_export_row_reads_back_on_the_journal(client, routed_db):
    """An export row is written by the route, and an auditor still reads it."""
    make_signal(routed_db, "Cell_Temp", unit="°C")

    client.get(SIGNALS_URL)

    page = client.get("/api/v1/journal", params={"entity_type": "export"})
    assert page.status_code == 200, page.text
    assert [entry["entity_id"] for entry in page.json()["items"]] == ["signals"]
