"""Server-side CSV export of the three list screens (FR-DM-043, export half).

The browser export (`frontend/components/shared/export-button.tsx`) writes the
file from the rows the screen already holds. It therefore fails the
requirement twice: it stops at the pages it walked, and no route produces a
file, so a scheduled job can fetch nothing.

These helpers close the export half. One route per list takes the SAME filters
the matching list route takes, and this module streams every matching row.

Four rules the module keeps:

* **Reuse the filter code, never copy it.** Each route builds its Mongo query
  with the same builder the list route uses — `queries_runs.runs_query`,
  `queries_signals.files_query`, `routers.signals.signals_query`. A second copy
  would let the export and the table select different rows.
* **Bound the answer.** `EXPORT_ROW_CAP` refuses a set no answer should carry.
  Nothing here ever streams an unbounded query.
* **Audit before bytes.** The file download writes its journal entry before the
  first byte (`api/api/routers/files.py`). An export is a data egress too, so
  it follows the same rule and the same 503 on a failed write.
* **One column list, and the caller picks from it.** The headers below repeat
  the headers the three screens declare, so the browser file and the server
  file carry the same columns under the same names.

**Why the column list lives here and not in the front end.** The screens
declare their columns as TypeScript closures over the row type
(`RUN_CSV_COLUMNS` and its two peers), and `frontend/lib/export-columns.ts`
stores only the chosen HEADERS in `localStorage`; it holds no column
definition at all. Neither is readable from Python. The headers are the shared
surface, so they are what this module matches.
"""

from __future__ import annotations

import csv
import io
from collections.abc import Callable, Iterable, Iterator
from datetime import UTC, datetime
from typing import NamedTuple

from fastapi.responses import StreamingResponse
from pymongo.database import Database
from pymongo.errors import PyMongoError

from api.errors import ApiError
from api.models.common import Source, _iso_z
from api.provenance import add_event
from api.services.file_bytes import content_disposition

# The row cap of one export.
#
# 50,000 rows: the biggest list of the demo registry is the signal catalogue at
# 6,412 rows, so a whole list still travels in one call with room to grow, and
# 50,000 rows of the widest column set (files, 18 columns) is roughly 10 MB of
# CSV — a size one HTTP answer and one spreadsheet both take. The browser
# export stops at 10,000 rows, so this route carries five times more and is
# still bounded. Beyond the cap the route refuses with `export_too_large`
# rather than open a cursor nobody sized.
EXPORT_ROW_CAP = 50_000

# How many documents one read pulls, and how many the run decoration folds in
# one pass. It matches the largest page size the list routes allow, so the
# export costs Mongo the same shape of work the table already costs it.
BATCH = 500

# The buffer flushes at this size, so the caller starts reading early and this
# process never holds the whole document.
_FLUSH_BYTES = 64 * 1024

# The note of a journal row states the filters, and a query string has no
# length limit. A long one is truncated: the row records the egress, it is not
# a copy of the request.
_NOTE_FILTER_LIMIT = 400


class Column(NamedTuple):
    """One column of the file: the header, and how to read one document."""

    header: str
    read: Callable[[dict], object]


def _at(document: dict, *path: str) -> object:
    """Read a nested key. A missing step reads as absent, never as an error."""
    value: object = document
    for key in path:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def _text(value: object) -> str:
    """Render one stored value as one CSV field.

    An absent value stays an empty field. The screen prints a dash for it, and
    that glyph must never reach a spreadsheet — the browser writer states the
    same rule (`frontend/lib/table-csv.ts`).

    A timestamp goes through the wire serializer of `api/models/common.py`, so
    a cell of this file reads exactly like the same value of the list route.
    """
    if value is None:
        return ""
    if isinstance(value, datetime):
        return _iso_z(value)
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


# The three column lists. Each header, its order and its rendering repeat the
# screen constant beside it, so the two files agree cell for cell.

