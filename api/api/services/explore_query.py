"""The Explore context: the table, its columns, the counts, the AI switch.

This module ran the guarded user SQL until 24 Aug 2026. The workbench now
posts its SQL straight to QuixLake through the frontend's own route
(`frontend/app/api/lake/query/route.ts`), so the guard (`explore_guard.py`)
and the query transport are deleted. See
`plans/design/EXPLORE-DIRECT-LAKE.md`.
"""

from pymongo.database import Database

from api.services import ai_client, queries_stats

# The LOGICAL table name and the five logical columns the context states.
# They moved here from the deleted guard. The lake writer pins the same five
# columns (`api/ingest/lake.py` COLUMNS) — keep the two tuples equal.
TABLE_NAME = "test_signal_samples"
PROJECTED_COLUMNS = ("run_id", "signal", "timestamp", "value", "filename")

# The two column spellings that vary per physical table.
#
# The frontend owns the master map (`frontend/lib/explore/lake-schema.ts`)
# and every generated statement still reads it. This copy serves ONE caller:
# the Ask-AI context, which must tell the assistant the identifiers the lake
# really has. SQL the assistant suggests now reaches QuixLake unchanged, so a
# wrong spelling here is a binder error in front of the user.
#
# A constant, not a `DESCRIBE` against the lake, on purpose. The lake is
# optional in this service and it can be down; a chat turn must never wait on
# it or fail because of it. Add a row here when you add one to the frontend
# map. A table absent from both keeps the identity spellings.
_PHYSICAL_SPELLINGS: dict[str, tuple[str, str]] = {
    "test_signal_samples_v3": ("ts_ms", "file_name"),
    "test_signal_samples_v4": ("ts_ms", "file_name"),
    "tm_signals": ("ts_ms", "file_name"),
}


def explore_table_name() -> str:
    """Name the Explore table for the context route.

    The name is LOGICAL. `GET /explore/context` reports the surface, and no
    query builder reads it — the workbench resolves the physical table on its
    own side. Ask AI needs the physical name instead; see
    ``physical_table_name``.
    """
    return TABLE_NAME


def physical_table_name() -> str:
    """Name the real lake table, the one the assistant must write SQL against.

    Reads `TM_LAKE_TABLE` through the one accessor this service already has.
    An unset variable answers the local stack's table, as it does today.
    """
    return queries_stats._lake_table()


def physical_columns() -> tuple[str, ...]:
    """The five real column spellings of the current physical table.

    An unmapped table keeps the identity spellings, the same fallback the
    frontend map takes. The worst outcome is then a binder error the user can
    read, never silently different data.
    """
    time_column, file_column = _PHYSICAL_SPELLINGS.get(
        physical_table_name(), ("timestamp", "filename")
    )
    return ("run_id", "signal", time_column, "value", file_column)


def run_context(db: Database, run_id: str) -> dict:
    """Describe the run's Explore surface without touching the lake.

    The counts come off the run document, the same stored fields the run
    detail serves. A run known only through its files carries no document
    yet, so the counts answer zero rather than 404 — the existence check
    already ran in the router. ``sample_count`` stays null on purpose: it
    would cost a lakeside COUNT(*), and context must stay cheap and honest.

    ``table`` is the LOGICAL name, and it is the only name any caller may see.
    ``explore_chat`` states the PHYSICAL name instead, because the assistant
    writes SQL the lake runs unchanged. See ``explore_table_name``.
    """
    run = db["test_runs"].find_one({"_id": run_id}) or {}
    return {
        "table": explore_table_name(),
        "columns": list(PROJECTED_COLUMNS),
        "file_count": run.get("file_count") or 0,
        "signal_count": run.get("signal_count") or 0,
        "sample_count": None,
        # The Ask-AI pipe is available when a Portal base URL is configured. It
        # keys off the pipe, not off a live agent (decision D-E3): a configured
        # Portal is what the chat route needs, and an agentless session is the
        # supported fallback until a TM agent is registered.
        "ai_available": bool(ai_client.portal_base()),
    }
