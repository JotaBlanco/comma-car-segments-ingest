"""The assistant's tool registry: read-only functions over the service layer.

Every tool is a plain call into ``queries_runs`` / ``queries_signals`` — the
same run_facts-fed services the screens read, so the assistant can never
disagree with a screen about a count. The registry is a WHITELIST and it is
the assistant's whole reach: no results upload, no PATCH, no journal POST
exists here, so no prompt — however hostile — can turn a chat into a write
(AI-SIDEBAR §5.2, "never weaken").

Tools execute in-process with the request's own db handle; the model never
receives a token or a connection. Results are JSON-safe dicts, each carrying a
one-line ``summary`` for the tool_result frame, and every list is capped at
``_MAX_ROWS`` rows so one tool call cannot flood the prompt.
"""

from datetime import UTC, datetime

from pymongo.database import Database

from api.models.common import Pagination
from api.services import queries_runs, queries_signals

# The hard cap on rows a tool may return to the model. Also the largest
# page_size a tool call may ask for.
_MAX_ROWS = 50


def _json_safe(value):
    """Convert a service-layer result to JSON-serializable data.

    Datetimes become ISO-8601 UTC strings with a Z suffix — the same wire
    format the API serves — so the model reads the dates the screens show.
    """
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    return value


def _as_list(value) -> list[str] | None:
    """Accept a scalar or a list for a multi-value filter; None passes through."""
    if value is None:
        return None
    if isinstance(value, list):
        return [str(item) for item in value]
    return [str(value)]


def _pagination(page, page_size) -> Pagination:
    """Clamp the model's paging to sane, capped values."""
    try:
        page = max(1, int(page))
    except (TypeError, ValueError):
        page = 1
    try:
        page_size = min(max(1, int(page_size)), _MAX_ROWS)
    except (TypeError, ValueError):
        page_size = 20
    return Pagination(page=page, page_size=page_size)


def _capped(envelope: dict, noun: str) -> dict:
    """Cap a pagination envelope's items and attach the one-line summary."""
    items = envelope.get("items") or []
    result = {**envelope, "items": items[:_MAX_ROWS]}
    result["summary"] = f"{envelope.get('total', len(items))} {noun}, page {envelope.get('page', 1)}"
    return _json_safe(result)


def search(db: Database, q: str, limit_per_group: int = 5) -> dict:
    limit = min(max(1, int(limit_per_group)), _MAX_ROWS)
    result = queries_runs.search(db, str(q), limit)
    hit_count = sum(len(group["items"]) for group in result["groups"])
    return _json_safe({**result, "summary": f"{hit_count} hits in {len(result['groups'])} groups"})