# `frontend/components/screens/runs/runs-screen.tsx` — RUN_CSV_COLUMNS.
RUN_COLUMNS: tuple[Column, ...] = (
    Column("Run", lambda row: row.get("_id")),
    Column("Description", lambda row: row.get("description")),
    Column("Definition", lambda row: row.get("definition_id")),
    Column("Work order", lambda row: row.get("work_order_id")),
    Column("Project", lambda row: row.get("project")),
    Column("Rig", lambda row: row.get("rig_id")),
    Column("Test cell", lambda row: row.get("test_cell")),
    Column("Files", lambda row: row.get("file_count")),
    Column("Signals", lambda row: row.get("signal_count")),
    Column("Arrived", lambda row: row.get("first_data_at")),
    Column("Status", lambda row: row.get("status")),
    # The runs screen writes the words, and the files screen writes the
    # boolean. The two differ, and this module copies each screen rather than
    # make them agree — a changed cell is a changed file for whoever reads the
    # export in a spreadsheet.
    Column("Invalid", lambda row: "yes" if _at(row, "invalid", "flagged") else "no"),
    Column("Invalid reason", lambda row: _at(row, "invalid", "reason")),
)

# `frontend/components/screens/files/files-screen.tsx` — FILE_CSV_COLUMNS.
FILE_COLUMNS: tuple[Column, ...] = (
    Column("File id", lambda row: row.get("_id")),
    Column("Filename", lambda row: row.get("filename")),
    Column("Run", lambda row: row.get("run_id")),
    Column("Source", lambda row: row.get("source_system")),
    Column("Format", lambda row: row.get("format")),
    Column("Size bytes", lambda row: row.get("size_bytes")),
    Column("Checksum SHA-256", lambda row: row.get("checksum_sha256")),
    Column("Checksum state", lambda row: row.get("checksum_state")),
    Column("Status", lambda row: row.get("status")),
    Column("Quarantine reason", lambda row: row.get("quarantine_reason")),
    Column("Lifecycle", lambda row: row.get("lifecycle") or "active"),
    Column("Invalid", lambda row: bool(_at(row, "invalid", "flagged"))),
    Column("Invalid reason", lambda row: _at(row, "invalid", "reason")),
    Column("Version", lambda row: row.get("version") or 1),
    Column("Signals", lambda row: row.get("signal_count")),
    Column("Time start", lambda row: row.get("time_start")),
    Column("Time end", lambda row: row.get("time_end")),
    Column("Registered", lambda row: row.get("registered_at")),
)

# `frontend/components/screens/signals/signals-screen.tsx` — SIGNAL_CSV_COLUMNS.
SIGNAL_COLUMNS: tuple[Column, ...] = (
    Column("Signal", lambda row: row.get("_id")),
    Column("Description", lambda row: row.get("description")),
    Column("Unit", lambda row: row.get("unit")),
    Column("Unit source", lambda row: row.get("unit_source")),
    Column("Data type", lambda row: row.get("dtype")),
    Column("Typical rate Hz", lambda row: row.get("typical_rate_hz")),
    Column("Runs", lambda row: row.get("run_count")),
    Column("First seen", lambda row: row.get("first_seen")),
    Column("Last seen", lambda row: row.get("last_seen")),
)

COLUMNS: dict[str, tuple[Column, ...]] = {
    "test-runs": RUN_COLUMNS,
    "files": FILE_COLUMNS,
    "signals": SIGNAL_COLUMNS,
}


def resolve_columns(list_name: str, chosen: list[str] | None) -> tuple[Column, ...]:
    """Pick the columns of one export, in the declared order of the screen.

    A caller that names none gets every column, so a file is never empty. That
    is the rule of the browser picker (`chooseColumns`), and it keeps the two
    exports the same.

    A caller that names an UNKNOWN column is refused with 422
    ``unknown_column``. The browser picker falls back to every column there,
    because a stale `localStorage` entry must not break a click. A program that
    asks the API for a column that does not exist has a bug, and a silent
    fallback would hand it a file with the wrong shape.
    """
    declared = COLUMNS[list_name]
    wanted = [value.strip() for value in (chosen or []) if value.strip()]
    if not wanted:
        return declared
    known = {column.header for column in declared}
    unknown = [header for header in wanted if header not in known]
    if unknown:
        raise ApiError(
            422,
            f"columns: {', '.join(unknown)} — the {list_name} export offers "
            f"{', '.join(sorted(known))}",
            "unknown_column",
        )
    picked = set(wanted)
    return tuple(column for column in declared if column.header in picked)


def _documents(
    db: Database,
    collection: str,
    query: dict,
    sort: list[tuple[str, int]],
    decorate: Callable[[Database, list[dict]], list[dict]] | None,
) -> Iterator[dict]:
    """Walk every matching document, in batches, never a page.

    One cursor reads the whole set, so no row is served twice and none is
    skipped — a paging loop over a table somebody writes to does both.

    ``decorate`` overlays the derived fields of a batch. The runs list needs
    it: `file_count` and `signal_count` are a read model
    (`queries_runs.with_facts`), not stored values, and two of the columns
    carry them.
    """
    chunk: list[dict] = []
    for document in db[collection].find(query).sort(sort).batch_size(BATCH):
        chunk.append(document)
        if len(chunk) == BATCH:
            yield from (decorate(db, chunk) if decorate else chunk)
            chunk = []
    if chunk:
        yield from (decorate(db, chunk) if decorate else chunk)


def _csv_bytes(columns: tuple[Column, ...], rows: Iterable[dict]) -> Iterator[bytes]:
    """Write the CSV document as UTF-8 chunks — header row first, CRLF endings.

    ``csv`` from the standard library owns the escaping. Its default quoting
    wraps a field that carries a comma, a quote or a line break and doubles an
    inner quote, which is RFC 4180 and is exactly what the browser writer does
    (`frontend/lib/explore/csv.ts`).
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")

    def drain() -> bytes:
        text = buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)
        return text.encode("utf-8")

    writer.writerow([column.header for column in columns])
    yield drain()
    for row in rows:
        writer.writerow([_text(column.read(row)) for column in columns])
        if buffer.tell() >= _FLUSH_BYTES:
            yield drain()
    tail = drain()
    if tail:
        yield tail


def _audit(
    db: Database,
    list_name: str,
    actor: str,
    rows: int,
    columns: tuple[Column, ...],
    filters: str,
) -> dict:
    """Record the egress BEFORE the first row leaves. Same rule as a download.

    The row states who exported, which list, how many rows, which columns and
    which filters. That is what an auditor needs to answer "who took this data,
    and what was in it".

    A failed write refuses the export with 503 ``not_ready``. Rows never move
    without a trace.
    """
    named = ", ".join(column.header for column in columns)
    stated = filters[:_NOTE_FILTER_LIMIT] if filters else "(none)"
    event = add_event(
        entity_type="export",
        entity_id=list_name,
        field="export.downloaded",
        source=Source.MANUAL,
        actor=actor,
        note=f"Exported {rows} {list_name} rows as CSV. Columns: {named}. Filters: {stated}",
    )
    try:
        db["journal_entries"].insert_one(event)
    except PyMongoError as error:
        raise ApiError(
            503,
            "the export event could not be recorded — refusing to serve rows",
            "not_ready",
        ) from error
    return event


def csv_export(
    db: Database,
    *,
    list_name: str,
    collection: str,
    query: dict,
    sort: list[tuple[str, int]],
    columns: list[str] | None,
    actor: str,
    filters: str,
    decorate: Callable[[Database, list[dict]], list[dict]] | None = None,
) -> StreamingResponse:
    """Stream every matching row of one list as CSV.

    The order of the four steps is the contract of this route:

    1. Resolve the columns. An unknown one refuses with 422 before any read.
    2. Count the matching set. Over ``EXPORT_ROW_CAP`` refuses with 413.
    3. Write the journal row. A failed write refuses with 503.
    4. Only then open the cursor and stream.

    The generator is lazy, so step 3 always completes before the first byte.
    """
    chosen = resolve_columns(list_name, columns)
    total = db[collection].count_documents(query)
    if total > EXPORT_ROW_CAP:
        raise ApiError(
            413,
            f"The export matches {total} rows and the cap is {EXPORT_ROW_CAP}. "
            "Narrow the filters and export again.",
            "export_too_large",
        )
    event = _audit(db, list_name, actor, total, chosen, filters)
    filename = f"{list_name}-{datetime.now(UTC):%Y-%m-%d}.csv"
    return StreamingResponse(
        _csv_bytes(chosen, _documents(db, collection, query, sort, decorate)),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": content_disposition(filename),
            # How many rows the file carries. The front end reads it to name
            # the export in a toast without counting the bytes.
            "X-Export-Rows": str(total),
            # The audit id, so an operator walks from the file to the entry.
            # The file download carries the same header.
            "X-Journal-Id": event["_id"],
            # Never let a proxy cache a per-caller export.
            "Cache-Control": "no-store",
        },
    )