def list_runs(
    db: Database,
    status=None,
    rig=None,
    project=None,
    work_order: str | None = None,
    q: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> dict:
    envelope = queries_runs.list_runs(
        db,
        _pagination(page, page_size),
        status=_as_list(status),
        rig=_as_list(rig),
        project=_as_list(project),
        work_order=work_order,
        q=q,
    )
    return _capped(envelope, "runs")


def get_run(db: Database, run_id: str) -> dict:
    run = queries_runs.get_run(db, str(run_id))
    return _json_safe({**run, "summary": f"run {run['_id']}: {run.get('status')}"})


def get_run_journal(db: Database, run_id: str, kind: str | None = None) -> dict:
    envelope = queries_runs.list_run_journal(
        db, str(run_id), Pagination(page=1, page_size=_MAX_ROWS), kind=kind
    )
    return _capped(envelope, "journal entries")


def get_run_lineage(db: Database, run_id: str) -> dict:
    chain = queries_runs.run_lineage(db, str(run_id))
    summary = (
        f"chain for {run_id}: {len(chain['files'])} files, {len(chain['results'])} results"
    )
    return _json_safe({**chain, "summary": summary})


def list_files(
    db: Database,
    status=None,
    source_system=None,
    run: str | None = None,
    unlinked: bool | None = None,
    q: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> dict:
    envelope = queries_signals.list_files(
        db,
        _pagination(page, page_size),
        status=_as_list(status),
        source_system=_as_list(source_system),
        run=run,
        unlinked=unlinked if isinstance(unlinked, bool) else None,
        q=q,
    )
    return _capped(envelope, "files")


def list_work_orders(
    db: Database,
    status=None,
    project=None,
    q: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> dict:
    envelope = queries_runs.list_work_orders(
        db,
        _pagination(page, page_size),
        status=_as_list(status),
        project=_as_list(project),
        q=q,
    )
    return _capped(envelope, "work orders")


def get_work_order(db: Database, wo_id: str) -> dict:
    detail = queries_runs.get_work_order_detail(db, str(wo_id))
    detail = {
        **detail,
        "definitions": detail["definitions"][:_MAX_ROWS],
        "runs": detail["runs"][:_MAX_ROWS],
    }
    summary = (
        f"work order {detail['_id']}: {len(detail['definitions'])} definitions, "
        f"{len(detail['runs'])} runs"
    )
    return _json_safe({**detail, "summary": summary})


def home_summary(db: Database) -> dict:
    result = queries_runs.home_summary(db)
    result = {**result, "recent_runs": result["recent_runs"][:_MAX_ROWS]}
    counts = result["counts"]
    summary = f"{counts['test_runs']} runs, {counts['files']} files in the registry"
    return _json_safe({**result, "summary": summary})


# The whitelist. run_tool refuses any name outside this map, so the model's
# tool vocabulary and the assistant's reach are one and the same table.
_REGISTRY = {
    "search": search,
    "list_runs": list_runs,
    "get_run": get_run,
    "get_run_journal": get_run_journal,
    "get_run_lineage": get_run_lineage,
    "list_files": list_files,
    "list_work_orders": list_work_orders,
    "get_work_order": get_work_order,
    "home_summary": home_summary,
}

# What the tool cards in the panel call each tool.
DISPLAY_NAMES = {
    "search": "Search the registry",
    "list_runs": "List runs",
    "get_run": "Read a run",
    "get_run_journal": "Read a run's journal",
    "get_run_lineage": "Trace a run's chain",
    "list_files": "List files",
    "list_work_orders": "List work orders",
    "get_work_order": "Read a work order",
    "home_summary": "Registry overview",
}


def run_tool(db: Database, name: str, args: dict) -> dict:
    """Execute one whitelisted tool. An unknown name is refused, never guessed."""
    tool = _REGISTRY.get(name)
    if tool is None:
        raise KeyError(f"tool {name!r} is not in the assistant whitelist")
    return tool(db, **(args or {}))


def _tool(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "name": name,
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": properties,
            "required": required,
        },
    }


_STR = {"type": "string"}
_STR_LIST = {"type": "array", "items": {"type": "string"}}
_PAGE = {
    "page": {"type": "integer", "minimum": 1},
    "page_size": {"type": "integer", "minimum": 1, "maximum": _MAX_ROWS},
}

# The Anthropic-shaped tool declarations the loop sends with every LLM call.
# Hand-authored (the OpenAPI snapshot is a description source, not a schema
# source — AI-SIDEBAR §1.3). The `answer` presenter tool is declared in
# ``assistant_presenter.py`` next to the code that hydrates it.
TOOL_SCHEMAS: list[dict] = [
    _tool(
        "search",
        "Search runs, work orders, files and signals by free text. "
        "Every word must match. Returns grouped hits with navigation ids.",
        {"q": _STR, "limit_per_group": {"type": "integer", "minimum": 1, "maximum": _MAX_ROWS}},
        ["q"],
    ),
    _tool(
        "list_runs",
        "List test runs, newest data first. Filters OR within a key and AND across keys. "
        "status values: complete (shown to users as 'Linked'), awaiting_work_order, invalid.",
        {
            "status": _STR_LIST,
            "rig": _STR_LIST,
            "project": _STR_LIST,
            "work_order": _STR,
            "q": _STR,
            **_PAGE,
        },
        [],
    ),
    _tool(
        "get_run",
        "Read one run's full record: fields, sources, invalid flag, counts.",
        {"run_id": _STR},
        ["run_id"],
    ),
    _tool(
        "get_run_journal",
        "Read one run's journal timeline, newest first. kind filters to "
        "'event', 'change' or 'note' entries.",
        {"run_id": _STR, "kind": _STR},
        ["run_id"],
    ),
    _tool(
        "get_run_lineage",
        "Trace one run's chain: work order, definition, run, files, results.",
        {"run_id": _STR},
        ["run_id"],
    ),
    _tool(
        "list_files",
        "List registered files. status values: registered, quarantined. "
        "unlinked=true keeps only files with no run.",
        {
            "status": _STR_LIST,
            "source_system": _STR_LIST,
            "run": _STR,
            "unlinked": {"type": "boolean"},
            "q": _STR,
            **_PAGE,
        },
        [],
    ),
    _tool(
        "list_work_orders",
        "List the work-order mirror with definition and run rollups. "
        "status values: active, closed.",
        {"status": _STR_LIST, "project": _STR_LIST, "q": _STR, **_PAGE},
        [],
    ),
    _tool(
        "get_work_order",
        "Read one work order with its definitions (planned vs actual) and runs.",
        {"wo_id": _STR},
        ["wo_id"],
    ),
    _tool(
        "home_summary",
        "The registry overview: totals, today's arrivals, needs-attention counts.",
        {},
        [],
    ),
]
